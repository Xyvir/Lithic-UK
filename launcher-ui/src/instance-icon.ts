/**
 * Instance icons: the emoji-favicon workflow that lets someone who runs more
 * than one self-hosted Lithic instance tell them apart (personal, work, …).
 *
 * The choice is applied in two places at once, exactly like the legacy
 * `ui.emoji` fragment:
 *
 *   locally   — the launcher header icon and the browser tab favicon, so the
 *               instance is recognizable while you are standing on it; and
 *   server-side — every favicon / touch-icon size is rendered from the emoji on
 *               a canvas client-side and PUT into `/sync/`, with `custom.ico`
 *               LAST because the inotify watcher treats that write as the
 *               signal to copy the whole pre-sized set into the public
 *               directory. No server-side imagemagick is involved, so the
 *               ordering below is a contract, not an implementation detail.
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
  const total = ICON_TARGETS.length;
  let saved = 0;

  for (const target of ICON_TARGETS) {
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
 * Restore the shipped icon: DELETE the doorbell, which is the watcher's signal
 * to restore the default set server-wide.
 */
export async function clearInstanceIcon(
  options: { fetcher?: typeof fetch; base?: string } = {}
): Promise<boolean> {
  const fetcher = options.fetcher ?? fetch;
  const base = options.base ?? WEBDAV_BASE;
  try {
    await fetcher(`${base}${ICON_DOORBELL}`, { method: 'DELETE' });
    return true;
  } catch {
    return false;
  }
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
