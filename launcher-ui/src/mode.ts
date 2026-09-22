export const MODES = ['webapp', 'tauri', 'self-host'] as const;
export type LauncherMode = (typeof MODES)[number];

/**
 * How the Ephemeral code-runner reaches an execution backend:
 *   'self-host'   -> same-origin /ephemeral/api/v1/* (the WebDAV backend proxies it)
 *   'paper-light' -> discover a bastion from docs/swarm.json and POST over https
 */
const MODE_QUERY_KEYS = ['mode', 'launcher-mode', 'launcher_mode'];

/** Whatever carries the injected Tauri global — `window` in a real document. */
type TauriHost = { __TAURI__?: unknown };

function defaultTauriHost(): TauriHost | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as TauriHost);
}

/**
 * Documents the desktop app serves itself from: Tauri 1 answers on the `tauri:`
 * scheme on macOS and Linux, and on `https://tauri.localhost` on Windows
 * (`Manager::get_url`). Nothing else is the app, whoever sent the window there.
 */
export function servedByApp(location: Location): boolean {
  return location.protocol === 'tauri:' || location.hostname === 'tauri.localhost';
}

/**
 * Whether the app's API is reachable from this document. With `withGlobalTauri`
 * the global is injected into every document the webview loads — the app's own
 * pages and a bookmarked instance's page alike — so on its own it says "there is
 * a desktop app behind this window", never "this document is the launcher".
 */
export function tauriApiAvailable(host: TauriHost | undefined = defaultTauriHost()): boolean {
  return Boolean(host && '__TAURI__' in host);
}

/**
 * A page the app's window loaded from somewhere else: a bookmarked instance's
 * own launcher, running in the desktop app. Its mode belongs to that server, but
 * it is the one state that wants a way back to the app's launcher, so it is
 * answered next to the mode rather than folded into it.
 *
 * The injected global is not *usable* here: Rust refuses IPC from a document
 * outside the app's own URL unless that origin was granted a scope
 * (`security.dangerousRemoteDomainIpcAccess`), so nothing may assume an
 * `invoke` will be answered.
 */
export function hostedInApp(
  location: Location,
  host: TauriHost | undefined = defaultTauriHost()
): boolean {
  return tauriApiAvailable(host) && !servedByApp(location);
}

/** Query key the launcher puts on an instance URL when it hands the window over. */
export const LAUNCHER_ORIGIN_PARAM = 'lithic-from';

/**
 * Hand the window to a bookmarked instance, saying what only the launcher knows.
 *
 * Two annotations ride on the URL, both of them because the page that arrives
 * cannot work either out for itself:
 *
 *   `mode=self-host` — the launcher only lets an origin be bookmarked after
 *   `verifyInstanceUrl` read its Lithic manifest, so "opened from the bookmark
 *   list" *is* "this is a Lithic instance". The page itself usually cannot say
 *   so: it is served at the origin root rather than under `/sync/`, may carry no
 *   declaration, and a tidy address like `personal.example.uk` gives nothing
 *   away. Without this it would resolve to `webapp` — no remote pill, no
 *   same-origin API — which is the breakage bookmarks keep running into.
 *
 *   `lithic-from=<launcher>` — the address to come back to. It has to travel
 *   with the navigation: a document outside the app's URL may not invoke Rust
 *   (see `hostedInApp`) and cannot guess the app's origin, which differs per
 *   platform (`tauri://localhost` vs `https://tauri.localhost`).
 */
export function withLauncherHandoff(instanceUrl: string, launcherHref: string): string {
  try {
    const url = new URL(instanceUrl);
    url.searchParams.set(LAUNCHER_ORIGIN_PARAM, launcherHref);
    url.searchParams.set('mode', 'self-host');
    return url.href;
  } catch {
    // Nothing we can annotate (or a scheme we do not know): navigating there
    // still works, it just will not carry the instance declaration or a way back.
    return instanceUrl;
  }
}

/**
 * How this page can return to the launcher it was opened from, when it knows:
 *   `{ kind: 'url' }`     the launcher's address, carried by the marker
 *   `{ kind: 'history' }` in the app with no marker: the window's history still
 *                         holds the launcher page it started on
 */
export type LauncherReturn = { kind: 'url'; url: string } | { kind: 'history' };

/** Where a handed-over page keeps the address it was given, for this window only. */
const RETURN_KEY = 'lithic-launcher-return';

type SessionStore = Pick<Storage, 'getItem' | 'setItem'>;

function defaultSessionStore(): SessionStore | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    // Storage access throws where it is blocked (sandboxed frames, some private
    // modes); the marker in the URL is enough on its own, so this is not fatal.
    return null;
  }
}

/** A launcher address we are willing to navigate to, or null. */
function safeLauncherUrl(value: string | null | undefined): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    // `tauri:` is the app's own scheme on macOS and Linux, so it is a legitimate
    // launcher address; anything else (notably `javascript:`) is not.
    if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'tauri:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function storedReturnUrl(store: SessionStore | null): string | null {
  try {
    return safeLauncherUrl(store?.getItem(RETURN_KEY));
  } catch {
    return null;
  }
}

export function launcherReturn(
  location: Location,
  host: TauriHost | undefined = defaultTauriHost(),
  store: SessionStore | null = defaultSessionStore()
): LauncherReturn | null {
  const marked = safeLauncherUrl(new URLSearchParams(location.search).get(LAUNCHER_ORIGIN_PARAM));
  if (marked) {
    // Remember it, because the instance's own pages are reached by its own links
    // and carry no marker — without this the way back would survive exactly one
    // click. Session storage, not local: the launcher handed over this window, so
    // that is the scope the address is meaningful in.
    try {
      store?.setItem(RETURN_KEY, marked);
    } catch {
      // A full or read-only store costs the durability, not the button.
    }
    return { kind: 'url', url: marked };
  }
  const remembered = storedReturnUrl(store);
  if (remembered) return { kind: 'url', url: remembered };
  return hostedInApp(location, host) ? { kind: 'history' } : null;
}

/**
 * An instance naming itself. The legacy launcher reads the same tag, so a
 * deployment that already carries it keeps working when it moves to this
 * launcher — and it is how an instance that is neither localhost nor `/sync/`
 * says "the thing behind this page is a server" without being guessed at from
 * its hostname.
 */
function declaresInstance(doc: Pick<Document, 'querySelector'> | null): boolean {
  return Boolean(doc && doc.querySelector('meta[name="lithic-webdav"]'));
}

export function resolveMode(
  location: Location,
  doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document,
  host: TauriHost | undefined = defaultTauriHost()
): LauncherMode {
  const params = new URLSearchParams(location.search);
  const forced = MODE_QUERY_KEYS
    .map((key) => params.get(key)?.trim().toLowerCase())
    .find((value): value is LauncherMode => MODES.includes(value as LauncherMode));

  if (forced) return forced;

  // Only the app's own page is the app. The global alone is not enough: it is
  // injected into every document the window loads, so a bookmarked instance —
  // served by its own server, in this same window — used to claim `tauri` here
  // and then take every local-only path built on it: invoking Rust, reindexing
  // this machine's folders, offering to write an install beside the exe. All of
  // that against a page whose content belongs to someone else's server.
  if (tauriApiAvailable(host) && servedByApp(location)) return 'tauri';

  const isSelfHost = location.pathname.startsWith('/sync/')
    || declaresInstance(doc)
    || location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || location.hostname.endsWith('.local');

  return isSelfHost ? 'self-host' : 'webapp';
}
