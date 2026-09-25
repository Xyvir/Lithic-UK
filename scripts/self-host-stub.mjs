/**
 * A stand-in Lithic instance, for the smoke test and the gallery.
 *
 * The self-host launcher's whole console is HTTP against its own origin: `/sync/`
 * for the WebDAV store, `/api/lithic/` for the git-backed patch API, and
 * `/api/github/` for the backup CGI that `deploy/entrypoint.sh` routes to
 * `github-sync.sh`. The last of those is the one the harness could not reach: not
 * because the states are complicated, but because they are a *conversation* — a
 * device code meant to be read off the screen, a poll that lands, a list of
 * repositories, a setup that sticks, a disconnect that undoes it — and a unit
 * test can only ever exercise one answer at a time.
 *
 * So this speaks the conversation, in the order the CGI does, with the same JSON
 * shapes the client parses (see `launcher-ui/src/server-git-sync.ts`, which names
 * each route against its `github-sync.sh` counterpart). It also serves the
 * launcher artifact from the same origin, which is what makes `/api/github/*`
 * same-origin — the reason a bookmarked instance works at all, and the reason
 * this cannot be done over `file://`.
 *
 * Nothing here is real: the token is a constant, GitHub is never contacted, no
 * git runs, and the WebDAV store is an array. What is real is the page's side of
 * it, which is the side under review.
 *
 *   const stub = await startSelfHostStub({ artifact: 'src/launcher.html' });
 *   await page.goto(`${stub.origin}/launcher.html?mode=self-host`);
 *   ...click Connect to GitHub...
 *   stub.authorize();            // as the person at github.com would
 *   const asked = stub.state.asked;   // every route the page called, in order
 *   await stub.close();
 *
 * Two of its options exist for the cache the deployment really ships rather than for the
 * backup conversation: `serviceWorker: 'real'` serves this repo's `offline-service-worker.js`
 * (the default is an empty script, so nothing a test does is cached unless it asks), and
 * `setLauncherDocument` swaps what the instance serves mid-run — which is what makes a
 * *stale* copy reproducible at all. The paths that worker precaches are answered here too,
 * because `cache.addAll` fails as a whole if one of them is missing.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

/** The fixture account's repositories, and how `partitionRepos` splits them. */
const DEFAULT_REPOS = [
  { full_name: 'keeper/lithic-sync-4k2p' },
  { full_name: 'keeper/lithic-archive' },
  { full_name: 'keeper/notes' },
  { full_name: 'keeper/website' }
];

/** The device code the fixture flow hands out. Read off the screen, then typed. */
const DEFAULT_USER_CODE = 'WXYZ9876';
const DEFAULT_DEVICE_CODE = 'device-code-fixture';
/** What the poll hands back once somebody authorizes. Never a real credential. */
const ACCESS_TOKEN = 'gho_fixture_token';

/**
 * How long ago a setup claims it synced. Not zero, deliberately: the heading
 * button colours a sync from the last five seconds as *syncing*, and a fixture
 * that synced "now" would make that state and the settled one indistinguishable
 * to whatever is asserting on the button.
 */
const SYNCED_AGO_SECONDS = 120;

/** The address an instance's own launcher reads its mark from. */
const INSTANCE_MARK_PATH = '/mstile-150x150.png';

/**
 * The instance's own mark, 2x2: small enough that it is unmistakably this file, and
 * deliberately not the 150x150 the build ships, so an assertion can tell the bytes the
 * instance served from the mark the page would fall back to.
 */
const INSTANCE_MARK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGM4YKX1H4QZYAwAS6QIjYg+ilEAAAAASUVORK5CYII=',
  'base64'
);

/** A 1x1 PNG, so the icon fetches an instance really makes are answers, not 404s. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** The well-known files an instance serves next to its launcher. */
const STATIC = {
  '/offline-service-worker.js': ['text/javascript; charset=utf-8', '/* the stub caches nothing */\n'],
  // Fillers for the shipped worker's precache list. What a test is about when it turns
  // that worker on is the cache it fills, not the documents in it.
  '/index.html': ['text/html; charset=utf-8', '<!doctype html><title>Lithic</title>\n'],
  '/src/lithic.html': ['text/html; charset=utf-8', '<!doctype html><title>Lithic</title>\n'],
  '/android-chrome-192x192.png': ['image/png', PIXEL_PNG],
  '/manifest.json': ['application/json', JSON.stringify({ name: 'Lithic', short_name: 'Lithic', version: '0.0.0' })],
  '/site.webmanifest': ['application/json', JSON.stringify({ name: 'Lithic', short_name: 'Lithic' })],
  '/favicon.ico': ['image/png', PIXEL_PNG],
  '/favicon-16x16.png': ['image/png', PIXEL_PNG],
  '/favicon-32x32.png': ['image/png', PIXEL_PNG],
  '/apple-touch-icon.png': ['image/png', PIXEL_PNG],
  '/src/app-icon.png': ['image/png', PIXEL_PNG]
};

/**
 * One WebDAV `<response>` for a file in the fixture store.
 *
 * A file put here without a size answers the way a store that does not report content
 * lengths does: a name and a date, which is what the launcher draws a row from when there
 * is no length to show.
 */
function propfindEntry(name, lastModified, sizeBytes = null) {
  return [
    '<D:response>',
    `<D:href>/sync/${encodeURIComponent(name)}</D:href>`,
    '<D:propstat><D:prop>',
    `<D:getlastmodified>${lastModified.toUTCString()}</D:getlastmodified>`,
    Number.isFinite(sizeBytes) ? `<D:getcontentlength>${sizeBytes}</D:getcontentlength>` : '',
    '</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>',
    '</D:response>'
  ].join('');
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(body);
  } catch {
    return {};
  }
}

/** The request's bytes, unparsed: icon renders are PNG and are stored as they arrived. */
function readRawBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

/**
 * Start the fixture instance on a free loopback port.
 *
 * Resolves once it is listening. `state` is live — the test is expected to reach
 * into it (`state.liths.push(...)`, `state.asked`) — and `authorize()` is the one
 * mutation that stands in for a human: it is what turns the poll from
 * `authorization_pending` into a token, which is the step nothing offline could
 * do before this.
 */
export async function startSelfHostStub(options = {}) {
  const artifact = options.artifact ?? 'src/launcher.html';
  const artifactHtml = await readFile(artifact);
  /** What the instance serves as its launcher. Swappable, because a redeploy is. */
  let launcherDocument = options.document ?? artifactHtml;
  /**
   * The worker this deployment serves, when a scenario wants the real one. The default
   * is the empty script below: a page that registers it caches nothing, so the tests
   * about `/api/github/*` are not also testing a cache in front of every request.
   */
  const worker = options.serviceWorker === 'real' ? await readFile('offline-service-worker.js') : null;
  const state = {
    /** What `/api/github/status` answers. */
    connected: false,
    repo: '',
    /** Epoch seconds, the CGI's unit (`server-git-sync.ts` multiplies by 1000). */
    lastSync: 0,
    /** Whether the next poll is authorized. */
    authorized: false,
    /**
     * Milliseconds to hold the *next* `/api/github/status` answer open for, consumed as it
     * is used. Zero is an instance that answers immediately, which is every other test.
     */
    statusDelayMs: 0,
    /** The holds that were actually applied, in order, so a test can prove it got one. */
    statusHolds: [],
    userCode: options.userCode ?? DEFAULT_USER_CODE,
    deviceCode: options.deviceCode ?? DEFAULT_DEVICE_CODE,
    repos: (options.repos ?? DEFAULT_REPOS).map((repo) => ({ ...repo })),
    /**
     * The WebDAV store's Liths: `{ name, lastModified, sizeBytes, text }`. `text` is what
     * the patch API's read route answers with, and null means the fixture body for it.
     */
    liths: options.liths ?? [],
    /**
     * Whether the instance serves its own mark at `/mstile-150x150.png`. True is what a
     * deployment looks like once its icon set has been published; false is one whose
     * public directory never got the set, which is the launcher's fallback case.
     */
    instanceMark: options.instanceMark !== false,
    /**
     * The rest of the store, by name: the instance's icon renders and its
     * `favicon.conf` choice, which is anything PUT into `/sync/` that is not a
     * Lith. Kept apart from `liths` because a Lith is what the launcher's list draws,
     * while these exist to be *read* — and because the real deployment's root holds both,
     * so a listing here that carried the icons is what proves the client filters them out.
     */
    files: new Map(),
    /**
     * Every `/api/...` and `/sync/...` request the page made, as `METHOD /path`, with the
     * query appended where there was one — the request line a server sees. It is what
     * tells a read of one file apart from a read of another.
     */
    asked: []
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub.invalid');
    const path = url.pathname;

    const send = (status, type, body, headers = {}) => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
      response.end(body);
    };
    const json = (body, status = 200) => send(status, 'application/json', JSON.stringify(body));

    if (path.startsWith('/api/') || path.startsWith('/sync/')) {
      state.asked.push(`${request.method} ${path}${url.search}`);
    }

    if (path === '/offline-service-worker.js' && worker) {
      send(200, 'text/javascript; charset=utf-8', worker.toString());
      return;
    }

    if ((path === '/' || path === '/launcher.html' || path === '/src/launcher.html') && request.method === 'GET') {
      // `documentMaxAge` is how a deployment behind a proxy that caches the page looks:
      // the webview then answers from its own HTTP cache rather than asking again.
      const freshness = options.documentMaxAge ? { 'cache-control': `max-age=${options.documentMaxAge}` } : {};
      send(200, 'text/html; charset=utf-8', launcherDocument, freshness);
      return;
    }

    // The instance's own mark, at the address its header reads — or the 404 a deployment
    // whose icon set was never published answers with.
    if (path === INSTANCE_MARK_PATH && request.method === 'GET') {
      if (!state.instanceMark) {
        send(404, 'text/plain; charset=utf-8', 'this instance has published no icon set\n');
        return;
      }
      send(200, 'image/png', INSTANCE_MARK_PNG);
      return;
    }

    const asset = STATIC[path];
    if (asset && request.method === 'GET') {
      send(200, asset[0], asset[1]);
      return;
    }

    // --- the git-backed patch API -------------------------------------------
    if (path === '/api/lithic/ping') {
      json({ service: 'lithic-sync' });
      return;
    }
    if (path === '/api/lithic/file' && request.method === 'GET') {
      // The patch API's read route, which is how a launcher indexes a Lith it has never
      // opened: the wiki comes back with the digest and revision a later save would be
      // checked against. What matters here is that a Lith in the store is readable as
      // *content*, since that is what the indexing pass is for.
      const name = url.searchParams.get('file') ?? '';
      const lith = state.liths.find((entry) => entry.name === name);
      if (!lith) {
        send(404, 'application/json', JSON.stringify({ error: `no ${name} in this store` }));
        return;
      }
      send(
        200,
        'text/plain; charset=utf-8',
        lith.text ?? `created: 20260920090000000\ntitle: ${name.replace(/\.lith$/i, '')}\ntype: text/vnd.tiddlywiki\n\nfrom this instance\n`,
        { 'x-lithic-digest': 'stub-digest', 'x-lithic-rev': 'stub-rev' }
      );
      return;
    }

    // --- the backup CGI ------------------------------------------------------
    if (path === '/api/github/status') {
      // The answer is composed now and delivered later, which is what a slow instance does
      // and what makes an ordering testable: a one-shot delay here holds one read's answer
      // open past the step that supersedes it, without changing what that answer says —
      // the state is read before the wait, exactly as a server that answered quickly but
      // whose reply arrived slowly would have it.
      const body = { connected: state.connected, repo: state.repo, last_sync: state.lastSync };
      const delay = state.statusDelayMs;
      state.statusDelayMs = 0;
      if (delay > 0) {
        state.statusHolds.push(delay);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
      json(body);
      return;
    }
    if (path === '/api/github/device-code') {
      state.authorized = false;
      json({
        device_code: state.deviceCode,
        user_code: state.userCode,
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 1
      });
      return;
    }
    if (path === '/api/github/poll') {
      // GitHub's own raw body, not the desktop app's normalized one: this route
      // is the CGI relaying github.com, and `parseServerDevicePoll` reads it.
      json(state.authorized ? { access_token: ACCESS_TOKEN } : { error: 'authorization_pending' });
      return;
    }
    if (path === '/api/github/list-repos') {
      json(state.repos);
      return;
    }
    if (path === '/api/github/create-repo' && request.method === 'POST') {
      const body = await readBody(request);
      const fullName = `keeper/${String(body.name ?? '').trim()}`;
      state.repos.push({ full_name: fullName });
      json({ full_name: fullName });
      return;
    }
    if (path === '/api/github/setup' && request.method === 'POST') {
      const body = await readBody(request);
      state.connected = true;
      state.repo = String(body.repo ?? '').trim();
      state.lastSync = Math.floor(Date.now() / 1000) - SYNCED_AGO_SECONDS;
      json({ status: 'success' });
      return;
    }
    if (path === '/api/github/disconnect') {
      state.connected = false;
      state.repo = '';
      state.lastSync = 0;
      json({ status: 'success' });
      return;
    }

    // --- the WebDAV store ----------------------------------------------------
    if (path === '/sync/' && request.method === 'PROPFIND') {
      // Everything the root holds, Liths and icons alike: the client's own filter is what
      // keeps a `favicon-32x32.png` out of the list of Liths, and this is where that shows.
      const entries = [
        ...state.liths.map((lith) => ({ name: lith.name, lastModified: lith.lastModified, sizeBytes: lith.sizeBytes })),
        ...[...state.files.values()].map((file) => ({
          name: file.name,
          lastModified: file.lastModified,
          sizeBytes: file.bytes?.length ?? null
        }))
      ]
        .map((entry) => propfindEntry(entry.name, entry.lastModified ?? new Date(0), entry.sizeBytes))
        .join('');
      send(
        207,
        'application/xml; charset=utf-8',
        `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/sync/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>${entries}</D:multistatus>`
      );
      return;
    }
    if (path.startsWith('/sync/') && request.method === 'GET') {
      const name = decodeURIComponent(path.slice('/sync/'.length));
      const file = state.files.get(name);
      if (!file) {
        send(404, 'text/plain; charset=utf-8', `no ${name} in this store\n`);
        return;
      }
      // The content type a real deployment would serve for it, so a client that cares is
      // answered here the way it is answered there.
      const type = name.endsWith('.conf')
        ? 'text/plain; charset=utf-8'
        : name.endsWith('.json')
          ? 'application/json'
          : 'application/octet-stream';
      send(200, type, file.bytes);
      return;
    }
    if (path.startsWith('/sync/') && request.method === 'PUT') {
      const name = decodeURIComponent(path.slice('/sync/'.length));
      const body = await readRawBody(request);
      // A `.lith` is a Lith the list draws; anything else — the icon renders, the
      // `favicon.conf` choice — is a file of the store that is only ever read.
      if (name.endsWith('.lith')) {
        // The store knows how big the file it just wrote is, and reports it like any
        // other length: a row drawn from an upload shows what was uploaded.
        const existing = state.liths.find((lith) => lith.name === name);
        if (existing) {
          existing.lastModified = new Date();
          existing.sizeBytes = body.length;
        } else {
          state.liths.push({ name, lastModified: new Date(), sizeBytes: body.length });
        }
      } else {
        state.files.set(name, { name, lastModified: new Date(), bytes: body });
      }
      send(201, 'text/plain; charset=utf-8', '');
      return;
    }
    // The row's own ×, and the presence lock the legacy delete tidied up after it: the
    // store drops the Lith, and anything else named on this route is answered the same
    // way without being there — which is what a lock file that was never written looks like.
    if (path.startsWith('/sync/') && request.method === 'DELETE') {
      const name = decodeURIComponent(path.slice('/sync/'.length));
      const index = state.liths.findIndex((lith) => lith.name === name);
      if (index >= 0) state.liths.splice(index, 1);
      state.files.delete(name);
      send(204, 'text/plain; charset=utf-8', '');
      return;
    }

    send(404, 'text/plain; charset=utf-8', `no route for ${request.method} ${path}\n`);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();

  return {
    origin: `http://127.0.0.1:${port}`,
    state,
    /** Let the next poll through — the stand-in for typing the code on GitHub. */
    authorize() {
      state.authorized = true;
    },
    /**
     * Put a Lith in the server's store, as an upload or a git pull would.
     *
     * `sizeBytes` is optional because the store is allowed to answer without a length;
     * passing one is how a test says what the server reports about a file it holds.
     */
    addLith(name, lastModified = new Date(), sizeBytes = null, text = null) {
      state.liths.push({ name, lastModified, sizeBytes, text });
    },
    /**
     * Put a file that is not a Lith in the store, as the instance's own icon flow and a
     * git restore both do — the icon renders, or the `favicon.conf` choice.
     */
    addFile(name, body = '', lastModified = new Date()) {
      state.files.set(name, { name, lastModified, bytes: Buffer.from(body, 'utf8') });
    },
    /**
     * Serve a different launcher from the same URL, as a redeploy does — the one thing
     * an instance's own copy cannot notice on its own, and so the setup every cache
     * assertion starts from.
     */
    setLauncherDocument(text) {
      launcherDocument = text;
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      });
    }
  };
}
