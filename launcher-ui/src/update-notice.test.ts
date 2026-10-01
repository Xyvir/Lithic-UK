/**
 * The shim's update notice, tested without a network.
 *
 * Two things are worth pinning here and neither is the happy path. The first is that
 * every way of not getting an answer is a *no notice* rather than a thrown error or a
 * fabricated offer, since the notice is decoration and the launcher is not. The second is
 * that the tag the shim's server writes and the tag this module reads are one name in two
 * languages, which only a test can hold together: `shim/src/lib.rs` is Rust and cannot
 * import this file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BUILD_TAG_META,
  RELEASES_LATEST_API,
  RELEASES_LATEST_PAGE,
  latestReleaseTag,
  readBuildTag,
  updateOffered
} from './update-notice.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(handler: Handler): typeof fetch {
  return ((url: unknown, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A document with one meta tag in it, which is all `readBuildTag` reads. */
function docWith(name: string, content: string): Pick<Document, 'querySelector'> {
  return {
    querySelector: (selector: string) =>
      selector === `meta[name="${name}"]` ? ({ getAttribute: () => content } as unknown as Element) : null
  };
}

test('the served tag is read, and anything else is no declaration at all', () => {
  assert.equal(readBuildTag(docWith(BUILD_TAG_META, 'v2026.09.30-2116')), 'v2026.09.30-2116');
  assert.equal(readBuildTag(docWith(BUILD_TAG_META, '  v2026.09.30-2116  ')), 'v2026.09.30-2116');
  // The declarations that belong to the other distributions are not this one.
  assert.equal(readBuildTag(docWith('lithic-browser-only', '1')), null);
  assert.equal(readBuildTag(docWith('lithic-webdav', '1')), null);
  // A tag with no value declares nothing, so it cannot be a build with one.
  assert.equal(readBuildTag(docWith(BUILD_TAG_META, '   ')), null);
  // And a page with no document at all, which is every non-browser caller.
  assert.equal(readBuildTag(null), null);
});

test('the newest release is asked for once, at the one address this module knows', async () => {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const tag = await latestReleaseTag(
    fakeFetch((url, init) => {
      seen.push({ url, init });
      return json({ tag_name: 'v2026.10.01-0900' });
    })
  );
  assert.equal(tag, 'v2026.10.01-0900');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, RELEASES_LATEST_API);
  // Unauthenticated on purpose: nothing here carries a token, so the request leaks nothing
  // about the person and cannot be rate limited into their account.
  assert.deepEqual(Object.keys(seen[0].init?.headers ?? {}), ['Accept']);
});

test('every way of not getting an answer is no notice', async () => {
  const failures: Handler[] = [
    () => new Response('rate limited', { status: 403 }),
    () => new Response('not found', { status: 404 }),
    () => new Response('<html>a captive portal</html>', { status: 200 }),
    () => json({}),
    () => json({ tag_name: 42 }),
    () => json({ tag_name: '   ' }),
    () => json(null),
    () => {
      throw new Error('offline');
    }
  ];
  for (const handler of failures) {
    assert.equal(await latestReleaseTag(fakeFetch(handler)), null, 'an unanswerable ask became a tag');
  }
});

test('a newer tag is an offer only when there is a tag to compare against', () => {
  assert.equal(updateOffered('v2026.09.30-2116', 'v2026.10.01-0900'), true);
  assert.equal(updateOffered('v2026.09.30-2116', 'v2026.09.30-2116'), false);
  // No build tag: a published deployment, an instance, the desktop app, a local build.
  assert.equal(updateOffered(null, 'v2026.10.01-0900'), false);
  // No answer from GitHub.
  assert.equal(updateOffered('v2026.09.30-2116', null), false);
  assert.equal(updateOffered(null, null), false);
  assert.equal(updateOffered('', ''), false);
});

test('the shim serves the tag under the name this module reads', () => {
  // The pair that no compiler can check: one string in Rust, one in TypeScript. The shim's
  // own test pins the other half of the mechanism (that a build with a tag serves one and a
  // build without serves none), so this one only holds the name together.
  const here = fileURLToPath(new URL('.', import.meta.url));
  const shim = readFileSync(`${here}../../shim/src/lib.rs`, 'utf8');
  assert.match(shim, new RegExp(`BUILD_TAG_META_NAME: &str = "${BUILD_TAG_META}"`));
  // And the tag the served one is compiled from, which the release workflow sets from the
  // same tag output the Tauri job bakes into the exe.
  assert.match(shim, /option_env!\("LITHIC_BUILD_TAG"\)/);
});

test('the notice opens the releases page rather than choosing a file', () => {
  assert.equal(RELEASES_LATEST_PAGE, 'https://github.com/Xyvir/Lithic-UK/releases/latest');
  assert.ok(!RELEASES_LATEST_PAGE.endsWith('.AppImage'), 'the notice must not pick a download for the user');
});
