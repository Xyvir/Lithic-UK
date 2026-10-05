#!/usr/bin/env node
/**
 * Device sync, driven through the built launcher in a real browser.
 *
 * This is the proof that the Svelte side actually drives the wasm engine: not that the
 * crate syncs (its own smoke script proves that in Node), but that the shipped
 * `src/launcher.html` plus the shipped `src/launcher.wasm` can pair two browsers, move a
 * Lith from one recent list to the other, and compare the bytes at the end.
 *
 * The Lith travels through the recent list and nothing else, which is the shape the feature
 * settled into: the panel pairs and says nothing about files, the row a device has and this
 * one does not is drawn as a row of its own, and the row's own mark is what sends and what
 * loads. There is no picker anywhere in either half.
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
 * Exit 0 = paired, sent from one device's row, loaded back through the other's, byte for byte.
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

/** The body of the header's line, which is where a row's own answer lands. */
async function statusLine(page) {
  return page.$eval('.status-line', (node) => node.textContent ?? '').catch(() => '');
}

/**
 * A row for a Lith the devices hold and this page does not, once it is drawn.
 *
 * The row is the whole of the load half: it exists because the folder holds a name the
 * recent list does not, and its control is what fetches the bytes.
 */
async function waitForDeviceRow(page, name) {
  await page.waitForFunction(
    (wanted) => [...document.querySelectorAll('.device-only-row .recent-name')].some((node) => (node.textContent ?? '').includes(wanted)),
    POLL,
    name
  );
}

/** Whether the row for this name is drawn as already on the devices. */
async function rowShared(page, name) {
  return page.evaluate((wanted) => {
    const rows = [...document.querySelectorAll('.recent-row')];
    const row = rows.find((node) => (node.textContent ?? '').includes(wanted));
    const button = row?.querySelector('.device-row-button');
    return Boolean(button?.classList.contains('shared'));
  }, name);
}

/** One page, opened the way this pass needs it: its own viewport, its own errors. */
async function newPage(context, url, errors, label) {
  const page = await context.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return page;
}

/**
 * One recent row, handed to the launcher the way a Lith this page created and never saved
 * is: a name and its own text. That is the simplest row with bytes in it, and the only one a
 * browser context can be given without a file picker, which is exactly what this pass is
 * about (the picker is gone from both halves now).
 */
async function seedOwnRow(page, row) {
  await page.evaluate((seeded) => {
    localStorage.setItem('lithic-recent-liths', JSON.stringify([seeded]));
  }, row);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction((wanted) => [...document.querySelectorAll('.recent-name')].some((node) => (node.textContent ?? '').includes(wanted)), POLL, row.name);
}

/** One panel, opened the way a person opens it. */
async function openPanel(page) {
  await page.waitForSelector('.device-sync-button', { timeout: 30000 });
  await page.click('.device-sync-button');
  await page.waitForSelector('.device-sync-modal');
  return page;
}

/** Close it, because the rows a person then presses are behind it. */
async function closePanel(page) {
  await page.click('.device-sync-modal .modal-close');
  await page.waitForFunction(() => !document.querySelector('.device-sync-modal'));
}

const scratch = mkdtempSync(join(tmpdir(), 'lithic-device-sync-'));
const downloads = join(scratch, 'downloads');
const proofName = 'devicesync-proof.lith';
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
  mkdirSync(downloads, { recursive: true });

  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${server.address().port}/src/launcher.html?mode=webapp`;

  // A is the separate context and B is the default one, which is not arbitrary: the
  // download at the end is B's, and Chrome refuses one from an incognito-like context
  // whatever `Browser.setDownloadBehavior` says. Two storages is what makes two devices,
  // so the pair is one of each rather than both in the default one.
  const deviceA = await newPage(await browser.createBrowserContext(), url, errors, 'device A');
  await seedOwnRow(deviceA, { name: proofName, text: proof });
  const deviceB = await newPage(browser.defaultBrowserContext(), url, errors, 'device B');

  // A recent list with nothing in it, and nothing on it: the row B will show comes from the
  // devices and from nowhere else, so the pull at the end is the only way the bytes reach it.
  assert.equal(
    await deviceB.$$eval('.recent-row', (rows) => rows.length),
    0,
    'device B should start with no rows at all'
  );

  // Pairing: A shows a ticket, B pastes it. The ticket is the whole handshake, so its
  // presence is also the proof that the engine loaded and reached the relay at all.
  await openPanel(deviceA);
  await deviceA.click('.device-sync-ticket-show');
  const ticket = await fieldValue(deviceA, '.device-sync-ticket-read');
  assert.match(ticket, /^\S{40,}$/, `a ticket came back minted: ${ticket.slice(0, 24)}…`);
  await closePanel(deviceA);

  await openPanel(deviceB);
  await deviceB.type('.device-sync-ticket-join', ticket);
  await deviceB.click('.device-sync-pair');
  await closePanel(deviceB);

  // Sending: the row's own mark publishes the Lith this page holds and the folder does not.
  // The row is grey before the press and green after it, which is the one thing a paired
  // person reads off the list.
  assert.equal(await rowShared(deviceA, proofName), false, 'A has not sent its Lith yet');
  await deviceA.click('.recent-row .device-row-button');
  await deviceA.waitForFunction(
    (wanted) => (document.querySelector('.status-line')?.textContent ?? '').includes(wanted),
    POLL,
    proofName
  );
  const sent = await statusLine(deviceA);
  assert.ok(sent.includes(proofName), `A reported its own send: ${sent}`);
  await deviceA.waitForFunction(
    (wanted) => [...document.querySelectorAll('.recent-row')].some((row) => (row.textContent ?? '').includes(wanted) && row.querySelector('.device-row-button.shared')),
    POLL,
    proofName
  );

  // The other device: the entry arrives, and so does the event that says another device wrote
  // it. The row is what says so, and the panel's own activity line is the other half of the
  // surface, read by reopening the panel the event refreshed behind.
  await waitForDeviceRow(deviceB, proofName);
  await openPanel(deviceB);
  await deviceB.waitForFunction(
    (wanted) => (document.querySelector('.device-sync-activity')?.textContent ?? '').includes(wanted),
    POLL,
    proofName
  );
  await closePanel(deviceB);

  // And the bytes themselves: B loads the Lith from its device row, and the file that lands
  // is compared with what A published. A read that was still downloading would be an error
  // here rather than a file, which is the retry the driver does.
  const client = await deviceB.createCDPSession();
  await client.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads, eventsEnabled: true });
  await deviceB.click('.device-only-row .device-row-button');

  const landed = join(downloads, proofName);
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

  console.log('DEVICE SYNC OK: two contexts paired over the relay, one row sent the Lith, the other device drew a row for it and loaded it back byte for byte.');
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
  rmSync(scratch, { recursive: true, force: true });
}
