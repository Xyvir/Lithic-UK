/**
 * Self-host transport: the WebDAV file API plus the git-backed patch API.
 *
 * This is the Svelte launcher's port of the legacy `runtime.webdav` fragment,
 * extended for the new save workflow. Two paths coexist on purpose:
 *
 *   Plain WebDAV (`/sync/`)  — listing, upload, delete and presence locks. Kept
 *     byte-compatible with the legacy launcher so the data directory stays
 *     browsable over WebDAV (VS Code, `cp -r /data` backups).
 *
 *   Patch API (`/api/lithic/`) — git-backed saves. The client fetches a wiki
 *     with its content digest, and on save sends only the changed lines; the
 *     server verifies the digest, applies the patch with `git apply` and
 *     commits. Git is therefore the source of truth for history and rollback,
 *     and a save that changes nothing sends nothing at all.
 *
 * The patch API is same-origin only (self-host keeps its private API, per the
 * deployment architecture), so probePatchApi() gates it: an instance without
 * the API — or a non-self-host mount — falls back to the legacy full-file PUT.
 */

export const WEBDAV_BASE = '/sync/';
export const LITHIC_API_BASE = '/api/lithic/';
/** A lock older than this belongs to a dead session (server purge uses 120s). */
export const LOCK_STALE_MS = 60_000;
export const LOCK_HEARTBEAT_MS = 30_000;

export type WebdavFile = { name: string; href: string; lastModified: Date | null };
export type WebdavLock = { user?: string; timestamp?: number; sessionId?: string };
export type RemoteVersion = { rev: string; ts: number; author: string; subject: string };
export type RemoteWiki = { text: string; digest: string; rev: string };

/** URL of one wiki or sidecar file inside the WebDAV root. */
export function webdavUrl(name: string, base = WEBDAV_BASE): string {
  return `${base}${encodeURIComponent(name)}`;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&');
}

/** First `<ns:name>…</ns:name>` body inside a WebDAV response block. */
function firstElementText(block: string, name: string): string | null {
  const pattern = new RegExp(`<(?:[A-Za-z0-9_.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[A-Za-z0-9_.-]+:)?${name}>`, 'i');
  const match = pattern.exec(block);
  return match ? match[1] : null;
}

/**
 * Parse a PROPFIND multistatus body into the `.lith` files it advertises.
 *
 * Deliberately hand-rolled rather than DOMParser-based: it keeps the listing
 * unit-testable in plain Node, and the servers we target (Caddy's webdav and
 * lighttpd's mod_webdav) emit simple, predictable multistatus XML. Namespace
 * prefixes are matched loosely, since both `D:` and `d:` are seen in the wild
 * and some servers omit the prefix entirely.
 */
export function parsePropfindXml(xml: string): WebdavFile[] {
  const files: WebdavFile[] = [];
  const responses = xml.matchAll(/<(?:[A-Za-z0-9_.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_.-]+:)?response>/gi);
  for (const response of responses) {
    const block = response[1];
    const rawHref = firstElementText(block, 'href');
    if (!rawHref) continue;
    const href = decodeXmlEntities(rawHref.trim());
    let path = href;
    try {
      path = decodeURIComponent(href);
    } catch {
      // A malformed escape is not worth failing the whole listing over.
    }
    if (path.endsWith('/')) continue; // the collection itself
    if (!path.toLowerCase().endsWith('.lith')) continue;
    const name = path.split('/').filter(Boolean).pop() ?? '';
    if (!name) continue;
    const stamp = firstElementText(block, 'getlastmodified');
    const parsed = stamp ? new Date(decodeXmlEntities(stamp.trim())) : null;
    files.push({ name, href, lastModified: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null });
  }
  files.sort((a, b) => (b.lastModified?.getTime() ?? 0) - (a.lastModified?.getTime() ?? 0));
  return files;
}

/** List the `.lith` files in the WebDAV root, newest first. */
export async function fetchRemoteFiles(fetcher: typeof fetch = fetch, base = WEBDAV_BASE): Promise<WebdavFile[]> {
  const response = await fetcher(base, { method: 'PROPFIND', headers: { Depth: '1' } });
  if (!response.ok) throw new Error(`PROPFIND failed: ${response.status}`);
  return parsePropfindXml(await response.text());
}

/** PUT a whole file (uploads, and the fallback when a patch cannot be used). */
export async function uploadRemoteFile(
  name: string,
  body: string | Blob,
  fetcher: typeof fetch = fetch,
  base = WEBDAV_BASE
): Promise<void> {
  const response = await fetcher(webdavUrl(name, base), { method: 'PUT', body });
  if (!response.ok && response.status !== 201 && response.status !== 204) throw new Error(`PUT failed: ${response.status}`);
}

export async function deleteRemoteFile(name: string, fetcher: typeof fetch = fetch, base = WEBDAV_BASE): Promise<void> {
  const response = await fetcher(webdavUrl(name, base), { method: 'DELETE' });
  if (!response.ok && response.status !== 204) throw new Error(`DELETE failed: ${response.status}`);
}

/** Per-tab id, so the launcher ignores the presence lock it wrote itself. */
export function resolveSessionId(storage: Storage | undefined = typeof sessionStorage === 'undefined' ? undefined : sessionStorage): string {
  try {
    const existing = storage?.getItem('lithicSessionId');
    if (existing) return existing;
    const generated = Math.random().toString(36).substring(2, 15);
    storage?.setItem('lithicSessionId', generated);
    return generated;
  } catch {
    return Math.random().toString(36).substring(2, 15);
  }
}

/** The active lock on a wiki, or null when free / ours / stale. */
export async function readRemoteLock(
  name: string,
  sessionId: string,
  fetcher: typeof fetch = fetch,
  now: number = Date.now(),
  base = WEBDAV_BASE
): Promise<WebdavLock | null> {
  try {
    const response = await fetcher(`${webdavUrl(name, base)}.lock`);
    if (!response.ok) return null;
    const lock = (await response.json()) as WebdavLock;
    if (!lock || typeof lock.timestamp !== 'number') return null;
    if (now - lock.timestamp >= LOCK_STALE_MS) return null;
    if (lock.sessionId === sessionId) return null;
    return lock;
  } catch {
    return null;
  }
}

export type LockHeartbeat = {
  /** Claim the wiki and keep the presence lock fresh. */
  start(name: string): Promise<void>;
  /** Release it (also called on page teardown). */
  stop(): void;
  current(): string | null;
};

/**
 * Presence-lock heartbeat. Mirrors the legacy 30s PUT cadence and 60s staleness
 * window so a crashed tab stops blocking the wiki without server involvement
 * (the server additionally purges anything older than 120s at boot). Timers are
 * injectable so the lifecycle is testable without waiting on real intervals.
 */
export function createLockHeartbeat(options: {
  sessionId: string;
  user?: string;
  fetcher?: typeof fetch;
  base?: string;
  intervalMs?: number;
  setIntervalImpl?: (callback: () => void, ms: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
  now?: () => number;
}): LockHeartbeat {
  const fetcher = options.fetcher ?? fetch;
  const base = options.base ?? WEBDAV_BASE;
  const user = options.user ?? 'Someone';
  const intervalMs = options.intervalMs ?? LOCK_HEARTBEAT_MS;
  const setIntervalImpl = options.setIntervalImpl ?? ((callback, ms) => setInterval(callback, ms));
  const clearIntervalImpl = options.clearIntervalImpl ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const now = options.now ?? (() => Date.now());
  let timer: unknown = null;
  let active: string | null = null;

  const write = async (name: string) => {
    try {
      await fetcher(`${webdavUrl(name, base)}.lock`, {
        method: 'PUT',
        body: JSON.stringify({ user, timestamp: now(), sessionId: options.sessionId })
      });
    } catch {
      // Presence is advisory: a failed heartbeat must never block editing.
    }
  };

  return {
    async start(name: string) {
      active = name;
      if (timer !== null) clearIntervalImpl(timer);
      await write(name);
      timer = setIntervalImpl(() => void write(name), intervalMs);
    },
    stop() {
      if (timer !== null) {
        clearIntervalImpl(timer);
        timer = null;
      }
      if (active) {
        const name = active;
        active = null;
        try {
          void fetcher(`${webdavUrl(name, base)}.lock`, { method: 'DELETE', keepalive: true }).catch(() => {});
        } catch {
          // Best effort, exactly like the legacy teardown.
        }
      }
    },
    current: () => active
  };
}

/** Uploads always land as `.lith`, even when a wiki arrives as bare JSON. */
export function lithUploadName(name: string): string {
  return /\.lith$/i.test(name) ? name : `${name.replace(/\.[^.]+$/, '')}.lith`;
}

/**
 * Startup tiddler injected into a mounted self-host wiki so the wiki can
 * release the presence lock from inside the engine (the mounted document is a
 * rewrite of the launcher page, so it cannot call back into the launcher UI).
 */
export const WEBDAV_UTILS_JS = `/*
title: $:/lithic/startup/webdav-utils.js
type: application/javascript
module-type: startup

WebDAV Utilities for Lithic
*/
(function(){
"use strict";
exports.name = "webdav-utils";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.synchronous = true;
exports.startup = function() {
    if(typeof window === "undefined") return;
    $tw.rootWidget.addEventListener("tm-lithic-stop-lock", function(event) {
        if (window.webdavStopHeartbeat) window.webdavStopHeartbeat();
        return false;
    });
};
})();`;

/* --- Git-backed patch API --- */

export type ApplyOutcome =
  | { ok: true; digest: string; unchanged?: boolean }
  | { ok: false; reason: 'unsupported' | 'stale' | 'rejected' | 'error'; digest?: string; detail?: string };

/**
 * Does this instance expose the patch API? An older deployment (or a plain
 * WebDAV server) answers 404, and the caller keeps using whole-file PUTs.
 */
export async function probePatchApi(fetcher: typeof fetch = fetch, apiBase = LITHIC_API_BASE): Promise<boolean> {
  try {
    const response = await fetcher(`${apiBase}ping`, { method: 'GET' });
    if (!response.ok) return false;
    const payload = (await response.json()) as { service?: string };
    return payload?.service === 'lithic-sync';
  } catch {
    return false;
  }
}

function headerValue(response: Response, name: string): string {
  // The API sends X-Lithic-<name>; accept the bare name too so a proxy that
  // rewrites or strips the custom prefix cannot silently disable patch saving.
  return response.headers?.get?.(`x-lithic-${name}`) ?? response.headers?.get?.(name) ?? '';
}

/** Fetch a wiki plus the digest the server will check a patch against. */
export async function fetchRemoteWiki(
  name: string,
  fetcher: typeof fetch = fetch,
  apiBase = LITHIC_API_BASE
): Promise<RemoteWiki> {
  const response = await fetcher(`${apiBase}file?file=${encodeURIComponent(name)}`, { method: 'GET' });
  if (!response.ok) throw new Error(`Failed to fetch ${name}: ${response.status}`);
  return {
    text: await response.text(),
    digest: headerValue(response, 'digest'),
    rev: headerValue(response, 'rev')
  };
}

/**
 * Send only the changed lines. The base digest is echoed back so the server can
 * refuse a patch built against a stale read instead of clobbering newer work.
 */
export async function applyRemotePatch(
  name: string,
  baseDigest: string,
  patch: string,
  fetcher: typeof fetch = fetch,
  apiBase = LITHIC_API_BASE
): Promise<ApplyOutcome> {
  let response: Response;
  try {
    response = await fetcher(`${apiBase}apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      // Line-oriented framing: the server (bash-only CGI) reads the file name,
      // the base digest, then the patch remainder verbatim.
      body: `${name}\n${baseDigest}\n${patch}`
    });
  } catch (error) {
    return { ok: false, reason: 'error', detail: String(error) };
  }

  if (response.ok) {
    let payload: { digest?: string; status?: string } = {};
    try {
      payload = (await response.json()) as { digest?: string; status?: string };
    } catch {
      // A body-less 200 is still a successful apply.
    }
    return { ok: true, digest: payload.digest ?? '', unchanged: payload.status === 'unchanged' };
  }

  let detail = '';
  let digest = '';
  try {
    const payload = (await response.json()) as { error?: string; digest?: string };
    detail = payload?.error ?? '';
    digest = payload?.digest ?? '';
  } catch {
    // Non-JSON error bodies are surfaced through the status code alone.
  }
  if (response.status === 409) return { ok: false, reason: 'stale', digest, detail };
  if (response.status === 404) return { ok: false, reason: 'unsupported', detail };
  if (response.status === 422) return { ok: false, reason: 'rejected', detail };
  return { ok: false, reason: 'error', digest, detail: detail || String(response.status) };
}

/** Commit history for one wiki, newest first (drives the rollback UI). */
export async function listRemoteVersions(
  name: string,
  fetcher: typeof fetch = fetch,
  apiBase = LITHIC_API_BASE,
  limit = 30
): Promise<RemoteVersion[]> {
  try {
    const response = await fetcher(`${apiBase}log?file=${encodeURIComponent(name)}&limit=${limit}`, { method: 'GET' });
    if (!response.ok) return [];
    const payload = (await response.json()) as { versions?: RemoteVersion[] };
    return Array.isArray(payload?.versions) ? payload.versions : [];
  } catch {
    return [];
  }
}

/** Roll a wiki back to an earlier commit (the backup is itself a commit). */
export async function restoreRemoteVersion(
  name: string,
  rev: string,
  fetcher: typeof fetch = fetch,
  apiBase = LITHIC_API_BASE
): Promise<boolean> {
  try {
    const response = await fetcher(`${apiBase}restore`, { method: 'POST', body: `${name}\n${rev}` });
    return response.ok;
  } catch {
    return false;
  }
}
