import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FORGET_INSTANCE_COPY,
  copyDropNote,
  forgetInstanceCopy,
  type CopyDrop
} from './instance-copy.ts';

/** Records what was asked, and answers what the test told it to. */
function stubInvoke(answer: unknown) {
  const calls: { command: string; args?: Record<string, unknown> }[] = [];
  return {
    calls,
    invoke: async (command: string, args?: Record<string, unknown>) => {
      calls.push({ command, args });
      if (answer instanceof Error) throw answer;
      return answer;
    }
  };
}

test('the origin is what the app is asked to clear', async () => {
  // The literal, because the other half of this bridge is Rust's own command name and the
  // two meet exactly here.
  assert.equal(FORGET_INSTANCE_COPY, 'forget_instance_copy');
  const stub = stubInvoke({ supported: true, cleared: true });
  const drop = await forgetInstanceCopy('https://personal.lithic.uk', stub.invoke);
  assert.deepEqual(
    stub.calls,
    [{ command: 'forget_instance_copy', args: { origin: 'https://personal.lithic.uk' } }],
    'the origin alone travels: a port, a path or a label has nothing to do with which copy this is'
  );
  assert.deepEqual(drop, { supported: true, cleared: true });
  // An address with no origin is not a request for anything.
  const empty = stubInvoke({ supported: true, cleared: true });
  assert.equal(await forgetInstanceCopy('', empty.invoke), null);
  assert.deepEqual(empty.calls, [], 'nothing is asked for a row with no address to clear');
});

test('a refused command is a copy that is still there', async () => {
  // Not a throw: the × has already removed the bookmark by the time this is asked, and an
  // exception here would leave the gesture half done and unspoken.
  const refused = stubInvoke(new Error('This app cannot do that.'));
  assert.equal(await forgetInstanceCopy('https://personal.lithic.uk', refused.invoke), null);
  // An answer that is not a verdict proves nothing, so it counts as one that was not made.
  for (const nonsense of [null, undefined, 'ok', 7, { cleared: true }, { supported: true, cleared: 'yes' }]) {
    assert.equal(
      await forgetInstanceCopy('https://personal.lithic.uk', stubInvoke(nonsense).invoke),
      null,
      `${JSON.stringify(nonsense)} is not a verdict from Rust`
    );
  }
});

test('the line is said only when there is something to say', () => {
  const label = 'personal.lithic.uk';
  const drop = (answer: CopyDrop | null) => copyDropNote(label, answer);
  // The gesture worked: the row is gone and that is the whole feedback.
  assert.equal(drop({ supported: true, cleared: true }), null);
  // The app tried and could not, so the user is told which instance is still holding an
  // old copy. This is the case the whole module exists for.
  assert.equal(drop({ supported: true, cleared: false }), `Could not clear the cached copy of ${label}`);
  // No answer at all (a refused command) is the same situation as a refused clear.
  assert.equal(drop(null), `Could not clear the cached copy of ${label}`);
  // A platform with no hook never offered this, so a row that goes quietly is the whole
  // of what the × does there — and saying otherwise would invent a failure.
  assert.equal(drop({ supported: false, cleared: false }), null);
});
