import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInstanceUrl, saveBookmark, removeBookmark } from './bookmarks.ts';

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  } as unknown as Storage;
}

test('normalizes self-host instance URLs to origin', () => {
  assert.equal(normalizeInstanceUrl('example.test/path'), 'https://example.test');
  assert.equal(normalizeInstanceUrl('http://example.test:8080/wiki'), 'http://example.test:8080');
  assert.throws(() => normalizeInstanceUrl(''), /URL/);
});

test('deduplicates and removes local instance bookmarks', () => {
  const store = storage();
  assert.deepEqual(saveBookmark('example.test/path', store), ['https://example.test']);
  assert.deepEqual(saveBookmark('https://example.test/other', store), ['https://example.test']);
  assert.deepEqual(saveBookmark('https://second.test', store), ['https://second.test', 'https://example.test']);
  assert.deepEqual(removeBookmark('https://second.test', store), ['https://example.test']);
});
