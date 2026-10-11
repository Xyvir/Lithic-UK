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
   * This platform hands the app real files: a path it can read and write, and a picker that
   * answers with one. False on Android, where the picker answers with a document reference
   * instead, and where the launcher therefore saves into the app's own storage.
   */
  local_files?: boolean;
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
