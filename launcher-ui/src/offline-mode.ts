/**
 * Offline mode: what a cached self-host launcher becomes when the instance behind it
 * cannot be reached.
 *
 * One mode has this state and the others do not, which is the whole reason it is a mode
 * rather than a status line. The desktop app runs from its own files and the plain PWA
 * from a copy on this device, so a lost network costs neither of them anything the
 * launcher has to announce; a self-host launcher, by contrast, is a page one instance
 * served and this browser kept, and every row it can draw lives on a server that is now
 * out of reach.
 *
 * So the state is owned here rather than spread through the component: the two inputs
 * that decide it, and the words that go on screen once it is true. Keeping the decision
 * and the copy together is what stops a later change to one from leaving the other
 * describing a launcher that no longer exists.
 */

import type { LauncherMode } from './mode.ts';

/**
 * Whether this launcher is in offline mode.
 *
 * `unreachable` is this instance having failed to answer as a *network* fault (see
 * `looksUnreachable`). Two ways in, because they are two real situations: the browser
 * knows it has no network and says so, and a server can be down while the network is
 * fine. Either is enough, and neither can be true in a mode that does not need a server.
 */
export function offlineMode(mode: LauncherMode, online: boolean, unreachable = false): boolean {
  if (mode !== 'self-host') return false;
  return !online || unreachable;
}

/**
 * Whether a failed read failed because nothing answered, rather than because the server
 * answered with a refusal.
 *
 * Worth telling apart: `PROPFIND failed: 404` is an instance that is talking to us, and
 * calling that "offline" would put the banner over a deployment problem and hide the
 * error that would have explained it. A browser's `fetch` rejects with a `TypeError` and
 * no status when the request never landed, which is the case this exists to name; the
 * message test is for engines that wrap it, and for an abort, which reaches the same
 * place from the same cause.
 */
export function looksUnreachable(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  if (error instanceof DOMException && error.name === 'AbortError') return true;
  const message = (error instanceof Error ? error.message : String(error ?? '')).toLowerCase();
  return /failed to fetch|networkerror|network request failed|load failed|fetch failed|connection/.test(message);
}

/**
 * The banner's heading: the cause, which is what the legacy launcher named first.
 *
 * The state used to be titled "Offline mode", which names the mode rather than what
 * happened to the reader. The retired launcher's own notice led with the symptom, and it
 * is the one line that explains why a list they know changed shape.
 */
export const OFFLINE_TITLE = 'Server unreachable';

/**
 * The banner's one line: what is listed, and what opening it does.
 *
 * The legacy launcher's wording, which said this better than a rewrite did and is where the
 * shape comes from: `Server unreachable — showing local cache. Files open in read-only
 * mode.` Its two clauses survive here (what is on screen, and the read-only consequence the
 * row tooltips would otherwise carry one row at a time); its em dash does not, because the
 * copy rules ban dashes and ask for a period instead (agents.md). "This device's saved
 * copies" is the half the reader needs: the list is theirs, not the server's.
 */
export const OFFLINE_BODY = 'Showing this device’s saved copies. Liths open read-only.';

/** The mark's title while offline: the reason a row reads as local-only. */
export const OFFLINE_ROW_MARK_TITLE = 'Only on this device while offline.';

/** What opening a listed row does while offline. */
export const OFFLINE_ROW_OPEN_TITLE = 'Open this device’s copy read-only';
