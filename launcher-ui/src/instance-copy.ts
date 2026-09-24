/**
 * Throwing away the copy this app downloaded of an instance.
 *
 * The × on a bookmarked instance means "throw this away", and the app is the only side
 * that can act on the whole of it. The bookmark list is this launcher's own storage, so
 * removing an entry needs nothing; the instance's *downloaded copy* — its launcher page,
 * its scripts, its icons — sits under that instance's origin, and a page may only touch
 * its own origin's storage. No amount of re-adding the bookmark reaches it, which is
 * exactly how a stuck instance used to be possible.
 *
 * So the × asks Rust, which is not a page and shares one profile with every origin the
 * window has visited. What that drops is the page and nothing else: the cached wikis the
 * launcher's cross-instance search reads, the instance's own settings, and the saved
 * login all stay. Forgetting a login remains the vault's own named action, which is the
 * distinction this module exists to keep.
 *
 * A refusal is a copy that is still there, never an error in the launcher: the × has
 * already removed the bookmark, and the one thing left to do about it is say so.
 */

import { tauriInvoke } from './file-bridge.ts';

/** The command Rust answers. Both sides have to agree on this word (see `lib.rs`). */
export const FORGET_INSTANCE_COPY = 'forget_instance_copy';

/**
 * What dropping the copy did.
 *
 * `supported` is the platform, not the attempt: on a system with no webview hook the
 * gesture never promised this half, so nothing is said. `cleared` is the attempt — false
 * on a supported platform means the copy is still there, which is the case worth a
 * sentence.
 */
export type CopyDrop = { supported: boolean; cleared: boolean };

/** The shape of the invoke lookup, so a test can stand in for it. */
export type CopyDropInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** A verdict only when both words arrived as booleans; anything else proves nothing. */
function asCopyDrop(answer: unknown): CopyDrop | null {
  if (!answer || typeof answer !== 'object') return null;
  const record = answer as Partial<CopyDrop>;
  if (typeof record.supported !== 'boolean' || typeof record.cleared !== 'boolean') return null;
  return { supported: record.supported, cleared: record.cleared };
}

/**
 * Ask the app to drop one origin's downloaded copy.
 *
 * The origin, not the address and not the label: the copy belongs to an origin, and the
 * port, path and query of whatever was clicked have nothing to do with which one.
 */
export async function forgetInstanceCopy(
  origin: string,
  invoke: CopyDropInvoke = tauriInvoke
): Promise<CopyDrop | null> {
  if (!origin) return null;
  try {
    return asCopyDrop(await invoke(FORGET_INSTANCE_COPY, { origin }));
  } catch {
    // Refused, unrecognizable, or no app behind the page: all of them are a copy the app
    // did not drop, which is what the caller reports.
    return null;
  }
}

/**
 * The one line the × adds, or silence.
 *
 * Silence in two cases, for the same reason: nothing was promised and nothing was lost.
 * A platform without a hook never offered to drop anything (`supported`), and an attempt
 * that worked has nothing to report — the row disappearing is the feedback.
 */
export function copyDropNote(label: string, drop: CopyDrop | null): string | null {
  if (drop?.supported === false) return null;
  if (drop?.cleared) return null;
  return `Could not clear the cached copy of ${label}`;
}
