import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BROWSER_ONLY_HISTORY_NOTE,
  BROWSER_ONLY_TOOLTIP,
  browserOnlyMarkTitle,
  isIosDevice,
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

test('a platform with files of its own is never storage-only, whatever the host reports', () => {
  // Neither one needs a picker (Rust writes the file, WebDAV writes the
  // server's copy) so a missing API there is not the launcher's problem.
  assert.equal(resolveStorageMode('tauri', {}), 'file');
  assert.equal(resolveStorageMode('self-host', {}), 'file');
  assert.equal(resolveStorageMode('tauri', {}, 'index-db'), 'file');
});

test('a process that cannot hold a document falls back to browser storage, app or not', () => {
  // No platform this app ships to answers `Capabilities::local_files` with false any more, but
  // the branch stays because the answer is the process's and not this file's assumption: a build
  // whose own picker and write cannot place a document keeps the document in browser storage,
  // exactly as a browser with no File System Access API does.
  assert.equal(resolveStorageMode('tauri', picker, null, false), 'index-db');
  assert.equal(resolveStorageMode('tauri', picker, undefined, false), 'index-db');
  // A self-host instance is the same shape of answer: no local files, no file saves.
  assert.equal(resolveStorageMode('self-host', picker, null, false), 'index-db');
  // The browser's own answers are untouched, having never had a file to lose.
  assert.equal(resolveStorageMode('webapp', picker, null, false), 'file');
  assert.equal(resolveStorageMode('webapp', {}, null, false), 'index-db');
  // And a process with documents is unchanged, which is what the default is for.
  assert.equal(resolveStorageMode('tauri', {}, null), 'file');
  assert.equal(resolveStorageMode('tauri', {}, null, true), 'file');
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

test('the one platform read separates an iPhone from the Mac in the same fallback', () => {
  const phone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const ipadDesktopUa = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  const macSafari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
  const windowsChrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

  assert.equal(isIosDevice(phone, 'iPhone', 5), true);
  // An iPad reports a Macintosh agent and asks for the desktop site, so the touch points
  // are the only half that catches it.
  assert.equal(isIosDevice(ipadDesktopUa, 'MacIntel', 5), true);
  assert.equal(isIosDevice('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'iPad', 5), true);
  // A Mac is the page this has to keep out, and it has no touch points to mistake it for one.
  assert.equal(isIosDevice(macSafari, 'MacIntel', 0), false);
  assert.equal(isIosDevice(windowsChrome, 'Win32', 0), false);
  // A page with no navigator at all is not a phone.
  assert.equal(isIosDevice('', '', 0), false);
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

test('a declared browser mount still answers by the platform, not by its declaration', () => {
  // The declaration (a shim's `lithic-browser-only`) is what makes a loopback origin resolve
  // to `webapp` rather than to an instance; it has no say in where saves land. A capable
  // browser on the shim therefore writes real files, and the fallback is for the browsers
  // that have no API at all.
  assert.equal(resolveStorageMode('webapp', picker), 'file');
  assert.equal(resolveStorageMode('webapp', {}), 'index-db');
  // The query is still the escape hatch, being how the fallback is exercised by hand.
  assert.equal(resolveStorageMode('webapp', picker, 'file'), 'file');
  assert.equal(resolveStorageMode('webapp', picker, 'index-db'), 'index-db');
});

test('a storage-only mount never remembers a row built on a handle', () => {
  // The rule that stops a mount whose saves go to browser storage from claiming a file: a
  // picker can hand a handle over for the one read, but every save in this mode goes to the
  // store instead, so the row has to be the browser-only one whatever the picker returned.
  assert.equal(rememberRowKind(true, true), 'browser-only');
  assert.equal(rememberRowKind(true, false), 'browser-only');
  // Away from browser storage a handle is what makes the row reopenable, and a name
  // with no handle is a row that can only be read back from the store.
  assert.equal(rememberRowKind(false, true), 'handle');
  assert.equal(rememberRowKind(false, false), 'plain');
});
