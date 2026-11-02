import { resolveStorageMode, storageModeOverride, type StorageMode } from './browser-storage.ts';
import type { LauncherMode } from './mode.ts';

/**
 * The decisions that say which launcher a page is.
 *
 * One artifact is served to every distribution, and it has to work out which one it is before it
 * draws anything: the desktop app, a shim behind a released build, a published deployment, an
 * instance's `self-host` page, and a browser mount on a platform that can or cannot write a file.
 * The page used to answer that inline, in a handful of declarations, which left every feature
 * reading `mode` itself (147 mentions) and re-deriving `mode === 'tauri' || shimToken !== null`
 * by hand (`shimBackend` beside it, five more times). These are the same rules, named and given
 * one home, so a feature asks a question instead of carrying the arithmetic.
 *
 * Nothing here holds state, and none of it is a store. Every function is a pure answer about an
 * environment the page has already read: `mode` from `main.ts`, the shim's per-launch secret and
 * build tag from the document, the storage override from the query, and the process's own
 * capability report. That is what lets these answers be tested here, where the page's inline
 * copies could only be tested by driving the whole launcher.
 *
 * The rules are not restatements of the page's old expressions for their own sake. Each one has
 * a reason the page states at length beside where it used to live, and moving the arithmetic here
 * does not move the reason: `storageMode` still turns on the *platform's* answer rather than on
 * the distribution, a shim page is never forced into the fallback, and an app whose process
 * cannot hold a document falls back rather than failing to save.
 */
export interface BranchEnvironment {
  /** What served this page, resolved once in `main.ts`. */
  mode: LauncherMode;
  /** The shim's per-launch secret, or null on a page no shim served. */
  shimToken: string | null;
  /** This page's `window.location.search`, or null where there is no window. */
  search: string | null;
  /** The window, as the File System Access check reads it, or undefined without one. */
  pickerHost?: { showSaveFilePicker?: unknown } | null;
  /** The process's own answer about holding a document (`local_files`), or undefined. */
  documents?: boolean;
}

/**
 * Whether a shim served this page, which is what makes its command wire reachable.
 *
 * The secret's presence and nothing else: a published deployment, an instance and the desktop
 * app all serve no token. It is not the same question as whether the shim's *backend* answered,
 * which is a probe and stays in the page.
 */
export function branchShimBackend(shimToken: string | null): boolean {
  return shimToken !== null;
}

/**
 * Where this page's saves land.
 *
 * A shim answers `file` on every browser, because the shim itself writes the path the desktop's
 * chooser named, so a browser with no File System Access API still has a process that can write.
 * Everywhere else the platform decides, and `resolveStorageMode` is where that rule is stated in
 * full, including the query override that exists so the fallback can be exercised on a machine
 * that has the API.
 */
export function branchStorageMode(env: BranchEnvironment): StorageMode {
  if (env.shimToken) return 'file';
  return resolveStorageMode(
    env.mode,
    env.pickerHost,
    env.search === null ? null : storageModeOverride(env.search),
    env.documents
  );
}

/** Whether the cached copy in this browser is the document, because no Lith here has a file. */
export function branchIndexDbOnly(storageMode: StorageMode): boolean {
  return storageMode === 'index-db';
}

/**
 * Whether this page can ask a process about a folder's backup at all.
 *
 * Two distributions can: the desktop app, whose Rust bridge owns the git repository, and a shim,
 * whose wire answers the same questions out of `.git/config`. A published deployment and an
 * instance cannot ask about *this machine's* folders, which is why the checks that used to read
 * "is this the app" read this instead. It covers reads and writes, and what a shim still cannot
 * do is bounded by the document it serves rather than by this answer.
 */
export function branchHasLocalSync(mode: LauncherMode, shimToken: string | null): boolean {
  return mode === 'tauri' || shimToken !== null;
}

/**
 * Whether the bookmark list belongs on this page.
 *
 * Bookmarks are the app's feature, and the published PWA exists to be the zero-setup way in, so a
 * browser with a native build to offer is not given them: a desktop visitor is meant to install
 * the app rather than keep a second list of instances. The two pages that keep them are the app
 * itself and the published PWA on an iPhone or iPad, the one platform with no native build to
 * point at, where the list is the whole of how one instance is kept beside another.
 *
 * That is why this takes the iOS answer as an argument instead of asking: the platform read is
 * `isIosDevice` in `browser-storage.ts`, which exists because Safari on macOS and Safari on iOS
 * land in the same storage fallback for unrelated reasons and only one of them has a build to
 * install. A macOS Safari visitor therefore gets no bookmarks, deliberately.
 */
export function branchShowBookmarks(mode: LauncherMode, iosDevice: boolean): boolean {
  return mode === 'tauri' || (mode === 'webapp' && iosDevice);
}

/** Whether an instance's own server is serving this page, which is always same-origin. */
export function branchIsSelfHost(mode: LauncherMode): boolean {
  return mode === 'self-host';
}
