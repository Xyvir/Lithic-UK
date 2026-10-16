/**
 * The status line's two deadlines.
 *
 * The thresholds are the contract this file exists to hold, so they are asserted rather than
 * left to the source: a status line is transient by definition, and the moment it may stand for
 * longer than a minute it is the stuck line the deadline was added to prevent. The timers are
 * injected, so nothing here waits on a clock.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  armStatusDeadlines,
  STATUS_CLEAR_MS,
  STATUS_SETTLE_MS,
  statusPhase,
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

test('a status is transient: the line cannot outlive a minute', () => {
  assert.ok(STATUS_SETTLE_MS > 0, 'a line must not settle before it has been drawn');
  assert.ok(STATUS_SETTLE_MS < STATUS_CLEAR_MS, 'the movement stops before the sentence goes');
  assert.ok(
    STATUS_CLEAR_MS >= 30_000,
    `clearing inside ${STATUS_CLEAR_MS}ms would take lines away while they are still being read`
  );
  assert.ok(
    STATUS_CLEAR_MS <= 60_000,
    `a status line may stand for at most a minute, and this one stands ${STATUS_CLEAR_MS}ms`
  );
});

test('the phase follows the two thresholds, not the animation', () => {
  assert.equal(statusPhase(0), 'fresh');
  assert.equal(statusPhase(STATUS_SETTLE_MS - 1), 'fresh');
  assert.equal(statusPhase(STATUS_SETTLE_MS), 'settled');
  assert.equal(statusPhase(STATUS_CLEAR_MS - 1), 'settled');
  assert.equal(statusPhase(STATUS_CLEAR_MS), 'expired');
  assert.equal(statusPhase(STATUS_CLEAR_MS * 100), 'expired');
});

test('arming a line sets both deadlines, and settling leaves the sentence alone', () => {
  const timers = fakeTimers();
  const seen: string[] = [];
  armStatusDeadlines({ settle: () => seen.push('settle'), clear: () => seen.push('clear') }, timers);
  assert.deepEqual(
    timers.pending().sort((a, b) => a - b),
    [STATUS_SETTLE_MS, STATUS_CLEAR_MS]
  );

  timers.run(STATUS_SETTLE_MS);
  assert.deepEqual(seen, ['settle'], 'settling must stop the dots and keep the line');

  timers.run(STATUS_CLEAR_MS);
  assert.deepEqual(seen, ['settle', 'clear']);
});

test('a replaced line cancels both of its deadlines', () => {
  const timers = fakeTimers();
  let cleared = 0;
  const cancel = armStatusDeadlines({ settle: () => undefined, clear: () => (cleared += 1) }, timers);

  cancel();
  assert.equal(timers.cancelled.length, 2, 'both deadlines of a replaced line must be cancelled');
  assert.equal(timers.pending().length, 0);

  timers.run(STATUS_CLEAR_MS * 4);
  assert.equal(cleared, 0, 'a cancelled line must never clear the one that replaced it');
});
