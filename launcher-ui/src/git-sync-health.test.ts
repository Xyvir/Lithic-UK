import test from 'node:test';
import assert from 'node:assert/strict';
import {
  syncIndicator,
  healthFailure,
  heartbeatBackoff,
  shouldHeartbeat,
  verifiedAge,
  HEARTBEAT_FLOOR_MS,
  HEARTBEAT_CEILING_MS
} from './git-sync-health.ts';

const T0 = 1_700_000_000_000;

test('a folder with no marker is idle even with a stale failure hanging around', () => {
  const indicator = syncIndicator({
    hasMarker: false,
    health: 'auth',
    lastPushError: 'boom',
    now: T0
  });
  assert.equal(indicator.state, 'idle');
});

test('a synced folder with no verdict yet asks the question in amber', () => {
  const indicator = syncIndicator({ hasMarker: true, health: null, now: T0 });
  assert.equal(indicator.state, 'checking');
});

test('a verified folder is green, and the tooltip says what and when', () => {
  const indicator = syncIndicator({
    hasMarker: true,
    health: 'ok',
    repo: 'owner/lithic-sync-ab2d',
    verifiedAt: T0 - 42_000,
    now: T0
  });
  assert.equal(indicator.state, 'connected');
  assert.match(indicator.title, /owner\/lithic-sync-ab2d/);
  assert.match(indicator.title, /verified 42s ago/);
});

test('a verdict that is not ok turns the icon red with its own reason', () => {
  for (const [health, expected] of [
    ['auth', /rejected the saved token/],
    ['missing', /not visible to the saved token/],
    ['readonly', /not push to it/],
    ['offline', /can't reach github.com/],
    ['throttled', /rate-limiting/],
    ['malformed', /not readable/]
  ] as const) {
    const indicator = syncIndicator({ hasMarker: true, health, now: T0 });
    assert.equal(indicator.state, 'error', `${health} must be an error`);
    assert.match(indicator.title, expected);
  }
});

test('unmanaged is not a failure — it is the marker check saying nothing is synced', () => {
  assert.equal(healthFailure('unmanaged'), null);
  assert.equal(healthFailure('ok'), null);
  assert.equal(healthFailure(null), null);
});

test('a push that failed outranks a healthy verdict', () => {
  // The repository is reachable and the token works, yet the last save provably
  // did not land — the first-hand evidence has to win, or the icon lies.
  const indicator = syncIndicator({
    hasMarker: true,
    health: 'ok',
    repo: 'owner/repo',
    lastPushError: 'not authorized',
    now: T0
  });
  assert.equal(indicator.state, 'error');
  assert.match(indicator.title, /not authorized/);
});

test('an in-flight sync outranks both a failure and the amber check', () => {
  const base = { hasMarker: true, syncingUntil: T0 + 1, now: T0 } as const;
  assert.equal(syncIndicator({ ...base, health: 'auth' }).state, 'syncing');
  assert.equal(syncIndicator({ ...base, health: null }).state, 'syncing');
  // And the moment the pulse expires the verdict underneath is back.
  assert.equal(
    syncIndicator({ hasMarker: true, health: 'auth', syncingUntil: T0, now: T0 }).state,
    'error'
  );
});

test('re-checking a folder does not flicker: a known verdict stays visible', () => {
  // The amber state is reserved for a folder whose verdict is unknown, so a
  // heartbeat fired on focus keeps showing the previous colour until it lands.
  const indicator = syncIndicator({ hasMarker: true, health: 'ok', now: T0 });
  assert.equal(indicator.state, 'connected');
});

test('verified ages read as seconds, minutes and hours', () => {
  assert.equal(verifiedAge(T0 - 5_000, T0), '5s');
  assert.equal(verifiedAge(T0 - 3 * 60_000, T0), '3m');
  assert.equal(verifiedAge(T0 - 2 * 3_600_000, T0), '2h');
  assert.equal(verifiedAge(0, T0), null);
  assert.equal(verifiedAge(null, T0), null);
});

test('the retry wait doubles away from failure and stops at the ceiling', () => {
  assert.equal(heartbeatBackoff(0), HEARTBEAT_FLOOR_MS);
  assert.equal(heartbeatBackoff(1), HEARTBEAT_FLOOR_MS * 2);
  assert.equal(heartbeatBackoff(2), HEARTBEAT_FLOOR_MS * 4);
  assert.equal(heartbeatBackoff(3), HEARTBEAT_FLOOR_MS * 8);
  // 60s * 16 would be 16 minutes; a failing connection settles at ten.
  assert.equal(heartbeatBackoff(4), HEARTBEAT_CEILING_MS);
  assert.equal(heartbeatBackoff(99), HEARTBEAT_CEILING_MS);
});

test('the gate holds back a burst, lets the window pass, and honours a forced ask', () => {
  const base = { failures: 0, hidden: false } as const;
  assert.equal(shouldHeartbeat({ ...base, lastAttemptAt: T0 - 5_000, now: T0 }), false);
  assert.equal(shouldHeartbeat({ ...base, lastAttemptAt: T0 - HEARTBEAT_FLOOR_MS, now: T0 }), true);
  // A failing connection waits longer, and a burst of failures lengthens it.
  assert.equal(
    shouldHeartbeat({ failures: 2, hidden: false, lastAttemptAt: T0 - 90_000, now: T0 }),
    false
  );
  assert.equal(
    shouldHeartbeat({ failures: 2, hidden: false, lastAttemptAt: T0 - 240_000, now: T0 }),
    true
  );
  // The dialog opening, or a push that just failed, is worth asking now.
  assert.equal(
    shouldHeartbeat({ ...base, lastAttemptAt: T0 - 1_000, now: T0, force: true }),
    true
  );
  // Nobody is looking at a hidden window, forced or not.
  assert.equal(
    shouldHeartbeat({ failures: 0, hidden: true, lastAttemptAt: 0, now: T0, force: true }),
    false
  );
});
