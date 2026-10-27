import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOSE_GUARD_REPORT,
  CLOSE_PENDING_KEY,
  CLOSE_PENDING_MS,
  reportUnsavedEdits,
  takePendingClose,
  unsavedEditsNow
} from './close-guard.ts';

// What a page says about itself, and the one predicate it is read from.

test('a document with no wiki behind it has nothing unsaved', () => {
  assert.equal(unsavedEditsNow({}), false, 'the launcher, and a page this app never booted');
  assert.equal(unsavedEditsNow({ $tw: {} }), false, 'a wiki whose saver handler is not up yet');
  assert.equal(unsavedEditsNow({ $tw: { saverHandler: {} } }), false, 'a saver handler that cannot answer');
});

test('an unsaved edit is the answer TiddlyWiki itself gives', () => {
  assert.equal(unsavedEditsNow({ $tw: { saverHandler: { isDirty: () => true } } }), true);
  assert.equal(unsavedEditsNow({ $tw: { saverHandler: { isDirty: () => false } } }), false);
  // Only a literal true is an edit: this predicate is what decides whether a close is
  // questioned, and a truthy answer from something other than the saver handler's own
  // boolean is not TiddlyWiki saying the wiki is dirty.
  const other = { isDirty: () => 'yes' as unknown as boolean };
  assert.equal(unsavedEditsNow({ $tw: { saverHandler: other } }), false);
});

test('the report carries the answer to the command the app answers on', () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  reportUnsavedEdits(true, (command, args) => {
    calls.push({ command, args });
    return Promise.resolve();
  });
  assert.deepEqual(calls, [{ command: CLOSE_GUARD_REPORT, args: { dirty: true } }]);
  // One name, two halves: the page reports on it and the app keeps the answer under it. A
  // rename that missed the Rust side would be silent in exactly the case this exists for.
  assert.equal(CLOSE_GUARD_REPORT, 'close_guard_report');
});

// The close a prompted navigation interrupted is the launcher's to finish, and the launcher is
// only ever told about it through the marker the interrupted page left behind.
test('the launcher finishes a close the prompt already answered', () => {
  const store = new Map<string, string>();
  const session = {
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => { store.delete(key); }
  };
  const now = 1_700_000_000_000;

  assert.equal(takePendingClose(session, now), false, 'nothing pending, nothing to finish');

  store.set(CLOSE_PENDING_KEY, String(now));
  assert.equal(takePendingClose(session, now + 1_000), true, 'a press that was answered is honoured');
  assert.equal(store.has(CLOSE_PENDING_KEY), false, 'and is one press and one answer');

  // A marker nobody cleared means the app died with the prompt on screen. Finishing that minutes
  // later would close a window somebody had gone back to using.
  store.set(CLOSE_PENDING_KEY, String(now));
  assert.equal(takePendingClose(session, now + CLOSE_PENDING_MS + 1), false);
  assert.equal(store.has(CLOSE_PENDING_KEY), false, 'and is not left behind to be read twice');
});

test('storage that refuses to answer does not close a window', () => {
  const denied = {
    getItem() { throw new Error('denied'); },
    removeItem() { throw new Error('denied'); }
  };
  assert.equal(takePendingClose(denied, 1_700_000_000_000), false);
});

test('a page with no app behind it reports nowhere rather than throwing', async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on('unhandledRejection', onRejection);
  try {
    reportUnsavedEdits(false, () => Promise.reject(new Error('Tauri API unavailable')));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.removeListener('unhandledRejection', onRejection);
  }
  assert.deepEqual(rejections, [], 'the report is best effort, not an unhandled rejection');
});
