import test from 'node:test';
import assert from 'node:assert/strict';

import { createStageBeat, FALLBACK_BEAT_MS, MAX_FAILURES, MIN_BEAT_MS, type StageAnswer } from './launcher-stage.ts';

/**
 * A beat with the timers in the test's hands: every beat is one `invoke` call, and every
 * cadence it asks for is a callback waiting to be run.
 */
function harness(options: { answers?: Array<StageAnswer | Error>; kind?: 'launcher' | 'wiki' } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const pending: Array<{ callback: () => void; ms: number }> = [];
  const cleared: unknown[] = [];
  let closed = 0;
  const script = options.answers ? [...options.answers] : null;

  const beat = createStageBeat({
    invoke: (command, args) => {
      calls.push({ command, ...args });
      const next = script ? script.shift() : {};
      if (next instanceof Error) return Promise.reject(next);
      return Promise.resolve(next ?? {});
    },
    onClose: () => {
      closed += 1;
    },
    kind: options.kind,
    setTimer: (callback, ms) => {
      pending.push({ callback, ms });
      return pending.length - 1;
    },
    clearTimer: (handle) => {
      cleared.push(handle);
    }
  });

  /** Run the cadence the beat is waiting on, and let its beat finish. */
  const tick = async () => {
    const next = pending.shift();
    assert.ok(next, 'the beat asked for no cadence, so there is nothing to run');
    next.callback();
    await Promise.resolve();
    await Promise.resolve();
  };

  return { beat, calls, pending, cleared, tick, closed: () => closed };
}

test('a beat names the window straight away and on every cadence after', async () => {
  const { beat, calls, pending, tick } = harness();
  await beat.start();

  assert.deepEqual(calls, [{ command: 'launcher_stage', stage: 'launcher', wiki: null }]);
  assert.equal(pending.length, 1, 'the first beat schedules the next');
  assert.equal(pending[0].ms, FALLBACK_BEAT_MS, 'an app that names no cadence gets the fallback');

  await tick();
  assert.equal(calls.length, 2, 'and the beat goes on for as long as the window lives');
  await tick();
  assert.equal(calls.length, 3);
});

test('the cadence is the app own, with a floor under a zero', async () => {
  const { beat, pending } = harness({ answers: [{ beat_ms: 5000 }, { beat_ms: 0 }] });
  await beat.start();
  assert.equal(pending[0].ms, 5000, 'the cadence the app served is the one used');
  const first = pending.shift()!;
  first.callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(pending[0].ms, MIN_BEAT_MS, 'and a zero is a floor rather than a spin');
});

test('a window that hands its document to a Lith says so at once, and says when it is back', async () => {
  const { beat, calls, pending, tick } = harness();
  await beat.start();
  assert.equal(calls.length, 1);

  // The transition that matters: the engine has taken the document over, so the next beat must
  // not wait out a cadence while an install still reads this window as an idle launcher.
  beat.stage('wiki', 'notes.lith');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls[1], { command: 'launcher_stage', stage: 'wiki', wiki: 'notes.lith' });

  beat.stage('launcher');
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(calls[2], { command: 'launcher_stage', stage: 'launcher', wiki: null });

  // A stage that has not changed is not worth a beat: the cadence already says it.
  const said = calls.length;
  beat.stage('launcher');
  await Promise.resolve();
  assert.equal(calls.length, said);
  await tick();
  assert.equal(calls.length, said + 1);
});

test('a close request is answered once, and the beat ends with it', async () => {
  const { beat, calls, pending, closed } = harness({ answers: [{ close: true }] });
  await beat.start();
  assert.equal(closed(), 1, 'the app asked, and the window answered');
  assert.equal(pending.length, 0, 'a closing window beats no more');
  beat.stage('wiki', 'notes.lith');
  await Promise.resolve();
  assert.equal(calls.length, 1, 'and nothing is said on the way out');

  // And a plain stop is the other end, with no request behind it.
  const stopped = harness();
  await stopped.beat.start();
  stopped.beat.stop();
  stopped.beat.stage('wiki', 'later.lith');
  await Promise.resolve();
  assert.equal(stopped.calls.length, 1);
  assert.equal(stopped.closed(), 0, 'a stop is not a close');
});

test('a beat that fails is retried, and a launcher with nothing behind it gives up', async () => {
  const { beat, calls, pending } = harness({
    answers: [new Error('no such command'), new Error('no such command'), new Error('no such command')]
  });
  await beat.start();
  assert.equal(calls.length, 1);
  assert.equal(pending.length, 1, 'one missed beat is not a window that has gone');
  await pending.shift()!.callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(pending.length, 1, 'nor are two');
  await pending.shift()!.callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, MAX_FAILURES);
  assert.equal(pending.length, 0, 'three in a row is nothing behind the page, and it stops asking');
});

test('a beat that recovers after a failure keeps going', async () => {
  const { beat, calls, pending } = harness({ answers: [new Error('offline'), { close: false }] });
  await beat.start();
  await pending.shift()!.callback();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.length, 2);
  assert.equal(pending.length, 1, 'the beat after a successful one is scheduled as usual');
});
