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

/** A 1x1 PNG, so the icon fetches an instance really makes are answers, not 404s. */
const PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

/** The well-known files an instance serves next to its launcher. */
const STATIC = {
  '/offline-service-worker.js': ['text/javascript; charset=utf-8', '/* the stub caches nothing */\n'],
  '/manifest.json': ['application/json', JSON.stringify({ name: 'Lithic', short_name: 'Lithic', version: '0.0.0' })],
  '/site.webmanifest': ['application/json', JSON.stringify({ name: 'Lithic', short_name: 'Lithic' })],
  '/favicon.ico': ['image/png', PIXEL_PNG],
  '/favicon-16x16.png': ['image/png', PIXEL_PNG],
  '/favicon-32x32.png': ['image/png', PIXEL_PNG],
  '/apple-touch-icon.png': ['image/png', PIXEL_PNG],
  '/src/app-icon.png': ['image/png', PIXEL_PNG]
};

/** One WebDAV `<response>` for a file in the fixture store. */
function propfindEntry(name, lastModified) {
  return [
    '<D:response>',
    `<D:href>/sync/${encodeURIComponent(name)}</D:href>`,
    '<D:propstat><D:prop>',
    `<D:getlastmodified>${lastModified.toUTCString()}</D:getlastmodified>`,
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
  const html = await readFile(artifact);
  const state = {
    /** What `/api/github/status` answers. */
    connected: false,
    repo: '',
    /** Epoch seconds, the CGI's unit (`server-git-sync.ts` multiplies by 1000). */
    lastSync: 0,
    /** Whether the next poll is authorized. */
    authorized: false,
    userCode: options.userCode ?? DEFAULT_USER_CODE,
    deviceCode: options.deviceCode ?? DEFAULT_DEVICE_CODE,
    repos: (options.repos ?? DEFAULT_REPOS).map((repo) => ({ ...repo })),
    /** The WebDAV store: `{ name, lastModified }`. */
    liths: options.liths ?? [],
    /** Every `/api/...` request the page made, as `METHOD /path`. */
    asked: []
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://stub.invalid');
    const path = url.pathname;

    const send = (status, type, body) => {
      response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      response.end(body);
    };
    const json = (body, status = 200) => send(status, 'application/json', JSON.stringify(body));

    if (path.startsWith('/api/')) state.asked.push(`${request.method} ${path}`);

    if ((path === '/' || path === '/launcher.html') && request.method === 'GET') {
      send(200, 'text/html; charset=utf-8', html);
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

    // --- the backup CGI ------------------------------------------------------
    if (path === '/api/github/status') {
      json({ connected: state.connected, repo: state.repo, last_sync: state.lastSync });
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
      const entries = state.liths
        .map((lith) => propfindEntry(lith.name, lith.lastModified ?? new Date(0)))
        .join('');
      send(
        207,
        'application/xml; charset=utf-8',
        `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>/sync/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>${entries}</D:multistatus>`
      );
      return;
    }
    if (path.startsWith('/sync/') && request.method === 'PUT') {
      const name = decodeURIComponent(path.slice('/sync/'.length));
      const existing = state.liths.find((lith) => lith.name === name);
      if (existing) existing.lastModified = new Date();
      else state.liths.push({ name, lastModified: new Date() });
      send(201, 'text/plain; charset=utf-8', '');
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
    /** Put a Lith in the server's store, as an upload or a git pull would. */
    addLith(name, lastModified = new Date()) {
      state.liths.push({ name, lastModified });
    },
    close() {
      return new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      });
    }
  };
}
