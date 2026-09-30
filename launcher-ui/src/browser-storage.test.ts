import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_ONLY_HISTORY_NOTE,
  BROWSER_ONLY_TOOLTIP,
  browserOnlyMarkTitle,
  rememberRowKind,
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
  // Neither one needs a picker (Rust writes the file, WebDAV writes the
  // server's copy) so a missing API there is not the launcher's problem.
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
  assert.match(title, /^recipes\.lith\. /);
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

// Both of these are read in a dialog and a tooltip, which is where the house rule about
// dashes matters most: an em dash between two clauses reads as editorializing and wraps
// badly, and the fix is a period and a new sentence. The rule is spelled out at the top of
// agents.md, and it is pinned here because the copy is prose somebody will re-tune.
test('neither the mark nor the dialog note reaches for a dash to join two clauses', () => {
  for (const copy of [BROWSER_ONLY_TOOLTIP, BROWSER_ONLY_HISTORY_NOTE]) {
    assert.doesNotMatch(copy, /[\u2013\u2014]/, `a dash in: ${copy}`);
  }
  // The claim leads with its own sentence rather than a dash: what it is, then what that
  // means, which is the shape the offline banner uses too.
  assert.match(BROWSER_ONLY_HISTORY_NOTE, /^Browser storage only\. This Lith has no file,/);
});

test('a declared browser mount never writes files, however capable the browser is', () => {
  // A shim serves the launcher from loopback and promises one data model, so a save that
  // landed in a Downloads folder would be the second copy of a Lith with no file.
  assert.equal(resolveStorageMode('webapp', picker, null, true), 'index-db');
  assert.equal(resolveStorageMode('webapp', {}, null, true), 'index-db');
  // The query is still the escape hatch, being how the fallback is exercised by hand.
  assert.equal(resolveStorageMode('webapp', picker, 'file', true), 'file');
  assert.equal(resolveStorageMode('webapp', picker, 'index-db', true), 'index-db');
  // Neither the app nor an instance is a browser mount, so neither is affected.
  assert.equal(resolveStorageMode('tauri', picker, null, true), 'file');
  assert.equal(resolveStorageMode('self-host', picker, null, true), 'file');
  // And a page that declared nothing keeps the platform's own answer.
  assert.equal(resolveStorageMode('webapp', picker, null, false), 'file');
});

test('a browser-only page never remembers a row built on a handle', () => {
  // The rule that stops a Chromium shim claiming a file: its picker hands files over as
  // handles, and every save in this mode goes to browser storage instead, so the row has to
  // be the browser-only one whatever the picker returned.
  assert.equal(rememberRowKind(true, true), 'browser-only');
  assert.equal(rememberRowKind(true, false), 'browser-only');
  // Away from a browser-only page a handle is what makes the row reopenable, and a name
  // with no handle is a row that can only be read back from the store.
  assert.equal(rememberRowKind(false, true), 'handle');
  assert.equal(rememberRowKind(false, false), 'plain');
});
