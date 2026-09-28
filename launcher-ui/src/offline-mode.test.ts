import test from 'node:test';
import assert from 'node:assert/strict';
import { offlineMode, looksUnreachable, OFFLINE_TITLE, OFFLINE_BODY } from './offline-mode.ts';

test('only a self-host launcher has an offline mode', () => {
  assert.equal(offlineMode('tauri', false), false);
  assert.equal(offlineMode('webapp', false), false);
  assert.equal(offlineMode('self-host', false), true);
});

test('a self-host launcher with a network and an answering instance is online', () => {
  assert.equal(offlineMode('self-host', true), false);
  assert.equal(offlineMode('self-host', true, false), false);
});

test('an instance that failed to answer is offline mode even while the browser has a network', () => {
  assert.equal(offlineMode('self-host', true, true), true);
  // The unreachable half is ignored outside the one mode that has the state, so a
  // Tauri read that failed cannot put the banner on a launcher that does not need a server.
  assert.equal(offlineMode('tauri', true, true), false);
});

test('a refused request is not an unreachable instance', () => {
  assert.equal(looksUnreachable(new Error('PROPFIND failed: 404')), false);
  assert.equal(looksUnreachable(new Error('GET failed: 500')), false);
  assert.equal(looksUnreachable(new Error('PUT failed: 403')), false);
});

test('a request that never landed is an unreachable instance', () => {
  assert.equal(looksUnreachable(new TypeError('Failed to fetch')), true);
  assert.equal(looksUnreachable(new Error('fetch failed')), true);
  assert.equal(looksUnreachable(new Error('NetworkError when attempting to fetch resource.')), true);
  assert.equal(looksUnreachable(new Error('Load failed')), true);
});

test('unknown failures are not claimed to be a lost network', () => {
  assert.equal(looksUnreachable(null), false);
  assert.equal(looksUnreachable(undefined), false);
  assert.equal(looksUnreachable('something else'), false);
});

test('the banner copy is the legacy notice, dash-free', () => {
  assert.equal(OFFLINE_TITLE, 'Server unreachable');
  // The retired launcher's notice said the same two things (see `OFFLINE_BODY`), and one
  // of them is the half a rewrite kept dropping: the copies open read-only.
  assert.match(OFFLINE_BODY, /saved copies/);
  assert.match(OFFLINE_BODY, /read-only/);
  assert.equal(/[—–]/.test(`${OFFLINE_TITLE} ${OFFLINE_BODY}`), false);
});

test('the banner copy is two short clauses, not a paragraph', () => {
  assert.equal(OFFLINE_BODY.split(/(?<=\.)\s+/).filter((part) => part.trim()).length, 2);
  assert.ok(
    OFFLINE_BODY.split(/\s+/).length <= 15,
    `the banner's line runs ${OFFLINE_BODY.split(/\s+/).length} words`
  );
});
