import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOOKMARKS_KEY,
  ICON_MAX_AGE_MS,
  normalizeInstanceUrl,
  readBookmarkEntries,
  readBookmarks,
  saveBookmark,
  removeBookmark,
  setBookmarkIcon,
  shouldRefreshIcon,
  fetchInstanceIcon,
  fetchInstanceIconNative,
  refreshBookmarkIcon,
  verifyInstanceUrl
} from './bookmarks.ts';

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  } as unknown as Storage;
}

test('normalizes self-host instance URLs to origin', () => {
  assert.equal(normalizeInstanceUrl('example.test/path'), 'https://example.test');
  assert.equal(normalizeInstanceUrl('http://example.test:8080/wiki'), 'http://example.test:8080');
  assert.equal(normalizeInstanceUrl('HTTP://example.test/wiki'), 'http://example.test');
  // A port is not a scheme: a host given with one keeps it.
  assert.equal(normalizeInstanceUrl('example.test:8080'), 'https://example.test:8080');
  assert.throws(() => normalizeInstanceUrl(''), /URL/);
});

test('refuses a spelled-out scheme rather than reading it as a host', () => {
  // `https://` used to be prefixed to anything without one, so `ftp://other.example`
  // parsed as the origin `https://ftp` — a bookmark to a machine that does not exist,
  // saved without a complaint.
  assert.throws(() => normalizeInstanceUrl('ftp://other.example'), /HTTP or HTTPS/);
  assert.throws(() => normalizeInstanceUrl('file:///c:/liths/wiki.lith'), /HTTP or HTTPS/);
  assert.throws(() => normalizeInstanceUrl('mailto:someone@example.test'), /HTTP or HTTPS/);
  // No host at all: `https:foo` parses, but its origin is the string `null`.
  assert.throws(() => normalizeInstanceUrl('https:foo'), /URL/);
});

test('deduplicates and removes local instance bookmarks', () => {
  const store = storage();
  assert.deepEqual(saveBookmark('example.test/path', store), [
    { url: 'https://example.test', label: 'example.test' }
  ]);
  assert.deepEqual(saveBookmark('https://example.test/other', store), [
    { url: 'https://example.test', label: 'example.test' }
  ]);
  const two = saveBookmark('https://second.test', store);
  assert.deepEqual(two.map((entry) => entry.url), ['https://second.test', 'https://example.test']);
  assert.deepEqual(removeBookmark('https://second.test', store).map((entry) => entry.url), ['https://example.test']);
  assert.deepEqual(readBookmarks(store), ['https://example.test']);
});

test('legacy string bookmarks migrate to labeled entries', () => {
  const store = storage();
  store.setItem(BOOKMARKS_KEY, JSON.stringify(['https://work.test', 'http://home.local:8080/', 42, '']));
  assert.deepEqual(readBookmarkEntries(store), [
    { url: 'https://work.test', label: 'work.test' },
    { url: 'http://home.local:8080', label: 'home.local:8080' }
  ]);
});

test('a cached icon survives re-bookmarking and is dropped on request', () => {
  const store = storage();
  saveBookmark('https://work.test', store);
  const withIcon = setBookmarkIcon('https://work.test', 'data:image/png;base64,AAA', store, 1000);
  assert.deepEqual(withIcon, [
    { url: 'https://work.test', label: 'work.test', icon: 'data:image/png;base64,AAA', iconFetchedAt: 1000 }
  ]);

  // Re-adding the same instance keeps the icon instead of losing it.
  const again = saveBookmark('https://work.test/other', store);
  assert.equal(again[0].icon, 'data:image/png;base64,AAA');

  // Removing the icon leaves a clean entry (no undefined keys in storage).
  const cleared = setBookmarkIcon('https://work.test', null, store);
  assert.deepEqual(cleared, [{ url: 'https://work.test', label: 'work.test' }]);
  assert.ok(!('icon' in JSON.parse(store.getItem(BOOKMARKS_KEY) ?? '[]')[0]));
});

// "Don't ask again" is gone: the modal that offers to save a login is now the only
// place a password can be typed, so the answer it stood for is the modal's own
// "open without saving" button.
test('a stored "do not ask again" is not read, and does not survive a re-save', () => {
  const store = storage();
  store.setItem(
    BOOKMARKS_KEY,
    JSON.stringify([{ url: 'https://work.test', label: 'work.test', manualAuth: true }])
  );
  assert.ok(
    !('manualAuth' in readBookmarkEntries(store)[0]),
    'the flag is dropped as the entry is read, so nothing downstream can branch on it'
  );
  // The old bytes stay until something writes, and the write is what clears them.
  saveBookmark('https://work.test', store);
  assert.ok(!('manualAuth' in JSON.parse(store.getItem(BOOKMARKS_KEY) ?? '[]')[0]));

  // And a legacy entry (a bare URL string) still reads back as an entry.
  const legacy = storage();
  legacy.setItem(BOOKMARKS_KEY, JSON.stringify(['https://old.test']));
  assert.equal(readBookmarkEntries(legacy)[0].label, 'old.test');
});

test('icon refresh policy is missing-or-stale', () => {
  const fresh = { url: 'https://a.test', label: 'a.test', icon: 'data:,', iconFetchedAt: 1000 };
  assert.equal(shouldRefreshIcon(fresh, 1000 + ICON_MAX_AGE_MS), false);
  assert.equal(shouldRefreshIcon(fresh, 1000 + ICON_MAX_AGE_MS + 1), true);
  assert.equal(shouldRefreshIcon({ url: 'https://a.test', label: 'a.test' }, 1000), true);
  // A cached icon with no timestamp (older storage) counts as stale.
  assert.equal(shouldRefreshIcon({ url: 'https://a.test', label: 'a.test', icon: 'data:,' }, 1000), true);
});

test('fetchInstanceIcon prefers the 32px icon and caches it as a data URL', async () => {
  const requests: string[] = [];
  const fetcher = (async (url: string) => {
    requests.push(url);
    if (url.endsWith('/favicon-32x32.png')) {
      return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  }) as unknown as typeof fetch;

  const icon = await fetchInstanceIcon('https://work.test', fetcher);
  assert.deepEqual(requests, ['https://work.test/favicon-32x32.png']);
  assert.equal(icon, `data:image/png;base64,${btoa(String.fromCharCode(1, 2, 3))}`);
});

test('fetchInstanceIcon falls back to favicon.ico and gives up quietly', async () => {
  const requests: string[] = [];
  const fetcher = (async (url: string) => {
    requests.push(url);
    if (url.endsWith('/favicon.ico')) {
      return new Response(new Blob([new Uint8Array([9])], { type: 'image/x-icon' }), { status: 200 });
    }
    return new Response('', { status: 403 });
  }) as unknown as typeof fetch;
  assert.match((await fetchInstanceIcon('https://protected.test', fetcher)) ?? '', /^data:image\/x-icon;base64,/);
  assert.deepEqual(requests, ['https://protected.test/favicon-32x32.png', 'https://protected.test/favicon.ico']);

  // Protected instances answer 401 with an HTML login page — no icon, no throw.
  const protectedFetcher = (async () => new Response('<html>login</html>', { status: 401 })) as unknown as typeof fetch;
  assert.equal(await fetchInstanceIcon('https://protected.test', protectedFetcher), null);

  const offline = (async () => { throw new Error('network'); }) as unknown as typeof fetch;
  assert.equal(await fetchInstanceIcon('https://offline.test', offline), null);
});

test('refreshBookmarkIcon only fetches when the cache is missing or stale', async () => {
  const store = storage();
  saveBookmark('https://work.test', store);
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    return new Response(new Blob([new Uint8Array([7])], { type: 'image/png' }), { status: 200 });
  }) as unknown as typeof fetch;

  const first = await refreshBookmarkIcon('https://work.test', fetcher, store, 1000);
  assert.equal(calls, 1);
  assert.equal(first[0].iconFetchedAt, 1000);

  await refreshBookmarkIcon('https://work.test', fetcher, store, 2000);
  assert.equal(calls, 1, 'a fresh icon must not be re-fetched');

  await refreshBookmarkIcon('https://work.test', fetcher, store, 1000 + ICON_MAX_AGE_MS + 1);
  assert.equal(calls, 2, 'a stale icon is refreshed');

  // An unknown URL is a no-op rather than a request.
  await refreshBookmarkIcon('https://never-bookmarked.test', fetcher, store, 1000);
  assert.equal(calls, 2);
});

test('verifyInstanceUrl accepts a Lithic manifest', async () => {
  const fetcher = async () => new Response(JSON.stringify({ name: 'Lithic' }), { status: 200 });
  assert.deepEqual(await verifyInstanceUrl('https://example.test', fetcher), { verified: true });
});

test('verifyInstanceUrl rejects non-Lithic manifests', async () => {
  const wrongManifest = async () => new Response(JSON.stringify({ name: 'Other' }), { status: 200 });
  assert.deepEqual(await verifyInstanceUrl('https://example.test', wrongManifest), { verified: false });
});

test('a host that answers nothing is reported as unreachable, not as a wrong instance', async () => {
  const networkFailure = async () => { throw new Error('network'); };
  assert.deepEqual(await verifyInstanceUrl('https://example.test', networkFailure), {
    verified: false,
    unreachable: true
  });
});

test('verifyInstanceUrl flags protected instances for manual confirmation', async () => {
  const protectedResponse = async () => new Response('', { status: 401 });
  assert.deepEqual(await verifyInstanceUrl('https://example.test', protectedResponse), { verified: true, requiresManualConfirm: true });
});

test('a blocked-but-answering instance is confirmed by hand, not refused', async () => {
  // The measured case: a self-hosted instance serves /manifest.json with 200 and
  // no Access-Control-Allow-Origin, which the browser withholds entirely, so the
  // readable fetch rejects exactly like a dead host would. The opaque probe is
  // the one bit that tells them apart, and without it a working instance is
  // reported as "not a Lithic instance".
  const modes: Array<string | undefined> = [];
  const blockedButAlive: typeof fetch = async (_input, init) => {
    modes.push(init?.mode);
    if (init?.mode === 'no-cors') return new Response('', { status: 200 });
    throw new TypeError('Failed to fetch');
  };
  assert.deepEqual(await verifyInstanceUrl('https://personal.example', blockedButAlive), {
    verified: true,
    requiresManualConfirm: true
  });
  assert.deepEqual(modes, [undefined, 'no-cors'], 'the readable fetch is tried first');
});

test('the native icon loader caches bytes as a data URL', async () => {
  const png = [137, 80, 78, 71, 13, 10, 26, 10];
  const dataUrl = await fetchInstanceIconNative('https://example.test', async () => ({
    content_type: 'image/png',
    bytes: png
  }));
  assert.match(dataUrl ?? '', /^data:image\/png;base64,/);
  assert.equal(
    Buffer.from((dataUrl ?? '').split(',')[1], 'base64').subarray(0, 4).toString('hex'),
    '89504e47'
  );
  // Nothing fetched, nothing oversized, and a failure all land on null rather
  // than a broken image in the list.
  assert.equal(await fetchInstanceIconNative('https://example.test', async () => null), null);
  assert.equal(await fetchInstanceIconNative('https://example.test', async () => ({ bytes: [] })), null);
  assert.equal(await fetchInstanceIconNative('https://example.test', async () => { throw new Error('no'); }), null);
});

test('a bookmark icon is fetched through Rust when the desktop app offers it', async () => {
  const store = storage();
  saveBookmark('https://work.test', store);
  let browserCalls = 0;
  const fetcher = async () => {
    browserCalls += 1;
    return new Response('', { status: 200 });
  };
  const entries = await refreshBookmarkIcon('https://work.test', fetcher, store, 1000, async () => ({
    content_type: 'image/png',
    bytes: [1, 2, 3]
  }));
  assert.match(entries[0].icon ?? '', /^data:image\/png;base64,/);
  assert.equal(browserCalls, 0, 'the native loader is preferred: the browser cannot read a CORS-less host');
});
