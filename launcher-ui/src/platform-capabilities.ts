/**
 * What the process behind this page says it can do.
 *
 * The launcher is one artifact shipped to every desktop and to the phone, so the only honest
 * way for it to know whether an Install button or a file picker means anything is to ask the
 * side that knows: Rust's `platform_capabilities` command, whose shape is `Capabilities` in
 * `src-tauri/src/platform/mod.rs`. Nothing in the page tests for an operating system name.
 *
 * Read once, before the launcher mounts, because one of the answers settles where saves land
 * and that is a `const` at boot (`App.svelte`'s storage mode). Everything else here is
 * re-asked where it is used, which is why every field past `install` is optional: a Rust side
 * older than a field sends nothing for it, and a missing answer must not be read as a refusal.
 */
import type { LaunchEntry } from './copy.ts';
import { tauriInvoke } from './file-bridge.ts';
import type { LauncherMode } from './mode.ts';

export interface PlatformCapabilities {
  /** The platform's own name, for diagnostics. */
  os?: string;
  /** This app can place a launchable copy of itself somewhere the user will find it. */
  install: boolean;
  /** Which launch mechanism an install creates here, as a token rather than a noun. */
  launch_entry: LaunchEntry | null;
  /** This build carries the folder-based GitHub backup. */
  git_sync?: boolean;
  /** This build carries the credential vault. */
  credentials?: boolean;
  /**
   * This app has documents of its own: its picker hands one over and its own process can read
   * and write it.
   *
   * The key keeps its old name and has lost its old meaning. It once asked whether that document
   * is a *path*, which Android could not answer: its picker returns a granted `content://`
   * reference instead, and the launcher fell back to storing the document in the browser's own
   * storage. A phone now opens and saves a real document the same way a desktop does, through
   * this app's own picker and its own write, so what is asked is whether there is anywhere for a
   * document to go at all. False would mean a build with no document access whatever, which is
   * no platform this app ships to; the flag is read as `!== false` so a report that did not
   * arrive keeps the behaviour that has always been. See `Capabilities::local_files` in
   * `src-tauri/src/platform/mod.rs`.
   */
  local_files?: boolean;
  /**
   * This platform's own webview can answer a bookmarked instance's login challenge, so the
   * app's window can host one.
   *
   * False on Android: the webview there cancels the challenge rather than answering it, so a
   * window handed an instance behind a login lands on the browser's own error page with the
   * launcher already gone. See `opensInstanceInBrowser` for what the launcher does instead.
   */
  instance_auth?: boolean;
}

/**
 * Whether a bookmarked instance opens in this window or in the platform's own browser.
 *
 * Two questions, and neither of them is a preference. Only the app has a window of its own to
 * host an instance in (`mode === 'tauri'`); every browser page, which is the published PWA, an
 * instance's own launcher and a shim alike, navigates the tab it is already in, and that tab
 * *is* the user's browser and is where that instance's login lives. And an app whose webview cannot answer the
 * instance's login challenge (see `instance_auth`) must not be handed one at all: the
 * navigation ends on a browser error page with the launcher gone, and the phone's own browser
 * is both where the saved password is and where the instance can be kept as an app.
 *
 * A missing capability reads as the window hosting it, like every other field past `install`: a
 * report that did not arrive must not take over the behaviour the app has always had.
 */
export function opensInstanceInBrowser(
  mode: LauncherMode,
  capabilities: PlatformCapabilities | null
): boolean {
  return mode === 'tauri' && capabilities?.instance_auth === false;
}

/**
 * The platform's own report, or null where there is no process to ask or none answered.
 *
 * Null is the answer for every page with no app behind it (a published deployment, a
 * self-hosted instance, a shim), and also for an app whose command could not be reached. Both
 * read as "no capabilities to narrow anything with", which is what keeps a failure here from
 * taking a control away that the platform does have: every caller treats a missing field as
 * the platform's old behaviour rather than as a refusal (`local_files !== false`, say).
 */
export async function readPlatformCapabilities(mode: LauncherMode): Promise<PlatformCapabilities | null> {
  if (mode !== 'tauri') return null;
  try {
    const answer = await tauriInvoke<PlatformCapabilities>('platform_capabilities');
    return answer ?? null;
  } catch {
    // A missing command or a bridge that did not answer: the launcher keeps the behaviour it
    // has always had rather than losing a capability to an error that says nothing about the
    // platform.
    return null;
  }
}
