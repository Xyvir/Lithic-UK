/**
 * The contract between the launcher and the three things that answer its GitHub-sync questions:
 * the desktop app's `git_sync_heartbeat`, the shim's `git_heartbeat`, and an instance's
 * `/api/github/heartbeat`.
 *
 * This module is the single source of truth for two things that used to be written out in every
 * backend as well as in the page: the verdict a heartbeat reports and the one sentence that goes
 * with it, and how many commits the history trail asks for.
 *
 * `scripts/sync-contract.mjs` reads this module and emits the two Rust contract modules and the
 * `HealthState` union in `git-sync-health.ts`. The values and ordered status rules below are the
 * source of truth; the generator contains no policy literals. `npm run check:push` rejects stale
 * copies, the same bargain `color-palette.ts` makes with `styles.css`.
 *
 * Why it is one copy rather than two that agree by hand. The desktop app and the shim are separate
 * binaries that link no shared crate, so the verdict arithmetic and its sentences were written
 * twice and kept in step by reading both. That is exactly the arrangement this file removes.
 *
 * Nothing here is copy for the page: the launcher's own strings live in `copy.ts`, and the
 * fragment deck it shows is deliberately a different shape (lowercase, and it names no
 * repository). What is shared is the machine's side of the contract, which both backends must
 * state identically.
 */

/** One verdict a heartbeat can reach, and the one sentence a backend shows for it. */
export interface SyncVerdict {
  /** The wire token the launcher switches on, and the Rust state string. */
  state: string;
  /** The sentence a backend shows, with `{repo}` replaced by `owner/name`. */
  detail: string;
  /**
   * The sentence for a repository whose branch does not exist yet (HTTP 409), which is a first
   * backup waiting to happen rather than a fault. Only one verdict has two sentences.
   */
  empty?: string;
  /**
   * The state an unrecognised token reads as, and the one sentence a heartbeat can always state.
   * Exactly one verdict carries this, because a fallback that had company would be a verdict.
   */
  fallback?: boolean;
}

/**
 * The verdicts, in the order the launcher's union declares them.
 *
 * Order is load bearing only for readability: the generator emits the union in this order so a
 * diff of this file and a diff of the generated block read the same way.
 */
export const SYNC_VERDICTS: readonly SyncVerdict[] = [
  {
    state: 'ok',
    detail: 'Backed up to github.com/{repo}.',
    empty: 'github.com/{repo} is empty, so the next save starts it.'
  },
  {
    state: 'readonly',
    detail: 'This token can only read github.com/{repo}. Reconnect to allow pushes.'
  },
  { state: 'auth', detail: 'GitHub rejected this token. Reconnect to sign in again.' },
  {
    state: 'missing',
    detail: 'github.com/{repo} is missing or not shared with this token.'
  },
  {
    state: 'throttled',
    detail: 'GitHub is rate-limiting this device. Saves stay local for now.'
  },
  {
    state: 'offline',
    detail: 'Cannot reach github.com. Saves stay on this device.',
    fallback: true
  },
  {
    state: 'malformed',
    detail: "This folder's saved remote is unreadable. Reconnect to repair it."
  },
  { state: 'unmanaged', detail: 'This folder is not synced.' }
];

/** One HTTP status rule in the ordered heartbeat classifier. */
export interface SyncStatusRule {
  /** Inclusive status-code ranges, checked in order. */
  statuses: readonly (readonly [number, number])[];
  /** State for matching statuses unless one of the conditions below applies. */
  state: string;
  /** State instead when GitHub explicitly says the token cannot push. */
  pushDenied?: string;
  /** State instead when the 403 response is a rate limit. */
  rateLimited?: string;
}

/**
 * Ordered HTTP classification rules. The final fallback is the `offline` verdict. Every number
 * and branch is declared here so the generator has no hard-coded verdict logic of its own.
 */
export const SYNC_STATUS_RULES: readonly SyncStatusRule[] = [
  {
    statuses: [[200, 299], [409, 409]],
    state: 'ok',
    pushDenied: 'readonly'
  },
  { statuses: [[401, 401]], state: 'auth' },
  { statuses: [[403, 403]], state: 'auth', rateLimited: 'throttled' },
  { statuses: [[404, 404]], state: 'missing' }
];

/** State returned when no status rule matches. */
export const SYNC_STATUS_FALLBACK = 'offline';

/**
 * Sync-wide values used by the desktop app, shim, self-host CGI and test stub.
 *
 * Local enforcement remains in each prong; these values are its shared policy, not a shared
 * trust boundary. Every backend still clamps its own untrusted input.
 */
export const SYNC_CONSTANTS = {
  trailLimit: 10,
  trailLimitMax: 50,
  firstSyncFileCap: 2000,
  mainRef: 'refs/heads/main',
  remoteMainRef: 'refs/remotes/origin/main',
  originFetchSpec: '+refs/heads/*:refs/remotes/origin/*',
  preRevertMessage: 'Save before revert',
  revertMessagePrefix: 'Revert to ',
  managedMarker: 'oauth2:'
} as const;

/** Alias exports preserve the launcher's existing named imports. */
export const TRAIL_LIMIT = SYNC_CONSTANTS.trailLimit;
export const TRAIL_LIMIT_MAX = SYNC_CONSTANTS.trailLimitMax;
