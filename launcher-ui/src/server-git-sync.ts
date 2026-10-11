/**
 * Self-host GitHub backup: the *server's* sync, driven from the launcher page.
 *
 * The desktop app links a folder on this machine to a repository, and Rust does
 * the git work. A self-hosted instance is the opposite arrangement: `/data` is
 * already the repository, the server commits and pushes on every save, and the
 * launcher page is only a console for it. That difference is why these calls are
 * `fetch` against `/api/github/` rather than IPC. There is nothing to do on
 * this device, and the token never touches it.
 *
 * Ported from the legacy launcher (`launcher-fragments/runtime.js`), which drove
 * the same CGI in the same order: status → device code → poll → list repos →
 * setup, with disconnect to undo. What changed is the shape: the parsing and the
 * decisions are pure functions here (testable without a server), and the failure
 * of a request is a value the caller renders rather than an `alert`.
 *
 * The CGI answers raw GitHub JSON on the OAuth routes (including GitHub's own
 * error codes) so the messages below are the server's, translated once.
 */

import { copy } from './copy.ts';
import {
  parseDeviceCode,
  parseServerDevicePoll,
  partitionRepos,
  type DeviceCodeResponse
} from './github-device.ts';
import { verifiedAge, type SyncIndicator } from './git-sync-health.ts';
// The trail's shapes and the one parser for every backend's answer: the page reads
// `TrailCommit` whichever prong produced it.
import { parseTrailCommits, TRAIL_LIMIT, type TrailCommit } from './instance-trail.ts';

export const GITHUB_API_BASE = '/api/github/';

/** What `/api/github/status` says about the server's repository. */
export interface ServerSyncStatus {
  connected: boolean;
  /** `owner/name`, empty when nothing is connected. */
  repo: string;
  /** When the server last synced, in epoch milliseconds (0 = never). */
  lastSync: number;
}

/** A sync that happened this recently colors the button as syncing. */
export const SYNC_FRESH_MS = 5_000;

/** A request that failed in a way the dialog should say out loud. */
export type ServerFailure = { ok: false; message: string };

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Is this server backed up to GitHub, and when did it last sync?
 *
 * `null` rather than a thrown error: wherever this is called, "the instance did
 * not answer" is a state to render, not an exception to catch, and on a plain
 * WebDAV server it is the *ordinary* answer, since there is no CGI to route to.
 */
export async function fetchServerSyncStatus(
  fetcher: typeof fetch = fetch,
  base = GITHUB_API_BASE
): Promise<ServerSyncStatus | null> {
  try {
    const response = await fetcher(`${base}status`, { headers: { Accept: 'application/json' } });
    if (!response.ok) return null;
    const payload = (await readJson(response)) as Record<string, unknown> | null;
    if (!payload || typeof payload.connected !== 'boolean') return null;
    return {
      connected: payload.connected,
      repo: typeof payload.repo === 'string' ? payload.repo : '',
      lastSync: typeof payload.last_sync === 'number' ? payload.last_sync * 1000 : 0
    };
  } catch {
    return null;
  }
}

/**
 * Ask for a device code. The server relays the request to GitHub with its own
 * client id, so the code the user types is authorizing *this instance*.
 */
export async function requestServerDeviceCode(
  fetcher: typeof fetch = fetch,
  base = GITHUB_API_BASE
): Promise<DeviceCodeResponse | ServerFailure> {
  try {
    const response = await fetcher(`${base}device-code`, { headers: { Accept: 'application/json' } });
    const payload = await readJson(response);
    if (!response.ok) return { ok: false, message: copy.serverSync.noCode };
    const code = parseDeviceCode(payload);
    if (code) return code;
    const record = (payload ?? {}) as Record<string, unknown>;
    const detail = typeof record.error_description === 'string' ? record.error_description : record.error;
    return { ok: false, message: typeof detail === 'string' && detail ? detail : 'GitHub did not answer with a code.' };
  } catch {
    return { ok: false, message: copy.serverSync.unreachableForCode };
  }
}

/** One poll of the device flow, in the server's raw GitHub shape. */
export async function pollServerDeviceToken(
  deviceCode: string,
  fetcher: typeof fetch = fetch,
  base = GITHUB_API_BASE
) {
  try {
    const response = await fetcher(`${base}poll?device_code=${encodeURIComponent(deviceCode)}`, {
      headers: { Accept: 'application/json' }
    });
    return parseServerDevicePoll(await readJson(response));
  } catch {
    return { kind: 'pending' as const, slowDown: false };
  }
}

/** The repositories a token can push to, split into Lithic's own and the rest. */
export async function listServerRepos(
  token: string,
  fetcher: typeof fetch = fetch,
  base = GITHUB_API_BASE
): Promise<{ managed: string[]; other: string[] } | ServerFailure> {
  try {
    const response = await fetcher(`${base}list-repos?token=${encodeURIComponent(token)}`, {
      headers: { Accept: 'application/json' }
    });
    const payload = await readJson(response);
    if (!response.ok || !Array.isArray(payload)) return { ok: false, message: copy.serverSync.noRepos };
    const repos = (payload as Array<{ full_name?: unknown }>)
      .map((repo) => (typeof repo?.full_name === 'string' ? repo.full_name : ''))
      .filter(Boolean);
    return partitionRepos(repos.map((full_name) => ({ full_name })));
  } catch {
    return { ok: false, message: copy.serverSync.noRepos };
  }
}

/** Create a repository to hold the backup; returns its `owner/name`. */
export async function createServerRepo(
  token: string,
  name: string,
  fetcher: typeof fetch = fetch,
  base = GITHUB_API_BASE
): Promise<string | ServerFailure> {
  try {
    const response = await fetcher(`${base}create-repo`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, name })
    });
    const payload = (await readJson(response)) as Record<string, unknown> | null;
    const fullName = typeof payload?.full_name === 'string' ? payload.full_name : '';
    if (response.ok && fullName) return fullName;
    const detail = typeof payload?.message === 'string' ? payload.message : '';
    return { ok: false, message: detail || 'Could not create the repository.' };
  } catch {
    return { ok: false, message: copy.serverSync.noCreate };
  }
}

/**
 * Point the server's `/data` at a repository and push it.
 *
 * This is the long one: the server adds the remote, fetches, rescues any wiki
 * only the remote has, commits and force-pushes, so its answer may carry a git
 * log on failure.
 */
export async function setupServerSync(
  token: string,
  repo: string,
  fetcher: typeof fetch = fetch,
  base = GITHUB_API_BASE
): Promise<{ ok: true } | ServerFailure> {
  try {
    const response = await fetcher(`${base}setup`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, repo })
    });
    const payload = (await readJson(response)) as Record<string, unknown> | null;
    if (response.ok && payload?.status === 'success') return { ok: true };
    const detail = typeof payload?.message === 'string' ? payload.message : '';
    return { ok: false, message: setupFailureNote(detail) };
  } catch {
    return { ok: false, message: copy.serverSync.unreachableForSetup };
  }
}

/**
 * Stop the server's backup: the token is deleted there, and the watcher skips a
 * server that has none, so the push stops where the credential did. The remote
 * stays, carrying the token it was made with, and the next setup replaces it.
 */
export async function disconnectServerSync(
  fetcher: typeof fetch = fetch,
  base = GITHUB_API_BASE
): Promise<boolean> {
  try {
    const response = await fetcher(`${base}disconnect`, { headers: { Accept: 'application/json' } });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * The server's own trail, as `/api/github/history` reads it.
 *
 * The CGI walks `/data`'s commits and answers the same fields the desktop app's
 * command does, so the parsing the page needs is `instance-trail.ts`, once, for
 * all three prongs.
 *
 * The three answers are kept apart rather than folded into an empty list. A server
 * whose `/data` is not a repository has no trail to draw at all, which is not the
 * same thing as a repository whose first commit is the only one there is, and the
 * dialog draws them differently. The third `no-repo` case is a server that does not
 * *have* this route, which is what the CGI's catch-all answers to an instance older than
 * it: no trail to draw is the honest reading of that too, and it keeps a deployment that
 * simply predates the feature from wearing a failure line about it.
 */
export type ServerTrail =
  | { state: 'trail'; commits: TrailCommit[] }
  | { state: 'no-repo' }
  | { state: 'failed'; message: string };

/**
 * The server's last few commits. A local read there: it needs no token and no GitHub,
 * which is why an instance with local git and no backup is still offered its trail.
 */
export async function fetchServerSyncHistory(
  limit = TRAIL_LIMIT,
  fetcher: typeof fetch = fetch,
  base = GITHUB_API_BASE
): Promise<ServerTrail> {
  try {
    const response = await fetcher(`${base}history?limit=${limit}`, { headers: { Accept: 'application/json' } });
    const payload = (await readJson(response)) as Record<string, unknown> | null;
    // A repository to have a history in is the one answer that is not a failure and not a
    // trail: the dialog draws nothing at all for it. So is a server with no such route.
    if (payload?.error === 'no_repo' || payload?.error === 'route_not_found') return { state: 'no-repo' };
    const commits = parseTrailCommits(payload);
    // Null is a payload nobody can read, which is not the same as an empty repository: one
    // says the history is empty, the other says nobody read it, and only one is true.
    if (response.ok && commits) return { state: 'trail', commits };
    return { state: 'failed', message: copy.serverSync.noHistory };
  } catch {
    return { state: 'failed', message: copy.serverSync.unreachableForHistory };
  }
}

/**
 * What a revert on the server did, in the desktop app's own answer shape
 * (`GitSyncRevert`), so the dialog reads one shape from three prongs.
 */
export interface ServerRevert {
  /** The commit the revert added: where the branch is now. */
  short: string;
  /** The commit it went back to, shortened. */
  target: string;
  /** How many paths moved. */
  changes: number;
  /** Whether the instance's own uncommitted work was committed first. */
  savedFirst: boolean;
  /** The push's failure, when the revert landed there but the backup did not. */
  error: string | null;
}

/**
 * Put the server's `/data` back as it was at one of its own commits.
 *
 * The server commits the old tree forward rather than moving the branch: the trail grows by
 * one commit and the move is undone by reverting to the commit it replaced. Its own
 * uncommitted work is committed first, so a revert can never discard a change git was never
 * given, and the push is best effort for the reason a save's is: a revert made offline is
 * still a revert, and the failure travels back as data.
 */
export async function revertServerSync(
  commit: string,
  fetcher: typeof fetch = fetch,
  base = GITHUB_API_BASE
): Promise<ServerRevert | ServerFailure> {
  try {
    const response = await fetcher(`${base}revert`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit })
    });
    const payload = (await readJson(response)) as Record<string, unknown> | null;
    if (response.ok && payload?.status === 'success') {
      return {
        short: typeof payload.short === 'string' ? payload.short : '',
        target: typeof payload.target === 'string' ? payload.target : '',
        changes: typeof payload.changes === 'number' ? payload.changes : 0,
        savedFirst: payload.saved_first === true,
        error: typeof payload.error === 'string' && payload.error ? payload.error : null
      };
    }
    const detail = typeof payload?.message === 'string' ? payload.message : '';
    return { ok: false, message: revertFailureNote(detail) };
  } catch {
    return { ok: false, message: copy.serverSync.unreachableForRevert };
  }
}

/**
 * The revert's refusal, said in one line.
 *
 * The CGI answers a code here (`unknown_commit`, `read_tree_failed`) rather than the
 * transcript a setup failure carries, so there is nothing to pick a line out of; what
 * the code can be is empty, and then the sentence stands alone.
 */
export function revertFailureNote(message: string): string {
  const clipped = String(message || '').trim().slice(0, 160);
  return clipped ? copy.serverSync.revertFailedDetail(clipped) : copy.serverSync.revertFailed;
}

/**
 * The server's failure, said in one line.
 *
 * The CGI hands back whatever `git` wrote, which is several lines at best and a
 * transcript at worst. The last line is the one git failed on, so that is the
 * one that gets shown; the whole log stays for the caller to put in a tooltip.
 * Picking a line rather than truncating the blob is deliberate. A truncated
 * transcript hides the sentence that says what went wrong.
 */
export function setupFailureNote(message: string): string {
  const lines = String(message || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.length > 0 ? lines[lines.length - 1] : '';
  if (!last) return copy.serverSync.setupFailed;
  const clipped = last.length > 160 ? `${last.slice(0, 157)}…` : last;
  return copy.serverSync.setupFailedDetail(clipped);
}

/**
 * The heading button's state on a server.
 *
 * Simpler than the desktop truth table (git-sync-health.ts) because the server
 * answers one question (connected, repository, last sync) and does the git
 * work itself. What is left is the same four states the legacy `#github-sync-btn`
 * had: grey when nothing is set up, green when it is, purple while a sync is
 * recent, red when the instance did not answer. Nothing here claims the backup
 * works; only the server knows that, and this is the button for asking it.
 */
export function serverSyncIndicator(
  status: ServerSyncStatus | null,
  now: number,
  failed: boolean
): { state: SyncIndicator; title: string } {
  if (failed) return { state: 'error', title: copy.sync.serverFailed };
  if (!status) return { state: 'checking', title: copy.sync.checking };
  if (!status.connected) return { state: 'idle', title: copy.dialogs.gitSync.title };
  const target = status.repo ? `github.com/${status.repo}` : copy.sync.connectedLabel;
  const age = verifiedAge(status.lastSync, now);
  if (status.lastSync > 0 && now - status.lastSync < SYNC_FRESH_MS) {
    return { state: 'syncing', title: copy.sync.serverSyncing(target) };
  }
  return { state: 'connected', title: copy.sync.serverConnected(target, age) };
}
