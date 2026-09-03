import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyvalWikiHistory, HISTORY_VERSIONS_PER_WIKI, recoveredFileName, recoverStamp, isHistoryKey, type WikiHistoryStore } from './wiki-history.ts';
import type { CacheStore } from './storage.ts';

class MemoryIdb implements CacheStore {
  private data = new Map<string, any>();
  constructor(seed: Array<[string, any]> = []) {
    for (const [key, value] of seed) this.data.set(String(key), value);
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

// Realistic wiki: long, mostly-static bodies plus a small changing journal
// entry per version (mirrors a real save, which touches only a few tiddlers).
const BODY = ' body content. '.repeat(40);
const STAMPS = ['20260101', '20260102', '20260103', '20260104', '20260105', '20260106', '20260107', '20260108'];
const tiddlers = (i: number) =>
  JSON.stringify([
    { title: 'Welcome', text: `static welcome page${BODY}` },
    { title: 'Notes', text: `static notes page${BODY}` },
    ...['RefA', 'RefB', 'RefC', 'RefD', 'RefE', 'RefF'].map((ref) => ({ title: ref, text: `static ${ref}${BODY}` })),
    { title: 'Journal', text: `entries for ${STAMPS[i]}${BODY}`, modified: STAMPS[i] }
  ]);
const wikiA = tiddlers(0);
const wikiB = tiddlers(1);
const wikiC = JSON.stringify([
  { title: 'Welcome', text: `static welcome page${BODY}` },
  { title: 'Notes', text: `static notes page${BODY}` },
  { title: 'Journal', text: `entries for ${STAMPS[2]}${BODY}`, modified: STAMPS[2] },
  { title: 'New Page', text: 'created' }
]);

const welcomeVersion = (text: string) => JSON.parse(text).find((t: any) => t.title === 'Welcome').text as string;

let clock = 0;
const nextTs = () => (clock += 60_000);

function history(): { store: WikiHistoryStore; mem: MemoryIdb } {
  const mem = new MemoryIdb();
  return { store: new KeyvalWikiHistory(mem), mem };
}

test('first save writes a base snapshot and registers one version', async () => {
  const { store } = history();
  await store.saveVersion('a.lith', wikiA, nextTs());
  const versions = await store.listVersions('a.lith');
  assert.equal(versions.length, 1);
  assert.equal(versions[0].isBase, true);
  assert.equal(versions[0].sizeBytes, new Blob([wikiA]).size);
});

test('saves chain deltas, and every version materializes to its own text', async () => {
  const { store } = history();
  await store.saveVersion('a.lith', wikiA, nextTs());
  await store.saveVersion('a.lith', wikiB, nextTs());
  await store.saveVersion('a.lith', wikiC, nextTs());

  const versions = await store.listVersions('a.lith');
  assert.equal(versions.length, 3);
  assert.equal(versions[versions.length - 1].isBase, true);

  const materialized = await store.getVersion('a.lith', versions[0].id);
  assert.ok(materialized);
  const parsed = JSON.parse(materialized!.text);
  assert.equal(parsed.find((t: any) => t.title === 'Journal').text.includes('20260103'), true);
  assert.equal(parsed.find((t: any) => t.title === 'New Page').title, 'New Page');
});

test('deltas are actually small (not deep copies)', async () => {
  const mem = new MemoryIdb();
  const store = new KeyvalWikiHistory(mem);
  await store.saveVersion('a.lith', wikiA, nextTs());
  await store.saveVersion('a.lith', wikiB, nextTs());
  const deltaKey = (await mem.keys()).find((key) => String(key).startsWith('search_cache_delta_'));
  assert.ok(deltaKey, 'second save should store a delta');
  const delta = await mem.get<{ ops: unknown[] }>(deltaKey!);
  assert.ok(JSON.stringify(delta!.ops).length < wikiB.length / 4, 'delta should be far smaller than a snapshot');
});

test('getVersion returns null for unknown ids', async () => {
  const { store } = history();
  await store.saveVersion('a.lith', wikiA, nextTs());
  assert.equal(await store.getVersion('a.lith', 'nope'), null);
  assert.equal(await store.getVersion('missing.lith', 'also-nope'), null);
});

test('recovered file name embeds the original stem and timestamp stamp', () => {
  const ts = Date.UTC(2026, 8, 3, 15, 45, 0);
  assert.equal(recoverStamp(ts), '20260903T154500Z');
  assert.equal(recoveredFileName('My Wiki.lith', ts), 'My Wiki_recover_20260903T154500Z.lith');
  assert.equal(recoveredFileName('notes.html', ts), 'notes_recover_20260903T154500Z.lith');
});

test('retention keeps only the newest maxVersions entries without losing HEAD', async () => {
  const mem = new MemoryIdb();
  const store = new KeyvalWikiHistory(mem, 5);
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) {
    await store.saveVersion('a.lith', tiddlers(i), nextTs());
    const versions = await store.listVersions('a.lith');
    ids.push(versions[0].id);
  }
  const versions = await store.listVersions('a.lith');
  assert.equal(versions.length, 5);
  // The oldest three are gone; every retained version still materializes.
  assert.equal(await store.getVersion('a.lith', ids[0]), null);
  assert.equal(await store.getVersion('a.lith', ids[2]), null);
  for (const [index, id] of ids.slice(3).entries()) {
    const version = await store.getVersion('a.lith', id);
    assert.ok(version, `retained version ${id} must materialize`);
    assert.equal(JSON.parse(version!.text).find((t: any) => t.title === 'Journal').text.includes(STAMPS[index + 3]), true);
  }
});

test('retention re-bases instead of destroying history', async () => {
  const mem = new MemoryIdb();
  const store = new KeyvalWikiHistory(mem, 4);
  for (let i = 0; i < 6; i++) {
    await store.saveVersion('a.lith', tiddlers(i), nextTs());
  }
  const versions = await store.listVersions('a.lith');
  assert.equal(versions.length, 4);
  const head = await store.getVersion('a.lith', versions[0].id);
  assert.equal(JSON.parse(head!.text).find((t: any) => t.title === 'Journal').text.includes('20260106'), true);
  // The retained oldest entry is a promoted base snapshot, never a delta
  // whose parent has been deleted.
  const oldest = versions[versions.length - 1];
  assert.equal(oldest.isBase, true);
});

test('huge rewrite (>50% changed) starts a new base but keeps prior history', async () => {
  const mem = new MemoryIdb();
  const store = new KeyvalWikiHistory(mem);
  await store.saveVersion('a.lith', wikiA, nextTs());
  const big = JSON.stringify([
    { title: 'Welcome', text: 'z'.repeat(600) },
    { title: 'Notes', text: 'y'.repeat(600) },
    { title: 'Journal', text: 'x'.repeat(600) }
  ]);
  await store.saveVersion('a.lith', big, nextTs());
  const versions = await store.listVersions('a.lith');
  assert.equal(versions.length, 2);
  assert.equal(versions[0].isBase, true, 'the rewrite should be a base snapshot');
  const prior = versions.find((version) => version.id !== versions[0].id)!;
  const old = await store.getVersion('a.lith', prior.id);
  assert.ok(old, 'prior history stays materializable');
  assert.equal(JSON.parse(old!.text).find((t: any) => t.title === 'Journal').text.includes('20260101'), true);
});

test('identical content still records a version (timestamps differ)', async () => {
  const { store } = history();
  await store.saveVersion('a.lith', wikiA, nextTs());
  await store.saveVersion('a.lith', wikiA, nextTs());
  const versions = await store.listVersions('a.lith');
  assert.equal(versions.length, 2);
  assert.notEqual(versions[0].id, versions[1].id);
});

test('deleteHistory removes every key for that wiki and nothing else', async () => {
  const mem = new MemoryIdb([
    ['search_cache_meta_a.lith', {}],
    ['search_cache_base_a.lith_x', {}],
    ['search_cache_delta_a.lith_x', {}],
    ['search_cache_meta_b.lith', {}],
    ['search_cache_a.lith', {}]
  ]);
  const store = new KeyvalWikiHistory(mem);
  await store.deleteHistory('a.lith');
  const keys = (await mem.keys()).map(String);
  assert.deepEqual(keys, ['search_cache_meta_b.lith', 'search_cache_a.lith']);
  assert.ok(isHistoryKey('search_cache_meta_x.lith'));
  assert.ok(isHistoryKey('search_cache_base_y.lith_1'));
  assert.ok(isHistoryKey('search_cache_delta_y.lith_123'));
  assert.ok(!isHistoryKey('search_cache_z.lith'));
});

test('listVersions is newest-first and survives missing meta', async () => {
  const { store } = history();
  assert.deepEqual(await store.listVersions('ghost.lith'), []);
  await store.saveVersion('a.lith', wikiA, nextTs());
  await store.saveVersion('a.lith', wikiB, nextTs());
  const versions = await store.listVersions('a.lith');
  assert.ok(versions[0].ts > versions[1].ts);
  assert.ok(versions[0].lastModified.includes('UTC'));
});

test('corrupt delta chains stop replay instead of producing wrong content', async () => {
  const mem = new MemoryIdb();
  const store = new KeyvalWikiHistory(mem);
  await store.saveVersion('a.lith', wikiA, nextTs());
  await store.saveVersion('a.lith', wikiB, nextTs());
  await store.saveVersion('a.lith', wikiC, nextTs());
  // Sabotage: point the middle delta at a parent that does not exist.
  const deltaKeys = (await mem.keys()).filter((key) => String(key).startsWith('search_cache_delta_')).map(String).sort();
  assert.equal(deltaKeys.length, 2);
  const middle = deltaKeys[0];
  const sabotaged = (await mem.get<any>(middle))!;
  await mem.set(middle, { ...sabotaged, parentId: 'bogus' });
  const versions = await store.listVersions('a.lith');
  const head = versions[0];
  // The corrupted version is unreachable; the base snapshot still is.
  assert.equal(await store.getVersion('a.lith', head.id), null);
  const baseId = versions[versions.length - 1].id;
  const first = await store.getVersion('a.lith', baseId);
  assert.ok(first, 'reachable base version still materializes');
});

test('HISTORY_VERSIONS_PER_WIKI default and WikiHistoryStore interface shape', () => {
  assert.equal(HISTORY_VERSIONS_PER_WIKI, 30);
  const store: WikiHistoryStore = new KeyvalWikiHistory(new MemoryIdb());
  assert.ok(typeof store.listVersions === 'function' && typeof store.saveVersion === 'function');
});
