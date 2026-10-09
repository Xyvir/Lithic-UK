import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyvalStore, setRecentRows, mergeRecentRow, mergeRecentLists, sameRecentRow, isAnonymousRow, getRecentFiles, recentRowName, clearAllRecentFiles, forgetWikiCache, saveSearchCache, purgeOldestCachesIfNeeded, isWikiDriftedFromHead, recentDiskPath, isFlatCacheKey, cachedWikiNames, isInstallDismissed, setInstallDismissed, INSTALL_DISMISS_KEY, type CacheStore } from './storage.ts';
import { KeyvalWikiHistory } from './wiki-history.ts';

// In Node environment without native indexedDB, we mock indexedDB or test logic
test('KeyvalStore handles fallback when indexedDB is undefined', async () => {
  const store = new KeyvalStore('test-db', 'test-store');
  await assert.rejects(async () => {
    await store.get('foo');
  }, /IndexedDB not available/);
});

test('RecentEntry normalization works with handles', () => {
  const mockHandle = {
    name: 'project.lith',
    isSameEntry: async (other: any) => other?.name === 'project.lith'
  };

  assert.equal(mockHandle.name, 'project.lith');
});

/** Minimal in-memory stand-in for the KeyvalStore surface used by the purge. */
class MemoryIdb implements CacheStore {
  private data = new Map<string, any>();
  constructor(seed: Array<[string, any]> = []) {
    for (const [key, value] of seed) this.data.set(key, value);
  }
  keys(): Promise<IDBValidKey[]> {
    return Promise.resolve([...this.data.keys()]);
  }
  get<T = any>(key: IDBValidKey): Promise<T | undefined> {
    return Promise.resolve(this.data.get(String(key)) as T | undefined);
  }
  set(key: IDBValidKey, value: any): Promise<void> {
    this.data.set(String(key), value);
    return Promise.resolve();
  }
  del(key: IDBValidKey): Promise<void> {
    this.data.delete(String(key));
    return Promise.resolve();
  }
}

test('the install offer dismissal can be restored independently of recents storage', async () => {
  const store = new MemoryIdb();
  await setInstallDismissed(true, store);
  assert.equal(await isInstallDismissed(store), true);
  assert.equal((await store.get(INSTALL_DISMISS_KEY)), true);

  await setInstallDismissed(false, store);
  assert.equal(await isInstallDismissed(store), false);
  assert.equal(await store.get(INSTALL_DISMISS_KEY), undefined);
});

function cacheEntry(text: string, lastModified: string) {
  return { text, lastModified, backupTimestamp: 0 };
}

const cache = (name: string, text: string, lastModified: string): [string, any] =>
  [`search_cache_${name}`, cacheEntry(text, lastModified)];

test('a history snapshot is not a cached wiki', () => {
  // A wiki saved from inside itself writes a base snapshot, which carries a
  // `text` field exactly like a cache does. Counting those as wikis invented
  // entries like `base_recipes.lith_3f2a`: no row (cached rows only render
  // while searching), unopenable, and enough on its own to keep the Recent
  // panel on screen after the last real row was removed.
  const keys: IDBValidKey[] = [
    'search_cache_recipes.lith',
    'search_cache_meta_recipes.lith',
    'search_cache_base_recipes.lith_3f2a',
    'search_cache_delta_recipes.lith_9c11',
    'search_cache_bk1_recipes.lith',
    'search_cache_bk2_recipes.lith',
    'dirty_state_recipes.lith',
    'recentFiles'
  ];
  assert.deepEqual(cachedWikiNames(keys), ['recipes.lith']);
  assert.equal(isFlatCacheKey('search_cache_recipes.lith'), true);
  assert.equal(isFlatCacheKey('search_cache_base_recipes.lith_3f2a'), false);
  assert.equal(isFlatCacheKey('search_cache_delta_recipes.lith_9c11'), false);
  assert.equal(isFlatCacheKey('search_cache_meta_recipes.lith'), false);
  assert.equal(isFlatCacheKey('search_cache_bk1_recipes.lith'), false);
});

test('a wiki named after a history prefix is invisible to the cache list', () => {
  // Known, accepted limitation of the key scheme: a flat cache key and a base
  // snapshot key are told apart by prefix alone, so a wiki whose own name
  // starts with `meta_`, `base_` or `delta_` reads as history. It still appears
  // in the list through its own recent row; only its cached copy goes
  // unlisted. Fixing this properly means a key scheme that cannot collide.
  assert.deepEqual(cachedWikiNames(['search_cache_base_notes.lith']), []);
  assert.equal(isFlatCacheKey('search_cache_base_notes.lith'), false);
});

test('purge does nothing when usage is below the threshold', async () => {
  const store = new MemoryIdb([
    cache('a.lith', 'x'.repeat(10), '2026-01-01T00:00:00Z'),
    cache('b.lith', 'y'.repeat(10), '2026-01-02T00:00:00Z')
  ]);
  const purged = await purgeOldestCachesIfNeeded({
    store,
    estimate: async () => ({ usage: 10, quota: 1000 })
  });
  assert.equal(purged, 0);
  assert.deepEqual((await store.keys()).sort(), ['search_cache_a.lith', 'search_cache_b.lith']);
});

test('purge deletes oldest-modified caches until below threshold', async () => {
  // Each cache is ~100 bytes, so dropping from 900/1000 needs two purges
  // (900 -> 800 still >= 800 -> 700 < 800) before the loop stops.
  const store = new MemoryIdb([
    cache('old.lith', 'o'.repeat(92), 'Wed, 01 Jan 2026 00:00:00 GMT'),
    cache('mid.lith', 'm'.repeat(92), 'Thu, 02 Jan 2026 00:00:00 GMT'),
    cache('new.lith', 'n'.repeat(92), 'Fri, 03 Jan 2026 00:00:00 GMT'),
    cache('newest.lith', 'q'.repeat(92), 'Sat, 04 Jan 2026 00:00:00 GMT')
  ]);
  const purged = await purgeOldestCachesIfNeeded({
    store,
    estimate: async () => ({ usage: 900, quota: 1000 })
  });
  assert.equal(purged, 2);
  const keys = (await store.keys()).sort();
  assert.ok(!keys.includes('search_cache_old.lith'));
  assert.ok(!keys.includes('search_cache_mid.lith'));
  assert.deepEqual(keys, ['search_cache_new.lith', 'search_cache_newest.lith']);
});

test('purge never deletes the last remaining cache', async () => {
  const store = new MemoryIdb([
    cache('old.lith', 'z'.repeat(900), '2026-01-01T00:00:00Z'),
    cache('survivor.lith', 'z'.repeat(50), '2026-02-01T00:00:00Z')
  ]);
  const purged = await purgeOldestCachesIfNeeded({
    store,
    estimate: async () => ({ usage: 990, quota: 1000 })
  });
  // Oldest purged, then the loop stops with one cache left even though
  // usage is still over the threshold.
  assert.equal(purged, 1);
  const keys = (await store.keys()).sort();
  assert.deepEqual(keys, ['search_cache_survivor.lith']);
});

test('purge ignores backup keys and skips single-cache quota pressure', async () => {
  const store = new MemoryIdb([
    cache('a.lith', 'a'.repeat(10), '2026-01-01T00:00:00Z'),
    ['search_cache_bk1_a.lith', cacheEntry('old backup', '2025-12-01T00:00:00Z')],
    ['search_cache_bk2_a.lith', cacheEntry('older backup', '2025-11-01T00:00:00Z')]
  ]);
  const purged = await purgeOldestCachesIfNeeded({
    store,
    estimate: async () => ({ usage: 990, quota: 1000 })
  });
  assert.equal(purged, 0);
  assert.equal((await store.keys()).length, 3);
});

test('purge tolerates a failing estimate and malformed timestamps', async () => {
  const store = new MemoryIdb([
    ['search_cache_a.lith', { text: 'a' }],
    ['search_cache_b.lith', { text: 'b', lastModified: 'not-a-date' }]
  ]);
  const purged = await purgeOldestCachesIfNeeded({
    store,
    estimate: async () => { throw new Error('no estimates here'); }
  });
  assert.equal(purged, 0);
  assert.equal((await store.keys()).length, 2);
});

test('forgetWikiCache removes one wiki entirely and leaves the others alone', async () => {
  const store = new MemoryIdb([
    cache('a.lith', 'text-a', '2026-01-01T00:00:00Z'),
    ['search_cache_bk1_a.lith', cacheEntry('bk1', '2025-12-01T00:00:00Z')],
    ['search_cache_bk2_a.lith', cacheEntry('bk2', '2025-11-01T00:00:00Z')],
    ['dirty_state_a.lith', { ts: 1, tiddlers: [{ title: 'Unsaved edit' }] }],
    cache('b.lith', 'text-b', '2026-01-02T00:00:00Z'),
    ['unrelated-key', 'keep me']
  ]);
  // A versioned history writes its own meta/base/delta keys; all of them go.
  await new KeyvalWikiHistory(store).saveVersion('a.lith', '[{"title":"A","text":"one"}]', 1);

  await forgetWikiCache('a.lith', store);

  assert.deepEqual((await store.keys()).sort(), ['search_cache_b.lith', 'unrelated-key']);
});

test('forgetWikiCache tolerates a wiki with nothing stored', async () => {
  const store = new MemoryIdb([['unrelated-key', 'keep me']]);
  await forgetWikiCache('never-saved.lith', store);
  assert.deepEqual(await store.keys(), ['unrelated-key']);
});

test('clearAllRecentFiles drops orphaned search caches and backups', async () => {
  const store = new MemoryIdb([
    ['recentFiles', [{ handle: { name: 'a.lith' }, tauriPath: null }]],
    cache('a.lith', 'text-a', '2026-01-01T00:00:00Z'),
    ['search_cache_bk1_a.lith', cacheEntry('bk1', '2025-12-01T00:00:00Z')],
    ['search_cache_bk2_a.lith', cacheEntry('bk2', '2025-11-01T00:00:00Z')],
    cache('b.lith', 'text-b', '2026-01-02T00:00:00Z'),
    ['unrelated-key', 'keep me']
  ]);
  await clearAllRecentFiles(store);
  assert.deepEqual(await store.keys(), ['unrelated-key']);
});

import { getDirtyState, clearDirtyState, listDirtyRecoveries } from './storage.ts';

test('dirty state round-trips and validates the record shape', async () => {
  const store = new MemoryIdb();
  assert.equal(await getDirtyState('a.lith', store), null);
  await store.set('dirty_state_a.lith', { ts: 42, tiddlers: [{ title: 'Welcome', text: 'draft' }] });
  const record = await getDirtyState('a.lith', store);
  assert.equal(record?.ts, 42);
  assert.equal(record?.tiddlers[0].text, 'draft');
  // Empty or malformed records never surface as recoverable.
  await store.set('dirty_state_b.lith', { ts: 1, tiddlers: [] });
  assert.equal(await getDirtyState('b.lith', store), null);
  await store.set('dirty_state_c.lith', 'garbage');
  assert.equal(await getDirtyState('c.lith', store), null);
  await clearDirtyState('a.lith', store);
  assert.equal(await getDirtyState('a.lith', store), null);
});

test('drift detection compares the opened Lith against the local history HEAD', async () => {
  const store = new MemoryIdb();
  const history = new KeyvalWikiHistory(store);
  const saved = JSON.stringify([{ title: 'Note', text: 'saved' }]);
  await history.saveVersion('a.lith', saved, 1);

  assert.equal(await isWikiDriftedFromHead('a.lith', `title: Note\n\nsaved`, store), false);
  assert.equal(await isWikiDriftedFromHead('a.lith', `title: Note\n\nchanged`, store), true);
  assert.equal(await isWikiDriftedFromHead('missing.lith', `title: Note\n\nsaved`, store), false);
});

test('listDirtyRecoveries reports only wikis with unsaved edits', async () => {
  const store = new MemoryIdb([
    ['dirty_state_a.lith', { ts: 7, tiddlers: [{ title: 'T' }] }],
    ['dirty_state_empty.lith', { ts: 8, tiddlers: [] }]
  ]);
  const recoveries = await listDirtyRecoveries(['a.lith', 'empty.lith', 'ghost.lith'], store);
  assert.deepEqual(recoveries, { 'a.lith': 7 });
});

test('recentDiskPath finds the path in every row shape the recents store holds', () => {
  // Launcher-written row (save dialog, sidecar merge).
  assert.equal(recentDiskPath({ name: 'a.lith', path: 'C:\\Lithic\\a.lith' }), 'C:\\Lithic\\a.lith');
  // Engine-written row: every save from inside a Lith lands like this, which is
  // how a freshly saved blank Lith ended up invisible to the sync target.
  assert.equal(recentDiskPath({ name: 'b.lith', tauriPath: 'C:\\Lithic\\b.lith', handle: null }), 'C:\\Lithic\\b.lith');
  assert.equal(recentDiskPath({ handle: { name: 'c.lith', __lithicTauriPath__: 'C:\\Lithic\\c.lith' } }), 'C:\\Lithic\\c.lith');
  // Legacy double-wrapped shape seen in older stores.
  assert.equal(
    recentDiskPath({ handle: { handle: null, name: 'd.lith', __lithicTauriPath__: 'C:\\Lithic\\d.lith' } }),
    'C:\\Lithic\\d.lith'
  );
  // Browser rows have no path, and neither do half-built ones.
  assert.equal(recentDiskPath({ handle: { name: 'e.lith' } }), null);
  assert.equal(recentDiskPath({ name: 'f.lith', path: '' }), null);
  assert.equal(recentDiskPath({ handle: 'g.lith' }), null);
});

test('a browser-only row lands in the same store the file rows live in', async () => {
  const store = new MemoryIdb();
  await setRecentRows([{ handle: null, tauriPath: null, name: 'notes.lith', browserOnly: true }], store);
  const rows = (await store.get<any[]>('recentFiles'))!;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'notes.lith');
  assert.equal(rows[0].handle, null);
  assert.equal(rows[0].browserOnly, true);
});

test('re-saving a browser-only Lith moves its row rather than duplicating it', async () => {
  const store = new MemoryIdb();
  let list = await mergeRecentRow([], { handle: null, name: 'notes.lith', browserOnly: true });
  list = await mergeRecentRow(list, { handle: null, name: 'other.lith', browserOnly: true });
  list = await mergeRecentRow(list, { handle: null, name: 'notes.lith', browserOnly: true });
  const rows = await setRecentRows(list, store);
  assert.deepEqual(rows.map((row) => recentRowName(row)), ['notes.lith', 'other.lith']);
});

test('a browser-only row supersedes the file row of the same name', async () => {
  // The same Lith cannot be both: whatever this mode mounts is remembered as
  // living in browser storage, so the older file-row shape must not linger
  // beside it and offer to open a file nobody can write to.
  const current = [{ handle: { name: 'notes.lith' }, tauriPath: null }];
  const next = await mergeRecentRow(current, { handle: null, name: 'notes.lith', browserOnly: true });
  assert.equal(next.length, 1);
  assert.equal((next[0] as any).browserOnly, true);
});

test('removing a row writes the list that is left, and nothing else', async () => {
  const store = new MemoryIdb();
  const list = await setRecentRows(
    [
      { handle: null, name: 'notes.lith', browserOnly: true },
      { handle: null, name: 'other.lith', browserOnly: true }
    ],
    store
  );
  const next = await setRecentRows(list.filter((row) => recentRowName(row) !== 'notes.lith'), store);
  assert.deepEqual(next.map((row) => recentRowName(row)), ['other.lith']);
  assert.deepEqual(((await store.get<any[]>('recentFiles'))!).map((row) => recentRowName(row)), ['other.lith']);
});

test('a save adds to the list rather than adopting one store answer', async () => {
  // Regression, measured in the shim. With a backup connected the list *is* the synced Liths,
  // which arrive as path rows, and a save used to answer with whatever IndexedDB held, which
  // was nothing of theirs: the new row replaced every one of them. Coverage then had no paths
  // to compute from, which is what turned the panel's foot into `Reset Recents`.
  const store = new MemoryIdb();
  const synced = [
    { handle: null, name: 'notes.lith', tauriPath: '/home/u/Documents/Lithic/notes.lith' },
    { handle: null, name: 'recipes.lith', tauriPath: '/home/u/Documents/Lithic/recipes.lith' }
  ];
  await setRecentRows(synced, store);
  const saved = { handle: { name: 'new.lith' }, tauriPath: null, name: 'new.lith' };
  const next = await setRecentRows(await mergeRecentRow(synced, saved), store);
  assert.deepEqual(
    next.map((row) => recentRowName(row)),
    ['new.lith', 'notes.lith', 'recipes.lith'],
    'the new row goes in front of what was listed, and nothing leaves'
  );
  const stored = (await store.get<any[]>('recentFiles'))!;
  assert.deepEqual(
    stored.map((row) => recentRowName(row)),
    ['new.lith', 'notes.lith', 'recipes.lith'],
    'and the store holds the same list, so a relaunch reads it rather than a one-row answer'
  );
  assert.deepEqual(
    stored.map((row) => recentDiskPath(row)),
    [null, '/home/u/Documents/Lithic/notes.lith', '/home/u/Documents/Lithic/recipes.lith'],
    'the paths survive the round trip: coverage and the rebuild both read them back'
  );
});

test('the store and the mirror are read as one list', () => {
  // Regression, and the reason the two copies are merged rather than chosen between: the store
  // held the one row a save had written and the mirror held the synced Liths, so reading the
  // store alone showed the one row and hid the backup's own list.
  const stored = [{ handle: { name: 'saved.lith' }, tauriPath: null }];
  const mirrored = [
    { name: 'notes.lith', path: '/home/u/Documents/Lithic/notes.lith' },
    { handle: { name: 'saved.lith' } }
  ];
  const merged = mergeRecentLists(stored, mirrored);
  assert.deepEqual(merged.map((row) => recentRowName(row)), ['saved.lith', 'notes.lith']);
  assert.equal((merged[0] as any).handle.name, 'saved.lith', 'the store order leads');
  assert.equal(
    recentDiskPath(merged[1]),
    '/home/u/Documents/Lithic/notes.lith',
    'and a row only the mirror holds comes back with its path'
  );
});

test('a body rides only in a row that has nowhere else to keep it', async () => {
  // The same rule the localStorage mirror follows, and it matters more here: this store is the
  // one a body can bloat, and a copy nothing keeps in step is not worth the space.
  const store = new MemoryIdb();
  const rows = await setRecentRows(
    [
      { handle: null, name: 'monolith.html', text: '<html>a whole page</html>' },
      { handle: null, name: 'notes.lith', path: '/Lithic/notes.lith', text: 'a body with a file behind it' }
    ],
    store
  );
  assert.equal((rows[0] as any).text, '<html>a whole page</html>');
  assert.equal((rows[1] as any).text, undefined);
});

test('two rows are the same Lith by path, by handle, or by name', async () => {
  const notes = { handle: null, name: 'notes.lith', tauriPath: '/Lithic/notes.lith' };
  const other = { handle: null, name: 'notes.lith', tauriPath: '/Elsewhere/notes.lith' };
  assert.equal(await sameRecentRow(notes, { ...notes }), true, 'the same path is the same file');
  assert.equal(await sameRecentRow(notes, other), false, 'and a different path is not, however alike the names');

  const handle = { name: 'a.lith', isSameEntry: async (candidate: any) => candidate === 'same' };
  assert.equal(await sameRecentRow({ handle }, { handle: 'same' as any }), true, 'a comparable handle answers for itself');
  assert.equal(await sameRecentRow({ handle }, { handle: 'other' as any }), false);

  // Two files called `notes.lith` in two folders are two of the user's Liths. A handle that
  // cannot be compared is not a name match, or one of them would be hidden.
  assert.equal(
    await sameRecentRow(
      { handle: { name: 'notes.lith' }, tauriPath: null },
      { handle: { name: 'notes.lith' }, tauriPath: null }
    ),
    false
  );
  // With no handle on either side a name is all there is, which is what a path row and a
  // browser-only row already compared by.
  assert.equal(
    await sameRecentRow(
      { handle: null, name: 'notes.lith', browserOnly: true },
      { handle: null, name: 'notes.lith', browserOnly: true }
    ),
    true
  );
});

test('a row that names no file is not a row', () => {
  assert.equal(isAnonymousRow({ name: 'new.lith' }), true, 'a name alone says nothing to open');
  assert.equal(isAnonymousRow({ name: 'new.lith', path: '' }), true, 'and an empty path is no path');
  assert.equal(isAnonymousRow({ name: 'notes.lith', path: '/Lithic/notes.lith' }), false);
  assert.equal(isAnonymousRow({ handle: { name: 'notes.lith' } }), false);
  // The two ways a row can have somewhere to be instead of a path: the browser's storage, and
  // the document itself. Both can be opened, which is what separates them from a name alone.
  assert.equal(isAnonymousRow({ handle: null, name: 'notes.lith', browserOnly: true }), false);
  assert.equal(isAnonymousRow({ handle: null, name: 'monolith.html', text: '<html>a page</html>' }), false);
});

test('the placeholder a blank Lith left behind loses to the row its save wrote', () => {
  // The exact duplicate the merge used to produce: the mount remembered a name with nowhere to
  // save it, the engine's saver then recorded the file the chooser named, and reading the store
  // and the mirror as one list showed both. One of them cannot be opened.
  const stored = [
    { handle: { name: 'test.lith', __lithicShimPath__: '/home/u/Documents/Lithic/test.lith' }, tauriPath: null }
  ];
  const mirrored = [{ name: 'test.lith' }];
  const merged = mergeRecentLists(stored, mirrored);
  assert.deepEqual(merged.map((row) => recentRowName(row)), ['test.lith'], 'one Lith, one row');
  assert.equal(recentDiskPath(merged[0]), '/home/u/Documents/Lithic/test.lith', 'and it is the openable one');
});

test('nothing writes a placeholder row, so a relaunch cannot resurrect one', async () => {
  const store = new MemoryIdb();
  const rows = await setRecentRows([{ name: 'new.lith' }, { name: 'notes.lith', path: '/Lithic/notes.lith' }], store);
  assert.deepEqual(rows.map((row) => recentRowName(row)), ['notes.lith']);
  assert.deepEqual(((await store.get<any[]>('recentFiles'))!).map((row) => recentRowName(row)), ['notes.lith']);
});
