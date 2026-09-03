import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const preLauncherHtml = readFileSync('src/pre-launcher.html', 'utf8');
const testHtmlPath = resolve('src/test-prelauncher-e2e.html');
const profileDir = resolve('scratch/chrome-test-profile-e2e');

// Drive everything from the Puppeteer side: mounting a wiki boots the engine
// in-place via document.open/write/close, which destroys any harness script
// injected into the launcher page. Page context swaps mid-flow, so wait by
// polling evaluate() (tolerating temporary context destruction) instead of
// injecting an in-page driver.
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security'],
  defaultViewport: { width: 900, height: 700 }
});

async function poll(fn, what, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastErr = error; // execution context destroyed mid-boot etc.
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for ${what}${lastErr ? ` (last: ${lastErr.message})` : ''}`);
}

try {
  writeFileSync(testHtmlPath, preLauncherHtml, 'utf8');

  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(`file:///${testHtmlPath.replace(/\\/g, '/')}`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000
  });

  // 1. Launcher is hydrated.
  const typedName = 'E2E Blank ' + Date.now();
  await poll(
    () => page.evaluate(() => {
      const btn = [...document.querySelectorAll('.launcher-actions button')]
        .find(button => button.textContent?.includes('New Blank Lith'));
      if (!btn) return false;
      btn.click();
      return true;
    }),
    'the New Blank Lith button'
  );

  // 2. Name the new lith and confirm.
  await poll(
    () => page.evaluate((name) => {
      const input = document.querySelector('input[aria-label="Lith file name"]');
      if (!input) return false;
      input.value = name;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    }, typedName),
    'the lith naming input'
  );

  // 3. The engine boots in-place (document swap). Wait for $tw + customSaver.
  const booted = await poll(
    () => page.evaluate(() =>
      !!(window.$tw && window.$tw.wiki && window.$tw.saverHandler &&
         window.$tw.rootWidget && window.$tw.customSaver)),
    'the booted wiki with the custom saver registered'
  );
  assert.ok(booted);

  // 4. Install the picker mock, add a tiddler, and save.
  await page.evaluate(() => {
    window.__E2E_SAVER_LOGS__ = [];
    window.showSaveFilePicker = async function(options) {
      window.__E2E_SAVER_LOGS__.push({ event: 'showSaveFilePicker', options });
      return {
        name: options.suggestedName || 'new.lith',
        createWritable: async function() {
          return {
            write: async function(data) {
              window.__E2E_SAVER_LOGS__.push({
                event: 'write',
                dataSnippet: data.slice(0, 300),
                dataLength: data.length,
                dataHasJournalNote: data.includes('E2E Journal Note'),
                dataHasE2ETag: data.includes('E2ETag')
              });
            },
            close: async function() {
              window.__E2E_SAVER_LOGS__.push({ event: 'close' });
            }
          };
        }
      };
    };
  });

  await page.evaluate(() => {
    window.$tw.wiki.addTiddler(new window.$tw.Tiddler({
      title: "E2E Journal Note",
      text: "Testing full modular launcher save as flow",
      tags: ["E2ETag"]
    }));
    window.$tw.rootWidget.dispatchEvent({ type: "tm-save-wiki" });
  });

  const logs = await poll(
    () => page.evaluate(() =>
      (window.__E2E_SAVER_LOGS__ && window.__E2E_SAVER_LOGS__.length >= 3)
        ? window.__E2E_SAVER_LOGS__
        : null),
    'the save to reach the mock file picker'
  );

  const result = await page.evaluate(() => ({
    hasCustomSaver: !!(window.$tw && window.$tw.customSaver),
    savers: (window.$tw.saverHandler.savers || []).map(s => ({ name: s.info.name, priority: s.info.priority })),
    typedName: JSON.parse(sessionStorage.getItem('lithic-active-file') || 'null')?.name || null
  }));

  console.log('E2E Pre-Launcher Test Results:\n', JSON.stringify(result, null, 2));

  assert.equal(result.hasCustomSaver, true);
  const customSaver = result.savers.find(s => s.name === 'custom');
  assert.ok(customSaver, 'Custom saver was registered');
  assert.equal(customSaver.priority, 4000);

  assert.equal(logs.length, 3);
  assert.equal(logs[0].event, 'showSaveFilePicker');
  assert.equal(logs[0].options.suggestedName, typedName + '.lith', 'the name from the launcher prompt reaches the save picker');
  assert.deepEqual(logs[0].options.types[0].accept, { 'application/x-lith': ['.lith'] });
  assert.equal(logs[1].event, 'write');
  assert.ok(logs[1].dataHasJournalNote, 'write payload contains the added tiddler');
  assert.ok(logs[1].dataHasE2ETag, 'write payload contains the added tiddler tags');
  assert.equal(logs[2].event, 'close');

  // The custom saver registered and the save reached the picker means the
  // injected bootstrap parsed cleanly (a syntax error there would have
  // prevented $tw.customSaver from ever being set).
  assert.deepEqual(pageErrors.filter(text =>
    !text.includes('Failed to load resource') &&
    !text.includes('ERR_FILE_NOT_FOUND') &&
    !text.includes('Access to manifest')
  ), []);

  console.log('\n✔ E2E Pre-Launcher Save-As Parity Test Passed!');
} finally {
  await browser.close();
  unlinkSync(testHtmlPath);
}
