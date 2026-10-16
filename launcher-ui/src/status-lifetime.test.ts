/**
 * The status line's one deadline.
 *
 * The threshold is the contract this file exists to hold, so it is asserted rather than left to
 * the source: a status line is transient by definition, and the moment it may stand for longer
 * than a minute it is the stuck line the deadline was added to prevent. It also has a floor,
 * because a line that vanishes before a reader can take it in is not a status either. The timers
 * are injected, so nothing here waits on a clock.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  armStatusClear,
  armStatusHold,
  STATUS_LIFETIME_MS,
  type StatusTimers
} from './status-lifetime.ts';

/** A timer set that runs nothing until the test asks, and remembers what it was asked for. */
function fakeTimers(): StatusTimers & {
  run(ms: number): void;
  pending(): number[];
  cancelled: number[];
} {
  let next = 1;
  const queued = new Map<number, { run: () => void; at: number }>();
  const cancelled: number[] = [];
  return {
    after(fn, ms) {
      const id = next++;
      queued.set(id, { run: fn, at: ms });
      return id;
    },
    cancel(id) {
      cancelled.push(id);
      queued.delete(id);
    },
    run(ms) {
      for (const [id, job] of Array.from(queued)) {
        if (job.at <= ms) {
          queued.delete(id);
          job.run();
        }
      }
    },
    pending() {
      return Array.from(queued.values()).map((job) => job.at);
    },
    cancelled
  };
}

test('a status is transient: the line cannot outlive a minute, and is not gone in a blink', () => {
  assert.ok(STATUS_LIFETIME_MS > 0, 'a line must not go before it has been drawn');
  assert.ok(
    STATUS_LIFETIME_MS >= 10_000,
    `clearing inside ${STATUS_LIFETIME_MS}ms would take lines away before they are read`
  );
  assert.ok(
    STATUS_LIFETIME_MS <= 60_000,
    `a status line may stand for at most a minute, and this one stands ${STATUS_LIFETIME_MS}ms`
  );
});

test('an ordinary line arms one deadline, and clearing is the whole of it', () => {
  const timers = fakeTimers();
  let cleared = 0;
  armStatusClear({ clear: () => (cleared += 1) }, timers);

  assert.deepEqual(timers.pending(), [STATUS_LIFETIME_MS], 'an ordinary line has a single deadline');
  assert.equal(cleared, 0, 'and it has not fired yet');

  timers.run(STATUS_LIFETIME_MS);
  assert.equal(cleared, 1, 'the line goes at the deadline, with no second stage before it');

  timers.run(STATUS_LIFETIME_MS * 10);
  assert.equal(cleared, 1, 'and nothing is left armed that could fire again');
  assert.deepEqual(timers.pending(), []);
});

test('a held line stops moving and is never taken away on a clock', () => {
  const timers = fakeTimers();
  let settled = 0;
  const cancel = armStatusHold({ settle: () => (settled += 1) }, timers);

  assert.deepEqual(
    timers.pending(),
    [STATUS_LIFETIME_MS],
    'a held line arms the same single deadline as any other'
  );

  timers.run(STATUS_LIFETIME_MS);
  assert.equal(settled, 1, 'the movement still stops, so a standing line never reads as busy');
  assert.deepEqual(timers.pending(), [], 'and nothing is left armed that could end the sentence');

  // Ten lifetimes later, an ordinary line would have gone long ago, and this one has not.
  timers.run(STATUS_LIFETIME_MS * 10);
  assert.equal(settled, 1, 'a held line must not wake again after its one deadline');

  // The cancel is what a caller uses when the line is replaced, and a hold has one timer.
  cancel();
  assert.equal(timers.cancelled.length, 1, 'cancelling a hold returns its single deadline');
  assert.equal(timers.pending().length, 0);
});

test('a replaced line cancels its deadline', () => {
  const timers = fakeTimers();
  let cleared = 0;
  const cancel = armStatusClear({ clear: () => (cleared += 1) }, timers);

  cancel();
  assert.equal(timers.cancelled.length, 1, 'a replaced line gives back its deadline');
  assert.equal(timers.pending().length, 0);

  timers.run(STATUS_LIFETIME_MS * 4);
  assert.equal(cleared, 0, 'a cancelled line must never clear the one that replaced it');
});
