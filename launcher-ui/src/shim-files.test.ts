/**
 * The shim's file backend, tested without a shim and without a network.
 *
 * Three things are worth pinning. The first is that each helper frames the command the
 * shim's own dispatcher answers, since the names live in two languages the compiler cannot
 * compare. The second is that a failure is a value (`error`) and never a throw, because
 * every caller falls back to the browser's picker on one. The third is the path helpers,
 * which decide the row a pick produces.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SHIM_TOKEN_META } from './shim-command.ts';
import { basename, dirname, hasShimBackend, shimList, shimPick, shimRead, shimStartupPath, shimWrite } from './shim-files.ts';

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

function docWith(name: string, content: string): Pick<Document, 'querySelector'> {
  return {
    querySelector: (selector: string) =>
      selector === `meta[name="${name}"]` ? ({ getAttribute: () => content } as unknown as Element) : null
  };
}

test('a path is split for a row name whichever separator the platform writes', () => {
  assert.equal(basename('/home/a/notes.lith'), 'notes.lith');
  assert.equal(basename('C:\\Users\\a\\notes.lith'), 'notes.lith');
  assert.equal(basename('notes.lith'), 'notes.lith');
  assert.equal(dirname('/home/a/notes.lith'), '/home/a');
  assert.equal(dirname('notes.lith'), null);
});

test('a page holds a backend exactly when it holds the secret', () => {
  assert.equal(hasShimBackend(docWith(SHIM_TOKEN_META, 'deadbeef')), true);
  assert.equal(hasShimBackend(docWith(SHIM_TOKEN_META, '  ')), false);
  assert.equal(hasShimBackend(docWith('lithic-browser-only', '1')), false);
  assert.equal(hasShimBackend(null), false);
});

test('a pick asks for the mode and the multiplicity, and reads the paths back', async () => {
  const { fetcher, seen } = fakeFetch(() => json({ ok: true, result: { paths: ['/home/a/one.lith', '/home/a/two.lith'] } }));
  const picked = await shimPick('open', { multiple: true, startDir: '/home/a' }, { fetcher, token: 'deadbeef' });
  assert.deepEqual(picked, { ok: true, value: { paths: ['/home/a/one.lith', '/home/a/two.lith'] } });
  // Compared as the serialized body, because a key whose value is undefined never reaches the
  // wire at all, and that is the behavior worth pinning.
  assert.equal(
    String(seen[0].init?.body),
    JSON.stringify({ command: 'pick', args: { mode: 'open', multiple: true, suggestedName: undefined, startDir: '/home/a' } })
  );

  const save = fakeFetch(() => json({ ok: true, result: { paths: [] } }));
  await shimPick('save', { multiple: true, suggestedName: 'notes.lith' }, { fetcher: save.fetcher, token: 'deadbeef' });
  // A save is one path by definition, so the multiplicity is not sent for it.
  assert.equal(
    String(save.seen[0].init?.body),
    JSON.stringify({ command: 'pick', args: { mode: 'save', multiple: false, suggestedName: 'notes.lith', startDir: undefined } })
  );
});

test('read, write, list and startup each frame the command the shim answers', async () => {
  const { fetcher, seen } = fakeFetch(() => json({ ok: true, result: {} }));
  await shimRead('/home/a/one.lith', { fetcher, token: 'deadbeef' });
  await shimWrite('/home/a/one.lith', 'text', { fetcher, token: 'deadbeef' });
  await shimList(undefined, { fetcher, token: 'deadbeef' });
  await shimList('/home/a', { fetcher, token: 'deadbeef' });
  await shimStartupPath({ fetcher, token: 'deadbeef' });
  assert.deepEqual(answerBody(seen[0].init), { command: 'read', args: { path: '/home/a/one.lith' } });
  assert.deepEqual(answerBody(seen[1].init), { command: 'write', args: { path: '/home/a/one.lith', text: 'text' } });
  assert.deepEqual(answerBody(seen[2].init), { command: 'list', args: {} });
  assert.deepEqual(answerBody(seen[3].init), { command: 'list', args: { path: '/home/a' } });
  assert.deepEqual(answerBody(seen[4].init), { command: 'startup', args: {} });
});

test('every failure is a value rather than a throw, so a caller can fall back', async () => {
  const { fetcher } = fakeFetch(() => new Response('no', { status: 403 }));
  assert.deepEqual(await shimPick('open', {}, { fetcher, token: 'deadbeef' }), { ok: false, error: 'refused' });
  assert.deepEqual(await shimRead('/home/a/one.lith', { fetcher, token: 'deadbeef' }), { ok: false, error: 'refused' });
  // A refusal from the shim's own dispatcher (a command-level code) is a value too.
  const { fetcher: noPicker } = fakeFetch(() => json({ ok: false, error: 'no-picker' }));
  assert.deepEqual(await shimPick('open', {}, { fetcher: noPicker, token: 'deadbeef' }), { ok: false, error: 'no-picker' });
});

test('the commands this module sends are the commands the shim dispatches', () => {
  // The names live in Rust and TypeScript, so only a test can hold them together. The shim's
  // own tests pin what each one does; this only holds the vocabulary in agreement.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const shim = readFileSync(`${here}../../shim/src/command.rs`, 'utf8');
  for (const command of ['ping', 'startup', 'pick', 'read', 'write', 'list']) {
    assert.match(shim, new RegExp(`"${command}" =>`), `the shim does not dispatch ${command}`);
  }
});
