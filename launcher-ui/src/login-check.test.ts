import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGIN_CHECK_LABELS,
  askInstanceAboutLogin,
  loginVerdict,
  loginVerdictFromError,
  typedLoginCheck,
  type LoginVerdict
} from './login-check.ts';

/** Long enough for a 2ms settle timer plus the promise jobs behind it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('an outcome Rust sends becomes the state the launcher classes it as', () => {
  assert.deepEqual(loginVerdict('accepted', 'ok'), { state: 'accepted', detail: 'ok' });
  assert.deepEqual(loginVerdict('not-required', 'no prompt'), { state: 'not-required', detail: 'no prompt' });
  // A word this build has never heard of must not read as "fine".
  assert.deepEqual(loginVerdict('something-new', 'why'), { state: 'unclear', detail: 'why' });
});

test('a check that could not be made proves nothing about the password', () => {
  assert.deepEqual(loginVerdictFromError(new Error('Tauri API unavailable')), {
    state: 'unreachable',
    detail: 'Tauri API unavailable'
  });
  assert.deepEqual(loginVerdictFromError('gone'), { state: 'unreachable', detail: 'gone' });
});

test('the check is one command, carrying the typed login and nothing else', async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const verdict = await askInstanceAboutLogin('https://work.test', 'me', 'hunter2', async (command, args) => {
    calls.push({ command, args });
    return { outcome: 'refused', status: 401, detail: 'The instance refused this login (401).' };
  });
  assert.deepEqual(calls, [
    {
      command: 'check_login_for_instance',
      args: { origin: 'https://work.test', user: 'me', password: 'hunter2' }
    }
  ]);
  assert.deepEqual(verdict, { state: 'refused', detail: 'The instance refused this login (401).' });
});

test('a command that refused is reported as no answer rather than as a refusal', async () => {
  const verdict = await askInstanceAboutLogin('https://work.test', 'me', 'x', async () => {
    throw new Error('Tauri API unavailable');
  });
  assert.equal(verdict.state, 'unreachable');
});

test('nothing is asked until all three boxes hold something', async () => {
  const asked: string[] = [];
  const reports: Array<LoginVerdict | null> = [];
  const check = typedLoginCheck((verdict) => reports.push(verdict), 2, async (_origin, _user, password) => {
    asked.push(password);
    return { state: 'accepted', detail: 'ok' };
  });
  check('https://work.test', 'me', '');
  check('https://work.test', '', 'one');
  check('', 'me', 'one');
  await settle();
  // Every call still cleared whatever was on screen: a half-filled form has no verdict.
  assert.deepEqual(asked, []);
  assert.deepEqual(reports, [null, null, null]);
});

test('a login is asked about as soon as it is typed, with no second password box', async () => {
  const asked: string[] = [];
  const reports: Array<LoginVerdict | null> = [];
  const check = typedLoginCheck((verdict) => reports.push(verdict), 2, async (_origin, _user, password) => {
    asked.push(password);
    return { state: 'accepted', detail: 'ok' };
  });
  // Three keystrokes' worth of calls, of which only the last may reach the network.
  check('https://work.test', 'me', 'one');
  check('https://work.test', 'me', 'two');
  check('https://work.test', 'me', 'three');
  await settle();
  assert.deepEqual(asked, ['three']);
  assert.deepEqual(reports[reports.length - 1], { state: 'accepted', detail: 'ok' });
  assert.equal(reports[reports.length - 2]?.state, 'busy');
});

test('editing a box clears the verdict, and an answer about the old text is dropped', async () => {
  const reports: Array<LoginVerdict | null> = [];
  const pending: Array<(verdict: LoginVerdict) => void> = [];
  const check = typedLoginCheck(
    (verdict) => reports.push(verdict),
    2,
    () => new Promise<LoginVerdict>((resolve) => pending.push(resolve))
  );
  check('https://work.test', 'me', 'one');
  await settle();
  assert.deepEqual(reports[reports.length - 1], { state: 'busy', detail: LOGIN_CHECK_LABELS.busy });
  // The password is corrected while the first question is still out.
  check('https://work.test', 'me', 'two');
  await settle();
  assert.equal(pending.length, 2);
  // The answer to the password nobody is looking at any more arrives first.
  pending[0]({ state: 'refused', detail: 'stale' });
  await settle();
  assert.equal(reports[reports.length - 1]?.state, 'busy');
  pending[1]({ state: 'accepted', detail: 'ok' });
  await settle();
  assert.deepEqual(reports[reports.length - 1], { state: 'accepted', detail: 'ok' });
  assert.equal(reports.some((verdict) => verdict?.detail === 'stale'), false);
});
