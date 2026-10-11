import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_API_BASE,
  SYNC_FRESH_MS,
  createServerRepo,
  disconnectServerSync,
  fetchServerSyncHistory,
  fetchServerSyncStatus,
  listServerRepos,
  pollServerDeviceToken,
  requestServerDeviceCode,
  revertFailureNote,
  revertServerSync,
  serverSyncIndicator,
  setupFailureNote,
  setupServerSync
} from './server-git-sync.ts';
import { TRAIL_LIMIT } from './instance-trail.ts';
import { copy } from './copy.ts';

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
  await fetchServerSyncHistory(TRAIL_LIMIT, fetcher);
  await revertServerSync('abc1234', fetcher);
  assert.equal(seen.length, 9);
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

test('the history is read from the server, and the three answers stay three', async () => {
  const commit = { hash: 'abcdef1234567890', short: 'abcdef1', summary: 'Save notes.lith', time: 1_700_000_000 };
  const seen: string[] = [];
  const trail = await fetchServerSyncHistory(10, (async (url: unknown) => {
    seen.push(String(url));
    return json({ commits: [commit] });
  }) as unknown as typeof fetch);
  assert.deepEqual(trail, { state: 'trail', commits: [commit] });
  assert.match(seen[0], /\/history\?limit=10$/);

  // A server whose `/data` is not a repository has no trail to draw, which is not the same
  // answer as one whose history is empty: the dialog hides the section for the first and says
  // there is nothing yet for the second.
  assert.deepEqual(await fetchServerSyncHistory(10, fakeFetch(() => json({ error: 'no_repo' }))), {
    state: 'no-repo'
  });
  // And an instance older than this route, whose CGI answers its own catch-all: the same
  // "no trail to draw", rather than a failure line about a feature it does not have.
  assert.deepEqual(
    await fetchServerSyncHistory(10, fakeFetch(() => json({ error: 'route_not_found', uri: '/api/github/history' }))),
    { state: 'no-repo' }
  );
  assert.deepEqual(await fetchServerSyncHistory(10, fakeFetch(() => json({ commits: [] }))), {
    state: 'trail',
    commits: []
  });
  // A payload nobody can read is a server that did not answer, not an empty history.
  assert.deepEqual(await fetchServerSyncHistory(10, fakeFetch(() => json('nonsense'))), {
    state: 'failed',
    message: copy.serverSync.noHistory
  });
  // And one that does not answer at all is the other sentence.
  const refused = await fetchServerSyncHistory(10, fakeFetch(() => new Response('no', { status: 502 })));
  assert.deepEqual(refused, { state: 'failed', message: copy.serverSync.noHistory });
});

test('a revert is posted as the commit, and its answer is read in the app’s own shape', async () => {
  let body: unknown = null;
  const answer = await revertServerSync('abcdef1', (async (_url: unknown, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    return json({ status: 'success', short: '1234567', target: 'abcdef1', changes: 3, saved_first: true });
  }) as unknown as typeof fetch);
  assert.deepEqual(body, { commit: 'abcdef1' });
  assert.deepEqual(answer, {
    short: '1234567',
    target: 'abcdef1',
    changes: 3,
    savedFirst: true,
    error: null
  });
  // A push that did not land is data beside the revert rather than a failed revert.
  const unpushed = await revertServerSync(
    'abcdef1',
    fakeFetch(() => json({ status: 'success', short: '1234567', target: 'abcdef1', changes: 3, saved_first: false, error: 'denied' }))
  );
  assert.deepEqual(unpushed, { short: '1234567', target: 'abcdef1', changes: 3, savedFirst: false, error: 'denied' });
});

test('a refused revert quotes the server’s own code, and nothing else is invented', async () => {
  const refused = await revertServerSync(
    'abcdef1',
    fakeFetch(() => json({ status: 'error', message: 'unknown_commit' }, 200))
  );
  assert.deepEqual(refused, { ok: false, message: copy.serverSync.revertFailedDetail('unknown_commit') });
  // A refusal with no message is the plain sentence rather than a bracket with nothing in it.
  assert.deepEqual(await revertServerSync('abcdef1', fakeFetch(() => new Response('', { status: 500 }))), {
    ok: false,
    message: copy.serverSync.revertFailed
  });
  // And one that never arrived is the transport's own sentence, which is a different claim.
  const unreachable = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch;
  assert.deepEqual(await revertServerSync('abcdef1', unreachable), {
    ok: false,
    message: copy.serverSync.unreachableForRevert
  });
  // And an empty message is the plain sentence rather than a bracket with nothing in it.
  assert.equal(revertFailureNote('  '), copy.serverSync.revertFailed);
  assert.equal(revertFailureNote('x'.repeat(400)).length, copy.serverSync.revertFailedDetail('x'.repeat(160)).length);
});

test('the button asks the instance, and its four states are the legacy four', () => {
  const now = 1_700_000_000_000;

  // Not asked yet: amber rather than grey, because grey would be an answer.
  assert.equal(serverSyncIndicator(null, now, false).state, 'checking');

  // The instance did not answer at all. The one state that is about the
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
