/**
 * The shim's file backend, from the launcher page's side.
 *
 * The shim serves this page and answers commands on a wire only this page can reach (see
 * `shim-command.ts`). What it can do that a browser cannot is native file work, because a
 * browser hands a page a file's contents and never where the file is: a `FileSystemFileHandle`
 * exposes a name and no path, and `<input type=file>` gives a fake one. So opening a Lith for
 * real, saving it back to the file it came from, and offering a recents row that reopens the
 * same path are all things the shim does on request.
 *
 * Every function here returns a value rather than throwing, exactly as `shim-command.ts` does,
 * and every one carries an `error` code from the shim's own vocabulary (`no-shim`,
 * `unreachable`, `no-picker`, `unreadable`, and so on). Callers fall back to the browser's own
 * picker when the wire or the desktop's chooser is not there, which is why the codes matter:
 * `no-picker` is a "use the browser instead", while a cancellation is not.
 */

import { readShimToken, shimCommand, type ShimCall } from './shim-command.ts';

/** The name of a path, whichever separator the platform uses. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** The directory part of a path, or null when there is none to name. */
export function dirname(path: string): string | null {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return at > 0 ? path.slice(0, at) : null;
}

/** A file the shim read. */
export interface ShimFile {
  name: string;
  path: string;
  text: string;
}

/** One entry of a directory the shim listed. */
export interface ShimDirEntry {
  name: string;
  path: string;
  dir: boolean;
}

export interface ShimListing {
  path: string;
  parent: string | null;
  entries: ShimDirEntry[];
}

/** Whether this page holds the per-launch secret that reaches a shim at all. */
export function hasShimBackend(doc: Pick<Document, 'querySelector'> | null = defaultDocument()): boolean {
  return readShimToken(doc) !== null;
}

function defaultDocument(): Pick<Document, 'querySelector'> | null {
  return typeof document === 'undefined' ? null : document;
}

/** What a backend call answered, success or failure, never a throw. */
export type ShimResult<T> = { ok: true; value: T } | { ok: false; error: string };

function result<T>(answer: Awaited<ReturnType<typeof shimCommand>>): ShimResult<T> {
  if (!answer.ok) return { ok: false, error: answer.error };
  return { ok: true, value: answer.result as T };
}

/**
 * Ask the desktop for a path. `mode` is `'open'` or `'save'`; an open can ask for several and
 * a save is one by definition. An empty `paths` is a cancellation, which is an ordinary
 * answer, while `no-picker` means the desktop has no chooser to show.
 */
export function shimPick(
  mode: 'open' | 'save',
  options: { multiple?: boolean; suggestedName?: string; startDir?: string } = {},
  call: ShimCall = {}
): Promise<ShimResult<{ paths: string[] }>> {
  return shimCommand(
    'pick',
    {
      mode,
      multiple: mode === 'open' && options.multiple === true,
      suggestedName: options.suggestedName,
      startDir: options.startDir
    },
    call
  ).then((answer) => result<{ paths: string[] }>(answer));
}

/** Read a path's text. */
export function shimRead(path: string, call: ShimCall = {}): Promise<ShimResult<ShimFile>> {
  return shimCommand('read', { path }, call).then((answer) => result<ShimFile>(answer));
}

/** Put text back at a path, atomically, on the shim's side. */
export function shimWrite(path: string, text: string, call: ShimCall = {}): Promise<ShimResult<{ name: string; path: string }>> {
  return shimCommand('write', { path, text }, call).then((answer) => result<{ name: string; path: string }>(answer));
}

/** List a directory, or the home directory when no path is given. */
export function shimList(path?: string, call: ShimCall = {}): Promise<ShimResult<ShimListing>> {
  return shimCommand('list', path ? { path } : {}, call).then((answer) => result<ShimListing>(answer));
}

/**
 * The `.lith` this shim was started with, if any. A file manager's Open With association
 * passes one on the command line, and this is how the launcher learns of it after it boots,
 * since a served page cannot see the process it came from.
 */
export function shimStartupPath(call: ShimCall = {}): Promise<ShimResult<{ path: string | null }>> {
  return shimCommand('startup', {}, call).then((answer) => result<{ path: string | null }>(answer));
}
