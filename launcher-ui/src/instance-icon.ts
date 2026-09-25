/**
 * Instance icons: the emoji-favicon workflow that lets someone who runs more
 * than one self-hosted Lithic instance tell them apart (personal, work, …).
 *
 * The icon belongs to the *instance*, not to the browser that set it, so the workflow has
 * three parts:
 *
 *   the choice   — the emoji itself is left in the store root (`ICON_SETTING`), one line of
 *                  plain text, where every client reads it: an instance opened in a
 *                  browser that has never seen it shows the icon its owner picked. It
 *                  travels with the store, so a backup carries the choice and a connect
 *                  brings it back with the icons.
 *   locally      — the launcher header icon and the browser tab favicon, so the instance
 *                  is recognizable while you are standing on it. `localStorage` holds a
 *                  mirror of the choice, used only when the instance cannot be asked.
 *   server-side  — every favicon / touch-icon size is rendered from the emoji on a canvas
 *                  client-side and PUT into `/sync/`, with `custom.ico` LAST because the
 *                  inotify watcher treats that write as the signal to copy the whole
 *                  pre-sized set into the public directory. The setting is written
 *                  immediately before that doorbell (see `uploadInstanceIcon`). No
 *                  server-side imagemagick is involved, so the ordering below is a
 *                  contract, not an implementation detail.
 *
 * Everything DOM-touching is injectable (canvas factory, fetcher, storage) so
 * the upload contract is unit-testable in plain Node.
 */
import { WEBDAV_BASE } from './webdav.ts';

/** Legacy emoji shortlist, grouped the same way as the picker grid. */
export const EMOJI_LIST: string[] = [
  // Study & Work
  '📚', '📖', '📝', '📋', '🗒️', '📁', '🗂️', '📦', '🔖', '📌', '📍', '🗃️', '🗄️', '📊', '📈', '📉',
  // Science & Tech
  '🔬', '🔭', '⚗️', '🧪', '🧫', '🧬', '💡', '🔋', '🔌', '💻', '🖥️', '⌨️', '📱', '📡', '🛰️', '🤖', '🧲', '⚙️', '🔩', '🧰',
  // World & Nature
  '🌐', '🗺️', '🧭', '🌍', '🌎', '🌏', '⭐', '🌙', '☀️', '🌊', '⚡', '🔥', '❄️', '🌿', '🌱', '🌸', '🌺', '🌻', '🍃', '🌴',
  // Places & Things
  '🏛️', '🏰', '⛩️', '🗼', '⏰', '⌚', '🕰️', '🔐', '🔑', '🗝️', '🔮', '🎯', '🧩', '🎲', '♟️', '🎺', '🗿',
  // Art & Creative
  '🎨', '🖌️', '🖍️', '🗳️', '🗯️', '✏️', '🖊️', '🖋️', '📷', '📸', '🎥', '🎞️', '🏗️', '🎭', '🎬', '🎤', '🎧', '🎈', '🎆', '🎇', '✨', '🌈', '🗣️', '🐞',
  // Faces (just a few)
  '😊', '😄', '😂', '😍', '🤔', '😎', '🤓', '😤', '😠', '😢', '😴', '🥳', '🤯', '😇', '🥶'
];

/**
 * The instance's own icon *choice*: the emoji, one line of plain text, in the store root
 * beside the icons rendered from it.
 *
 * This is what makes the icon the instance's rather than this browser's: every client
 * reads it (see `readServerEmoji`), so somebody opening an instance for the first time in
 * a browser that has never seen it gets the icon its owner picked, not the shipped mark.
 * It sits in the same directory as the wikis and the icon renders, so it is in the git
 * tree too — a backup carries the choice, and connecting a server brings it back along
 * with the icons. The deployment needs nothing from it beyond that: its watcher copies the
 * icons the browser rendered, and this file only says which character they are.
 */
export const ICON_SETTING = 'favicon.conf';

/**
 * The pre-sized icon set written on save. Order matters: `custom.ico` is the
 * watcher's doorbell and must stay last (legacy parity — see deploy/watcher.sh).
 */
export const ICON_TARGETS: Array<{ path: string; size: number }> = [
  { path: 'favicon-16x16.png', size: 16 },
  { path: 'favicon-32x32.png', size: 32 },
  { path: 'favicon.ico', size: 32 },
  { path: 'mstile-150x150.png', size: 150 },
  { path: 'android-chrome-192x192.png', size: 192 },
  { path: 'apple-touch-icon.png', size: 180 },
  { path: 'android-chrome-512x512.png', size: 512 },
  { path: 'custom.ico', size: 512 }
];

/** The write the watcher watches for; must be the final PUT. */
export const ICON_DOORBELL = 'custom.ico';

/**
 * The mark an instance's own header draws: the largest of the renders it publishes.
 *
 * One of `ICON_TARGETS`, so it is a file the picker writes and the deployment's watcher
 * copies into the public directory — which is what makes it the instance's current icon
 * rather than a picture of one. The shipped set lives at the same address, so an instance
 * that has never had an icon picked still answers here.
 */
export const INSTANCE_MARK_FILE = '/mstile-150x150.png';

/**
 * Where to read that mark from, or null when there is no instance to ask.
 *
 * Root-absolute and same-origin on purpose: the launcher page is served *by* the instance,
 * so this is the instance's own file. The legacy launcher's header was this exact
 * `<img src="/mstile-150x150.png">` with an `onerror` fallback, and it read the same address
 * for the same reason — the mark beside the title is the instance's identity, and a client
 * that draws the project's own mark there makes every instance look alike.
 *
 * Null is the page with no instance behind it at all (a downloaded copy, the desktop app's
 * own): a file has no root to read this from. An instance that answers 404 — a store whose
 * icon set was never published — is the other half of the same question, and is handled at
 * the image, which is the only place that can tell the difference.
 */
export function instanceMarkUrl(
  loc: { protocol?: string } | null | undefined = typeof location === 'undefined' ? undefined : location
): string | null {
  const protocol = loc?.protocol;
  return protocol === 'http:' || protocol === 'https:' ? INSTANCE_MARK_FILE : null;
}

export const INSTANCE_EMOJI_KEY = 'lithic-icon-emoji';
/** Legacy background behind the glyph — every generated icon matches it. */
export const ICON_BACKGROUND = '#333';

export type Canvas2DLike = {
  fillStyle: string;
  font: string;
  textAlign: string;
  textBaseline: string;
  fillRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
};

export type CanvasLike = {
  width: number;
  height: number;
  getContext(id: '2d'): Canvas2DLike | null;
  toBlob(callback: (blob: Blob | null) => void, type?: string): void;
  toDataURL?(type?: string): string;
};

/** May return null: a DOM-less or quarantined canvas is a expected outcome. */
export type CanvasFactory = (size: number) => CanvasLike | null;

/** Real canvas via the document; returns null in a DOM-less context. */
export function defaultCanvasFactory(size: number): CanvasLike | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas as unknown as CanvasLike;
}

/** Draw one emoji centred on a dark tile (legacy geometry, unchanged). */
export function paintEmoji(canvas: CanvasLike, emoji: string): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const size = canvas.width;
  context.fillStyle = ICON_BACKGROUND;
  context.fillRect(0, 0, size, size);
  context.font = `${Math.floor(size * 0.65)}px serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(emoji, size / 2, size / 2 + 2);
}

/** Render an emoji tile to a PNG blob, or null when there is no canvas. */
export function emojiIconBlob(
  emoji: string,
  size: number,
  createCanvas: CanvasFactory = defaultCanvasFactory
): Promise<Blob | null> {
  let canvas: CanvasLike | null;
  try {
    canvas = createCanvas(size);
  } catch {
    // A quarantined canvas (or an absent document) must not blow up the save.
    return Promise.resolve(null);
  }
  if (!canvas) return Promise.resolve(null);
  paintEmoji(canvas, emoji);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/png'));
}

/**
 * Data URL for `<link rel="icon">` / the launcher header, so the tab matches
 * the instance without waiting on a server round trip.
 */
export function emojiFaviconUrl(
  emoji: string,
  size = 32,
  createCanvas: CanvasFactory = defaultCanvasFactory
): string | null {
  try {
    const canvas = createCanvas(size);
    if (!canvas || typeof canvas.toDataURL !== 'function') return null;
    paintEmoji(canvas, emoji);
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}

export type UploadResult = { ok: boolean; saved: number; total: number; error?: string };

/**
 * The instance's icon, as the instance itself records it.
 *
 * Two different answers matter here and are told apart on purpose: `null` is "the
 * instance could not be asked" (offline, a proxy in the way), and `''` is "the instance
 * has no custom icon". A client that could not ask may fall back to whatever this browser
 * remembers; a client that asked and was told there is nothing has been answered, and the
 * shipped mark is the truth.
 */
export async function readServerEmoji(
  options: { fetcher?: typeof fetch; base?: string } = {}
): Promise<string | null> {
  const fetcher = options.fetcher ?? fetch;
  const base = options.base ?? WEBDAV_BASE;
  try {
    const response = await fetcher(`${base}${ICON_SETTING}`, { headers: { Accept: 'text/plain' } });
    // Nothing stored is the ordinary state of an instance nobody has given an icon.
    if (response.status === 404) return '';
    if (!response.ok) return null;
    return (await response.text()).trim();
  } catch {
    return null;
  }
}

/**
 * Record the instance's choice. Written as part of the icon set rather than beside it,
 * so the file never names icons that were not written: `uploadInstanceIcon` puts it up
 * after the renders and immediately before the doorbell.
 */
export async function writeServerEmoji(
  emoji: string,
  options: { fetcher?: typeof fetch; base?: string } = {}
): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch;
  const base = options.base ?? WEBDAV_BASE;
  try {
    const response = await fetcher(`${base}${ICON_SETTING}`, {
      method: 'PUT',
      body: emoji,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
    return response.ok || response.status === 201 || response.status === 204;
  } catch {
    return false;
  }
}

/** Drop the recorded choice. A store that never had one is already in that state. */
export async function deleteServerEmoji(
  options: { fetcher?: typeof fetch; base?: string } = {}
): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch;
  const base = options.base ?? WEBDAV_BASE;
  try {
    const response = await fetcher(`${base}${ICON_SETTING}`, { method: 'DELETE' });
    return response.ok || response.status === 204 || response.status === 404;
  } catch {
    return false;
  }
}

/**
 * PUT the whole pre-sized icon set, sequentially, `custom.ico` last. A failed
 * write stops the run: a half-updated set is worse than none, and the watcher
 * only fires on the doorbell, so nothing is copied unless the whole set landed.
 */
export async function uploadInstanceIcon(
  emoji: string,
  options: {
    fetcher?: typeof fetch;
    base?: string;
    createCanvas?: CanvasFactory;
    onProgress?: (saved: number, total: number) => void;
  } = {}
): Promise<UploadResult> {
  const fetcher = options.fetcher ?? fetch;
  const base = options.base ?? WEBDAV_BASE;
  const createCanvas = options.createCanvas ?? defaultCanvasFactory;
  // The setting is a write of this set, so it is counted as one.
  const total = ICON_TARGETS.length + 1;
  let saved = 0;

  for (const target of ICON_TARGETS) {
    // Between the last render and the doorbell: the whole set is up, so the backup cannot
    // commit a choice whose icons are half-written, and the doorbell (which is what makes
    // the deployment apply the set) still closes the run.
    if (target.path === ICON_DOORBELL) {
      if (!(await writeServerEmoji(emoji, { fetcher, base }))) {
        return { ok: false, saved, total, error: `PUT ${ICON_SETTING} failed` };
      }
      saved += 1;
      options.onProgress?.(saved, total);
    }
    const blob = await emojiIconBlob(emoji, target.size, createCanvas);
    if (!blob) return { ok: false, saved, total, error: 'Could not render the icon (no canvas).' };
    try {
      const response = await fetcher(`${base}${target.path}`, {
        method: 'PUT',
        body: blob,
        headers: { 'Content-Type': 'image/png' }
      });
      if (!response.ok && response.status !== 201 && response.status !== 204) {
        return { ok: false, saved, total, error: `PUT ${target.path} → ${response.status}` };
      }
    } catch (error) {
      return { ok: false, saved, total, error: `${target.path}: ${String(error)}` };
    }
    saved += 1;
    options.onProgress?.(saved, total);
  }

  return { ok: true, saved, total };
}

/**
 * Restore the shipped icon: forget the instance's choice, then DELETE the doorbell,
 * which is the watcher's signal to restore the default set server-wide.
 *
 * The two deletes are ordered like the writes they undo, and the doorbell is last for
 * the same reason there: until it goes, nothing has been decided. An instance that had
 * no choice recorded still answers true — the state asked for is the state reached.
 */
export async function clearInstanceIcon(
  options: { fetcher?: typeof fetch; base?: string } = {}
): Promise<boolean> {
  const forgotten = await deleteServerEmoji(options);
  const fetcher = options.fetcher ?? fetch;
  const base = options.base ?? WEBDAV_BASE;
  try {
    await fetcher(`${base}${ICON_DOORBELL}`, { method: 'DELETE' });
  } catch {
    return false;
  }
  return forgotten;
}

/** Tell the service worker the icons changed so it drops cached copies. */
export function bustIconCache(delayMs = 2000): void {
  if (typeof navigator === 'undefined' || typeof setTimeout === 'undefined') return;
  setTimeout(() => {
    try {
      const worker = navigator.serviceWorker?.controller;
      worker?.postMessage({ type: 'BUST_ICON_CACHE' });
    } catch {
      // Cache busting is best effort.
    }
  }, delayMs);
}

/**
 * The mirror of the instance's choice, kept in this browser.
 *
 * It is not the setting — the store is — and it is never consulted while the instance
 * answers: it exists so an instance that cannot be asked (a proxy in the way, a plain
 * WebDAV box behind a broken CGI) still shows the icon this browser last saw, instead of
 * falling back to the shipped mark for no reason the user can see.
 */
export function readInstanceEmoji(storage: Storage | undefined = safeStorage()): string {
  try {
    return storage?.getItem(INSTANCE_EMOJI_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveInstanceEmoji(emoji: string, storage: Storage | undefined = safeStorage()): void {
  try {
    storage?.setItem(INSTANCE_EMOJI_KEY, emoji);
  } catch {
    // A quarantined storage area must not break the picker.
  }
}

export function clearInstanceEmoji(storage: Storage | undefined = safeStorage()): void {
  try {
    storage?.removeItem(INSTANCE_EMOJI_KEY);
  } catch {
    // Ignore.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Point the browser tab at an emoji favicon (or back at the shipped one).
 * Mirrors the legacy link handling: reuse an existing icon link if present.
 */
export function applyFavicon(href: string | null, doc: Document | undefined = typeof document === 'undefined' ? undefined : document): void {
  if (!doc) return;
  let link = doc.querySelector<HTMLLinkElement>("link[rel='icon']") ?? doc.querySelector<HTMLLinkElement>("link[rel='shortcut icon']");
  if (!link) {
    link = doc.createElement('link');
    link.rel = 'icon';
    doc.head.appendChild(link);
  }
  if (href) {
    link.type = 'image/png';
    link.href = href;
  } else {
    link.removeAttribute('type');
    link.href = '/favicon.ico';
  }
}
