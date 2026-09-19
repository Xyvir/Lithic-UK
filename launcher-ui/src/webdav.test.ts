import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WEBDAV_BASE,
  LITHIC_API_BASE,
  LOCK_STALE_MS,
  LOCK_HEARTBEAT_MS,
  webdavUrl,
  parsePropfindXml,
  fetchRemoteFiles,
  uploadRemoteFile,
  deleteRemoteFile,
  resolveSessionId,
  readRemoteLock,
  createLockHeartbeat,
  lithUploadName,
  probePatchApi,
  fetchRemoteWiki,
  applyRemotePatch,
  listRemoteVersions,
  restoreRemoteVersion,
  WEBDAV_UTILS_JS
} from './webdav.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(handler: Handler): typeof fetch {
  return ((url: unknown, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as unknown as typeof fetch;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

/** A Caddy/lighttpd-style PROPFIND response, DAV: prefixed. */
const PROPFIND = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
  <D:response>
    <D:href>/sync/</D:href>
    <D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/sync/Older.lith</D:href>
    <D:propstat><D:prop><D:getlastmodified>Mon, 01 Jan 2024 10:00:00 GMT</D:getlastmodified></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/sync/my%20work%20wiki.lith</D:href>
    <D:propstat><D:prop><D:getlastmodified>Fri, 18 Sep 2026 12:00:00 GMT</D:getlastmodified></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/sync/notes.txt</D:href>
    <D:propstat><D:prop><D:getlastmodified>Sat, 19 Sep 2026 12:00:00 GMT</D:getlastmodified></D:prop></D:propstat>
  </D:response>
  <D:response>
    <D:href>/sync/NoStamp.lith</D:href>
    <D:propstat><D:prop></D:prop></D:propstat>
  </D:response>
</D:multistatus>`;

test('parsePropfindXml lists only .lith files, newest first, skipping the collection', () => {
  const files = parsePropfindXml(PROPFIND);
  assert.deepEqual(
    files.map((file) => file.name),
    ['my work wiki.lith', 'Older.lith', 'NoStamp.lith']
  );
  assert.equal(files[0].lastModified?.toISOString(), '2026-09-18T12:00:00.000Z');
  assert.equal(files[2].lastModified, null, 'a missing getlastmodified sorts last rather than dropping the file');
});

test('parsePropfindXml tolerates other namespace forms and escaped entities', () => {
  const xml = `<multistatus>
    <response><href>https://host/sync/a&amp;b.lith</href>
      <propstat><prop><getlastmodified>Fri, 18 Sep 2026 12:00:00 GMT</getlastmodified></prop></propstat></response>
    <d:response><d:href>/sync/lower.lith</d:href></d:response>
  </multistatus>`;
  const files = parsePropfindXml(xml);
  assert.deepEqual(
    files.map((file) => file.name).sort(),
    ['a&b.lith', 'lower.lith']
  );
});

test('parsePropfindXml survives a malformed percent escape', () => {
  const xml = `<D:multistatus xmlns:D="DAV:"><D:response><D:href>/sync/100%.lith</D:href></D:response></D:multistatus>`;
  assert.deepEqual(parsePropfindXml(xml).map((file) => file.name), ['100%.lith']);
});

test('webdavUrl encodes names so spaces and specials survive the round trip', () => {
  assert.equal(webdavUrl('my wiki.lith'), '/sync/my%20wiki.lith');
  assert.equal(webdavUrl('a&b.lith'), '/sync/a%26b.lith');
  assert.equal(webdavUrl('x.lith', '/other/'), '/other/x.lith');
});

test('fetchRemoteFiles issues a Depth-1 PROPFIND and surfaces failures', async () => {
  const seen: Array<{ url: string; method?: string; depth?: string }> = [];
  const files = await fetchRemoteFiles(
    fakeFetch((url, init) => {
      seen.push({ url, method: init?.method, depth: (init?.headers as Record<string, string>)?.Depth });
      return text(PROPFIND, 207);
    })
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, WEBDAV_BASE);
  assert.equal(seen[0].method, 'PROPFIND');
  assert.equal(seen[0].depth, '1');
  assert.equal(files.length, 3);

  await assert.rejects(
    () => fetchRemoteFiles(fakeFetch(() => text('nope', 401))),
    /PROPFIND failed: 401/
  );
});

test('uploadRemoteFile PUTs and accepts 200/201/204 but rejects other failures', async () => {
  const puts: Array<{ url: string; method?: string; body?: unknown }> = [];
  for (const status of [200, 201, 204]) {
    await uploadRemoteFile(
      'my wiki.lith',
      'body',
      fakeFetch((url, init) => {
        puts.push({ url, method: init?.method, body: init?.body });
        return new Response(null, { status });
      })
    );
  }
  assert.equal(puts.length, 3);
  assert.equal(puts[0].url, '/sync/my%20wiki.lith');
  assert.equal(puts[0].method, 'PUT');
  await assert.rejects(() => uploadRemoteFile('x.lith', 'b', fakeFetch(() => new Response(null, { status: 500 }))), /PUT failed: 500/);
});

test('deleteRemoteFile DELETEs and tolerates 204', async () => {
  let method = '';
  await deleteRemoteFile('gone.lith', fakeFetch((_url, init) => {
    method = String(init?.method);
    return new Response(null, { status: 204 });
  }));
  assert.equal(method, 'DELETE');
  await assert.rejects(() => deleteRemoteFile('gone.lith', fakeFetch(() => new Response(null, { status: 403 }))), /DELETE failed: 403/);
});

test('resolveSessionId persists one id per tab and degrades without storage', () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value)
  } as unknown as Storage;

  const first = resolveSessionId(storage);
  const second = resolveSessionId(storage);
  assert.equal(first, second, 'stable within a tab so the launcher ignores its own lock');
  assert.equal(store.get('lithicSessionId'), first);

  const generated = resolveSessionId(undefined);
  assert.ok(generated.length > 0, 'works when sessionStorage is unavailable');
});

test('readRemoteLock ignores our own, stale, and absent locks', async () => {
  const now = Date.UTC(2026, 8, 18, 12, 0, 0);
  const lockOf = (payload: unknown, status = 200) => fakeFetch(() => json(payload, status));

  assert.equal(await readRemoteLock('a.lith', 'me', lockOf({ sessionId: 'me', timestamp: now }), now), null);
  assert.equal(
    await readRemoteLock('a.lith', 'me', lockOf({ sessionId: 'other', timestamp: now - LOCK_STALE_MS - 1 }), now),
    null,
    'a lock past the staleness window is treated as dead'
  );
  assert.equal(await readRemoteLock('a.lith', 'me', lockOf({}, 404), now), null, 'no lock file means free');
  assert.equal(await readRemoteLock('a.lith', 'me', lockOf('not json at all', 200), now), null);
  assert.equal(await readRemoteLock('a.lith', 'me', fakeFetch(() => { throw new Error('offline'); }), now), null);

  const held = await readRemoteLock('a.lith', 'me', lockOf({ sessionId: 'other', timestamp: now - 1000 }), now);
  assert.deepEqual(held, { sessionId: 'other', timestamp: now - 1000 });
});

test('createLockHeartbeat PUTs immediately, on every tick, and DELETEs on stop', async () => {
  const calls: Array<{ url: string; method?: string; body?: string; keepalive?: boolean }> = [];
  let tick: (() => void) | null = null;
  let cleared: unknown = null;

  const heartbeat = createLockHeartbeat({
    sessionId: 's1',
    fetcher: fakeFetch((url, init) => {
      calls.push({ url, method: init?.method, body: init?.body as string | undefined, keepalive: (init as RequestInit & { keepalive?: boolean })?.keepalive });
      return new Response(null, { status: 204 });
    }),
    now: () => 1234,
    setIntervalImpl: (callback, ms) => {
      assert.equal(ms, LOCK_HEARTBEAT_MS, 'heartbeat cadence matches the server staleness window');
      tick = callback;
      return 'timer-handle';
    },
    clearIntervalImpl: (handle) => {
      cleared = handle;
    }
  });

  await heartbeat.start('my wiki.lith');
  assert.equal(heartbeat.current(), 'my wiki.lith');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/sync/my%20wiki.lith.lock');
  assert.equal(calls[0].method, 'PUT');
  assert.deepEqual(JSON.parse(calls[0].body!), { user: 'Someone', timestamp: 1234, sessionId: 's1' });

  (tick as unknown as () => void)();
  assert.equal(calls.length, 2, 'the interval keeps the lock fresh');

  heartbeat.stop();
  assert.equal(heartbeat.current(), null);
  assert.equal(cleared, 'timer-handle');
  const release = calls[calls.length - 1];
  assert.equal(release.method, 'DELETE');
  assert.equal(release.keepalive, true, 'a teardown DELETE must outlive the page');

  heartbeat.stop();
  assert.equal(calls.length, 3, 'stopping twice is harmless');
});

test('createLockHeartbeat never blocks editing when presence fails', async () => {
  const heartbeat = createLockHeartbeat({
    sessionId: 's1',
    fetcher: fakeFetch(() => {
      throw new Error('offline');
    }),
    setIntervalImpl: () => 'handle',
    clearIntervalImpl: () => {}
  });
  await heartbeat.start('a.lith');
  assert.equal(heartbeat.current(), 'a.lith');
  heartbeat.stop();
});

test('lithUploadName normalises uploads to .lith', () => {
  assert.equal(lithUploadName('wiki.lith'), 'wiki.lith');
  assert.equal(lithUploadName('wiki.LITH'), 'wiki.LITH');
  assert.equal(lithUploadName('backup.json'), 'backup.lith');
  assert.equal(lithUploadName('no-extension'), 'no-extension.lith');
});

test('WEBDAV_UTILS_JS wires the engine-side lock release', () => {
  assert.match(WEBDAV_UTILS_JS, /tm-lithic-stop-lock/);
  assert.match(WEBDAV_UTILS_JS, /webdavStopHeartbeat/);
  assert.match(WEBDAV_UTILS_JS, /module-type: startup/);
});

test('probePatchApi gates the git path on the instance capability', async () => {
  assert.equal(await probePatchApi(fakeFetch(() => json({ service: 'lithic-sync', version: 1 }))), true);
  assert.equal(await probePatchApi(fakeFetch(() => json({ service: 'something-else' }))), false);
  assert.equal(await probePatchApi(fakeFetch(() => json({ error: 'route_not_found' }, 404))), false, 'an older instance 404s and falls back to PUT');
  assert.equal(await probePatchApi(fakeFetch(() => { throw new Error('offline'); })), false);
  assert.equal(await probePatchApi(fakeFetch(() => text('<html>not json</html>'))), false);
});

test('fetchRemoteWiki returns the text with the digest the server will verify', async () => {
  let requested = '';
  const wiki = await fetchRemoteWiki(
    'my wiki.lith',
    fakeFetch((url) => {
      requested = url;
      return text('title: A\n\nbody\n', 200, { 'X-Lithic-Digest': 'abc123', 'X-Lithic-Rev': 'deadbeef' });
    })
  );
  assert.equal(requested, `${LITHIC_API_BASE}file?file=my%20wiki.lith`);
  assert.equal(wiki.text, 'title: A\n\nbody\n');
  assert.equal(wiki.digest, 'abc123');
  assert.equal(wiki.rev, 'deadbeef');
  await assert.rejects(() => fetchRemoteWiki('x.lith', fakeFetch(() => text('', 404))), /Failed to fetch x.lith: 404/);
});

test('applyRemotePatch frames the request as name/base/patch and reports success', async () => {
  let body = '';
  let contentType = '';
  const patch = '--- a/wiki.lith\n+++ b/wiki.lith\n@@ -1 +1 @@\n-one\n+two\n';
  const outcome = await applyRemotePatch(
    'wiki.lith',
    'digest-1',
    patch,
    fakeFetch((_url, init) => {
      body = String(init?.body);
      contentType = (init?.headers as Record<string, string>)['Content-Type'];
      return json({ status: 'ok', digest: 'digest-2' });
    })
  );
  assert.deepEqual(outcome, { ok: true, digest: 'digest-2', unchanged: false });
  assert.equal(body, `wiki.lith\ndigest-1\n${patch}`, 'the patch survives verbatim, newlines included');
  assert.match(contentType, /text\/plain/);
});

test('applyRemotePatch marks a no-op apply as unchanged', async () => {
  const outcome = await applyRemotePatch('a.lith', 'd', 'p', fakeFetch(() => json({ status: 'unchanged', digest: 'd' })));
  assert.deepEqual(outcome, { ok: true, digest: 'd', unchanged: true });
});

test('applyRemotePatch distinguishes stale, rejected, unsupported and offline', async () => {
  const stale = await applyRemotePatch('a.lith', 'd', 'p', fakeFetch(() => json({ error: 'stale', digest: 'fresh' }, 409)));
  assert.deepEqual(stale, { ok: false, reason: 'stale', digest: 'fresh', detail: 'stale' });

  const rejected = await applyRemotePatch('a.lith', 'd', 'p', fakeFetch(() => json({ error: 'patch_failed: boom' }, 422)));
  assert.equal(rejected.ok, false);
  assert.equal(rejected.ok === false && rejected.reason, 'rejected');

  const unsupported = await applyRemotePatch('a.lith', 'd', 'p', fakeFetch(() => json({ error: 'route_not_found' }, 404)));
  assert.equal(unsupported.ok === false && unsupported.reason, 'unsupported');

  const broken = await applyRemotePatch('a.lith', 'd', 'p', fakeFetch(() => new Response('not json', { status: 500 })));
  assert.equal(broken.ok === false && broken.reason, 'error');

  const offline = await applyRemotePatch('a.lith', 'd', 'p', fakeFetch(() => { throw new Error('network down'); }));
  assert.equal(offline.ok === false && offline.reason, 'error');
  assert.match(String(offline.ok === false ? offline.detail : ''), /network down/);
});

test('listRemoteVersions and restoreRemoteVersion drive the rollback UI', async () => {
  const versions = [
    { rev: 'a'.repeat(40), ts: 1758200000, author: 'Lithic Sync', subject: 'Save wiki.lith' },
    { rev: 'b'.repeat(40), ts: 1758100000, author: 'Lithic Sync', subject: 'init' }
  ];
  const listed = await listRemoteVersions('wiki.lith', fakeFetch(() => json({ file: 'wiki.lith', versions })), LITHIC_API_BASE, 5);
  assert.deepEqual(listed, versions);
  assert.deepEqual(await listRemoteVersions('wiki.lith', fakeFetch(() => json({}, 500))), []);
  assert.deepEqual(await listRemoteVersions('wiki.lith', fakeFetch(() => { throw new Error('offline'); })), []);

  let restoreBody = '';
  const ok = await restoreRemoteVersion('wiki.lith', 'a'.repeat(40), fakeFetch((_url, init) => {
    restoreBody = String(init?.body);
    return json({ status: 'ok' });
  }));
  assert.equal(ok, true);
  assert.equal(restoreBody, `wiki.lith\n${'a'.repeat(40)}`);
  assert.equal(await restoreRemoteVersion('wiki.lith', 'bad', fakeFetch(() => json({}, 404))), false);
  assert.equal(await restoreRemoteVersion('wiki.lith', 'bad', fakeFetch(() => { throw new Error('offline'); })), false);
});
