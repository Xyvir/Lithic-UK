/**
 * One file out of a picker.
 *
 * A pick is a *reference* to a file, not its contents: it carries a `path` (the
 * desktop app) or a `handle` (the browser's own picker), which is what opening or
 * reading it again later needs. `text` is filled only where the picker had no
 * other way to hand the file over (the classic `<input type=file>` gives names
 * and bytes and nothing else) and is otherwise read on demand by `readText`.
 * That distinction is the point of it: a multi-file pick is a list of liths
 * nobody has opened, and each one is a whole wiki.
 */
import { copy } from './copy.ts';
import { documentMimetype, documentPickerTypes, inputAcceptTypes, normalizeDocumentName } from './document-format.ts';
import { resolveMode, servedByApp } from './mode.ts';
import { basename, hasShimBackend, shimPick, shimRead, shimWrite } from './shim-files.ts';

export interface PickedLith {
  name: string;
  path?: string;
  text: string;
  handle?: unknown;
}

export interface FileBridge {
  /** The files one trip through the picker chose, in the order it listed them. */
  openMany(): Promise<PickedLith[]>;
  /** The pick's contents, read now when the picker only named the file. */
  readText(pick: PickedLith): Promise<string>;
  save(text: string, suggestedName: string, path?: string): Promise<{ name: string; path?: string }>;
  loadUrl(url: string): Promise<string>;
}

type TauriApi = { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };

/**
 * Resolve the Tauri invoke function across versions: Tauri v1 exposes
 * window.__TAURI__.tauri.invoke and Tauri v2 exposes window.__TAURI__.core.invoke
 * (both under withGlobalTauri), with the bare window.__TAURI__.invoke accepted
 * too. The launcher bundle ships to all three (the desktop app, the hosted site
 * and a portable folder) so it has to work whichever one is hosting it.
 */
/**
 * Exposed so UI surfaces (e.g. the desktop Install button) can invoke
 * commands without duplicating the version-compat lookup.
 */
export function tauriInvoke<T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> {
  const api = tauriApi();
  if (!api) return Promise.reject(new Error('Tauri API unavailable'));
  return api.invoke(command, args) as Promise<T>;
}

function tauriApi(): TauriApi | null {
  const root = (globalThis as typeof globalThis & {
    __TAURI__?: {
      invoke?: TauriApi['invoke'];
      core?: { invoke?: TauriApi['invoke'] };
      tauri?: { invoke?: TauriApi['invoke'] };
    }
  }).__TAURI__;
  if (root?.invoke) return { invoke: root.invoke };
  if (root?.core?.invoke) return { invoke: root.core.invoke };
  if (root?.tauri?.invoke) return { invoke: root.tauri.invoke };
  return null;
}

type TauriEventApi = {
  listen: (event: string, handler: (message: { payload: unknown }) => void) => Promise<unknown>;
};

function tauriEventApi(): TauriEventApi | null {
  const root = (globalThis as typeof globalThis & {
    __TAURI__?: {
      event?: TauriEventApi;
      core?: { event?: TauriEventApi };
      tauri?: { event?: TauriEventApi };
    };
  }).__TAURI__;
  if (root?.event?.listen) return root.event;
  if (root?.core?.event?.listen) return root.core.event;
  if (root?.tauri?.event?.listen) return root.tauri.event;
  return null;
}

/**
 * Subscribe to an event emitted from Rust (Tauri's `emit`), returning
 * an unsubscribe function, or null outside Tauri, so callers can register
 * unconditionally. `listen` is async, so an unsubscribe that arrives before the
 * subscription resolves cancels it on arrival instead of leaking the handler.
 */
export function tauriListen<T>(event: string, handler: (payload: T) => void): (() => void) | null {
  const api = tauriEventApi();
  if (!api) return null;
  let disposed = false;
  let unlisten: (() => void) | null = null;
  void api
    .listen(event, (message) => handler(message.payload as T))
    .then((stop) => {
      if (disposed) {
        (stop as () => void)?.();
        return;
      }
      unlisten = (stop as () => void) ?? null;
    })
    .catch(() => { /* event bridge missing: progress lines are best effort */ });
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}

export type SaveOutcome = 'saved' | 'started' | 'cancelled';

/**
 * Whether the app is treating this document as its own.
 *
 * The question is about the document, not about the API. With `withGlobalTauri` the global is
 * injected into every document the window loads, so a bookmarked instance's own launcher holds
 * one too, and its origin is not inside the capability that answers a command: an invoke sent
 * from there can only be refused. A page that is not the app's own therefore reaches the
 * browser instead (see `saveTextVerifiably` and `createFileBridge`).
 *
 * Two things make a document the app's own, and `resolveMode` already knows both of them: the
 * address the app serves itself from (`servedByApp`, which is `tauri://localhost` or
 * `https://tauri.localhost`), and a page that was told it is the app with `?mode=tauri`, which
 * is how the smoke harness stands the app up over `file://`.
 */
function appServedThisPage(): boolean {
  const location = (globalThis as { location?: Location }).location;
  if (!location) return false;
  try {
    return servedByApp(location) || resolveMode(location) === 'tauri';
  } catch {
    // A location this cannot read is not the app's own.
    return false;
  }
}

/**
 * Write text where the platform puts a download, and report false for the two answers that
 * mean "ask where instead".
 *
 * The two are a platform with no Downloads folder this app can see (a phone's storage is
 * app-private, and its picker hands over a grant rather than a folder) and a build that does
 * not carry the command yet. Both leave the caller to fall back to the save dialog, which is
 * where these buttons started. A write that was attempted and failed also lands here, and the
 * dialog that follows reports its own failure, so an unreadable Downloads folder costs a
 * second press rather than a sentence about a folder the person cannot fix.
 */
async function downloadThroughApp(api: TauriApi, fileName: string, text: string): Promise<boolean> {
  try {
    const result = (await api.invoke('save_lith_download', { text, suggestedName: fileName })) as
      | { path?: string }
      | null;
    return Boolean(result?.path);
  } catch {
    return false;
  }
}

/**
 * Save text to a file, reporting whether the platform could confirm the write.
 *
 * The distinction is the whole point: the desktop app writes through Rust, so a returned path
 * proves the bytes landed. A download a browser starts cannot be confirmed, because the browser
 * never reports whether one finished, so it reports `started` and callers must not present that
 * as a file that exists.
 *
 * `documents` is the process's own answer (`Capabilities::local_files`), passed in by the caller
 * because this function is also reached from the app's own page: an app whose own process cannot
 * hold a document has no write to confirm, and the browser's download is the only copy that can
 * leave at all.
 *
 * The app's own route is taken only for a page the app served. Everywhere else, an instance's
 * own launcher included, this ends at the browser's download, which is a copy that needs no
 * permission from this machine beyond the browser's own.
 */
export async function saveTextVerifiably(fileName: string, text: string, documents = true): Promise<SaveOutcome> {
  const api = documents && appServedThisPage() ? tauriApi() : null;
  if (api) {
    // A download first, with no dialog in the way. These are the launcher's export buttons, so
    // the copy is one somebody asked to keep rather than a new document to find a home for, and
    // the platform's Downloads folder is where a browser the same page runs in would put it.
    if (await downloadThroughApp(api, fileName, text)) return 'saved';
    try {
      // The native dialog *and* the write happen in Rust, so a returned path is
      // evidence the file is on disk.
      const result = (await api.invoke('save_lith_file', { text, suggestedName: fileName })) as
        | { name?: string; path?: string }
        | null;
      return result?.path ? 'saved' : 'started';
    } catch (error) {
      if (error instanceof Error && /cancel/i.test(error.message)) return 'cancelled';
      throw error;
    }
  }

  // On a shim the desktop's own chooser names the path and the shim writes it, so the write
  // is confirmed exactly as the app's is. A chooser the desktop does not have (`no-picker`)
  // or a wire that did not answer falls through to the browser's download below, which is the
  // same rung the shim itself falls back to.
  if (hasShimBackend()) {
    const picked = await shimPick('save', { suggestedName: fileName });
    if (picked.ok) {
      const target = picked.value.paths[0];
      if (!target) return 'cancelled';
      const written = await shimWrite(target, text);
      if (written.ok) return 'saved';
    }
  }

  // The browser's own download, with no save dialog in front of it: `showSaveFilePicker` used to
  // be asked first because it resolves after `close()` and so could prove the bytes landed, and
  // the cost was a dialog on every export. A copy somebody asked to keep is not a decision about
  // where to put it, and a browser that wants to ask is asked once in its own settings instead.
  // The trade is deliberate: this returns `started` everywhere a browser answers, which is the
  // sentence the copy already has for a download nobody can confirm.
  const blob = new Blob([text], { type: documentMimetype() });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return 'started';
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(copy.status.engineUnavailable(String(response.status)));
  return response.text();
}

const OPEN_TYPES = [
  { description: copy.fileTypes.monolith, accept: { 'application/x-lith': ['.lith'] } },
  { description: copy.fileTypes.json, accept: { 'application/json': ['.json'] } },
  { description: copy.fileTypes.htmlMany, accept: { 'text/html': ['.html', '.htm'] } },
  { description: copy.fileTypes.text, accept: { 'text/plain': ['.md', '.txt', '.tid'] } },
  { description: copy.fileTypes.notebook, accept: { 'application/x-ipynb+json': ['.ipynb'] } }
];

/**
 * The browser's two pickers behind one call.
 *
 * Only Chromium's `showOpenFilePicker` can answer with several files that stay
 * openable: each one comes back as a handle, which is what a Recents row needs
 * to find the file again, and a handle is also how its contents are read later,
 * so nothing is read here. The classic `<input type=file>` hands over names and
 * bytes and nothing else, so it stays single-select rather than offering a
 * multi-select whose extra picks could never be reopened.
 */
async function browserPicks(): Promise<PickedLith[]> {
  if (typeof window !== 'undefined' && (window as any).showOpenFilePicker) {
    try {
      const handles = (await (window as any).showOpenFilePicker({ multiple: true, types: OPEN_TYPES })) as Array<{
        getFile: () => Promise<File>;
      }>;
      const picks: PickedLith[] = [];
      for (const handle of handles) {
        // The name comes off the file, not the handle: both carry it, but the picker
        // below has only the file, and one spelling of a name is enough.
        const file = await handle.getFile();
        picks.push({ name: file.name, text: '', handle });
      }
      return picks;
    } catch (err: any) {
      if (err && typeof err === 'object' && err.name === 'AbortError') {
        return [];
      }
      // Fall back to standard file input
    }
  }
  return classicPicks();
}

/**
 * The chooser was never drawn: the press reached the control, and the platform answered as though a
 * dialog had opened and been dismissed.
 *
 * A dismissal takes as long as a person takes, so one that arrives in the instant after the press
 * was no dismissal. Android's captive portal window is the case this exists for: a file input is
 * inert in that window, and the browser reports the inertness as a dismissal at once.
 */
export class PickerUnavailableError extends Error {
  constructor() {
    super('the file chooser did not open');
    this.name = 'PickerUnavailableError';
  }
}

/**
 * How soon a dismissal has to arrive to be a refusal instead.
 *
 * A system dialog has to be drawn before anybody can close it, and drawing one takes a moment on
 * every platform this ships to. Half a second is under the fastest draw seen and far over the
 * fastest dismissal a person could make, so nothing here is a judgement about their speed.
 */
const PICK_REFUSAL_MS = 500;

/**
 * How long the system's chooser may leave no trace at all before it is taken not to have opened.
 *
 * A chooser answers in one of three ways: a file (`change`), a dismissal (`cancel`, or the
 * window coming back with no file), or nothing at all, which is a browser that refused to open
 * one. The first two arrive in a moment, and the third is what this measures: a system dialog
 * takes the window with it, so a window that never went away was never handed a dialog.
 */
const PICK_SILENCE_MS = 4000;

/**
 * The classic `<input type=file>`, driven the way a page is allowed to drive it.
 *
 * Three things here are load-bearing, and each of them was a way the launcher could sit on its
 * own `Opening` line with nothing happening:
 *
 * 1. **The input lives in the page while it is used.** A system chooser is the platform's, and
 *    some of them only offer one to an element the document holds. It is drawn off-screen and
 *    transparent rather than `display: none`, which is the one hiding that puts it back where it
 *    started, and it is taken out again the moment the trip ends.
 * 2. **Every way a trip can end is listened for.** A chosen file is `change`. A dismissed chooser
 *    is `cancel` where the platform sends it, and otherwise the window coming back with no file:
 *    a dismissal used to resolve nothing at all, so the promise never settled and the launcher
 *    stayed busy for the rest of the session, which reads as a frozen page.
 * 3. **A chooser that never opened says so.** No dialog can open without taking the window, so a
 *    window still focused and visible after `PICK_SILENCE_MS` was never handed one; the promise
 *    rejects with that, which the caller puts on its failure line instead of leaving the dots
 *    turning. A phone that is slow to draw its picker has already blurred by then, so a real
 *    chooser is never taken for a refusal.
 */
function classicPicks(): Promise<PickedLith[]> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    // The extension list, except where the platform's chooser resolves extensions to MIME
    // types and would drop this project's own type on the floor: see `inputAcceptTypes`.
    const accept = inputAcceptTypes();
    if (accept) input.accept = accept;
    input.style.cssText = 'position: fixed; left: -100vw; top: 0; width: 1px; height: 1px; opacity: 0';
    input.setAttribute('aria-hidden', 'true');

    let settled = false;
    let handedOver = false;
    let askedAt = 0;
    let silence: ReturnType<typeof setTimeout> | undefined;

    /** End the trip once, whichever way it ended. */
    const finish = (answer: PickedLith[] | Error) => {
      if (settled) return;
      settled = true;
      if (silence !== undefined) clearTimeout(silence);
      window.removeEventListener('blur', departed);
      window.removeEventListener('focus', returned);
      input.remove();
      if (answer instanceof Error) reject(answer);
      else resolve(answer);
    };
    /** The chooser took the window, which is what a dialog that opened looks like from here. */
    const departed = () => { handedOver = true; };
    /**
     * The window came back. A file arrives with its own `change`, so this is read a turn later,
     * and only for a page that came back empty: that is a chooser that was dismissed.
     */
    const returned = () => {
      setTimeout(() => {
        if (settled || !handedOver || (input.files?.length ?? 0) > 0) return;
        finish([]);
      }, 250);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return finish([]);
      const reader = new FileReader();
      reader.onerror = () => finish(reader.error ?? new Error('Unable to read file'));
      reader.onload = () => finish([{ name: file.name, text: String(reader.result ?? '') }]);
      reader.readAsText(file);
    });
    // Chrome, Edge and Safari say a dismissed chooser this way, and it is the answer that needs
    // no timing at all.
    input.addEventListener('cancel', () =>
      finish(performance.now() - askedAt < PICK_REFUSAL_MS ? new PickerUnavailableError() : [])
    );
    window.addEventListener('blur', departed);
    window.addEventListener('focus', returned);

    silence = setTimeout(() => {
      if (settled || handedOver) return;
      if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
      finish(new PickerUnavailableError());
    }, PICK_SILENCE_MS);

    document.body.appendChild(input);
    askedAt = performance.now();
    input.click();
  });
}

function browserBridge(): FileBridge {
  return {
    loadUrl: fetchText,
    async save(text, suggestedName) {
      if (typeof window !== 'undefined' && (window as any).showSaveFilePicker) {
        try {
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: normalizeDocumentName(suggestedName),
            types: documentPickerTypes()
          });
          const writable = await handle.createWritable();
          await writable.write(text);
          await writable.close();
          return { name: handle.name };
        } catch (err: any) {
          if (err && typeof err === 'object' && err.name === 'AbortError') {
            return { name: suggestedName };
          }
          // Fall back to blob anchor download below
        }
      }
      const blob = new Blob([text], { type: documentMimetype() });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = normalizeDocumentName(suggestedName);
      anchor.click();
      URL.revokeObjectURL(url);
      return { name: anchor.download };
    },
    openMany() {
      return browserPicks();
    },
    async readText(pick) {
      // The classic input has already read its one file; anything out of Chromium's
      // picker is read here, from the handle, when something needs it.
      if (pick.text) return pick.text;
      const handle = pick.handle as { getFile: () => Promise<File> } | undefined;
      if (!handle) return '';
      return (await handle.getFile()).text();
    }
  };
}

/**
 * The shim's file bridge: real paths, chosen by the desktop's own dialog.
 *
 * The shape matches the app's bridge rather than the browser's, because the shim has what the
 * browser lacks: a path. An open returns paths and reads on demand; a save writes back to the
 * path a row carries, and only falls back to a chooser for a file that has none. Every rung
 * that fails for want of a wire or a dialog hands over to `browserBridge`, so a shim on a
 * desktop with no `zenity` or `kdialog` behaves exactly like the plain page it used to be.
 */
function shimBridge(): FileBridge {
  const fallback = browserBridge();
  return {
    loadUrl: fetchText,
    async openMany() {
      const picked = await shimPick('open', { multiple: true });
      // A cancellation (`paths` empty) is a real answer: the person closed the dialog, and
      // the browser's picker must not open on top of that.
      if (picked.ok) return picked.value.paths.map((path) => ({ name: basename(path), path, text: '' }));
      return fallback.openMany();
    },
    async readText(pick) {
      if (pick.text) return pick.text;
      if (pick.path) {
        const read = await shimRead(pick.path);
        if (read.ok) return read.value.text;
      }
      return fallback.readText(pick);
    },
    async save(text, suggestedName, path) {
      if (path) {
        const written = await shimWrite(path, text);
        if (written.ok) return { name: written.value.name, path: written.value.path };
      }
      const picked = await shimPick('save', { suggestedName });
      if (picked.ok) {
        const target = picked.value.paths[0];
        // No path is a cancelled save: nothing is written and the caller keeps the name.
        if (!target) return { name: suggestedName };
        const written = await shimWrite(target, text);
        if (written.ok) return { name: written.value.name, path: written.value.path };
      }
      return fallback.save(text, suggestedName, path);
    }
  };
}

export function createFileBridge(documents = true): FileBridge {
  // The app's own bridge only for a page that is the app's own, for the reason
  // `appServedThisPage` gives: an instance's launcher runs in this same window with the same
  // injected global, and a pick or a read sent from it is refused by the capability that answers
  // commands. Without this, the Mount control on that page did nothing at all.
  const invoke = documents && appServedThisPage() ? tauriApi()?.invoke : undefined;
  // A process that cannot hold a document of its own uses the browser's bridge even inside an
  // app, for the reason `Capabilities::local_files` records: its Rust commands would have nothing
  // to write to, so opening goes through the browser's own file input and a download through its
  // own download. No platform this app ships to answers that, the phone included, whose picker
  // returns a granted reference its own process can read and write. The shim check below is
  // unaffected: it is the secret in the document that decides, and an app page never carries one.
  if (!invoke) return hasShimBackend() ? shimBridge() : browserBridge();
  return {
    loadUrl: fetchText,
    async save(text, suggestedName, path) {
      const result = await invoke('save_lith_file', { text, suggestedName, path });
      return result as { name: string; path?: string };
    },
    async openMany() {
      // Rust answers with names and paths, never bytes: a pick is a list of liths
      // nobody has opened yet, and each one is a whole wiki to push through the
      // IPC bridge for nothing. `readText` reads the one that is actually needed.
      const result = await invoke('open_lith_files');
      return ((result as Array<{ name: string; path: string }> | null) ?? []).map(
        (pick) => ({ name: pick.name, path: pick.path, text: '' })
      );
    },
    async readText(pick) {
      if (pick.text) return pick.text;
      if (!pick.path) return '';
      const result = (await invoke('read_lith_path', { path: pick.path })) as { text?: string } | null;
      return result?.text ?? '';
    }
  };
}
