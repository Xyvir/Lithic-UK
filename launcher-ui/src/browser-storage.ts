import { copy } from './copy.ts';
import type { LauncherMode } from './mode.ts';

/**
 * Where a browser mount's saves land.
 *
 *   'file'     the File System Access API is present, so a picked file can be
 *              written back in place. Chromium on every desktop platform.
 *   'index-db' it is not, which is every browser on macOS except Chrome (Safari
 *              is the only browser a PWA can be installed from there, and
 *              Firefox has never shipped the API either). No file is ever
 *              opened or written: the browser's own storage *is* the document,
 *              and the launcher's existing cache, version history and download
 *              flows are the only copies that exist.
 *
 * The distinction is not a preference. It is the platform's answer to "can
 * this tab write a file it was not given".
 */
export type StorageMode = 'file' | 'index-db';

/** Query parameter that forces a storage mode, for testing the fallback. */
export const STORAGE_MODE_PARAM = 'storage';

type PickerHost = { showSaveFilePicker?: unknown };

/** The one capability that separates the two modes. */
export function supportsFileAccessApi(host: PickerHost | null | undefined): boolean {
  return typeof host?.showSaveFilePicker === 'function';
}

/**
 * The storage mode for this page.
 *
 * Only browser mounts are ever at stake: the desktop app writes through Rust
 * and a self-host instance writes to its own server, so neither one has a use
 * for the fallback and neither may be talked into it. `forced` is the query
 * parameter, so the fallback can be exercised (and the Chromium path kept
 * honest) on a platform that does have the API.
 *
 * A page whose own server declared it browser-only (see `declaresBrowserOnly`) does not
 * enter into the answer. That declaration is what makes a loopback shim resolve to `webapp`
 * rather than to an instance, and it says nothing about where saves land: on the shim,
 * Chromium writes real files in place and the browsers without the API keep the fallback
 * they have everywhere else. Forcing the store on a capable browser would make the shim the
 * one launcher that ignores the platform it is running on, so it does not.
 */
export function resolveStorageMode(
  mode: LauncherMode,
  host: PickerHost | null | undefined = typeof window === 'undefined' ? undefined : (window as PickerHost),
  forced?: string | null
): StorageMode {
  if (mode !== 'webapp') return 'file';
  const override = forced?.trim().toLowerCase();
  if (override === 'index-db' || override === 'indexdb' || override === 'browser') return 'index-db';
  if (override === 'file') return 'file';
  return supportsFileAccessApi(host) ? 'file' : 'index-db';
}

/** The forced mode carried on this page's URL, or null. */
export function storageModeOverride(search: string): string | null {
  try {
    return new URLSearchParams(search).get(STORAGE_MODE_PARAM);
  } catch {
    return null;
  }
}

/**
 * Which kind of recents row a mount leaves behind.
 *
 *   'browser-only' nothing this page produces can be written to a file, so the row claims
 *                  the browser's own copy and says so
 *   'handle'       a file the platform can write back to, which is how it is reopened
 *   'plain'        a name, or a path the running shape reaches without a handle
 *
 * The storage-only answer is asked first, ahead of the handle, and that order is the rule
 * rather than a detail of any one caller. Chromium's picker hands its files over as handles
 * and the other browsers cannot, so a page that decided its saves go to browser storage and
 * then built the row out of the handle would describe a document nobody is updating: the
 * file would be left exactly as it was found while the row claimed to hold it.
 */
export type RecentRowKind = 'browser-only' | 'handle' | 'plain';

export function rememberRowKind(indexDbOnly: boolean, hasHandle: boolean): RecentRowKind {
  if (indexDbOnly) return 'browser-only';
  return hasHandle ? 'handle' : 'plain';
}

/**
 * What the row's mark says, and it is the whole of the saying: there is no line
 * above the list repeating it.
 *
 * The claim is deliberately absolute: nothing in this mode writes a file, so
 * every row it produces is volatile for the same reason, and the mark is not a
 * problem to be cleared. It is what the Lith *is* until the user downloads a
 * copy of it. Clearing site data is the browser's own equivalent of deleting
 * the folder, which is why the launcher offers no `Reset Recents` here.
 *
 * A list that opens with a paragraph of explanation is worse at being a list, so
 * the title on the mark carries all of it. `title` reaches a pointer and
 * `aria-label` a screen reader, but a touch screen reaches neither. Which is what
 * the dialog below is for.
 */
export const BROWSER_ONLY_TOOLTIP = copy.row.browserOnlyClaim;

/**
 * The same claim, said where a touch screen can read it: the version-history dialog
 * the mark itself opens, above the versions whose download is the way out.
 */
export const BROWSER_ONLY_HISTORY_NOTE = copy.row.browserOnlyNote;

/**
 * The row mark's title: the wiki's name, then what is true of it.
 *
 * A period between the two rather than a dash, like every other title in this app that
 * says a name and then a claim (`Not in a backed-up folder. Open for the copy offer.`).
 * A tooltip is one of the two places the no-dashes rule names, so the mark's own title is
 * where it would be most visible.
 */
export function browserOnlyMarkTitle(name: string): string {
  return copy.row.browserOnly(name);
}
