/**
 * The shim's sync writes, tested without a shim and without a network.
 *
 * Three things are worth pinning. The first is the vocabulary: the command names live in Rust and
 * TypeScript, so only a test can hold them in agreement. The second is that the *job* half of the
 * protocol works, which is the part a component cannot test for itself: a job that runs, one that
 * fails, one a person cancelled, and one from a previous launch that answers `unknown`. The third
 * is that every failure is a value rather than a throw, because the launcher's flow renders one.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  awaitShimJob,
  shimClearFolderPick,
  shimCreateRepo,
  shimDeviceCode,
  shimDevicePoll,
  shimGitCancel,
  shimGitCommit,
  shimGitDisconnect,
  shimGitFolder,
  shimGitHeartbeat,
  shimGitJob,
  shimGitReauth,
  shimGitSetup,
  shimListRepos,
  shimPickFolder
} from './shim-sync.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fetcher: typeof fetch; seen: Array<{ init: RequestInit | undefined }> } {
  const seen: Array<{ init: RequestInit | undefined }> = [];
  const fetcher = ((url: unknown, init?: RequestInit) => {
    seen.push({ init });
    return Promise.resolve(handler(String(url), init));
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function body(init: RequestInit | undefined): { command: string; args: Record<string, unknown> } {
  return JSON.parse(String(init?.body));
}

const CALL = { token: 'deadbeef' } as const;

test('the writes frame the commands the shim dispatches', async () => {
  const { fetcher, seen } = fakeFetch(() => json({ ok: true, result: {} }));
  await shimGitFolder('/home/a/notes.lith', { fetcher, ...CALL });
  await shimGitFolder(null, { fetcher, ...CALL });
  await shimPickFolder('/home/a', { fetcher, ...CALL });
  await shimClearFolderPick({ fetcher, ...CALL });
  await shimGitSetup('/home/a', 'owner/name', 'ghp_x', { fetcher, ...CALL });
  await shimGitCommit('/home/a/notes.lith', 'Save notes.lith from Lithic', { fetcher, ...CALL });
  await shimGitReauth('/home/a', 'owner/name', 'ghp_x', { fetcher, ...CALL });
  await shimGitDisconnect('/home/a', { fetcher, ...CALL });
  await shimGitJob(7, { fetcher, ...CALL });
  await shimGitCancel(7, { fetcher, ...CALL });
  await shimGitHeartbeat('/home/a', { fetcher, ...CALL });
  await shimDeviceCode({ fetcher, ...CALL });
  await shimDevicePoll('device-code', { fetcher, ...CALL });
  await shimListRepos('ghp_x', { fetcher, ...CALL });
  await shimCreateRepo('ghp_x', 'lithic-sync-abcd', { fetcher, ...CALL });

  assert.deepEqual(body(seen[0].init), { command: 'git-folder', args: { derived: '/home/a/notes.lith' } });
  // A launcher with nothing to name asks the same question with no argument at all.
  assert.deepEqual(body(seen[1].init), { command: 'git-folder', args: {} });
  assert.deepEqual(body(seen[2].init), { command: 'pick-folder', args: { current: '/home/a' } });
  assert.deepEqual(body(seen[3].init), { command: 'clear-folder-pick', args: {} });
  assert.deepEqual(body(seen[4].init), {
    command: 'git-setup',
    args: { path: '/home/a', repo: 'owner/name', token: 'ghp_x' }
  });
  assert.deepEqual(body(seen[5].init), {
    command: 'git-commit',
    args: { path: '/home/a/notes.lith', message: 'Save notes.lith from Lithic' }
  });
  assert.deepEqual(body(seen[11].init), { command: 'github-device-code', args: {} });
  assert.deepEqual(body(seen[12].init), { command: 'github-device-poll', args: { deviceCode: 'device-code' } });
  assert.deepEqual(body(seen[13].init), { command: 'github-list-repos', args: { token: 'ghp_x' } });
  assert.deepEqual(body(seen[14].init), { command: 'github-create-repo', args: { token: 'ghp_x', name: 'lithic-sync-abcd' } });
});

test('every write answers a failure as a value rather than a throw', async () => {
  const { fetcher } = fakeFetch(() => new Response('no', { status: 403 }));
  assert.deepEqual(await shimGitSetup('/home/a', 'owner/name', 't', { fetcher, ...CALL }), {
    ok: false,
    error: 'refused'
  });
  assert.deepEqual(await shimGitHeartbeat('/home/a', { fetcher, ...CALL }), { ok: false, error: 'refused' });
  assert.deepEqual(await shimDeviceCode({ fetcher, ...CALL }), { ok: false, error: 'refused' });
  // A page with no secret makes no request at all: the shim's wire is not even there.
  const never = fakeFetch(() => json({ ok: true, result: {} }));
  assert.deepEqual(await shimGitHeartbeat('/home/a', { fetcher: never.fetcher, token: null }), {
    ok: false,
    error: 'no-shim'
  });
  assert.equal(never.seen.length, 0);
});

test('a job that finishes answers its result, reporting each stage once', async () => {
  const stages: string[] = [];
  const answers = [
    { ok: true, result: { state: 'running', stage: 'Reading the repository', error: null, result: null } },
    { ok: true, result: { state: 'running', stage: 'Reading the repository', error: null, result: null } },
    { ok: true, result: { state: 'running', stage: 'Pushing to GitHub', error: null, result: null } },
    { ok: true, result: { state: 'done', stage: '', error: null, result: { summary: 'Backed up' } } }
  ];
  let at = 0;
  const { fetcher } = fakeFetch(() => json(answers[Math.min(at++, answers.length - 1)]));
  const polled = await awaitShimJob<{ summary: string }>(4, {
    call: { fetcher, ...CALL },
    intervalMs: 0,
    onStage: (stage) => stages.push(stage)
  });
  assert.deepEqual(polled, { ok: true, value: { summary: 'Backed up' } });
  // The first line and the change, and not the repeat in between.
  assert.deepEqual(stages, ['Reading the repository', 'Pushing to GitHub']);
});

test('a failed, cancelled or forgotten job each end the loop with their own code', async () => {
  const failed = fakeFetch(() => json({ ok: true, result: { state: 'failed', stage: '', error: 'the push was refused', result: null } }));
  assert.deepEqual(await awaitShimJob(1, { call: { fetcher: failed.fetcher, ...CALL }, intervalMs: 0 }), {
    ok: false,
    error: 'the push was refused'
  });
  const cancelled = fakeFetch(() => json({ ok: true, result: { state: 'cancelled', stage: '', error: null, result: null } }));
  assert.deepEqual(await awaitShimJob(1, { call: { fetcher: cancelled.fetcher, ...CALL }, intervalMs: 0 }), {
    ok: false,
    error: 'cancelled'
  });
  // An id from a previous launch of the shim is an answer, not a failure to render.
  const unknown = fakeFetch(() => json({ ok: true, result: { state: 'unknown' } }));
  assert.deepEqual(await awaitShimJob(1, { call: { fetcher: unknown.fetcher, ...CALL }, intervalMs: 0 }), {
    ok: false,
    error: 'unknown-job'
  });
  // A poll the wire could not deliver stops the loop too, rather than spinning forever.
  const unreachable = fakeFetch(() => new Response('no', { status: 500 }));
  assert.deepEqual(await awaitShimJob(1, { call: { fetcher: unreachable.fetcher, ...CALL }, intervalMs: 0 }), {
    ok: false,
    error: 'refused'
  });
});

test('a github refusal carries GitHub\'s own sentence beside its code', async () => {
  // A call that reached GitHub is refused by GitHub, and its wording is what the user is shown.
  const { fetcher } = fakeFetch(() => json({ ok: false, error: 'github', detail: 'Bad credentials' }));
  assert.deepEqual(await shimDeviceCode({ fetcher, ...CALL }), {
    ok: false,
    error: 'github',
    detail: 'Bad credentials'
  });
  // A failure with no sentence has no detail, so the code is all there is.
  const bare = fakeFetch(() => json({ ok: false, error: 'no-picker' }));
  assert.deepEqual(await shimPickFolder(null, { fetcher: bare.fetcher, ...CALL }), {
    ok: false,
    error: 'no-picker'
  });
});

test('the commands this module sends are the commands the shim dispatches', () => {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const shim = readFileSync(`${here}../../shim/src/command.rs`, 'utf8');
  for (const command of [
    'git-folder',
    'pick-folder',
    'clear-folder-pick',
    'git-setup',
    'git-commit',
    'git-reauth',
    'git-disconnect',
    'git-job',
    'git-cancel',
    'git-heartbeat',
    'github-device-code',
    'github-device-poll',
    'github-list-repos',
    'github-create-repo'
  ]) {
    assert.match(shim, new RegExp(`"${command}" =>`), `the shim does not dispatch ${command}`);
  }
});
