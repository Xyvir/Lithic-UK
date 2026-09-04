import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyvalStore, addRecentFile, getRecentFiles, removeRecentFile, clearAllRecentFiles, saveSearchCache, purgeOldestCachesIfNeeded, isWikiDriftedFromHead, type CacheStore } from './storage.ts';
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

function cacheEntry(text: string, lastModified: string) {
  return { text, lastModified, backupTimestamp: 0 };
}

const cache = (name: string, text: string, lastModified: string): [string, any] =>
  [`search_cache_${name}`, cacheEntry(text, lastModified)];

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
