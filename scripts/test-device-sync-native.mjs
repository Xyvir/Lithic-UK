#!/usr/bin/env node
/**
 * The app's half of device sync, driven through the built launcher with Rust stood in for.
 *
 * The desktop prong's engine is native: the page reaches it over Tauri IPC and loads no
 * wasm at all. The app itself cannot be built on this box (the Tauri crate needs GLib and
 * WebKitGTK, which this checkout does not carry), so what is driven here is the launcher's
 * half of that path: the page is served from the app's own URL (`tauri.localhost`,
 * resolved to this machine by the browser), a stand-in for the bridge Rust injects answers
 * the commands over an in-page folder, and the panel is walked the way a person walks it.
 *
 * What this proves: the heading draws the circle where an engine can run and the build has
 * one, the driver takes the native transport (`device_sync_*` commands, base64 bytes, the
 * app's own event) inside the app instead of the wasm module, a recent row's own mark sends
 * the file's exact bytes over the IPC (read off the disk through the app, not out of the
 * row), the event Rust emits refreshes the list the event is about, and a Lith only the
 * folder holds is a row that loads through the app's own save rather than a browser
 * download. The Lith travels through the recent list on both sides, which is the shape this
 * settled into: the panel pairs, and the list is the record.
 *
 * The three ways the circle is withheld are driven here too, because each is a different
 * question: an app whose executable was built without the iroh prong (the host's report, which
 * is how one committed artifact serves every app variant), a page that declares itself
 * browser-only (the shim, whose payload has no `launcher.wasm` on it), and the one place a
 * page outside the app gets the circle at all, a self-host page, which takes the browser prong
 * rather than the app's.
 *
 * What it does not prove: the Rust side. The engine's behaviour is the crate's own tests
 * (`sync/tests/`), and the command layer is compiled by CI (`rust-check.yml`), not here.
 *
 *   node scripts/build-launcher.mjs
 *   node scripts/test-device-sync-native.mjs
 *
 * A machine without Puppeteer's own download points it at the browser it has:
 *
 *   PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium node scripts/test-device-sync-native.mjs
 *
 * Exit 0 = the circle, the native start, a ticket, a join, a publish (bytes compared), an
 * event-driven refresh, and a saved copy, all through the panel.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import puppeteer from 'puppeteer';

/** The declaration the shim's page carries (see `mode.ts`), which the second control adds. */
const BROWSER_ONLY_META = 'lithic-browser-only';

const root = process.cwd();
const artifact = resolve(root, 'src/launcher.html');
assert.ok(existsSync(artifact), `build the launcher first: ${artifact} is missing`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/** The repository as a static server: the same one the browser pass uses. */
function staticServer(where) {
  return createServer((request, response) => {
    const path = resolve(where, `.${decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)}`);
    if (path !== where && !path.startsWith(where + sep)) {
      response.writeHead(403).end('outside the repository');
      return;
    }
    try {
      const body = readFileSync(path);
      response.writeHead(200, { 'Content-Type': MIME[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
}

const POLL = { polling: 250, timeout: 30000 };

/**
 * The bridge Rust injects, stood in for: the six commands over an in-page folder.
 *
 * It lives in the page because that is the side of the IPC this pass is about, and it
 * models the one behaviour the panel depends on: publishing adds an entry, and the event
 * the native engine emits is what tells the page to read the list again.
 */
function bridge(capabilities, seed) {
  const encoder = new TextEncoder();
  const state = {
    commands: [],
    // The folder as the app's engine already holds it. A row with no local copy is what the
    // recent list draws from this, so a seeded entry is how a pass gets one.
    entries: (seed?.folder ?? []).map(([name, text]) => ({
      name,
      size: encoder.encode(text).length,
      hash: `hash-${name}`,
      author: 'peer-node',
      timestamp: 1_700_000_000_000_000
    })),
    bytes: new Map((seed?.folder ?? []).map(([name, text]) => [name, encoder.encode(text)])),
    // What the app can read off this disk, by file name, which is what a path row is read
    // through (`read_lith_path`). Separate from the folder above, because the two answers are
    // different questions: a Lith can be on this disk and not on the devices, which is exactly
    // the state a send is for.
    disk: new Map(seed?.disk ?? []),
    saved: null,
    listener: null,
    nodeId: 'node-app',
    ticket: 'ticket-app',
    // What the mocked executable was built with. The archive app is the default: the
    // repository prong and no device prong, which is what `--sync=auto` builds.
    capabilities: capabilities ?? { github: false, iroh: true }
  };
  const encode = (bytes) => {
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) binary += String.fromCharCode(bytes[index]);
    return btoa(binary);
  };
  const decode = (text) => {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  window.__TAURI__ = {
    core: {
      invoke: async (command, args) => {
        state.commands.push({ command, args: args ?? null });
        switch (command) {
          case 'sync_capabilities':
            return state.capabilities;
          case 'device_sync_start':
            return { node_id: state.nodeId };
          case 'device_sync_share':
            return state.ticket;
          case 'device_sync_entries':
            return state.entries;
          case 'device_sync_read': {
            const bytes = state.bytes.get(args.name);
            return bytes ? encode(bytes) : null;
          }
          case 'read_lith_path': {
            const name = String(args.path).split('/').pop();
            const text = state.disk.get(name);
            if (text === undefined) throw new Error(`no such file: ${args.path}`);
            return { name, path: args.path, text };
          }
          case 'device_sync_publish': {
            const bytes = decode(args.bytes);
            state.bytes.set(args.name, bytes);
            state.entries = [
              ...state.entries.filter((entry) => entry.name !== args.name),
              { name: args.name, size: bytes.length, hash: 'hash', author: state.nodeId, timestamp: 1_700_000_000_000_000 }
            ];
            // The native engine tells the page its own way; the same event the crate's
            // `WireEvent` serializes.
            state.listener?.({ payload: { kind: 'seeded', name: args.name } });
            return null;
          }
          case 'save_lith_file':
            state.saved = { name: args.suggestedName, text: args.text };
            return { name: args.suggestedName, path: `/tmp/${args.suggestedName}` };
          default:
            return null;
        }
      }
    },
    event: {
      listen: async (event, handler) => {
        state.listener = handler;
        return () => {
          state.listener = null;
        };
      }
    }
  };
  window.__TAURI_STUB__ = state;
}

const scratch = mkdtempSync(join(tmpdir(), 'lithic-device-sync-native-'));
const proofPath = join(scratch, 'native-proof.lith');
// The file's own name, which is also what the bridge reads a path by: a real read goes
// through the app, and the app resolves a path to a file.
const proofName = 'native-proof.lith';
const proof = ['title: Native Proof', 'type: text/vnd.tiddlywiki', '', 'published through the app bridge', ''].join('\n');
// The Lith the peer holds and this device does not: the row the list has to invent, from the
// folder's own listing, and the one that loads rather than sends.
const foreignName = 'from-other-device.lith';
const foreign = ['title: From The Peer', 'type: text/vnd.tiddlywiki', '', 'written on the other device', ''].join('\n');

const server = staticServer(root);
const browser = await puppeteer.launch({
  headless: process.env.HEADED === '1' ? false : 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--host-resolver-rules=MAP tauri.localhost 127.0.0.1'],
  defaultViewport: { width: 1000, height: 800 }
});
const errors = [];

try {
  writeFileSync(proofPath, proof, 'utf8');
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  const appUrl = `http://tauri.localhost:${port}/src/launcher.html`;

  // The first control: the same launcher, served by an executable that was built without the
  // iroh prong, draws no device-sync circle however much the page itself could run. This is the
  // half of the pin the page has to ask about: one committed launcher is embedded in every app
  // variant, so what the process reports is the only thing that can tell them apart.
  const archive = await browser.newPage();
  await archive.setViewport({ width: 1000, height: 800 });
  await archive.evaluateOnNewDocument(bridge, { github: true, iroh: false });
  await archive.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await archive.waitForSelector('.heading-actions', { timeout: 30000 });
  // Waited for rather than sampled: the control for the prong this executable *does* have is
  // what says the report was read at all, and it arrives with it.
  await archive.waitForSelector('.heading .sync-button', { timeout: 30000 });
  assert.equal(
    await archive.$('.device-sync-button'),
    null,
    'an app built without the iroh prong should draw no device-sync circle'
  );
  await archive.close();

  // The second control: a page that declares itself browser-only draws none either, which is
  // the shim's rule until it grows an engine prong of its own. The declaration is the shim's
  // markup, so it is added to the document the server hands over.
  const shim = await browser.newPage();
  await shim.setViewport({ width: 1000, height: 800 });
  await shim.setRequestInterception(true);
  shim.on('request', (request) => {
    if (!request.isNavigationRequest() || !request.url().endsWith('/src/launcher.html')) {
      void request.continue();
      return;
    }
    const html = readFileSync(artifact, 'utf8').replace(
      '<head>',
      `<head>\n<meta name="${BROWSER_ONLY_META}" content="1">`
    );
    void request.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
  });
  await shim.goto(`http://127.0.0.1:${port}/src/launcher.html`, { waitUntil: 'domcontentloaded' });
  await shim.waitForSelector('.heading-actions', { timeout: 30000 });
  assert.equal(
    await shim.$('.device-sync-button'),
    null,
    'a page that declares itself browser-only should draw no device-sync circle'
  );
  await shim.close();

  // The third control is the one page outside the app that does draw it: an instance's launcher
  // ships the same wasm module, so a self-host page takes the browser prong rather than the
  // app's. Which prong it took is what the request for the module proves, and the app's own
  // bridge is not in this document at all.
  const plain = await browser.newPage();
  await plain.setViewport({ width: 1000, height: 800 });
  const plainUrls = [];
  plain.on('request', (request) => plainUrls.push(request.url()));
  await plain.goto(`http://127.0.0.1:${port}/src/launcher.html`, { waitUntil: 'domcontentloaded' });
  await plain.waitForSelector('.device-sync-button', { timeout: 30000 });
  await plain.click('.device-sync-button');
  await plain.waitForSelector('.device-sync-modal', { timeout: 30000 });
  await plain.waitForFunction(() => !document.querySelector('.device-sync-status')?.textContent?.includes('node-app'));
  await new Promise((done) => setTimeout(done, 1500));
  assert.ok(
    plainUrls.some((url) => url.endsWith('/src/launcher.wasm')),
    'a self-host page should reach for the wasm module, not the app bridge'
  );
  await plain.close();

  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (error) => errors.push(error.message));
  // The folder the app's engine already holds: one Lith only the peer has, which is the row
  // this list has to draw and the only way a pass can get one without a second machine.
  await page.evaluateOnNewDocument(bridge, undefined, {
    folder: [[foreignName, foreign]],
    disk: [[proofName, proof], [foreignName, foreign]]
  });
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });

  // One recent row of this device's own, with a path: the app reads it through its bridge,
  // which is what sending from a row is, and the file it names is the proof file on disk.
  await page.evaluate((row) => {
    localStorage.setItem('lithic-recent-liths', JSON.stringify([row]));
  }, { name: proofName, path: proofPath });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((wanted) => [...document.querySelectorAll('.recent-name')].some((node) => (node.textContent ?? '').includes(wanted)), POLL, proofName);

  // The circle is the app's, drawn from the mode and the page's own reachability.
  await page.waitForSelector('.device-sync-button', { timeout: 30000 });
  await page.click('.device-sync-button');
  await page.waitForSelector('.device-sync-modal', { timeout: 30000 });

  // The start: the node id the native engine answers with is what the panel shows.
  await page.waitForFunction(
    () => (document.querySelector('.device-sync-status')?.textContent ?? '').includes('node-app'),
    POLL
  );

  // The ticket comes from `device_sync_share`, not from a remembered local one.
  await page.click('.device-sync-ticket-show');
  await page.waitForFunction(
    () => (document.querySelector('.device-sync-ticket-read')?.value ?? '').length > 0,
    POLL
  );
  const ticket = await page.$eval('.device-sync-ticket-read', (node) => node.value);
  assert.equal(ticket, 'ticket-app');

  // Pairing sends the pasted ticket to Rust, whitespace taken out first.
  await page.type('.device-sync-ticket-join', '  ticket-from-other  ');
  await page.click('.device-sync-pair');
  await page.waitForFunction(() => window.__TAURI_STUB__.commands.some((call) => call.command === 'device_sync_join'), POLL);
  const joined = await page.evaluate(() => window.__TAURI_STUB__.commands.find((call) => call.command === 'device_sync_join').args);
  assert.deepEqual(joined, { ticket: 'ticket-from-other' }, 'the ticket crosses normalized');

  // The panel is the pairing and nothing else now, so the rows are behind it and the Liths
  // travel through them: shut it, and the list is what a person works from.
  await page.click('.device-sync-modal .modal-close');
  await page.waitForFunction(() => !document.querySelector('.device-sync-modal'));

  // Sending: the row's own mark, whose bytes come off this disk through the bridge. The row
  // is grey until the send lands and green after it, which is the state a paired person reads.
  const beforeSend = await page.$eval('.recent-row .device-row-button', (node) => node.classList.contains('shared'));
  assert.equal(beforeSend, false, 'the row should start unsent');
  await page.click('.recent-row .device-row-button');
  await page.waitForFunction(() => window.__TAURI_STUB__.commands.some((call) => call.command === 'device_sync_publish'), POLL);
  const published = await page.evaluate(() => {
    const stub = window.__TAURI_STUB__;
    const call = stub.commands.find((entry) => entry.command === 'device_sync_publish');
    const read = stub.commands.find((entry) => entry.command === 'read_lith_path');
    return {
      name: call.args.name,
      text: new TextDecoder().decode(stub.bytes.get(call.args.name)),
      readPath: read?.args?.path ?? null
    };
  });
  assert.equal(published.name, proofName);
  assert.equal(published.text, proof, 'the bytes that crossed the IPC are the file the row points at');
  assert.equal(published.readPath, proofPath, 'the bytes came off the disk through the app, not from the row');
  await page.waitForFunction(
    () => Boolean(document.querySelector('.recent-row .device-row-button.shared')),
    POLL
  );
  const sent = await page.$eval('.status-line', (node) => node.textContent ?? '');
  assert.ok(sent.includes(proofName), `the header reported the send: ${sent}`);

  // The panel's own line is the other half of the event surface, read by reopening it: the
  // engine's `seeded` event is what the bridge emitted, and the panel heard it.
  await page.click('.device-sync-button');
  await page.waitForSelector('.device-sync-modal', { timeout: 30000 });
  const activity = await page.$eval('.device-sync-activity', (node) => node.textContent ?? '');
  assert.ok(activity.includes(proofName), `the panel heard the engine's own event: ${activity}`);
  await page.click('.device-sync-modal .modal-close');
  await page.waitForFunction(() => !document.querySelector('.device-sync-modal'));

  // Loading: the Lith only the peer has is a row of its own, and its control fetches the
  // bytes and hands them to the app's own save, which is a file on disk rather than a
  // browser download. The row the save then records is this device's, so the device-only row
  // is gone and what took its place names the path Rust answered with.
  const deviceRow = await page.$$eval('.device-only-row .recent-name', (nodes) => nodes.map((node) => node.textContent ?? ''));
  assert.ok(deviceRow.some((text) => text.includes(foreignName)), `the peer's Lith should be a row of its own: ${JSON.stringify(deviceRow)}`);
  await page.click('.device-only-row .device-row-button');
  await page.waitForFunction(() => Boolean(window.__TAURI_STUB__.saved), POLL);
  const saved = await page.evaluate(() => window.__TAURI_STUB__.saved);
  assert.equal(saved.name, foreignName);
  assert.equal(saved.text, foreign, 'the copy is the same bytes the folder holds');
  const read = await page.evaluate(() => window.__TAURI_STUB__.commands.some((call) => call.command === 'device_sync_read'));
  assert.ok(read, 'loading a row should read the entry through the app');
  await page.waitForFunction(
    (wanted) => {
      const rows = [...document.querySelectorAll('.recent-row')];
      const mine = rows.find((row) => (row.textContent ?? '').includes(wanted) && !row.classList.contains('device-only-row'));
      return Boolean(mine) && !document.querySelector('.device-only-row');
    },
    POLL,
    foreignName
  );
  const ownRowPath = await page.evaluate((wanted) => {
    const rows = [...document.querySelectorAll('.recent-row')];
    const row = rows.find((node) => (node.textContent ?? '').includes(wanted));
    return row?.querySelector('.recent-name')?.getAttribute('title') ?? null;
  }, foreignName);
  assert.equal(ownRowPath, `/tmp/${foreignName}`, 'the loaded Lith should be recorded as the file the app wrote');

  assert.deepEqual(errors, [], 'the launcher threw on the page it was driven through');
  console.log('DEVICE SYNC NATIVE OK: the app page drew the circle, started the native engine, paired, sent a Lith from a recent row through the IPC, heard its own event, and loaded the peer\u2019s Lith into a row of its own.');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
}
