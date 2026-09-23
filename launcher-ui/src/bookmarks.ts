/**
 * Bookmarked self-hosted instances — the "meta-launcher" list.
 *
 * The bookmark affordance is deliberately ABSENT from self-host mode: its whole
 * purpose is for an installed PWA or the Tauri app to act as a front end to
 * several different instances (personal, work, …). The one thing that makes
 * such a list usable is telling the instances apart, so each entry keeps the
 * instance's *own* icon — the emoji favicon its owner set (see
 * `instance-icon.ts`) — cached locally as a data URL. Caching (rather than
 * pointing an `<img>` at the remote favicon) means the list still shows the
 * right icons offline, in the Tauri WebView, and across a redeploy.
 */
export const BOOKMARKS_KEY = 'bookmarkedInstances';
/** Re-fetch an entry's icon after this long; beyond it the icon may be stale. */
export const ICON_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Icons are stored in localStorage, so refuse anything unreasonably large. */
export const ICON_MAX_BYTES = 128 * 1024;
/** Ordered by preference: the instance writes all of these. */
export const ICON_PATHS = ['/favicon-32x32.png', '/favicon.ico'];

export type BookmarkEntry = {
  url: string;
  label: string;
  /** Data URL of the instance's cached icon, when one could be fetched. */
  icon?: string;
  iconFetchedAt?: number;
  /**
   * The user answered "don't ask again" when the app offered to save a login for
   * this instance, so opening it goes straight through and no further offer is
   * made. It is only about the *offer*: a login saved later — from the row's own
   * key control, or by hand in the manager — is used exactly as any other, which
   * is also why the flag needs no way to be taken back. Saving is the way back.
   */
  manualAuth?: boolean;
};

export function normalizeInstanceUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('Enter a self-hosted Lithic instance URL.');
  const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Use an HTTP or HTTPS instance URL.');
  return url.origin;
}

/** Display label: the host, without the scheme (legacy launcher parity). */
export function instanceLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}

function toEntry(value: unknown): BookmarkEntry | null {
  // Legacy storage shape: a bare array of URL strings.
  if (typeof value === 'string') {
    try {
      const url = normalizeInstanceUrl(value);
      return { url, label: instanceLabel(url) };
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Partial<BookmarkEntry>;
  if (typeof record.url !== 'string' || !record.url) return null;
  const entry: BookmarkEntry = {
    url: record.url,
    label: typeof record.label === 'string' && record.label ? record.label : instanceLabel(record.url)
  };
  if (typeof record.icon === 'string' && record.icon) {
    entry.icon = record.icon;
    entry.iconFetchedAt = typeof record.iconFetchedAt === 'number' ? record.iconFetchedAt : 0;
  }
  if (record.manualAuth === true) entry.manualAuth = true;
  return entry;
}

export function readBookmarkEntries(storage: Storage = localStorage): BookmarkEntry[] {
  try {
    const value = JSON.parse(storage.getItem(BOOKMARKS_KEY) ?? '[]');
    if (!Array.isArray(value)) return [];
    const entries: BookmarkEntry[] = [];
    for (const item of value) {
      const entry = toEntry(item);
      if (entry && !entries.some((existing) => existing.url === entry.url)) entries.push(entry);
    }
    return entries.slice(0, 20);
  } catch {
    return [];
  }
}

function writeBookmarkEntries(entries: BookmarkEntry[], storage: Storage): BookmarkEntry[] {
  const result = entries.slice(0, 20);
  storage.setItem(BOOKMARKS_KEY, JSON.stringify(result));
  return result;
}

/** URLs only (legacy view of the same storage). */
export function readBookmarks(storage: Storage = localStorage): string[] {
  return readBookmarkEntries(storage).map((entry) => entry.url);
}

/** Bookmark an instance, newest first, preserving any icon already cached. */
export function saveBookmark(value: string, storage: Storage = localStorage): BookmarkEntry[] {
  const normalized = normalizeInstanceUrl(value);
  const existing = readBookmarkEntries(storage);
  const previous = existing.find((entry) => entry.url === normalized);
  const rest = existing.filter((entry) => entry.url !== normalized);
  return writeBookmarkEntries([previous ?? { url: normalized, label: instanceLabel(normalized) }, ...rest], storage);
}

export function removeBookmark(value: string, storage: Storage = localStorage): BookmarkEntry[] {
  return writeBookmarkEntries(
    readBookmarkEntries(storage).filter((entry) => entry.url !== value),
    storage
  );
}

/**
 * Remember (or clear) "don't ask again" for one bookmark.
 *
 * Kept with the bookmark rather than in the vault because that is where the fact
 * belongs: it is about *opening this instance*, not about any stored credential —
 * and it has to be readable while the vault is locked, since the offer it silences
 * is made before anything is unlocked.
 */
export function setBookmarkManualAuth(
  value: string,
  manual: boolean,
  storage: Storage = localStorage
): BookmarkEntry[] {
  const entries = readBookmarkEntries(storage).map((entry) => {
    if (entry.url !== value) return entry;
    if (manual) return { ...entry, manualAuth: true };
    const { manualAuth: _manual, ...rest } = entry;
    return rest;
  });
  return writeBookmarkEntries(entries, storage);
}

/** Attach (or drop) a cached icon for one bookmark. */
export function setBookmarkIcon(
  url: string,
  icon: string | null,
  storage: Storage = localStorage,
  now: number = Date.now()
): BookmarkEntry[] {
  const entries = readBookmarkEntries(storage).map((entry) => {
    if (entry.url !== url) return entry;
    if (!icon) {
      const { icon: _icon, iconFetchedAt: _at, ...rest } = entry;
      return rest;
    }
    return { ...entry, icon, iconFetchedAt: now };
  });
  return writeBookmarkEntries(entries, storage);
}

/** Does this entry still need its icon fetched? */
export function shouldRefreshIcon(entry: BookmarkEntry, now: number = Date.now()): boolean {
  if (!entry.icon) return true;
  // An icon without a timestamp means storage written before we tracked them:
  // refresh it once so the entry gains a timestamp and settles.
  if (typeof entry.iconFetchedAt !== 'number') return true;
  return now - entry.iconFetchedAt > ICON_MAX_AGE_MS;
}

async function blobToDataUrl(blob: Blob): Promise<string | null> {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
  } catch {
    return null;
  }
}

/** An SVG icon is still a valid favicon; keep it inline rather than base64. */
function svgDataUrl(text: string): string | null {
  const trimmed = text.trim();
  if (!/^<svg[\s>]/i.test(trimmed)) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}`;
}

/**
 * Fetch the instance's current icon as a cacheable data URL.
 *
 * Cross-origin, so the instance must allow it (this repo's deployment sends
 * `Access-Control-Allow-Origin` for the icon paths, though a hand-rolled server
 * often does not — see `fetchInstanceIconNative`, which the desktop app uses for
 * exactly that case). A null result is normal and non-fatal: protected
 * instances, offline servers, and hosts that never customized their icon all
 * land here, and the UI falls back to the remote URL or a plain label.
 */
export async function fetchInstanceIcon(url: string, fetcher: typeof fetch = fetch): Promise<string | null> {
  for (const path of ICON_PATHS) {
    try {
      const response = await fetcher(`${url}${path}`, { mode: 'cors', cache: 'no-store' });
      if (!response.ok) continue;
      const blob = await response.blob();
      if (!blob || blob.size === 0 || blob.size > ICON_MAX_BYTES) continue;
      if (/svg/i.test(blob.type)) return svgDataUrl(await blob.text());
      const dataUrl = await blobToDataUrl(blob);
      if (dataUrl) return dataUrl;
    } catch {
      // Try the next candidate path.
    }
  }
  return null;
}

/** One icon fetched through Rust, where CORS does not apply. */
export type NativeIconLoader = (
  url: string
) => Promise<{ content_type?: string; bytes?: number[] } | null>;

/**
 * The same icon, fetched natively and turned into the same kind of data URL.
 *
 * This is what makes the meta-launcher's disambiguation work against a real
 * deployment: the emoji favicon is what tells a personal instance from a work
 * one, and a self-hosted server that sends no `Access-Control-Allow-Origin`
 * cannot be read by the browser at all.
 */
export async function fetchInstanceIconNative(url: string, loader: NativeIconLoader): Promise<string | null> {
  try {
    const result = await loader(url);
    const bytes = result?.bytes;
    if (!Array.isArray(bytes) || bytes.length === 0) return null;
    const blob = new Blob([new Uint8Array(bytes)], { type: result?.content_type || 'image/png' });
    if (blob.size > ICON_MAX_BYTES) return null;
    // An SVG served as bytes still needs the inline form, so the data URL stays
    // legible in storage and renders in the list.
    if (/svg/i.test(blob.type)) return svgDataUrl(await blob.text());
    return blobToDataUrl(blob);
  } catch {
    return null;
  }
}

/**
 * Refresh one bookmark's icon if it is missing or stale. Returns the entry list
 * so callers can assign it straight back to their reactive state.
 *
 * `native` is the desktop app's Rust fetch, preferred when present because it
 * succeeds against instances the browser cannot read.
 */
export async function refreshBookmarkIcon(
  url: string,
  fetcher: typeof fetch = fetch,
  storage: Storage = localStorage,
  now: number = Date.now(),
  native?: NativeIconLoader
): Promise<BookmarkEntry[]> {
  const entry = readBookmarkEntries(storage).find((item) => item.url === url);
  if (!entry || !shouldRefreshIcon(entry, now)) return readBookmarkEntries(storage);
  const icon = native ? await fetchInstanceIconNative(url, native) : await fetchInstanceIcon(url, fetcher);
  if (!icon) return readBookmarkEntries(storage);
  return setBookmarkIcon(url, icon, storage, now);
}

export type InstanceVerification = {
  verified: boolean;
  /**
   * The host answered, but Lithic could not read what it answered: a 401/403, or
   * a response the browser withheld because the instance sends no
   * `Access-Control-Allow-Origin`. The user confirms by hand rather than being
   * refused, because from here those two are indistinguishable from a refusal
   * that has nothing to do with whether the instance is real.
   */
  requiresManualConfirm?: boolean;
  /** Nothing answered at all: wrong address, offline, or a host that is down. */
  unreachable?: boolean;
};

/**
 * Did anything answer, when the response itself may not be read?
 *
 * `mode: 'no-cors'` resolves with an opaque response for any HTTP reply and
 * rejects only when there is no reply, which is precisely the one bit `fetch`
 * can still give us about a cross-origin host that sends no CORS headers. A
 * self-hosted instance is the normal case for that: it serves its manifest
 * without them, so the readable fetch fails on a perfectly good instance.
 */
async function answeredOpaquely(target: string, fetcher: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    await fetcher(target, { mode: 'no-cors', cache: 'no-store', signal: controller.signal });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Verify a self-hosted instance by fetching its manifest.json (legacy launcher
 * parity). Aborts after 5s so an unreachable host fails fast instead of
 * hanging the bookmark dialog.
 *
 * In the desktop app this is the fallback: `probe_instance` in Rust sees the
 * same response without CORS in the way, so it can verify an instance this
 * cannot even read. Here, an unreadable answer becomes a confirmation rather
 * than a refusal.
 */
export async function verifyInstanceUrl(url: string, fetcher: typeof fetch = fetch): Promise<InstanceVerification> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetcher(`${url}/manifest.json`, { method: 'GET', signal: controller.signal });
    if (response.ok) {
      const manifest = await response.json();
      if (manifest && (manifest.name === 'Lithic' || manifest.short_name === 'Lithic')) {
        return { verified: true };
      }
      return { verified: false };
    }
    if (response.status === 401 || response.status === 403) {
      return { verified: true, requiresManualConfirm: true };
    }
    return { verified: false };
  } catch {
    return (await answeredOpaquely(`${url}/manifest.json`, fetcher))
      ? { verified: true, requiresManualConfirm: true }
      : { verified: false, unreachable: true };
  } finally {
    clearTimeout(timeoutId);
  }
}
