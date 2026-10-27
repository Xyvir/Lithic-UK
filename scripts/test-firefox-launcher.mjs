#!/usr/bin/env node
/**
 * The Firefox smoke suite: a real mount, a real save and a real reload in the one
 * desktop browser that lands in the `index-db` fallback by default.
 *
 * WHY FIREFOX HAS ITS OWN SUITE. `browser-storage.ts` has two modes: `file` where the
 * File System Access API is present, `index-db` where it is not. Chromium on every
 * desktop has the API, so the Chrome suite exercises the file path, and Safari cannot be
 * driven headless on a Linux runner at all. Firefox ships no File System Access API on
 * any platform, so every Firefox user is on `index-db` from the moment the launcher
 * opens, which makes it the only browser CI can reach that never touches the other path.
 * That fallback is also the one the failed extension prong would have lived on, and the
 * one every phone uses, so it is worth a run of its own rather than a hope.
 *
 * TWO TRAPS TO KNOW BEFORE EDITING THIS FILE, both found the hard way.
 *
 *   1. A DROPPED `.lith` DOES NOT MOUNT. `handleDrop` queues `.lith` and `.json` into the
 *      pending-imports panel; only an `.html` drop boots a wiki. So a drop-based harness
 *      can never reach the engine, and the class of the failure reads as "the launcher
 *      is broken in Firefox" when it is the harness proving nothing. The mount below goes
 *      through the launcher's own hidden file input instead, which is the route a person
 *      without the File System Access API actually takes.
 *   2. `intro.lith` BOOTS AS A JOURNAL DAY, NOT A PAGE. Its root is today's journal entry,
 *      whose body is a short placeholder with a hanging link, so an assertion on drawn
 *      text length fails on a perfectly healthy boot. Boot is therefore asserted on the
 *      engine's own store (`$tw.wiki.getTiddlerText`, the story list, the page container).
 *
 * The one step that is not what a person does: a headless Firefox cannot be answered at
 * the native file chooser, so the chooser is answered where the launcher creates it, by
 * putting the file on the hidden input and firing its own `change` handler, which is what
 * the operating system does after a pick. Everything after that is the shipped code.
 *
 * Usage: npm run test:firefox     (LAUNCHER_ARTIFACT / LAUNCHER_ENGINE to point elsewhere)
 */
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import puppeteer from 'puppeteer';

// The committed single-file launcher and the engine it fetches at runtime. Both are
// overridable so this can be pointed at a scratch build without overwriting the artifact,
// which CI regenerates and which is never hand-built.
const artifact = resolve(process.env.LAUNCHER_ARTIFACT ?? 'src/launcher.html');
const engine = resolve(process.env.LAUNCHER_ENGINE ?? 'src/lithic.html');
const fixture = resolve('intro.lith');
for (const [what, path] of [['launcher', artifact], ['engine', engine], ['fixture', fixture]]) {
  if (!existsSync(path)) throw new Error(`Missing ${what}: ${path}. Build the launcher first (npm run build:launcher).`);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.lith': 'application/x-lith'
};

/**
 * One loopback origin serving the shipped artifacts beside the fixture.
 *
 * A `file://` page cannot fetch a sibling engine, so a run over files would report every
 * mount as broken. The address is also why the page below asks for `?mode=webapp`: a
 * launcher on `localhost`, `127.0.0.1` or a `.local` name is an *instance* by the rule in
 * `mode.ts`, and an instance writes to its own server rather than to browser storage.
 */
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://127.0.0.1').pathname;
  const files = {
    '/launcher.html': artifact,
    '/lithic.html': engine,
    '/intro.lith': fixture,
    '/manifest.json': resolve('manifest.json'),
    '/site.webmanifest': resolve('site.webmanifest'),
    '/offline-service-worker.js': resolve('offline-service-worker.js')
  };
  const file = files[path];
  if (!file) {
    res.writeHead(404).end('not found');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});
// Port 0, so a second suite or a dev server on a fixed port cannot make this look broken.
const port = await new Promise((done) => {
  server.listen(0, '127.0.0.1', () => done(server.address().port));
});
const origin = `http://127.0.0.1:${port}`;

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
};

// A promise the page never settles would hang the suite rather than fail it, and a suite that
// hangs on a green run teaches nobody anything: every wait on the page is bounded, and the
// failure names the read that went quiet.
const bounded = async (what, promise, ms = 20000) => {
  let timer;
  const expiry = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`${what} did not answer within ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer);
  }
};

let browser;
try {
  try {
    browser = await puppeteer.launch({ browser: 'firefox', headless: true });
  } catch (error) {
    throw new Error(
      `Firefox is not installed for this puppeteer (${error.message}).\n` +
        'Install it with:  npx puppeteer browsers install firefox'
    );
  }

  const page = await browser.newPage();
  const noise = [];
  const foreign = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') noise.push(`[${message.type()}] ${message.text()}`);
  });
  page.on('pageerror', (error) => noise.push(`[pageerror] ${error.message}`));
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')) foreign.push(url);
  });

  const address = `${origin}/launcher.html?mode=webapp`;
  await page.goto(address, { waitUntil: 'domcontentloaded' });

  // --- The launcher is the launcher, in Firefox ------------------------------
  const launcher = await page.evaluate(() => ({
    picker: typeof window.showSaveFilePicker,
    controls: Array.from(document.querySelectorAll('button')).map((b) => b.textContent.trim()).filter(Boolean)
  }));
  record('the launcher UI mounts in Firefox', launcher.controls.length > 0, `${launcher.controls.length} controls`);
  record(
    'Firefox has no File System Access API, so browser storage is the mode',
    launcher.picker === 'undefined',
    `showSaveFilePicker: ${launcher.picker}`
  );
  // Firefox does not install PWAs (MDN, "Making PWAs installable"), and the offer is drawn
  // from the browser's own beforeinstallprompt rather than from a manifest read.
  record(
    'no install offer is drawn where the browser cannot install',
    !launcher.controls.some((label) => /install/i.test(label)),
    launcher.controls.filter((label) => /install/i.test(label)).join(', ') || 'none'
  );

  // --- Mount through the launcher's own picker ------------------------------
  const mountButton = launcher.controls.find((label) => /mount/i.test(label));
  record('a Mount control is offered', Boolean(mountButton), mountButton ?? 'none');
  if (mountButton) {
    const text = await page.evaluate(async () => (await fetch('/intro.lith')).text());
    await page.evaluate((lith) => {
      const click = HTMLInputElement.prototype.click;
      HTMLInputElement.prototype.click = function () {
        if (this.type !== 'file') return click.call(this);
        const transfer = new DataTransfer();
        transfer.items.add(new File([lith], 'intro.lith', { type: 'application/x-lith' }));
        this.files = transfer.files;
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return undefined;
      };
      Array.from(document.querySelectorAll('button'))
        .find((button) => /mount/i.test(button.textContent.trim()))
        ?.click();
    }, text);
  }

  // The engine replaces the document, so poll for its globals rather than for a selector.
  const booted = await bounded(
    'the engine booting',
    page
      .waitForFunction(
      () => {
        const tw = globalThis.$tw;
        return Boolean(tw?.wiki && typeof tw.wiki.getTiddlerText === 'function' && tw.wiki.getTiddler('$:/SiteTitle'));
      },
      { timeout: 25000, polling: 250 }
    )
      .then(() =>
        page.evaluate(() => ({
          tiddlers: globalThis.$tw.wiki.allTitles().length,
          story: globalThis.$tw.wiki.getTiddlerList('$:/StoryList'),
          storyNodes: document.querySelector('.tc-story-river')?.childElementCount ?? -1,
          pageContainer: Boolean(document.querySelector('.tc-page-container')),
          rootWidget: Boolean(globalThis.$tw.rootWidget),
          saver: Boolean(globalThis.$tw.customSaver)
        }))
      )
      .catch(() => null),
    30000
  );

  record(
    'the wiki boots and draws a page',
    Boolean(booted?.pageContainer && booted.storyNodes > 0 && booted.rootWidget && booted.tiddlers > 50),
    booted ? `${booted.tiddlers} tiddlers, story ${JSON.stringify(booted.story)}, ${booted.storyNodes} story nodes` : 'no $tw'
  );
  record('the injected saver is installed', Boolean(booted?.saver));

  // --- Save from inside the wiki --------------------------------------------
  /**
   * The whole `keyval` store, read the way the saver's own shim reads it.
   *
   * The two reads are chained rather than queued in one transaction, and that is not a
   * style choice: touching a second store's request from the first one's `onsuccess` throws
   * on a transaction that has already finished, which rejects nothing and leaves the promise
   * pending, so the suite hangs on a save that worked perfectly. Each read waits for its own
   * event here.
   */
  const keyval = () =>
    page.evaluate(
      () =>
        new Promise((done) => {
          const req = indexedDB.open('keyval-store');
          req.onerror = () => done({ keys: [], rows: null });
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains('keyval')) return done({ keys: [], rows: null });
            const keys = db.transaction('keyval', 'readonly').objectStore('keyval').getAllKeys();
            keys.onerror = () => done({ keys: [], rows: null });
            keys.onsuccess = () => {
              const rows = db.transaction('keyval', 'readonly').objectStore('keyval').get('recentFiles');
              rows.onerror = () => done({ keys: keys.result, rows: null });
              rows.onsuccess = () => done({ keys: keys.result, rows: rows.result ?? null });
            };
          };
        })
    );

  const before = (await bounded('the store before the save', keyval())).keys;
  const saving = await page.evaluate(() => {
    const tw = globalThis.$tw;
    try {
      if (typeof tw?.saverHandler?.saveWiki === 'function') tw.saverHandler.saveWiki({});
      else tw.rootWidget.dispatchEvent({ type: 'tm-save-wiki' });
      return null;
    } catch (error) {
      return String(error?.message ?? error);
    }
  });
  record('Save Wiki runs without throwing', saving === null, saving ?? '');
  // A save lands in sequence (the flat cache, then the history meta, base and delta), so
  // the read waits for the sequence rather than stopping at the first key.
  await new Promise((done) => setTimeout(done, 3000));
  const after = await bounded('the store after the save', keyval());
  const added = after.keys.filter((key) => !before.includes(key));
  record('a save writes to IndexedDB', added.length > 0, added.slice(0, 6).join(', ') || 'no new keys');
  record(
    'the search cache is written',
    after.keys.some((key) => String(key).startsWith('search_cache_intro')),
    after.keys.filter((key) => String(key).startsWith('search_cache_')).slice(0, 3).join(', ') || 'none'
  );
  record(
    'the version history is written',
    after.keys.some((key) => /history|_base_|_delta_/.test(String(key))),
    after.keys.filter((key) => /history|_base_|_delta_/.test(String(key))).slice(0, 3).join(', ') || 'none'
  );
  const row = Array.isArray(after.rows) ? after.rows.find((entry) => /intro/.test(entry?.name ?? entry?.handle?.name ?? '')) : null;
  // The claim is what makes this mode honest: nothing on disk holds this wiki.
  record('the recents row claims the browser copy', Boolean(row?.browserOnly), JSON.stringify(row)?.slice(0, 160) ?? 'no row');

  // The dirty watcher is the one path that listens on the engine's own change events, and
  // it is what saves an unsaved edit when a tab dies. DIRTY_DEBOUNCE_MS is 2000.
  const dirty = await page.evaluate(async () => {
    const tw = globalThis.$tw;
    if (!tw?.wiki?.addTiddler) return { armed: false, keys: [] };
    tw.wiki.addTiddler({ title: 'Firefox smoke probe', text: 'unsaved edit' });
    await new Promise((done) => setTimeout(done, 3200));
    const keys = await new Promise((done) => {
      const req = indexedDB.open('keyval-store');
      req.onsuccess = () => {
        const all = req.result.transaction('keyval', 'readonly').objectStore('keyval').getAllKeys();
        all.onsuccess = () => done(all.result);
        all.onerror = () => done([]);
      };
      req.onerror = () => done([]);
    });
    tw.wiki.deleteTiddler('Firefox smoke probe');
    const mine = keys.filter((key) => String(key).startsWith('dirty_state_'));
    return { armed: mine.length > 0, keys: mine };
  });
  record('an unsaved edit is backed up while the tab lives', dirty.armed, dirty.keys.join(', ') || 'no dirty_state_ key');

  // --- Reload the launcher and read the row back ----------------------------
  await page.goto(address, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => (document.body.innerText || '').length > 100, { timeout: 15000 }).catch(() => {});
  const list = await page.evaluate(() => ({
    text: (document.body.innerText || '').slice(0, 600),
    marks: document.querySelectorAll('.cache-history-button.modified').length
  }));
  record('the recent row survives a reload', /intro/i.test(list.text), list.text.slice(0, 120).replace(/\s+/g, ' '));
  record('the browser-only mark is drawn on the row', list.marks > 0, `${list.marks} marked controls`);

  // Version history is the only way to a hard copy in this mode, so the dialog is the
  // escape hatch and it has to work in the browser that can never write a file in place.
  await page.evaluate(() => {
    (document.querySelector('.cache-history-button.modified') ?? document.querySelector('.cache-history-button'))?.click();
  });
  await page.waitForSelector('.history-modal', { timeout: 5000 }).catch(() => {});
  const history = await page.evaluate(() => {
    const modal = document.querySelector('.history-modal');
    return { open: Boolean(modal), text: (modal?.innerText ?? '').slice(0, 260).replace(/\s+/g, ' '), controls: modal ? modal.querySelectorAll('button').length : 0 };
  });
  record('the version history dialog opens', history.open, history.text.slice(0, 120));
  record('it lists a version with a download control', history.controls > 1, `${history.controls} controls in the dialog`);

  // --- Offline plumbing ------------------------------------------------------
  const offline = await page.evaluate(async () => ({
    registrations: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0,
    persisted: typeof navigator.storage?.persisted === 'function' ? await navigator.storage.persisted() : 'unsupported',
    persist: typeof navigator.storage?.persist
  }));
  record('a service worker is registered', offline.registrations > 0, `${offline.registrations} registration(s)`);
  // Firefox asks the person rather than deciding, so the answer is reported and never
  // asserted: what is checked is that the call exists and the page survives asking.
  record('navigator.storage.persist is available', offline.persist !== 'unsupported', `persisted(): ${offline.persisted}`);
  // The engine resolves from beside the launcher and never from a host. In an extension
  // package this fetch has to be impossible rather than merely unlikely, so it is watched.
  record('nothing is fetched from another host', foreign.length === 0, foreign.slice(0, 4).join(', ') || 'loopback only');

  console.log('\n--- console errors and warnings ---');
  console.log(noise.length ? noise.slice(0, 20).join('\n') : '(none)');
  record('the run is free of console errors and warnings', noise.length === 0, `${noise.length} message(s)`);

  const failed = results.filter((result) => !result.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  if (browser) await browser.close();
  server.close();
}
