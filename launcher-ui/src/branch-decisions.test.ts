import assert from 'node:assert/strict';
import test from 'node:test';
import {
  branchHasLocalSync,
  branchIndexDbOnly,
  branchIsSelfHost,
  branchShimBackend,
  branchShowBookmarks,
  branchStorageMode
} from './branch-decisions.ts';

const picker = { showSaveFilePicker: () => Promise.reject(new Error('unused')) };

test('a shim page is a file backend even where the browser has no picker', () => {
  const mode = branchStorageMode({ mode: 'webapp', shimToken: 'secret', search: '', pickerHost: undefined });
  assert.equal(mode, 'file');
  assert.equal(branchShimBackend('secret'), true);
  assert.equal(branchIndexDbOnly(mode), false);
});

test('a shim page keeps the platform answer, it is not forced into the fallback', () => {
  // The shim writes the path itself, so the mode is `file`, but the *reason* is the shim and not
  // the API: this asserts the override cannot talk a shim out of it either.
  assert.equal(branchStorageMode({ mode: 'webapp', shimToken: 'secret', search: '?storage=index-db' }), 'file');
});

test('a published deployment follows the platform', () => {
  assert.equal(branchStorageMode({ mode: 'webapp', shimToken: null, search: '', pickerHost: picker }), 'file');
  const fallback = branchStorageMode({ mode: 'webapp', shimToken: null, search: '', pickerHost: null });
  assert.equal(fallback, 'index-db');
  assert.equal(branchIndexDbOnly(fallback), true);
});

test('the query override forces the fallback so it can be exercised', () => {
  assert.equal(
    branchStorageMode({ mode: 'webapp', shimToken: null, search: '?storage=index-db', pickerHost: picker }),
    'index-db'
  );
});

test('an app whose process cannot hold a document falls back rather than failing to save', () => {
  assert.equal(branchStorageMode({ mode: 'tauri', shimToken: null, search: '', documents: false }), 'index-db');
  assert.equal(branchStorageMode({ mode: 'tauri', shimToken: null, search: '', documents: true }), 'file');
});

test('only the app and a shim can ask about a folder backup', () => {
  assert.equal(branchHasLocalSync('tauri', null), true);
  assert.equal(branchHasLocalSync('webapp', 'secret'), true);
  assert.equal(branchHasLocalSync('webapp', null), false);
  assert.equal(branchHasLocalSync('self-host', null), false);
});

test('a self-host page is the instance, and is not a local backend', () => {
  assert.equal(branchIsSelfHost('self-host'), true);
  assert.equal(branchIsSelfHost('webapp'), false);
  assert.equal(branchIsSelfHost('tauri'), false);
});

test('the bookmark list belongs to the app, and to a published page on an iDevice', () => {
  assert.equal(branchShowBookmarks('tauri', false), true);
  assert.equal(branchShowBookmarks('tauri', true), true);
  assert.equal(branchShowBookmarks('webapp', true), true);
  assert.equal(branchShowBookmarks('webapp', false), false);
  assert.equal(branchShowBookmarks('self-host', true), false);
});
