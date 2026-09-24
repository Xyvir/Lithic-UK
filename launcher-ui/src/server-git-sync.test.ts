import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_API_BASE,
  SYNC_FRESH_MS,
  createServerRepo,
  disconnectServerSync,
  fetchServerSyncStatus,
  listServerRepos,
  pollServerDeviceToken,
  requestServerDeviceCode,
  serverSyncIndicator,
  setupFailureNote,
  setupServerSync
} from './server-git-sync.ts';

type Handler = (url: string, init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(handler: Handler): typeof fetch {
  return ((url: unknown, init?: RequestInit) => Promise.resolve(handler(String(url), init))) as unknown as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Every call a server transport makes must be against its own API base. */
test('the transport only ever calls the instance’s own git API', async () => {
  const seen: string[] = [];
  const record: Handler = (url) => {
    seen.push(url);
    return json({ connected: false });
  };
  const fetcher = fakeFetch(record);
  await fetchServerSyncStatus(fetcher);
  await requestServerDeviceCode(fetcher);
  await pollServerDeviceToken('d1', fetcher);
  await listServerRepos('tok', fetcher);
  await createServerRepo('tok', 'lithic-sync-ab2d', fetcher);
  await setupServerSync('tok', 'me/lithic-sync-ab2d', fetcher);
  await disconnectServerSync(fetcher);
  assert.equal(seen.length, 7);
  for (const url of seen) assert.ok(url.startsWith(GITHUB_API_BASE), `${url} is outside the instance's API`);
});

test('status parses a connected instance and its last sync, in milliseconds', async () => {
  const status = await fetchServerSyncStatus(
    fakeFetch(() => json({ connected: true, repo: 'me/lithic-sync-ab2d', last_sync: 1_700_000_000 }))
  );
  assert.deepEqual(status, { connected: true, repo: 'me/lithic-sync-ab2d', lastSync: 1_700_000_000_000 });
});

test('status parses a disconnected instance and never invents a repository', async () => {
  assert.deepEqual(await fetchServerSyncStatus(fakeFetch(() => json({ connected: false }))), {
    connected: false,
    repo: '',
    lastSync: 0
  });
});

test('status answers null when the instance does not speak the API at all', async () => {
  // The plain-WebDAV case: Caddy serves /api/github/* out of the filesystem, or
  // 404s it. Either way this is "not set up", not a crash.
  assert.equal(await fetchServerSyncStatus(fakeFetch(() => new Response('<html>404</html>', { status: 404 }))), null);
  assert.equal(await fetchServerSyncStatus(fakeFetch(() => json('not an object'))), null);
  assert.equal(
    await fetchServerSyncStatus(
      fakeFetch(() => {
        throw new Error('offline');
      })
    ),
    null
  );
});

test('a device code comes back parsed, and its absence is a sentence rather than a throw', async () => {
  const code = await requestServerDeviceCode(
    fakeFetch(() => json({ device_code: 'd123', user_code: 'ABCD-1234', interval: 5 }))
  );
  assert.equal('ok' in code ? null : code.user_code, 'ABCD-1234');

  const githubSaid = await requestServerDeviceCode(
    fakeFetch(() => json({ error: 'unauthorized_client', error_description: 'Client is not allowed.' }))
  );
  assert.deepEqual(githubSaid, { ok: false, message: 'Client is not allowed.' });

  // A reachable server that answers with something else entirely: no detail to
  // quote, so the line has to be ours.
  const shapeless = await requestServerDeviceCode(fakeFetch(() => json({})));
  assert.deepEqual(shapeless, { ok: false, message: 'GitHub did not answer with a code.' });
});

test('the poll loop reads GitHub’s own codes, because the server relays them raw', async () => {
  const pending = await pollServerDeviceToken('d1', fakeFetch(() => json({ error: 'authorization_pending' })));
  assert.deepEqual(pending, { kind: 'pending', slowDown: false });

  const slowDown = await pollServerDeviceToken('d1', fakeFetch(() => json({ error: 'slow_down' })));
  assert.deepEqual(slowDown, { kind: 'pending', slowDown: true });

  const token = await pollServerDeviceToken('d1', fakeFetch(() => json({ access_token: 'gho_x' })));
  assert.deepEqual(token, { kind: 'authorized', token: 'gho_x' });

  const expired = await pollServerDeviceToken('d1', fakeFetch(() => json({ error: 'expired_token' })));
  assert.match(expired.kind === 'failed' ? expired.message : '', /expired/i);

  // A poll that cannot reach the server is not a failure: it is the same wait,
  // and giving up on one dropped request would strand the code on screen.
  const offline = await pollServerDeviceToken(
    'd1',
    fakeFetch(() => {
      throw new Error('offline');
    })
  );
  assert.deepEqual(offline, { kind: 'pending', slowDown: false });
});

test('repository listing splits Lithic’s own repositories from the rest', async () => {
  const listed = await listServerRepos(
    'tok',
    fakeFetch(() =>
      json([
        { full_name: 'me/lithic-sync-ab2d' },
        { full_name: 'me/notes' },
        { full_name: 'me/lithic-backup-2026' },
        { full_name: 'me/empty-repo' }
      ])
    )
  );
  assert.deepEqual(listed, { managed: ['me/lithic-sync-ab2d', 'me/lithic-backup-2026'], other: ['me/notes', 'me/empty-repo'] });
});

test('a listing that fails says so instead of offering an empty list', async () => {
  const failed = await listServerRepos('tok', fakeFetch(() => json({ error: 'missing_token' }, 400)));
  assert.deepEqual(failed, { ok: false, message: 'Could not list your repositories.' });
  // GitHub answering with something that is not a list is the same answer: the
  // dialog must not read it as "you have no repositories".
  const shapeless = await listServerRepos('tok', fakeFetch(() => json({ message: 'Bad credentials' })));
  assert.deepEqual(shapeless, { ok: false, message: 'Could not list your repositories.' });
});

test('creating a repository returns its full name, and its failure quotes GitHub', async () => {
  const created = await createServerRepo('tok', 'lithic-sync-ab2d', fakeFetch(() => json({ full_name: 'me/lithic-sync-ab2d' })));
  assert.equal(created, 'me/lithic-sync-ab2d');

  const refused = await createServerRepo(
    'tok',
    'lithic-sync-ab2d',
    fakeFetch(() => json({ message: 'name already exists on this account' }, 422))
  );
  assert.deepEqual(refused, { ok: false, message: 'name already exists on this account' });
});

test('setup succeeds only on the server’s own success answer', async () => {
  const ok = await setupServerSync('tok', 'me/lithic-sync-ab2d', fakeFetch(() => json({ status: 'success', repo: 'me/lithic-sync-ab2d' })));
  assert.deepEqual(ok, { ok: true });

  // The server answers 200 with a status field even when git failed, which is
  // why this cannot be decided by the HTTP code.
  const failed = await setupServerSync('tok', 'me/lithic-sync-ab2d', fakeFetch(() => json({ status: 'error', message: 'fatal: could not read Username' })));
  assert.deepEqual(failed, { ok: false, message: 'Setup failed: fatal: could not read Username' });
});

test('a git transcript becomes its last line, and the clipping never eats the reason', () => {
  assert.equal(setupFailureNote(''), 'Setup failed.');
  assert.equal(setupFailureNote('\n  \n'), 'Setup failed.');
  assert.equal(
    setupFailureNote('Fetching origin\nFrom https://github.com/me/repo\n ! [rejected] main -> main (non-fast-forward)'),
    'Setup failed: ! [rejected] main -> main (non-fast-forward)'
  );
  const long = 'x'.repeat(400);
  const note = setupFailureNote(`first\n${long}`);
  assert.ok(note.startsWith('Setup failed: '));
  assert.ok(note.length < long.length, 'a long line is clipped, not pasted whole');
  assert.ok(note.endsWith('…'));
});

test('disconnect reports whether the server confirmed it', async () => {
  assert.equal(await disconnectServerSync(fakeFetch(() => json({ status: 'disconnected' }))), true);
  assert.equal(await disconnectServerSync(fakeFetch(() => new Response('', { status: 500 }))), false);
  assert.equal(
    await disconnectServerSync(
      fakeFetch(() => {
        throw new Error('offline');
      })
    ),
    false
  );
});

test('the button asks the instance, and its four states are the legacy four', () => {
  const now = 1_700_000_000_000;

  // Not asked yet: amber rather than grey, because grey would be an answer.
  assert.equal(serverSyncIndicator(null, now, false).state, 'checking');

  // The instance did not answer at all — the one state that is about the
  // launcher's own request rather than about the backup.
  const unreachable = serverSyncIndicator(null, now, true);
  assert.equal(unreachable.state, 'error');
  assert.match(unreachable.title, /did not answer/);

  const disconnected = serverSyncIndicator({ connected: false, repo: '', lastSync: 0 }, now, false);
  assert.equal(disconnected.state, 'idle');
  assert.equal(disconnected.title, 'GitHub Sync');

  // Fresh, in flight, or long ago: one repository, three readings.
  const syncing = serverSyncIndicator({ connected: true, repo: 'me/lithic-sync-ab2d', lastSync: now - SYNC_FRESH_MS + 1 }, now, false);
  assert.equal(syncing.state, 'syncing');
  assert.match(syncing.title, /syncing to github\.com\/me\/lithic-sync-ab2d/);

  const settled = serverSyncIndicator({ connected: true, repo: 'me/lithic-sync-ab2d', lastSync: now - 3 * 60_000 }, now, false);
  assert.equal(settled.state, 'connected');
  assert.equal(settled.title, 'GitHub Sync: github.com/me/lithic-sync-ab2d, last synced 3m ago');

  // Connected but never synced: a repository is a claim the server made, and
  // there is no age to put beside it.
  const never = serverSyncIndicator({ connected: true, repo: 'me/lithic-sync-ab2d', lastSync: 0 }, now, false);
  assert.equal(never.state, 'connected');
  assert.equal(never.title, 'GitHub Sync: github.com/me/lithic-sync-ab2d');
});
