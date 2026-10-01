/**
 * The shim's command wire, tested without a shim and without a network.
 *
 * Two things are worth pinning and neither is the happy path. The first is that every
 * way of not getting an answer is a value rather than a throw, and that a page with no
 * secret makes no request at all: the desktop app, a deployment and an instance all
 * import this module and none of them may reach a wire. The second is that the three
 * names this module knows and the three the shim serves are one spelling in two
 * languages, which only a test can hold together, since `shim/src/lib.rs` is Rust.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SHIM_COMMAND_PATH,
  SHIM_TOKEN_HEADER,
  SHIM_TOKEN_META,
  readShimToken,
  shimCommand
} from './shim-command.ts';

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

/** A document with one meta tag in it, which is all `readShimToken` reads. */
function docWith(name: string, content: string): Pick<Document, 'querySelector'> {
  return {
    querySelector: (selector: string) =>
      selector === `meta[name="${name}"]` ? ({ getAttribute: () => content } as unknown as Element) : null
  };
}

test('the served secret is read, and anything else is no declaration at all', () => {
  assert.equal(readShimToken(docWith(SHIM_TOKEN_META, 'deadbeef')), 'deadbeef');
  assert.equal(readShimToken(docWith(SHIM_TOKEN_META, '  deadbeef  ')), 'deadbeef');
  // The declarations that belong to the other distributions are not this one.
  assert.equal(readShimToken(docWith('lithic-browser-only', '1')), null);
  assert.equal(readShimToken(docWith('lithic-build-tag', 'v2026.09.30-2116')), null);
  assert.equal(readShimToken(docWith(SHIM_TOKEN_META, '   ')), null);
  assert.equal(readShimToken(null), null);
});

test('a page with no secret makes no request at all', async () => {
  const { fetcher, seen } = fakeFetch(() => json({ ok: true }));
  const answer = await shimCommand('ping', {}, { fetcher, token: null });
  assert.deepEqual(answer, { ok: false, error: 'no-shim' });
  assert.equal(seen.length, 0, 'a page with no wire reached one anyway');
});

test('the request is a POST of that one command, with the secret in its header', async () => {
  const { fetcher, seen } = fakeFetch(() => json({ ok: true, result: { shim: true } }));
  const answer = await shimCommand('ping', {}, { fetcher, token: 'deadbeef' });
  assert.deepEqual(answer, { ok: true, result: { shim: true } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, SHIM_COMMAND_PATH);
  assert.equal(seen[0].init?.method, 'POST');
  const headers = seen[0].init?.headers as Record<string, string>;
  assert.equal(headers[SHIM_TOKEN_HEADER], 'deadbeef');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(seen[0].init?.body)), { command: 'ping', args: {} });
});

test('a command with nothing behind it is an answer, not an exception', async () => {
  const { fetcher } = fakeFetch(() => json({ ok: false, error: 'unknown-command', command: 'open-file' }));
  assert.deepEqual(await shimCommand('open-file', {}, { fetcher, token: 'deadbeef' }), {
    ok: false,
    error: 'unknown-command'
  });
});

test('every way of not getting an answer is a value', async () => {
  const failures: Handler[] = [
    () => new Response('no', { status: 403 }),
    () => new Response('no', { status: 405 }),
    () => new Response('<html>a captive portal</html>', { status: 200 }),
    () => json(null),
    () => json({ ok: 'maybe' }),
    () => {
      throw new Error('offline');
    }
  ];
  const expected = [
    { ok: false, error: 'refused', status: 403 },
    { ok: false, error: 'refused', status: 405 },
    { ok: false, error: 'unreadable' },
    { ok: false, error: 'unreadable' },
    { ok: false, error: 'refused' },
    { ok: false, error: 'unreachable' }
  ] as const;
  for (let index = 0; index < failures.length; index += 1) {
    const { fetcher } = fakeFetch(failures[index]);
    assert.deepEqual(await shimCommand('ping', {}, { fetcher, token: 'deadbeef' }), expected[index]);
  }
});

test('the shim serves the wire under the names this module uses', () => {
  // The two halves no compiler can check: one string in Rust, one in TypeScript. The
  // shim's own tests pin the behavior (which requests pass the gate, which are refused),
  // so this only holds the names together.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const shim = readFileSync(`${here}../../shim/src/lib.rs`, 'utf8');
  assert.match(shim, new RegExp(`TOKEN_META_NAME: &str = "${SHIM_TOKEN_META}"`));
  assert.match(shim, new RegExp(`COMMAND_PATH: &str = "${SHIM_COMMAND_PATH}"`));
  assert.match(shim, new RegExp(`TOKEN_HEADER: &str = "${SHIM_TOKEN_HEADER}"`));
});
