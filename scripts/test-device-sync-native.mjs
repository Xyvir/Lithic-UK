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
 * What this proves: the heading draws the circle on the app and not on a plain page, the
 * driver takes the native transport (`device_sync_*` commands, base64 bytes, the app's own
 * event) instead of the wasm module, publishing hands the file's exact bytes over the IPC,
 * the event Rust emits lands in the panel and refreshes its list, and a copy is saved
 * through the app's own save command rather than a browser download.
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
function bridge() {
  const state = {
    commands: [],
    entries: [],
    bytes: new Map(),
    saved: null,
    listener: null,
    nodeId: 'node-app',
    ticket: 'ticket-app'
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
          case 'device_sync_publish': {
            const bytes = decode(args.bytes);
            state.bytes.set(args.name, bytes);
            state.entries = [
              ...state.entries,
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
const proof = ['title: Native Proof', 'type: text/vnd.tiddlywiki', '', 'published through the app bridge', ''].join('\n');

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

  // The negative control: the same launcher on an address that is not the app's draws no
  // device-sync circle at all, however much the page could run were it the app.
  const plain = await browser.newPage();
  await plain.setViewport({ width: 1000, height: 800 });
  await plain.goto(`http://127.0.0.1:${port}/src/launcher.html`, { waitUntil: 'domcontentloaded' });
  await plain.waitForSelector('.heading-actions', { timeout: 30000 });
  assert.equal(await plain.$('.device-sync-button'), null, 'a plain page should draw no device-sync circle');
  await plain.close();

  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.evaluateOnNewDocument(bridge);
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });

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

  // Publishing: the picked file's bytes cross the IPC base64, and the entry the bridge
  // adds arrives because the event told the panel to read the list again.
  const picker = await page.$('.device-sync-file');
  await picker.uploadFile(proofPath);
  await page.waitForFunction(
    () => document.querySelectorAll('.device-sync-entry-name').length > 0,
    POLL
  );
  const published = await page.evaluate(() => {
    const stub = window.__TAURI_STUB__;
    const call = stub.commands.find((entry) => entry.command === 'device_sync_publish');
    const write = new TextDecoder().decode(stub.bytes.get(call.args.name));
    return { name: call.args.name, text: write, call };
  });
  assert.equal(published.name, 'native-proof.lith');
  assert.equal(published.text, proof, 'the bytes that crossed the IPC are the file that was picked');
  const activity = await page.$eval('.device-sync-activity', (node) => node.textContent ?? '');
  assert.ok(activity.includes('native-proof.lith'), `the panel heard the engine's own event: ${activity}`);

  // Saving a copy is the app's save, not a browser download: Rust names the file and the
  // panel reports the same sentence every other save does.
  await page.click('.device-sync-save');
  await page.waitForFunction(
    () => Boolean(window.__TAURI_STUB__.saved),
    POLL
  );
  const saved = await page.evaluate(() => window.__TAURI_STUB__.saved);
  assert.equal(saved.name, 'native-proof.lith');
  assert.equal(saved.text, proof, 'the copy is the same bytes the folder holds');
  await page.waitForFunction(
    () => (document.querySelector('.device-sync-note.ok')?.textContent ?? '').includes('native-proof.lith'),
    POLL
  );

  assert.deepEqual(errors, [], 'the launcher threw on the page it was driven through');
  console.log('DEVICE SYNC NATIVE OK: the app page drew the circle, started the native engine, paired, published through the IPC, heard its own event, and saved a copy through the app.');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
}
