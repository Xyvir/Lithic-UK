/**
 * The shim's git sync reads, from the launcher page's side.
 *
 * The backend half is `shim/src/git.rs`, and it answers the one question a browser cannot
 * answer for itself. A page is handed a file's contents and never the directory it sits in, so
 * it cannot walk up from a Lith to the repository that publishes it. That walk is what decides
 * whether a recents row is backed up, and it is why these three reads cross the wire.
 *
 * Only reads are here, which is why the file is called reads rather than sync. Connecting a
 * folder, committing, pushing and the GitHub calls behind them are writes, and they live in
 * `shim-sync.ts` beside this module: nothing in this one changes anything.
 *
 * Every function answers a value rather than throwing, exactly as `shim-files.ts` does, and
 * each carries a code from the shim's own vocabulary (`no-shim`, `unreachable`, `bad-args`).
 * A caller renders "no coverage known" on every one of them, which is the same thing it does
 * on a page with no shim at all.
 */

import { shimCommand, type ShimCall } from './shim-command.ts';
import type { ShimResult } from './shim-files.ts';

/**
 * What `git-status` returns: the desktop app's `GitSyncStatus`, or null when no repository
 * Lithic manages contains the path. `in_flight` is optional rather than required because the
 * shim answers `false` where an older desktop build omits the field entirely.
 */
export interface ShimSyncStatus {
  connected: boolean;
  repo: string;
  in_flight?: boolean;
}

function result<T>(answer: Awaited<ReturnType<typeof shimCommand>>): ShimResult<T> {
  if (!answer.ok) return { ok: false, error: answer.error, ...(answer.detail ? { detail: answer.detail } : {}) };
  return { ok: true, value: answer.result as T };
}

/**
 * Whether the folder this path sits in, or is, is a repository Lithic backs up.
 *
 * `null` is the ordinary answer rather than a failure: a Lith in a folder nothing manages is
 * not news, and it is the same answer the desktop app gives.
 */
export function shimGitStatus(path: string, call: ShimCall = {}): Promise<ShimResult<ShimSyncStatus | null>> {
  return shimCommand('git-status', { path }, call).then((answer) => result<ShimSyncStatus | null>(answer));
}

/**
 * One answer for a whole recents list rather than a call per row: path to the repository root
 * that publishes it. A path no repository covers is absent, so a row is never told apart from
 * an unbacked one by a null.
 */
export function shimGitCoverage(paths: string[], call: ShimCall = {}): Promise<ShimResult<Record<string, string>>> {
  return shimCommand('git-coverage', { paths }, call).then((answer) => result<Record<string, string>>(answer));
}

/**
 * Every `.lith` in one folder, newest first, for the launcher's re-index. Accepts a file or
 * the folder holding it, so a caller can hand over whichever of the two it already has.
 */
export function shimFolderLiths(path: string, call: ShimCall = {}): Promise<ShimResult<string[]>> {
  return shimCommand('list-folder-liths', { path }, call).then((answer) => result<string[]>(answer));
}
