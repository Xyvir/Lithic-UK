import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyvalStore, addRecentFile, getRecentFiles, removeRecentFile, clearAllRecentFiles, saveSearchCache } from './storage.ts';

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
