/**
 * The instance's history trail: the last few commits of the repository this device, or this
 * server, is backed up to, and the one way back to an earlier one.
 *
 * Three backends answer the same question and this module is where their answers become one
 * shape. The desktop app's `git_sync_history` answers an array of rows, because an IPC call has
 * no envelope; the shim's `git-history` and a server's `/api/github/history` answer
 * `{ commits: [...] }`, because both are JSON on a wire and a bare array is the one shape a
 * truncated answer can be confused with. `parseTrailCommits` reads either, which is the same
 * bargain `git-sync-health.ts` makes for the two status shapes: the page must not have to know
 * which backend answered.
 *
 * A row is the wiki history trail's row, one unit of it over. Same stamp (`utcStamp`, the shape
 * the store's own records carry), same distance (`versionGap` and `gapCount`, one unit, the
 * greatest that fits), same order (newest first, so the row above any row is the newer one).
 * The two lists mean the same thing to the person reading them and any second way of writing a
 * date or saying "4 minutes later" would be drift nobody notices until they sit side by side.
 *
 * What a commit adds to the version trail's row is the kind it is, and that is read off the
 * message rather than asked for: every message in this history was written by Lithic itself
 * (`trailPill` names each writer), so a row says "Lithic did this" or "something else did"
 * without a second round trip. The words for the three kinds are the deck's.
 *
 * Nothing here talks to a backend and nothing here is copy: the words are the deck's, and the
 * sentences a revert produces belong to the dialog that runs it.
 */

import { gapCount, versionGap, type VersionGap } from './history-gap.ts';
import { utcStamp } from './wiki-history.ts';

/**
 * How many commits the trail asks for, and the most one request may ask for.
 *
 * Declared once, in `git-sync-contract.ts`, because the two backends are generated from those same
 * numbers: re-exported here so the trail's own consumers keep one import.
 */
export { TRAIL_LIMIT, TRAIL_LIMIT_MAX } from './git-sync-contract.ts';

/** One commit, in the shape every backend is read into. */
export interface TrailCommit {
  hash: string;
  /** The seven characters git itself would print. Derived when a backend omits it. */
  short: string;
  summary: string;
  /** Author time, in epoch seconds: what git stores, converted here rather than at each call. */
  time: number;
}

/** A commit as the trail draws it: the stamp it shows, and its distance from the row above. */
export interface TrailRow extends TrailCommit {
  stamp: string;
  /** The gap to the next newer commit, or null when there is none to state. */
  gap: VersionGap | null;
  /** What the row's own message says the commit was. */
  pill: TrailPill;
}

/**
 * The three kinds of commit the trail draws as a pill.
 *
 *  - `auto`   a save Lithic's own writers made, on their own schedule rather than by hand.
 *  - `revert` the go-back a revert appends, and the safety save it makes on the way.
 *  - `other`  anything else, which is a commit made by hand or by something Lithic does not
 *             know about.
 */
export type TrailPill = 'auto' | 'revert' | 'other';

/**
 * The messages Lithic's own writers make, each with the writer that makes it.
 *
 * They are matched as prefixes because that is how they are written: the ones that carry a
 * date or a file name put it after the colon. A writer added without a pattern here is a
 * commit the trail calls `other`, which is the safe side of being wrong.
 */
const AUTO_MESSAGES: readonly RegExp[] = [
  /^Automated Sync\b/, // the self-host timer, on its own schedule and before it overwrites
  /^Initial Sync\b/, // the first push, from the entrypoint and the setup script
  /^Initial sync from Lithic$/, // the desktop app's own first commit when it connects
  /^System:/, // the setup commits, named so that they read as the system's
  /^Lithic backup$/, // the shim's save
  /^CONFLICT BACKUP:/, // a safety copy the timer takes before it clobbers the working tree
  /^Add .+ from Lithic$/, // the launcher copying a Lith into the backed-up folder
  /^Save \S+\.(?:lith|tid|json)$/ // one file, written by the server's own save route
];

/** The go-backs: the commit that records one, the save made before it, and a restore to a revision. */
const REVERT_MESSAGES: readonly RegExp[] = [
  /^Revert to \S/, // the revert itself, naming the commit it went back to
  /^Save before revert$/, // the unsaved edits, committed so the go-back cannot discard them
  /^Restore \S+ to \S+$/ // one file put back on an earlier revision
];

/**
 * Which pill a commit's own message earns it.
 *
 * Revert is asked first, because both of a revert's commits are Lithic's and only one of them
 * would still read as `auto` otherwise. An empty or unrecognised message is somebody else's.
 */
export function trailPill(summary: string): TrailPill {
  const message = summary.trim();
  if (REVERT_MESSAGES.some((pattern) => pattern.test(message))) return 'revert';
  if (AUTO_MESSAGES.some((pattern) => pattern.test(message))) return 'auto';
  return 'other';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One commit from a backend's row, or null when the row is not one.
 *
 * `short` is derived from the hash when it is missing rather than refused: the id is the fact,
 * and the abbreviation is git's own rule about it, so a backend that sends only the full hash is
 * still answering the question.
 */
function toCommit(value: unknown): TrailCommit | null {
  if (!isRecord(value)) return null;
  const hash = typeof value.hash === 'string' ? value.hash.trim() : '';
  if (!hash) return null;
  const time = typeof value.time === 'number' && Number.isFinite(value.time) ? value.time : null;
  if (time === null) return null;
  const short = typeof value.short === 'string' && value.short.trim() ? value.short.trim() : hash.slice(0, 7);
  return {
    hash,
    short,
    summary: typeof value.summary === 'string' ? value.summary : '',
    time
  };
}

/**
 * A backend's answer as commits, or null when it is not a list of them.
 *
 * Null and `[]` are deliberately different answers: an empty repository has an empty trail (the
 * dialog says there is nothing yet), while a payload this module cannot read is a backend that
 * did not answer the question, and the dialog says that instead. Collapsing the two would tell
 * somebody their history is empty when the truth is that nobody read it.
 */
export function parseTrailCommits(payload: unknown): TrailCommit[] | null {
  const list = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.commits)
      ? payload.commits
      : null;
  if (!list) return null;
  const commits: TrailCommit[] = [];
  for (const entry of list) {
    const commit = toCommit(entry);
    if (!commit) return null;
    commits.push(commit);
  }
  return commits;
}

/**
 * The rows the list draws: each commit with its stamp and its distance from the row above.
 *
 * The gap is measured from the row *above* (the newer commit), which is the direction the wiki
 * trail reads: the chevron between two rows points up at the newer one, and the distance beside
 * it is stated as that newer row's own "N later". Equal stamps, or a clock that ran backwards,
 * produce no gap and the chevron joins the two rows alone.
 */
export function trailRows(commits: readonly TrailCommit[]): TrailRow[] {
  return commits.map((commit, index) => {
    const newer = index > 0 ? commits[index - 1] : undefined;
    return {
      ...commit,
      stamp: utcStamp(commit.time * 1000),
      gap: newer ? versionGap((newer.time - commit.time) * 1000) : null,
      pill: trailPill(commit.summary)
    };
  });
}

/**
 * The words for a row's distance, in this locale's numbers.
 *
 * The unit words are the wiki history trail's (`dialogs.history.later`): both lists say the same
 * sentence about two timestamps, and a second set of four plural rules would be four more places
 * to get a plural wrong.
 */
export function trailGapLabel(
  gap: VersionGap,
  later: Record<VersionGap['unit'], (count: string) => string>,
  localeTag: string
): string {
  return later[gap.unit](gapCount(gap, localeTag));
}
