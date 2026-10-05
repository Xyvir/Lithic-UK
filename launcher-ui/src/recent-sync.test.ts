import test from 'node:test';
import assert from 'node:assert/strict';
import { syncIndex, isShared, deviceOnlyEntries, publishSource } from './recent-sync.ts';

/** One folder entry, spelled the way the engine reports it and with fields this module ignores. */
const entry = (name: string, size = 10) => ({ name, size, hash: `hash-${name}`, author: 'peer', at: 1_700_000_000_000 });

test('the index is keyed by name, so a row and an entry compare the same way', () => {
  const index = syncIndex([entry('Notes.lith'), entry('work.lith')]);
  assert.equal(isShared('notes.lith', index), true);
  assert.equal(isShared('NOTES.LITH', index), true);
  assert.equal(isShared('work.lith', index), true);
  assert.equal(isShared('elsewhere.lith', index), false);
});

test('a name the index holds twice keeps the last entry, so a list is not doubled', () => {
  const index = syncIndex([entry('dup.lith', 1), entry('DUP.lith', 2)]);
  assert.equal(index.size, 1);
  assert.equal(index.get('dup.lith')?.size, 2);
});

test('an entry no row accounts for is a row of its own, in the folder\u2019s order', () => {
  const only = deviceOnlyEntries(
    [{ name: 'mine.lith' }],
    [entry('from-other.lith'), entry('mine.lith'), entry('also-other.lith')]
  );
  assert.deepEqual(only.map((each) => each.name), ['from-other.lith', 'also-other.lith']);
});

test('a row and an entry differing only in case are one Lith, not two rows', () => {
  assert.deepEqual(deviceOnlyEntries([{ name: 'Notes.lith' }], [entry('notes.lith')]), []);
  assert.deepEqual(
    deviceOnlyEntries([], [entry('dup.lith'), entry('DUP.lith')]).map((each) => each.name),
    ['dup.lith']
  );
});

test('the folder\u2019s own copy is not a row when nothing is paired', () => {
  assert.deepEqual(deviceOnlyEntries([{ name: 'a.lith' }], []), []);
});

test('a row\u2019s own bytes are the first place a publish reads from', () => {
  const sources = { canReadPath: true, canFetchByName: true };
  assert.equal(publishSource({ name: 'a.lith', text: 'x' }, sources), 'text');
  assert.equal(publishSource({ name: 'a.lith', text: 'x', path: '/data/a.lith' }, sources), 'text');
});

test('a path is readable only where a process can read one', () => {
  assert.equal(publishSource({ name: 'a.lith', path: '/data/a.lith' }, { canReadPath: true, canFetchByName: false }), 'path');
  // A browser page keeps the path a row remembers and cannot open it, so the answer is
  // not "send it" but "nothing here can read it".
  assert.equal(publishSource({ name: 'a.lith', path: '/data/a.lith' }, { canReadPath: false, canFetchByName: false }), null);
});

test('a handle outranks the server, and the server is the last answer', () => {
  const handle = { getFile: () => null };
  assert.equal(publishSource({ name: 'a.lith', handle }, { canReadPath: false, canFetchByName: true }), 'handle');
  assert.equal(publishSource({ name: 'a.lith' }, { canReadPath: false, canFetchByName: true }), 'server');
  assert.equal(publishSource({ name: 'a.lith' }, { canReadPath: false, canFetchByName: false }), null);
  // An empty text is not a copy of anything: a row that carries no bytes falls through.
  assert.equal(publishSource({ name: 'a.lith', text: '' }, { canReadPath: false, canFetchByName: false }), null);
});
