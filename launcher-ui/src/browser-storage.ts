import type { LauncherMode } from './mode.ts';

/**
 * Where a browser mount's saves land.
 *
 *   'file'     the File System Access API is present, so a picked file can be
 *              written back in place — Chromium on every desktop platform.
 *   'index-db' it is not, which is every browser on macOS except Chrome (Safari
 *              is the only browser a PWA can be installed from there, and
 *              Firefox has never shipped the API either). No file is ever
 *              opened or written: the browser's own storage *is* the document,
 *              and the launcher's existing cache, version history and download
 *              flows are the only copies that exist.
 *
 * The distinction is not a preference — it is the platform's answer to "can
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
 * What the row's mark says, and what the section says once, above the list.
 *
 * The claim is deliberately absolute: nothing in this mode writes a file, so
 * every row it produces is volatile for the same reason, and the mark is not a
 * problem to be cleared — it is what the Lith *is* until the user downloads a
 * copy of it. Clearing site data is the browser's own equivalent of deleting
 * the folder, which is why the launcher offers no `Reset Recents` here.
 */
export const BROWSER_ONLY_LABEL = 'Browser storage only';

export const BROWSER_ONLY_TOOLTIP =
  'Browser storage only: this Lith is kept in this browser’s cache, and nothing here is written back to a file. ' +
  'That copy is intrinsically volatile — clearing site data, or the browser reclaiming space, will lose it. ' +
  'Download your own hard copies from its version history.';

export const BROWSER_ONLY_NOTE =
  'Browser storage only — these Liths are kept in this browser’s cache rather than written to files. ' +
  'Download copies from a Lith’s version history to keep them; this storage is finite and can be reclaimed.';

/** The row mark's title: the wiki's name, then what is true of it. */
export function browserOnlyMarkTitle(name: string): string {
  return `${name} — ${BROWSER_ONLY_TOOLTIP}`;
}
