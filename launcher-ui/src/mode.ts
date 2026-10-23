export const MODES = ['webapp', 'tauri', 'self-host'] as const;
export type LauncherMode = (typeof MODES)[number];

/**
 * How the Ephemeral code-runner reaches an execution backend:
 *   'self-host'   -> same-origin /ephemeral/api/v1/* (the WebDAV backend proxies it)
 *   'paper-light' -> discover a bastion from docs/swarm.json and POST over https
 */
const MODE_QUERY_KEYS = ['mode', 'launcher-mode', 'launcher_mode'];

/** Whatever carries the injected Tauri global. `window` in a real document. */
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
 * the global is injected into every document the webview loads (the app's own
 * pages and a bookmarked instance's page alike) so on its own it says "there is
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
 * Query key carrying the words the launcher was searching for.
 *
 * Only ever set when the handover *is* a search: the panel beside an instance's match
 * hands the window over with what was typed, so the instance's launcher comes up
 * looking for it rather than with an empty box the user would have to fill in again.
 * The reader on the other side is `handoffQuery`.
 */
export const LAUNCHER_QUERY_PARAM = 'q';

/**
 * Hand the window to a bookmarked instance, saying what only the launcher knows.
 *
 * Two annotations ride on the URL, both of them because the page that arrives
 * cannot work either out for itself:
 *
 *   `mode=self-host`. The launcher only lets an origin be bookmarked after
 *   `verifyInstanceUrl` read its Lithic manifest, so "opened from the bookmark
 *   list" *is* "this is a Lithic instance". The page itself usually cannot say
 *   so: it is served at the origin root rather than under `/sync/`, may carry no
 *   declaration, and a tidy address like `personal.example.uk` gives nothing
 *   away. Without this it would resolve to `webapp` (no remote pill, no
 *   same-origin API) which is the breakage bookmarks keep running into.
 *
 *   `lithic-from=<launcher>`. The address to come back to. It has to travel
 *   with the navigation: a document outside the app's URL may not invoke Rust
 *   (see `hostedInApp`) and cannot guess the app's origin, which differs per
 *   platform (`tauri://localhost` vs `https://tauri.localhost`). Written only
 *   where there is somewhere to come back to (`returnable`): a document opened
 *   in another application's browser cannot return to this one, and the marker
 *   is the whole of what draws the way back, so a handoff that cannot return
 *   writes no marker at all rather than one that leads nowhere.
 *
 *   `q=<words>`. Only when the handover is a search. The launcher's global search shows
 *   one hit per instance and no more, so the instance's own launcher is where the rest of
 *   them are read; arriving already searching is what makes that a step rather than a
 *   retyping. An instance running an older build ignores it and simply opens.
 */
export function withLauncherHandoff(
  instanceUrl: string,
  launcherHref: string,
  query = '',
  returnable = true
): string {
  try {
    const url = new URL(instanceUrl);
    if (returnable) url.searchParams.set(LAUNCHER_ORIGIN_PARAM, launcherHref);
    url.searchParams.set('mode', 'self-host');
    if (query.trim()) url.searchParams.set(LAUNCHER_QUERY_PARAM, query.trim());
    return url.href;
  } catch {
    // Nothing we can annotate (or a scheme we do not know): navigating there
    // still works, it just will not carry the instance declaration or a way back.
    return instanceUrl;
  }
}

/**
 * The search a page was handed, or an empty string when it was not handed one.
 *
 * Read once, at mount, and then taken back out of the address. See the launcher's
 * `onMount`: the query belongs to the handover, not to the URL the instance then owns,
 * so a reload starts on the instance's own list rather than silently searching again.
 */
export function handoffQuery(location: Location): string {
  try {
    return new URLSearchParams(location.search).get(LAUNCHER_QUERY_PARAM)?.trim() ?? '';
  } catch {
    // A location whose search cannot be read is a location with no query on it.
    return '';
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
    // and carry no marker. Without this the way back would survive exactly one
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
 * launcher. It is the explicit half of the answer. See `servedByInstance` for
 * the half that has to be inferred, because the launcher artifact is shared and
 * so cannot carry a tag of its own.
 */
/**
 * A process saying it is *not* an instance. It serves the launcher and the wiki and nothing
 * else, so nothing here has a server of its own and `self-host` would be a lie.
 *
 * The tag exists because the launcher file cannot carry it, for the same reason it cannot
 * carry `lithic-webdav` (see `servedByInstance`): the same bytes are an instance's own
 * launcher, so what this page is can only be said by whoever sent it. A local shim is the
 * first sender that is neither an instance nor a published deployment, and it is the one
 * sender the address cannot answer for, since a loopback origin is an instance by the
 * machine rule below.
 */
export const BROWSER_ONLY_META = 'lithic-browser-only';

export function declaresBrowserOnly(doc: Pick<Document, 'querySelector'> | null): boolean {
  return Boolean(doc && doc.querySelector(`meta[name="${BROWSER_ONLY_META}"]`));
}

function declaresInstance(doc: Pick<Document, 'querySelector'> | null): boolean {
  return Boolean(doc && doc.querySelector('meta[name="lithic-webdav"]'));
}

/**
 * Hosts that serve this launcher as a client rather than as part of an instance:
 * the published deployments, whose copy is the PWA a visitor uses to open *other*
 * people's servers. No `/sync/` sits beside them, which is the whole difference.
 */
const PUBLIC_LAUNCHER_HOSTS = ['lithic.uk', 'www.lithic.uk'];

/**
 * Whether the origin that served this document is somebody's instance.
 *
 * The launcher is one artifact shipped to every deployment (`autoupdate.sh`
 * pulls the same `src/launcher.html` into an instance's public directory that
 * GitHub Pages serves from the PWA's) so the file cannot declare what it is: the
 * same bytes are both. Every explicit declaration there is (`?mode=`, the `/sync/`
 * path, the meta tag) is therefore something the launcher an instance serves does
 * not have. What it does have is the fact that a copy of this launcher arriving
 * over http(s) from anywhere that is not a published deployment arrived from a
 * server somebody runs, and an instance serves this file precisely so its own
 * `/sync/` can be listed beside it. This is the inference the pre-Svelte launcher
 * made, and the reason a directly-opened instance needs no declaration at all.
 *
 * It is a guess, and both ways of being wrong are recoverable: a fork hosted on a
 * domain of its own is read as an instance (it can carry the meta tag, or be
 * opened with `?mode=webapp`), and a copy of the PWA served under a name that is
 * not in the list above would be misread the same way, which is why the list is
 * part of the rule rather than a detail of it.
 *
 * localhost, `127.0.0.1` and `.local` are not named here: those are instances by
 * their own rule, which is about a machine rather than about a guess. A document that
 * declares `lithic-browser-only` is the one exception, because a shim on the user's own
 * machine is reached at exactly that address and is not an instance.
 */
export function servedByInstance(location: Location): boolean {
  // Only http(s) can have a `/sync/` behind it; `tauri:` and `file:` are the app
  // and a copy on disk, and neither is an instance.
  if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
  const host = location.hostname.toLowerCase();
  if (!host) return false;
  if (PUBLIC_LAUNCHER_HOSTS.includes(host)) return false;
  if (host.endsWith('.github.io')) return false;
  return true;
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
  // injected into every document the window loads, so a bookmarked instance (
  // served by its own server, in this same window) used to claim `tauri` here
  // and then take every local-only path built on it: invoking Rust, reindexing
  // this machine's folders, offering to write an install beside the exe. All of
  // that against a page whose content belongs to someone else's server.
  if (tauriApiAvailable(host) && servedByApp(location)) return 'tauri';

  // A process that says it is browser-only is the launcher standing on its own, which is
  // what a local shim serves. It has to outrank the machine rules below, because the shim
  // is reached at exactly the address those rules read as an instance. An instance's own
  // declarations outrank it in turn, so no deployment is talked out of being what it says
  // it is.
  const browserOnly = declaresBrowserOnly(doc)
    && !declaresInstance(doc)
    && !location.pathname.startsWith('/sync/');
  if (browserOnly) return 'webapp';

  const isSelfHost = location.pathname.startsWith('/sync/')
    || declaresInstance(doc)
    || location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || location.hostname.endsWith('.local')
    // The launcher an instance serves carries none of the declarations above, so
    // the origin that served it is the only thing left to read. Last, because
    // every explicit signal outranks a guess about a hostname.
    || servedByInstance(location);

  return isSelfHost ? 'self-host' : 'webapp';
}

/**
 * The package an `intent://` link names to reach the app itself, and the whole of what "the app
 * is installed" means to a web page.
 *
 * Naming it explicitly is what makes the chooser unnecessary: Android hands the intent to that one
 * app, and when nothing answers, Chrome loads the browser fallback the same intent carries. So one
 * address serves both audiences and neither has to be detected.
 */
export const LITHIC_APP_PACKAGE = 'com.lithic.app';

/**
 * Query key the app adds to the board's address when it opens that page in its own window, so the
 * page can tell it is in the app rather than in a sign-in window.
 *
 * Both are WebViews and both answer no file chooser, but only one of them has somewhere better to
 * go: naming the app from inside the app would bring the app forward onto itself, while naming the
 * browser reaches the place a chooser works.
 */
export const LITHIC_APP_PARAM = 'in';

/**
 * Query key carrying the scheme the app should reopen the page with.
 *
 * A `lithic://` address says nothing about http and https, and the board is reached over http while
 * an instance is reached over https. The page that wrote the link knows which, so it says so rather
 * than the app guessing.
 */
export const LITHIC_APP_SCHEME_PARAM = 'lithic-scheme';

/** Whether this page was opened by the app, at an address the app marked. */
export function openedInApp(location: Pick<Location, 'search'>): boolean {
  try {
    return new URLSearchParams(location.search).get(LITHIC_APP_PARAM) === 'app';
  } catch {
    return false;
  }
}

/** The same address, marked as one the app opened. */
export function withAppMarker(url: string): string {
  try {
    const marked = new URL(url);
    marked.searchParams.set(LITHIC_APP_PARAM, 'app');
    return marked.href;
  } catch {
    return url;
  }
}

/**
 * The address an app hand-off was carrying, or null when it was not one.
 *
 * The app receives `lithic://<host><path>?<query>`, which is the page's own address with the scheme
 * swapped so that Android has something to route to the app. Turning it back is the reverse swap,
 * with the marker that says the page is now in the app and the scheme the page recorded before it
 * left. Anything that is not a `lithic` address with a host is refused rather than guessed at: the
 * one thing this must never do is send the window somewhere the intent did not name.
 */
export function boardFromDeepLink(link: string | null | undefined): string | null {
  if (!link) return null;
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'lithic:' || !url.host) return null;
  const scheme = url.searchParams.get(LITHIC_APP_SCHEME_PARAM) === 'https' ? 'https' : 'http';
  url.searchParams.delete(LITHIC_APP_SCHEME_PARAM);
  return withAppMarker(`${scheme}://${url.host}${url.pathname}${url.search}`);
}

/**
 * The address of this page, asked for in the app where it will answer a chooser, and in the browser
 * where the app cannot.
 *
 * Chrome's intent syntax is the one hand-off a page in a window that refuses a chooser can still
 * make, and it was measured on the board: a plain link to another host, a new window and a link to
 * the board under another name all stayed in the window, while an intent reached the browser with
 * the page loaded and its picker working. The browser form is the one to keep beside it: it is what
 * a device without the app installs, and what a board's own window reaches on every phone that has
 * never seen this app.
 */
export function handoffIntent(
  location: Pick<Location, 'protocol' | 'host' | 'pathname' | 'search'>,
  target: 'app' | 'browser'
): string {
  const scheme = location.protocol.replace(':', '');
  const here = `${location.protocol}//${location.host}${location.pathname}${location.search}`;
  const fallback = `S.browser_fallback_url=${encodeURIComponent(here)};`;
  if (target === 'browser') {
    return (
      `intent://${location.host}${location.pathname}${location.search}#Intent;` +
      `scheme=${scheme};package=com.android.chrome;${fallback}end`
    );
  }
  // The app is asked for a `lithic://` address, which is this page's own with the scheme swapped,
  // and it carries the real scheme so the app can rebuild the address it was actually about.
  const separator = location.search ? '&' : '?';
  const carried = `${location.search}${separator}${LITHIC_APP_SCHEME_PARAM}=${scheme}`;
  return (
    `intent://${location.host}${location.pathname}${carried}#Intent;` +
    `scheme=lithic;package=${LITHIC_APP_PACKAGE};${fallback}end`
  );
}
