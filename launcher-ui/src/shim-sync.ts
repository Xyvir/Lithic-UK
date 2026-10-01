/**
 * The shim's git sync writes, and the GitHub calls behind them, from the page's side.
 *
 * The reads live in `shim-git.ts` and the file commands in `shim-files.ts`; this is the half that
 * changes something. Two of the shim's commands here answer with a *job* rather than with the
 * work done (`git-setup` and `git-commit` do a first fetch, a rescue, a commit and a push, any of
 * which can outlive the wire's thirty-second write timeout), so the page polls `git-job` and can
 * `git-cancel`. `awaitShimJob` below is that loop, kept here rather than in the component so the
 * state machine the shim answers with can be tested without a browser.
 *
 * The GitHub half is four commands a page cannot make for itself. `github.com/login/device/code`
 * answers with no `Access-Control-Allow-Origin` at all, so a browser refuses the request before
 * it leaves; the shim makes all four so there is one token path and one place the credential is
 * handled. Their answers mirror the desktop app's commands down to the field names, because the
 * launcher's decoding (`github-device.ts`) is shared between the two and must not have to care
 * which backend answered.
 *
 * Every function answers a value rather than throwing, exactly as the modules beside it do, and
 * each carries a code from the shim's own vocabulary (`no-shim`, `unreachable`, `bad-args`,
 * `github`, `git`). A `github` failure carries GitHub's own sentence in `detail` beside the code,
 * which is what a caller shows; anything from the wire itself has no detail and the code is all
 * there is.
 */

import { shimCommand, type ShimCall } from './shim-command.ts';
import type { ShimResult } from './shim-files.ts';
// The verdict vocabulary is the desktop app's, because `git-sync-health.ts` reads both and must
// not have to know which backend answered.
import type { HealthState } from './git-sync-health.ts';

function result<T>(answer: Awaited<ReturnType<typeof shimCommand>>): ShimResult<T> {
  if (!answer.ok) return { ok: false, error: answer.error, ...(answer.detail ? { detail: answer.detail } : {}) };
  return { ok: true, value: answer.result as T };
}

/** What `git-folder` answers: the folder in force, and whether it is the person's own pick. */
export interface ShimFolderAnswer {
  folder: string | null;
  overridden: boolean;
}

/**
 * The folder the backup acts on, given the path the launcher derived for itself.
 *
 * `derived` is the open Lith or the newest recent row, and it may be null: a launcher with
 * nothing open and no recents still has to name the folder the dialog is about, and the shim
 * answers `null` for `folder` rather than naming a guess.
 */
export function shimGitFolder(derived: string | null, call: ShimCall = {}): Promise<ShimResult<ShimFolderAnswer>> {
  return shimCommand('git-folder', derived ? { derived } : {}, call).then((answer) =>
    result<ShimFolderAnswer>(answer)
  );
}

/**
 * Ask the desktop's chooser for the folder to back up.
 *
 * `{ folder: null }` is a cancellation, which is an ordinary answer rather than a failure. The
 * shim records the pick as part of this call, so a caller re-reads `git-folder` rather than
 * trusting the path it was handed.
 */
export function shimPickFolder(
  current: string | null,
  call: ShimCall = {}
): Promise<ShimResult<{ folder: string | null }>> {
  return shimCommand('pick-folder', current ? { current } : {}, call).then((answer) =>
    result<{ folder: string | null }>(answer)
  );
}

/** Go back to the folder the shim works out for itself, dropping the recorded pick. */
export function shimClearFolderPick(call: ShimCall = {}): Promise<ShimResult<Record<string, never>>> {
  return shimCommand('clear-folder-pick', {}, call).then((answer) => result<Record<string, never>>(answer));
}

/** A job's state, and the fields that go with it, exactly as `git-job` answers. */
export interface ShimJob {
  state: 'running' | 'done' | 'failed' | 'cancelled' | 'unknown';
  stage?: string;
  error?: string | null;
  result?: unknown;
}

export interface ShimJobHandle {
  job: number;
}

/** Start the first connect: clone or adopt the folder, commit it, and push. Answers a job id. */
export function shimGitSetup(
  path: string,
  repo: string,
  token: string,
  call: ShimCall = {}
): Promise<ShimResult<ShimJobHandle>> {
  return shimCommand('git-setup', { path, repo, token }, call).then((answer) =>
    result<ShimJobHandle>(answer)
  );
}

/**
 * One save: stage the file, commit it and push. Answers a job id for a managed folder, and the
 * desktop app's `{ managed: false }` shape for a folder nothing backs up, which is why the two
 * are spelt out here rather than collapsed.
 */
export type ShimCommitAnswer = {
  job?: number;
  managed?: boolean;
  pushed?: boolean;
  error?: string | null;
};

export function shimGitCommit(path: string, message: string, call: ShimCall = {}): Promise<ShimResult<ShimCommitAnswer>> {
  return shimCommand('git-commit', { path, message }, call).then((answer) => result<ShimCommitAnswer>(answer));
}

/** Re-point a synced folder at the same repository with a fresh token, and do nothing else. */
export function shimGitReauth(
  path: string,
  repo: string,
  token: string,
  call: ShimCall = {}
): Promise<ShimResult<{ repo: string }>> {
  return shimCommand('git-reauth', { path, repo, token }, call).then((answer) =>
    result<{ repo: string }>(answer)
  );
}

/** Drop the managed origin and record the folder as detached. */
export function shimGitDisconnect(path: string, call: ShimCall = {}): Promise<ShimResult<{ disconnected: boolean }>> {
  return shimCommand('git-disconnect', { path }, call).then((answer) =>
    result<{ disconnected: boolean }>(answer)
  );
}

/** Read a job's state, for the poll loop. */
export function shimGitJob(id: number, call: ShimCall = {}): Promise<ShimResult<ShimJob>> {
  return shimCommand('git-job', { id }, call).then((answer) => result<ShimJob>(answer));
}

/** Ask a running job to stop. A request, not a fact: the work ends at its next checkpoint. */
export function shimGitCancel(id: number, call: ShimCall = {}): Promise<ShimResult<{ stopped: boolean }>> {
  return shimCommand('git-cancel', { id }, call).then((answer) => result<{ stopped: boolean }>(answer));
}

/** The verdict `git-heartbeat` answers with, in the desktop app's own shape. */
export interface ShimHealth {
  state: HealthState;
  repo: string;
  detail: string;
  last_commit_error?: string | null;
}

/** Ask GitHub whether this folder's backup still works. */
export function shimGitHeartbeat(path: string, call: ShimCall = {}): Promise<ShimResult<ShimHealth>> {
  return shimCommand('git-heartbeat', { path }, call).then((answer) => result<ShimHealth>(answer));
}

/** Step one of the device flow: GitHub's own answer, passed through for `parseDeviceCode`. */
export function shimDeviceCode(call: ShimCall = {}): Promise<ShimResult<unknown>> {
  return shimCommand('github-device-code', {}, call).then((answer) => result<unknown>(answer));
}

/** Step two: one poll, normalized to `{ pending }` or `{ access_token }` as the desktop app is. */
export function shimDevicePoll(deviceCode: string, call: ShimCall = {}): Promise<ShimResult<unknown>> {
  return shimCommand('github-device-poll', { deviceCode }, call).then((answer) => result<unknown>(answer));
}

/** The repositories the account owns, as `{ full_name }` rows. */
export function shimListRepos(token: string, call: ShimCall = {}): Promise<ShimResult<Array<{ full_name: string }>>> {
  return shimCommand('github-list-repos', { token }, call).then((answer) =>
    result<Array<{ full_name: string }>>(answer)
  );
}

/** Create the private repository a first connect backs up into. */
export function shimCreateRepo(
  token: string,
  name: string,
  call: ShimCall = {}
): Promise<ShimResult<{ full_name: string }>> {
  return shimCommand('github-create-repo', { token, name }, call).then((answer) =>
    result<{ full_name: string }>(answer)
  );
}

/**
 * Poll `git-job` until the work ends, reporting each stage as it goes.
 *
 * The loop is the shim's half of the desktop app's blocking commands: `git-setup` and
 * `git-commit` answer at once with an id, and this is what turns that id back into the result the
 * launcher's flow expects. A cancelled job is a value rather than a throw, because a person who
 * pressed Stop is not an error to render, and `unknown` is what an id from a previous launch
 * answers: both end the loop.
 *
 * The stage line is what the dialog shows under its spinner, so `onStage` is called only when the
 * line actually changes rather than once per poll.
 */
export async function awaitShimJob<T>(
  id: number,
  options: { call?: ShimCall; onStage?: (stage: string) => void; intervalMs?: number } = {}
): Promise<ShimResult<T>> {
  const intervalMs = options.intervalMs ?? 500;
  let lastStage = '';
  for (;;) {
    const polled = await shimGitJob(id, options.call);
    if (!polled.ok) return { ok: false, error: polled.error };
    const job = polled.value;
    if (job.stage && job.stage !== lastStage) {
      lastStage = job.stage;
      options.onStage?.(job.stage);
    }
    switch (job.state) {
      case 'done':
        return { ok: true, value: job.result as T };
      case 'failed':
        return { ok: false, error: job.error || 'git' };
      case 'cancelled':
        return { ok: false, error: 'cancelled' };
      case 'unknown':
        return { ok: false, error: 'unknown-job' };
      default:
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}
