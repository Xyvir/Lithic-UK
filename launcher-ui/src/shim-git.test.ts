/**
 * The shim's git sync reads, tested without a shim and without a network.
 *
 * Two things are worth pinning here, and they are the two `shim-files.test.ts` pins for the
 * file commands. The first is that each helper frames the command the shim's own dispatcher
 * answers, since the names live in two languages the compiler cannot compare. The second is
 * that a failure is a value (`error`) and never a throw, because every caller of these renders
 * "no coverage known" on one rather than failing a mount.
 *
 * The answers are the interesting half of the first point: `git-status` answering `null` is a
 * success carrying nothing, not a failure, so it must not be flattened into an error by the
 * wrapper. That has a case of its own.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { shimFolderLiths, shimGitCoverage, shimGitStatus } from './shim-git.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(handler: Handler): { fetcher: typeof fetch; seen: Array<{ url: string; init: RequestInit | undefined }> } {
  const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetcher = ((url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init });
    return Promise.resolve(handler(String(url), init));
  }) as unknown as typeof fetch;
  return { fetcher, seen };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function answerBody(init: RequestInit | undefined): { command: string; args: Record<string, unknown> } {
  return JSON.parse(String(init?.body));
}

test('the three reads frame the commands the shim dispatches', async () => {
  const { fetcher, seen } = fakeFetch(() => json({ ok: true, result: {} }));
  await shimGitStatus('/home/a/notes.lith', { fetcher, token: 'deadbeef' });
  await shimGitCoverage(['/home/a/notes.lith', '/home/b/other.lith'], { fetcher, token: 'deadbeef' });
  await shimFolderLiths('/home/a', { fetcher, token: 'deadbeef' });
  assert.deepEqual(answerBody(seen[0].init), { command: 'git-status', args: { path: '/home/a/notes.lith' } });
  assert.deepEqual(answerBody(seen[1].init), {
    command: 'git-coverage',
    args: { paths: ['/home/a/notes.lith', '/home/b/other.lith'] }
  });
  assert.deepEqual(answerBody(seen[2].init), { command: 'list-folder-liths', args: { path: '/home/a' } });
});

test('a folder nothing manages is an answer carrying null, not a failure', async () => {
  const { fetcher } = fakeFetch(() => json({ ok: true, result: null }));
  assert.deepEqual(await shimGitStatus('/home/a/notes.lith', { fetcher, token: 'deadbeef' }), {
    ok: true,
    value: null
  });
  // The status the desktop app answers for a managed folder, in the shim's own shape.
  const managed = fakeFetch(() => json({ ok: true, result: { connected: true, repo: 'owner/name', in_flight: false } }));
  assert.deepEqual(await shimGitStatus('/home/a/notes.lith', { fetcher: managed.fetcher, token: 'deadbeef' }), {
    ok: true,
    value: { connected: true, repo: 'owner/name', in_flight: false }
  });
});

test('coverage and a folder listing come back as the shapes their callers read', async () => {
  const covered = fakeFetch(() => json({ ok: true, result: { '/home/a/deep/notes.lith': '/home/a' } }));
  assert.deepEqual(await shimGitCoverage(['/home/a/deep/notes.lith'], { fetcher: covered.fetcher, token: 'deadbeef' }), {
    ok: true,
    value: { '/home/a/deep/notes.lith': '/home/a' }
  });
  const listed = fakeFetch(() => json({ ok: true, result: ['/home/a/one.lith'] }));
  assert.deepEqual(await shimFolderLiths('/home/a', { fetcher: listed.fetcher, token: 'deadbeef' }), {
    ok: true,
    value: ['/home/a/one.lith']
  });
});

test('every failure is a value rather than a throw, so a caller can fall back', async () => {
  const { fetcher } = fakeFetch(() => new Response('no', { status: 403 }));
  assert.deepEqual(await shimGitStatus('/home/a/notes.lith', { fetcher, token: 'deadbeef' }), {
    ok: false,
    error: 'refused'
  });
  assert.deepEqual(await shimGitCoverage(['/home/a/notes.lith'], { fetcher, token: 'deadbeef' }), {
    ok: false,
    error: 'refused'
  });
  // A command-level code from the shim's own dispatcher is a value too.
  const { fetcher: badArgs } = fakeFetch(() => json({ ok: false, error: 'bad-args' }));
  assert.deepEqual(await shimFolderLiths('/home/a', { fetcher: badArgs, token: 'deadbeef' }), {
    ok: false,
    error: 'bad-args'
  });
  // A page with no secret makes no request at all, which is the ordinary answer everywhere
  // but a shim.
  const never = fakeFetch(() => json({ ok: true, result: {} }));
  assert.deepEqual(await shimGitStatus('/home/a/notes.lith', { fetcher: never.fetcher, token: null }), {
    ok: false,
    error: 'no-shim'
  });
  assert.equal(never.seen.length, 0);
});

test('the commands this module sends are the commands the shim dispatches', () => {
  // The names live in Rust and TypeScript, so only a test can hold them together. The shim's
  // own tests pin what each one does; this holds the vocabulary in agreement.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const shim = readFileSync(`${here}../../shim/src/command.rs`, 'utf8');
  for (const command of ['git-status', 'git-coverage', 'list-folder-liths']) {
    assert.match(shim, new RegExp(`"${command}" =>`), `the shim does not dispatch ${command}`);
  }
});
