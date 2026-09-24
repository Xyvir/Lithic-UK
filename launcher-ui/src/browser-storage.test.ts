import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_ONLY_HISTORY_NOTE,
  BROWSER_ONLY_TOOLTIP,
  browserOnlyMarkTitle,
  resolveStorageMode,
  storageModeOverride,
  supportsFileAccessApi
} from './browser-storage.ts';

const picker = { showSaveFilePicker: () => Promise.reject(new Error('unused')) };

test('a browser with the File System Access API saves to files', () => {
  assert.equal(supportsFileAccessApi(picker), true);
  assert.equal(resolveStorageMode('webapp', picker), 'file');
});

test('a browser without it falls back to browser storage', () => {
  // Safari and Firefox: no showSaveFilePicker at all, or not a function.
  assert.equal(supportsFileAccessApi({}), false);
  assert.equal(supportsFileAccessApi(undefined), false);
  assert.equal(supportsFileAccessApi({ showSaveFilePicker: 'nope' }), false);
  assert.equal(resolveStorageMode('webapp', {}), 'index-db');
});

test('the desktop app and a self-host instance are never storage-only', () => {
  // Neither one needs a picker — Rust writes the file, WebDAV writes the
  // server's copy — so a missing API there is not the launcher's problem.
  assert.equal(resolveStorageMode('tauri', {}), 'file');
  assert.equal(resolveStorageMode('self-host', {}), 'file');
  assert.equal(resolveStorageMode('tauri', {}, 'index-db'), 'file');
});

test('the query parameter can force either mode, for testing on any browser', () => {
  assert.equal(resolveStorageMode('webapp', picker, 'index-db'), 'index-db');
  assert.equal(resolveStorageMode('webapp', picker, 'browser'), 'index-db');
  assert.equal(resolveStorageMode('webapp', picker, ' INDEX-DB '), 'index-db');
  assert.equal(resolveStorageMode('webapp', {}, 'file'), 'file');
  // Anything unrecognized leaves the platform's own answer alone.
  assert.equal(resolveStorageMode('webapp', {}, 'yes'), 'index-db');
  assert.equal(resolveStorageMode('webapp', picker, ''), 'file');
});

test('the override is read from the page URL', () => {
  assert.equal(storageModeOverride('?storage=index-db&mode=webapp'), 'index-db');
  assert.equal(storageModeOverride(''), null);
});

test('the mark says the copy is the only copy, and where to get a real one', () => {
  const title = browserOnlyMarkTitle('recipes.lith');
  assert.match(title, /^recipes\.lith — /);
  assert.match(title, /intrinsically volatile/);
  assert.match(title, /version history/);
  assert.match(BROWSER_ONLY_TOOLTIP, /hard copies/);
});

// The tooltip is a hover, so it is no use to a phone. This is the same claim where
// the download actually is, which is also the dialog the mark opens.
test('the history dialog says the same thing without a pointer to hover with', () => {
  assert.match(BROWSER_ONLY_HISTORY_NOTE, /no file/);
  assert.match(BROWSER_ONLY_HISTORY_NOTE, /only copy/);
  assert.match(BROWSER_ONLY_HISTORY_NOTE, /Download a version/);
  assert.doesNotMatch(BROWSER_ONLY_HISTORY_NOTE, /hard copies/);
});
