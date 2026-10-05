#!/usr/bin/env node
/**
 * Device sync, driven through the built launcher in a real browser.
 *
 * This is the proof that the Svelte side actually drives the wasm engine: not that the
 * crate syncs (its own smoke script proves that in Node), but that the shipped
 * `src/launcher.html` plus the shipped `src/launcher.wasm` can pair two browsers through
 * the panel and move a Lith between them, with the bytes compared at the end.
 *
 * Two browser *contexts*, not two tabs. Contexts are separate storages, which is what
 * makes them two devices: two tabs of one browser share IndexedDB, so the second tab
 * would load the first tab's identity and its ticket and there would be nothing to pair.
 *
 * Served over http on 127.0.0.1, which `resolveMode` reads as an instance, so both pages
 * are opened with `?mode=webapp`: the PWA is the prong that draws the device-sync control.
 *
 * Needs the two built artifacts, and a network: the pairing goes over the public relay,
 * because a browser has no direct address to dial. Run it with the launcher and the engine
 * built first:
 *
 *   node scripts/build-launcher.mjs
 *   sync/scripts/build-wasm-launcher.sh
 *   node scripts/test-device-sync.mjs
 *
 * A machine without Puppeteer's own download points it at the browser it has:
 *
 *   PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium node scripts/test-device-sync.mjs
 *
 * Exit 0 = paired, published, pulled, and the downloaded bytes match what was published.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import puppeteer from 'puppeteer';

const root = process.cwd();
const artifact = resolve(root, 'src/launcher.html');
const engine = resolve(root, 'src/launcher.wasm');

assert.ok(existsSync(artifact), `build the launcher first: ${artifact} is missing`);
assert.ok(existsSync(engine), `build the engine first: ${engine} is missing (sync/scripts/build-wasm-launcher.sh)`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/** The repository as a static server: the launcher, its engine, and the wiki it mounts. */
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

const POLL = { polling: 250, timeout: 120000 };

/** The value of a field once it has one, because a ticket is minted after a relay wait. */
async function fieldValue(page, selector, timeout = 120000) {
  await page.waitForFunction(
    (found) => (document.querySelector(found)?.value ?? '').length > 20,
    { polling: 250, timeout },
    selector
  );
  return page.$eval(selector, (node) => node.value);
}

/** The name of the entry a page's panel lists, once it lists it. */
async function waitForEntry(page, name) {
  await page.waitForFunction(
    (wanted) => [...document.querySelectorAll('.device-sync-entry-name')].some((node) => node.textContent === wanted),
    POLL,
    name
  );
}

/** The panel's last-activity line, once one of the two pages has moved something. */
async function waitForActivity(page, includes) {
  await page.waitForFunction(
    (wanted) => (document.querySelector('.device-sync-activity')?.textContent ?? '').includes(wanted),
    POLL,
    includes
  );
}

/** One panel, opened the way a person opens it, with this page's errors collected. */
async function openPanel(context, url, errors, label) {
  const page = await context.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.device-sync-button', { timeout: 30000 });
  await page.click('.device-sync-button');
  await page.waitForSelector('.device-sync-modal');
  return page;
}

const scratch = mkdtempSync(join(tmpdir(), 'lithic-device-sync-'));
const downloads = join(scratch, 'downloads');
const proofPath = join(scratch, 'devicesync-proof.lith');
// A body with a title so the file is one the wiki could open, and bytes that differ from
// its own name so a download that answered with the wrong entry would not match.
const proof = ['title: Sync Proof', 'type: text/vnd.tiddlywiki', '', 'published by device A', ''].join('\n');

const server = staticServer(root);
const browser = await puppeteer.launch({
  headless: process.env.HEADED === '1' ? false : 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  defaultViewport: { width: 1000, height: 800 }
});
const errors = [];

try {
  writeFileSync(proofPath, proof, 'utf8');
  mkdirSync(downloads, { recursive: true });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/src/launcher.html?mode=webapp`;

  // A is the separate context and B is the default one, which is not arbitrary: the
  // download at the end is B's, and Chrome refuses one from an incognito-like context
  // whatever `Browser.setDownloadBehavior` says. Two storages is what makes two devices,
  // so the pair is one of each rather than both in the default one.
  const deviceA = await openPanel(await browser.createBrowserContext(), url, errors, 'device A');
  const deviceB = await openPanel(browser.defaultBrowserContext(), url, errors, 'device B');

  // Pairing: A shows a ticket, B pastes it. The ticket is the whole handshake, so its
  // presence is also the proof that the engine loaded and reached the relay at all.
  await deviceA.click('.device-sync-ticket-show');
  const ticket = await fieldValue(deviceA, '.device-sync-ticket-read');
  assert.match(ticket, /^\S{40,}$/, `a ticket came back minted: ${ticket.slice(0, 24)}…`);

  await deviceB.type('.device-sync-ticket-join', ticket);
  await deviceB.click('.device-sync-pair');

  // Publishing: the picked file goes to the folder, and A's own list answers with it.
  const picker = await deviceA.$('.device-sync-file');
  await picker.uploadFile(proofPath);
  await waitForEntry(deviceA, 'devicesync-proof.lith');
  const published = await deviceA.$eval('.device-sync-note.ok', (node) => node.textContent ?? '');
  assert.ok(published.includes('devicesync-proof.lith'), `A reported its own publish: ${published}`);

  // The other device: the entry arrives, and so does the event that says another device
  // wrote it. This is the subscribe half of the surface, read from the panel's own line.
  await waitForEntry(deviceB, 'devicesync-proof.lith');
  await waitForActivity(deviceB, 'devicesync-proof.lith');

  // And the bytes themselves: B saves a copy, and the file that lands is compared with
  // what A published. A read that was still downloading would be an error here rather
  // than a file, which is the retry the driver does.
  const client = await deviceB.createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  await deviceB.click('.device-sync-save');

  const landed = join(downloads, 'devicesync-proof.lith');
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (existsSync(landed)) break;
    await sleep(250);
  }
  assert.ok(existsSync(landed), `B handed the Lith to the browser: ${landed} never appeared`);
  assert.equal(await readFile(landed, 'utf8'), proof, 'the bytes B saved are the bytes A published');

  // Nothing above is allowed to have been a broken page underneath: an error thrown in the
  // launcher while pairing would not stop the archive from arriving over the network.
  assert.deepEqual(errors, [], 'the launcher threw on the page it was driven through');

  console.log('DEVICE SYNC OK: two contexts paired over the relay, published one Lith, pulled it back byte for byte.');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
}
