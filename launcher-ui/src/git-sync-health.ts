/**
 * What the GitHub sync icon should say, and when checking is worth a network
 * round trip.
 *
 * Two questions, deliberately kept apart:
 *
 * - The *marker* (`git_sync_status`) answers "is this folder wired to a
 *   repository". It reads the folder's own `.git/config` and costs nothing, so
 *   it drives connect/disconnect instantly.
 * - The *health* (`git_sync_heartbeat`) answers "is the backup still working".
 *   It costs a request, so it is throttled and event-driven.
 *
 * Green has to mean *verified*, because the failure it would otherwise hide is
 * silent: a revoked token, a deleted repository, and a token without write
 * access all leave the marker perfectly intact while every save quietly stops
 * uploading. So green requires a verdict, a verdict that came from a failed
 * push overrules it, and a folder with no verdict yet shows amber rather than
 * assuming the best.
 *
 * The same reasoning applies to grey, one step earlier. Grey means "nothing is
 * synced here", which the launcher cannot say until the marker read comes back
 * — so the first paint asks the question in amber instead of asserting there is
 * nothing to ask about. Returning to the launcher from a wiki makes this
 * visible: a reload discards the marker state, and the icon used to spend that
 * window grey, reading as "not set up" for a folder that is synced.
 *
 * Everything here is pure, so the truth table is testable without Tauri, a
 * network, or a real expired token.
 */

/** Verdicts `git_sync_heartbeat` can return. */
export type HealthState =
  | 'ok'
  | 'readonly'
  | 'auth'
  | 'missing'
  | 'throttled'
  | 'offline'
  | 'malformed'
  | 'unmanaged';

/** What the header icon renders (each has a colour in styles.css). */
export type SyncIndicator = 'idle' | 'checking' | 'connected' | 'syncing' | 'error';

/** Floor between heartbeats, so a burst of events costs one request. */
export const HEARTBEAT_FLOOR_MS = 60_000;
/** Ceiling while the connection keeps failing. */
export const HEARTBEAT_CEILING_MS = 600_000;
/** How long a save's commit colours the icon as syncing. */
export const SYNC_PULSE_MS = 4_000;

/**
 * Why a verdict means the backup is not working, or null when it is fine.
 *
 * One short sentence each, and the action where there is one. The Rust-side
 * details say the same things for the dialog, so the two are deliberately
 * near-identical: the same fault has no business reading two different ways
 * depending on where the user looks.
 *
 * `unmanaged` is not a failure — it is the marker check reporting that nothing
 * is synced here, which the caller renders as idle.
 */
export function healthFailure(health: HealthState | null | undefined): string | null {
  switch (health) {
    case 'readonly':
      return 'this token can only read the repository. Reconnect to allow pushes.';
    case 'auth':
      return 'GitHub rejected this token. Reconnect to sign in again.';
    case 'missing':
      return 'the repository is missing or not shared with this token.';
    case 'throttled':
      return 'GitHub is rate-limiting this device. Saves stay local for now.';
    case 'offline':
      return 'cannot reach github.com. Saves stay on this device.';
    case 'malformed':
      return "this folder's saved remote is unreadable. Reconnect to repair it.";
    default:
      return null;
  }
}

export interface SyncIndicatorInput {
  /**
   * The marker check found a Lithic-managed remote for the focused folder;
   * `null` while that read is still outstanding, which is the state to report
   * as amber rather than as grey.
   */
  hasMarker: boolean | null;
  /**
   * The last heartbeat verdict. Absent until one has landed, which is the only
   * situation that shows amber: re-checking a folder whose verdict is already
   * known must not flicker.
   */
  health?: HealthState | null;
  /**
   * Rust has a backup of this folder running right now. Authoritative and
   * independent of the marker: the command only reports in-flight for a folder
   * it is already syncing, so this outranks even an unknown marker. That is the
   * case of leaving a wiki whose save is still being pushed.
   */
  backupInFlight?: boolean;
  /** Epoch the pulse from a save lasts until; 0 when none. */
  syncingUntil?: number;
  /** Why the most recent save's push did not land; cleared once one does. */
  lastPushError?: string | null;
  /** Repository the folder is synced to, for the tooltip. */
  repo?: string | null;
  /** When the current verdict was obtained. */
  verifiedAt?: number | null;
  now: number;
}

export interface SyncIndicatorResult {
  state: SyncIndicator;
  title: string;
}

/**
 * The icon's state and tooltip. Precedence is in-flight backup → unknown marker
 * → idle → save pulse → error → checking → connected, and each rule exists for a
 * reason:
 *
 * - a backup Rust says is running is the most specific truth there is, and the
 *   only thing that can be said before the marker read answers;
 * - an unknown marker is amber: grey is a claim ("nothing is synced here") that
 *   has not been earned yet;
 * - a save pulse needs a marker, or saving an ordinary folder would flash purple;
 * - a push that failed is first-hand evidence that the backup is behind, so it
 *   outranks a "the repository is reachable" verdict;
 * - amber is only for a folder whose verdict is genuinely unknown.
 */
export function syncIndicator(input: SyncIndicatorInput): SyncIndicatorResult {
  const {
    hasMarker,
    health = null,
    backupInFlight = false,
    syncingUntil = 0,
    lastPushError = null,
    now
  } = input;

  // A backup that is running right now, reported by the side that is doing it.
  // Above the marker check because the launcher reloads into this state: the
  // wiki that was just left is the one whose push is still going.
  if (backupInFlight) return { state: 'syncing', title: 'GitHub Sync: syncing…' };

  // The marker read has not answered yet. This is the window that used to be
  // grey, which said "not set up" about a folder nobody had looked at yet.
  if (hasMarker === null) return { state: 'checking', title: 'GitHub Sync: checking…' };

  // Nothing is synced here: a stale verdict or a stale failure would put a
  // warning on a folder that is simply not part of any backup.
  if (!hasMarker) return { state: 'idle', title: 'GitHub Sync' };

  if (now < syncingUntil) return { state: 'syncing', title: 'GitHub Sync: syncing…' };

  if (lastPushError) {
    return { state: 'error', title: `GitHub Sync: the last save did not upload (${lastPushError})` };
  }

  const failure = healthFailure(health);
  if (failure) return { state: 'error', title: `GitHub Sync: ${failure}` };

  if (!health) return { state: 'checking', title: 'GitHub Sync: verifying the connection…' };

  const age = verifiedAge(input.verifiedAt, now);
  const target = input.repo ? `github.com/${input.repo}` : 'connected';
  return { state: 'connected', title: `GitHub Sync: ${target}${age ? `, verified ${age} ago` : ''}` };
}

/** "45s" / "3m" / "2h" — how long ago the verdict was obtained. */
export function verifiedAge(verifiedAt: number | null | undefined, now: number): string | null {
  if (!verifiedAt) return null;
  const seconds = Math.max(0, Math.round((now - verifiedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}

/**
 * How long to wait before asking again, after `failures` verdicts in a row that
 * were not `ok`. Doubles from the floor to the ceiling: a laptop on a plane
 * must not sit there hammering github.com, and a connection that comes back
 * should be noticed within the ceiling.
 */
export function heartbeatBackoff(failures: number): number {
  const steps = Math.max(0, Math.min(Math.floor(failures), 4));
  return Math.min(HEARTBEAT_FLOOR_MS * 2 ** steps, HEARTBEAT_CEILING_MS);
}

export interface HeartbeatGate {
  /** Epoch of the last attempt; 0 when never attempted. */
  lastAttemptAt: number;
  /** Consecutive verdicts that were not ok, which lengthen the wait. */
  failures: number;
  now: number;
  /** A hidden window has nobody looking at the icon. */
  hidden: boolean;
  /** The user just asked — the dialog opened, or a push just failed. */
  force?: boolean;
}

/** Whether this moment is worth a heartbeat request. */
export function shouldHeartbeat(gate: HeartbeatGate): boolean {
  if (gate.hidden) return false;
  if (gate.force) return true;
  return gate.now - gate.lastAttemptAt >= heartbeatBackoff(gate.failures);
}
