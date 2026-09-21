import test from 'node:test';
import assert from 'node:assert/strict';
import { orphanPill, orphanDownloadNote, type OrphanDownloadState } from './orphan-download.ts';

test('only a confirmed write gets the green tone', () => {
  assert.equal(orphanPill('saved')?.tone, 'saved');
  // A started download must never look like a saved file: the browser does not
  // report completion, so claiming otherwise would be the lie this guards.
  assert.equal(orphanPill('unverified')?.tone, 'unverified');
  assert.equal(orphanPill('failed')?.tone, 'unverified');
  assert.match(orphanPill('unverified')?.title ?? '', /cannot confirm downloads/);
});

test('a row with nothing to report shows no pill', () => {
  assert.equal(orphanPill('idle'), null);
});

test('the pill says what is happening while it happens', () => {
  assert.equal(orphanPill('saving')?.label, 'saving…');
  assert.equal(orphanPill('saved')?.label, '✓ saved');
  assert.equal(orphanPill('failed')?.label, 'failed');
});

test('the note stays silent until something has actually been saved', () => {
  const none: OrphanDownloadState[] = ['idle', 'idle', 'idle'];
  assert.equal(orphanDownloadNote(none), '');
  assert.equal(orphanDownloadNote([]), '');
  // A failure is not a save.
  assert.equal(orphanDownloadNote(['failed', 'idle']), '');
});

test('the note counts progress and says when proceeding is safe', () => {
  assert.equal(orphanDownloadNote(['saved', 'idle', 'idle']), '1 of 3 saved.');
  assert.equal(orphanDownloadNote(['saved', 'saving', 'idle']), '1 of 3 saved.');
  assert.equal(orphanDownloadNote(['saved', 'saved', 'idle']), '2 of 3 saved.');
  assert.equal(orphanDownloadNote(['saved', 'saved', 'saved']), 'All 3 saved. Safe to proceed.');
});

test('the note never calls an unconfirmed download safe', () => {
  // Every row done, but one through the fallback path: the reassurance has to
  // be withheld rather than extended to a download nobody can vouch for.
  assert.equal(orphanDownloadNote(['saved', 'saved', 'unverified']), 'All 3 saved, but 1 unconfirmed.');
  assert.equal(orphanDownloadNote(['unverified', 'unverified']), 'All 2 saved, but 2 unconfirmed.');
});

test('a single orphan reads as a sentence, not as a count of one', () => {
  assert.equal(orphanDownloadNote(['saved']), 'Saved. Safe to proceed.');
  assert.equal(orphanDownloadNote(['unverified']), 'Saved, but unconfirmed.');
});
