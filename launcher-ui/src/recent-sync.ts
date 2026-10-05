/**
 * How the device folder and the recent list describe each other.
 *
 * The recent list is the record of the Liths a person has, and device sync is one more
 * place a Lith can be. That makes the folder a *source* of the same kind the connected
 * repository is, and the two answers the launcher needs are the two it already computes
 * there: which rows the source holds, and what to do about rows it does not.
 *
 * The three rules, which are github-sync's own and are why this is a module rather than a
 * condition in the template.
 *
 * - **The folder's entries are the list's.** An entry nothing here has is a row anyway: the
 *   list is built from the session's own state, so it heals itself and there is no adopted
 *   row to go stale, no write to race a refresh, and nothing that can be left behind when
 *   the pairing changes. It is the one place this differs from a connected folder, and the
 *   difference is honest: there, the folder's Liths really are files on this disk, so
 *   adopting them writes rows that can be opened; here the engine's copy lives in its own
 *   replica and a row for it would name a file the user cannot open.
 * - **A row the folder does not hold is not a fault and is never removed.** It is marked,
 *   and the mark is where the offer to publish it lives, which is the shape of github-sync's
 *   local-only rows: a Lith outside the backup is a fact worth stating, not a warning, and
 *   the one control that can change it sits on the row. Nothing else in the launcher may
 *   drop a recent row, so a device that pairs, syncs, and unpairs leaves the list as it
 *   found it.
 * - **Loading is offered only for a name nothing here has.** A pull writes a file the user
 *   picks the home for, so it can never land on top of a copy this device already keeps.
 *   That is what makes the pull side safe to put on a row: a name both sides hold is shown
 *   as shared and its control publishes, where github-sync's merge is adds-only for the
 *   same reason.
 *
 * What is deliberately *not* here is any notion of the folder's contents being newer or
 * older than a row's. The engine's document keeps every version of a name and publishes the
 * latest, so sending a Lith that is already there is a new version of it rather than an
 * overwrite (see `sync/src/engine.rs::publish`), and a comparison this module cannot make
 * (the engine hashes with blake3, the launcher has no digest of a local file at all) would
 * only be a guess dressed as a fact.
 */

import type { SyncedEntry } from './device-sync';

/** The one thing this module needs of a recent row: what it is called. */
export interface NamedRow {
  name: string;
}

/** The folder's entries by lowercased name, which is how a row and an entry are compared. */
export function syncIndex(entries: readonly SyncedEntry[]): Map<string, SyncedEntry> {
  const index = new Map<string, SyncedEntry>();
  for (const entry of entries) index.set(entry.name.toLowerCase(), entry);
  return index;
}

/**
 * Whether the folder holds this name.
 *
 * Case-insensitively, because the folder is not case-aware in a way that matters here and
 * two rows differing only in case are one Lith on every platform this runs on. The engine's
 * own name check (`is_safe_name`) is the other half of that.
 */
export function isShared(name: string, index: ReadonlyMap<string, SyncedEntry>): boolean {
  return index.has(name.toLowerCase());
}

/**
 * The folder's entries that no row here accounts for, in the folder's own order.
 *
 * These are what the recent list draws as rows of their own: a Lith another device has,
 * which this one can load. Deduped by name, because two entries differing only in case would
 * be one row.
 */
export function deviceOnlyEntries(rows: readonly NamedRow[], entries: readonly SyncedEntry[]): SyncedEntry[] {
  const known = new Set(rows.map((row) => row.name.toLowerCase()));
  const seen = new Set<string>();
  const only: SyncedEntry[] = [];
  for (const entry of entries) {
    const key = entry.name.toLowerCase();
    if (known.has(key) || seen.has(key)) continue;
    seen.add(key);
    only.push(entry);
  }
  return only;
}

/** What this page can read a row's Lith through. Asked of the caller because it is a fact
 * about the process serving the page, which is the same reason `device-sync.ts` asks the
 * served location where its engine is. */
export interface PublishSources {
  /** This process can read a path it is given (the desktop app; a shim, which has no
   * device prong at all). A browser page cannot, whatever a row remembers. */
  canReadPath: boolean;
  /** This page can ask the server it came from for a Lith by name (self-host). */
  canFetchByName: boolean;
}

/** Which of them a row's bytes would come from, in the order they are tried. */
export type PublishSource = 'text' | 'path' | 'handle' | 'server';

/**
 * Where this row's own Lith can be read from, or null when nothing here can read it.
 *
 * The order is by how directly the bytes are held: a Lith this page created and never saved
 * is already in memory, a path is a file the process can open, a handle is a file the
 * browser may open, and the server is a request. A row with none of the four is one this
 * page can show and open but not send, and saying so is better than a control that fails
 * when pressed.
 */
export function publishSource(
  row: { name: string; path?: string | null; text?: string; handle?: unknown },
  sources: PublishSources
): PublishSource | null {
  if (typeof row.text === 'string' && row.text !== '') return 'text';
  if (sources.canReadPath && typeof row.path === 'string' && row.path !== '') return 'path';
  if (row.handle) return 'handle';
  if (sources.canFetchByName) return 'server';
  return null;
}
