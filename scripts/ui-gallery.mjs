/**
 * The launcher's UI gallery: every reviewable state, rendered and tiled.
 *
 * This photographs the launcher instead of measuring it. It loads the artifact
 * that ships (`src/launcher.html`, over `file://`, so no dev server and no
 * source-map drift), drives it into a named state, and writes one PNG per state.
 * Those PNGs are then tiled into a handful of contact sheets — a sheet being the
 * whole point: the states are only comparable side by side.
 *
 * A pane marked `server` is the exception to `file://`, and it has to be: a
 * self-hosted instance's backup flow is HTTP against its own origin, so it cannot
 * be reached from a page on disk at all. Those panes are shot through the stand-in
 * instance in `scripts/self-host-stub.mjs`, which serves this same artifact and
 * answers the CGI the deployment routes. The copy they draw is the launcher's, so
 * they belong on a sheet like any other.
 *
 * It is a *review* tool, not a test. It asserts exactly one thing per pane — that
 * the state it asked for actually appeared — so a sheet can never quietly show a
 * blank pane and call it a design. Everything else about the picture is for a
 * human to look at.
 *
 * Dialogs are the exception, because there are now enough of them to lose one. A pane
 * that photographs a dialog says which one (`modal:`), which makes the run a walk as
 * well as a contact sheet: the claim is checked against the DOM before the shot, and the
 * run ends with every `role="dialog"` in `launcher-ui/src/App.svelte` — read out of the
 * source, since a dialog only exists in the DOM while it is open — next to the panes that
 * draw it. One that no pane draws is reported, with the reason or without one, and the
 * report is written to `ui-gallery/modal-coverage.md`. It never fails a run: the report
 * is the point, and a missing picture is not a broken launcher.
 *
 *   npm run gallery                     # every sheet
 *   node scripts/ui-gallery.mjs vault        # only sheets whose id contains "vault"
 *   node scripts/ui-gallery.mjs --artifact=ui-gallery/.build/launcher.html
 *   GALLERY_HEADED=1 npm run gallery    # watch it happen
 *
 * Which build it shoots matters. By default that is `src/launcher.html` — the
 * artifact that actually ships — and this is the reason a sheet can be trusted.
 * But that file is CI-only (see agents.md), so between releases it lags the
 * source: a pane for a feature that has not been released yet will photo the old
 * build and fail its own `expect`. For UI in that state, build a scratch copy
 * (`node scripts/build-launcher.mjs ui-gallery/.build/launcher.html`) and point
 * `--artifact` at it. Pane names are the same either way, so the sheets stay
 * comparable; the artifact in use is printed and written into the contact page
 * so a sheet is never mistaken for the shipped build.
 *
 * Output lands in `ui-gallery/` (gitignored): `raw/` holds one PNG per state and
 * each sheet is a montage of its states, labelled with their names. Tiling needs
 * ImageMagick 7 (`magick`) — everything else is already a devDependency, because
 * the smoke test this borrows its environment from needs the same things.
 *
 * On the stand-in for Rust: the desktop app's states (the credential vault, the
 * per-instance keys) only render in `mode === 'tauri'`, so this page is given the
 * app's own global with a mock standing in for Rust — the same trick
 * `test-puppeteer-launcher.mjs` uses. What it returns is *Rust's own copy*: the
 * login verdicts in `LOGIN_DETAILS` below, and the PIN bands in
 * `scripts/vault-copy.mjs`, which the smoke test shares. That is deliberate: the
 * sentences are the thing this gallery exists to review, and a mock that invented
 * its own would produce a sheet full of text that ships nowhere.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';

import { SECRET_SENTENCES } from './vault-copy.mjs';

// The stand-in instance the `server` panes are shot through. Started in the entry
// point below, because it has to be listening before the first pane is driven; the
// panes reach it through `paneUrl` and through this handle.
import { startSelfHostStub } from './self-host-stub.mjs';

const run = promisify(execFile);

const artifactArg = process.argv.find((arg) => arg.startsWith('--artifact='));
const ARTIFACT = resolve(artifactArg ? artifactArg.slice('--artifact='.length) : (process.env.GALLERY_ARTIFACT ?? 'src/launcher.html'));
const OUT_DIR = resolve('ui-gallery');
const RAW_DIR = join(OUT_DIR, 'raw');

/** The stand-in instance the `server` panes are shot through; started below. */
let stub;

/**
 * Viewports are presets rather than numbers at each call site, because the width a
 * state is reviewed at is part of the state: the launcher has three layouts
 * (phone, the narrow breakpoint, and the wide one the footer leaves) and a pane
 * shot at the wrong one proves nothing.
 *
 * `deviceScaleFactor: 2` is so the text survives being tiled four-to-a-row on a
 * sheet somebody is looking at from a distance.
 */
const VIEW = {
  phone: { width: 390, height: 800, deviceScaleFactor: 2 },
  wide: { width: 1000, height: 820, deviceScaleFactor: 2 },
  // Tall enough that a dialog never hits its own `max-height: 80vh`, so a pane is
  // the whole dialog rather than a window onto a scrolled one.
  dialog: { width: 900, height: 1700, deviceScaleFactor: 2 }
};

/**
 * What an instance says about a login, copied verbatim from `classify_login` in
 * `src-tauri/src/lib.rs`. Kept in one place here so the sheet and the app cannot
 * disagree about what a verdict reads like.
 */
const LOGIN_DETAILS = {
  accepted: 'The instance asks for a password, and accepts this login.',
  refused: 'The instance refused this login (401).',
  'not-required': 'This instance answered without a password at all: it no longer asks for one.',
  unclear: 'The instance answered 200 with this login and 404 without it, which is not a verdict.',
  unreachable: 'Nothing answered at this address.'
};


/** Where the desktop app's vault file lives, for the `Stored in …` line. */
const VAULT_PATH = 'C:\\Users\\you\\AppData\\Local\\Lithic\\credentials.vault';

/** The PIN every fixture ends up typing. Six characters, the sixth being the submit. */
const PIN = 'L1TH1C';

// --- fixtures ---------------------------------------------------------------

/**
 * A recents row with no disk path. This is what a browser mount's row looks like —
 * a handle has a name and nothing else — and it is *not* a fallback row, which is
 * the distinction the yellow mark exists to draw.
 */
const handleRow = (name) => ({ handle: { name }, tauriPath: null });

/**
 * The clock every fixture is stamped with, so a sheet's dates are comparable
 * between runs rather than being the moment it was shot. A version label is
 * rendered from `ts`, which makes a live `Date.now()` a one-line diff in every
 * PNG it touches.
 */
const SAVED_AT = Date.UTC(2026, 8, 20, 14, 32, 8);

/**
 * A recents row for the index-db fallback: no handle, no path, and marked. Every
 * row this mode can produce carries `browserOnly`, because in this mode nothing
 * was ever written to a file.
 */
const browserRow = (name) => ({ handle: null, tauriPath: null, name, browserOnly: true });

/**
 * A recents row with a path on disk: the desktop app's own shape, and the one a rebuild
 * can find missing. A row with no path is not something a folder was ever meant to hold,
 * so it can never be an orphan.
 */
const diskRow = (name, folder = 'C:\\liths') => ({ name, path: `${folder}\\${name}`, tauriPath: `${folder}\\${name}` });

/** A tiddler snapshot, so a cached Lith has searchable content without a mount. */
const cache = (tiddlers) => ({ text: JSON.stringify(tiddlers) });

/** One recorded version, which is what puts the history/download icon on a row. */
const history = (ts = SAVED_AT) => ({ headId: 'v1', versions: [{ id: 'v1', ts, sizeBytes: 120, isBase: true }] });

/**
 * Three recorded versions, oldest first: a full save, then the edits since it. Each
 * `sizeBytes` is the document's own size at that save, not the delta's — which is
 * what `saveVersion` records, and what makes the sizes comparable down the list.
 */
const versionChain = () => ({
  headId: 'v3',
  versions: [
    { id: 'v1', ts: SAVED_AT - 86_400_000, sizeBytes: 41_820, isBase: true },
    { id: 'v2', ts: SAVED_AT - 3_600_000, sizeBytes: 42_360 },
    { id: 'v3', ts: SAVED_AT, sizeBytes: 43_010 }
  ]
});

/**
 * A chain that re-anchored: the newest version is a full copy tagged `external`,
 * which is what the launcher records when the file on disk drifted from its own
 * HEAD — somebody else's change, taken as the new base.
 */
const driftedChain = () => ({
  headId: 'v2',
  versions: [
    { id: 'v1', ts: SAVED_AT - 86_400_000, sizeBytes: 41_820, isBase: true },
    { id: 'v2', ts: SAVED_AT - 600_000, sizeBytes: 38_400, isBase: true, external: true }
  ]
});

/**
 * One cached wiki, with the stamps a real cache carries.
 *
 * Shared by the two panes that photograph its search panel, because the whole point
 * of the pair is that the same entry answers differently for a body query and for the
 * note's own name. It is also the fixture behind the smoke test's stamp assertions:
 * between the name and the body it holds `archive` and `distinctive` but not `te`,
 * which is the token creaTE d and `text/vnd.tiddlywiki` used to match on.
 */
const cachedArchive = cache([{
  title: 'Archive Box',
  created: '20260816020116648',
  modified: '20260816020116648',
  type: 'text/vnd.tiddlywiki',
  text: 'distinctive local findings'
}]);

/** A 3x2 PNG, so a bookmark row can show a cached instance icon rather than nothing. */
const ICON =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFUlEQVR42mP8z8Dwn4GBgYGJgYGBHgAeCgIBAAAAAElFTkSuQmCC';

const bookmark = (url, extra = {}) => ({ url, label: url.replace(/^https?:\/\//, ''), ...extra });

/**
 * Three instances, which between them cover every state a key can be in: one the
 * vault holds a login for (green), one it does not (grey), and one that is for the
 * `refused` verdict rather than the `accepted` one — the two have to be different
 * addresses, because the verdict is the instance's, not the dialog's.
 *
 * `www.foobar.com` rather than a reserved `.example` host, because these fixtures are copy:
 * an address a dialog prints ("For www.foobar.com.") has to read as an address, and the
 * reserved name this one used to carry was read as the words "other example". Two of the
 * three share a domain on purpose, so the sheet shows that a login is
 * kept per exact address rather than per site. Neither name is ever fetched or navigated to
 * — every endpoint behind these dialogs is the stand-in — which is also why the unit tests,
 * whose strings nobody reads off a sheet, keep their reserved names.
 */
const BOOKMARKS = [
  bookmark('https://personal.lithic.uk', { icon: ICON }),
  bookmark('https://www.foobar.com'),
  bookmark('https://wiki.foobar.com')
];

// --- the stand-in for Rust --------------------------------------------------

/**
 * Install the app's global and a mock behind it. Must run before any navigation,
 * because the launcher reads `window.__TAURI__` while it boots.
 *
 * Written as one arrow with a single argument because Puppeteer serialises the
 * function itself — it cannot close over anything in this file.
 */
const installRust = (page, config) =>
  // The three verdict sentences arrive as data, because nothing in this file is in
  // scope inside a serialised mock. They are shared with the smoke test.
  page.evaluateOnNewDocument((cfg) => {
    // Every pane that runs in this mode passes a vault config; the fallbacks are here so
    // a pane that only wants the mock behind the app boots anyway, rather than the whole
    // global failing to install and the pane quietly rendering in the wrong mode.
    const entries = (cfg.entries ?? []).map((entry) => ({ ...entry }));
    // No `unlocked`: opening is not a state. Every command that needs the PIN takes it
    // as an argument, opens the vault for the length of that one call and drops it.
    const state = { exists: cfg.exists === true, granted: false, path: cfg.path ?? null };
    const normalise = (address) => {
      try {
        return new URL(address).origin;
      } catch {
        return address;
      }
    };
    const verdict = (origin) => {
      const outcome = cfg.verdicts?.[normalise(origin)] ?? cfg.verdicts?.[origin] ?? cfg.defaultVerdict ?? 'accepted';
      return { outcome, status: outcome === 'unreachable' ? 0 : 200, detail: cfg.details[outcome] };
    };
    const answer = async (command, args = {}) => {
      switch (command) {
        case 'credentials_status':
          return { ...state, count: entries.length };
        case 'credential_coverage':
          // Never needs a secret, which is the point: a row's key is coloured
          // before the PIN has been typed.
          return args.origins.filter((origin) => entries.some((entry) => entry.origin === normalise(origin)));
        case 'list_credentials':
          if (args.secret !== cfg.pin) throw new Error('That PIN does not open the vault.');
          return entries;
        case 'check_credentials_secret': {
          // Rust's rule and its arithmetic: the band comes from the alphabet the PIN
          // uses, and the sentence is that band's own — which is what colours the line.
          const pin = String(args.secret ?? '').toUpperCase();
          if (!/^[0-9A-Z]{6}$/.test(pin)) {
            return { ok: false, problem: 'A PIN is 6 letters or digits.', warning: null, band: null };
          }
          const band = /^[0-9]{6}$/.test(pin) ? 'weak' : /^[A-Z]{6}$/.test(pin) ? 'average' : 'strong';
          return { ok: true, problem: null, band, warning: cfg.secretSentences[band] };
        }
        case 'probe_instance':
          return { state: 'protected', status: 401 };
        case 'unlock_for_instance':
          if (args.secret !== cfg.pin) throw new Error('That PIN does not open the vault.');
          state.granted = true;
          return { origin: args.origin, user: entries[0]?.user ?? 'keeper' };
        case 'check_credential':
          // Authenticated too: the password has to be readable to send it, so the PIN
          // opens the vault for this one call rather than a manager holding it open.
          if (args.secret !== cfg.pin) throw new Error('That PIN does not open the vault.');
          return verdict(args.origin);
        case 'check_login_for_instance': {
          // A delay is how the in-flight state — "Checking…" — gets onto a sheet
          // at all: it only exists between the question and its answer.
          if (cfg.checkDelayMs) await new Promise((done) => setTimeout(done, cfg.checkDelayMs));
          return verdict(args.origin);
        }
        case 'remember_credentials': {
          // With a vault on disk the PIN has to be its own; with none, whatever is
          // typed here becomes the vault's — which is how first use creates one, and
          // why the create shape can save a PIN and a login in one dialog.
          if (state.exists && args.secret !== cfg.pin) throw new Error('That PIN does not open the vault.');
          state.exists = true;
          const origin = normalise(args.origin);
          entries.splice(0, entries.length, ...entries.filter((entry) => entry.origin !== origin), {
            origin,
            user: args.user
          });
          return entries;
        }
        case 'save_login_for_instance':
          state.granted = true;
          return { origin: normalise(args.origin), user: args.user };
        case 'lend_instance_credentials':
          // "Open without saving": the same grant an unlock leaves behind, built from
          // what was typed. No secret is asked for and nothing is written.
          state.granted = true;
          return { origin: normalise(args.origin), user: args.user };
        case 'forget_credentials':
          // Authenticated because it is a change, not because of what it would reveal.
          if (args.secret !== cfg.pin) throw new Error('That PIN does not open the vault.');
          entries.splice(0, entries.length, ...entries.filter((entry) => entry.origin !== normalise(args.origin)));
          return entries;
        case 'destroy_credentials':
          // Unauthenticated on purpose: this is the recovery path from a forgotten PIN.
          state.exists = false;
          entries.length = 0;
          return { ...state, count: 0 };
        case 'instance_cache_search':
          // What the app's own reader answers (`instance_search.rs`): one instance with a
          // cached wiki and one with none. The launcher's page can never read this for
          // itself — an instance is a different origin — which is why the app reads it.
          return args.origins.map((origin) => ({
            origin,
            truncated: false,
            caches: origin === 'https://personal.lithic.uk'
              ? [{ name: 'notes.lith', text: JSON.stringify([{ title: 'Archive Box', text: 'distinctive local findings' }]) }]
              : []
          }));
        case 'read_recents_sidecar':
          // The desktop app's recents are Rust's own sidecar rather than the browser store,
          // so a tauri fixture only becomes a row when it arrives this way. `null` is the
          // mock's answer everywhere this is not configured, which the app already treats
          // as "no sidecar".
          return cfg.sidecarRecents ?? null;
        case 'git_sync_coverage':
          // Folder path → the repository root that covers it. No fixture is inside a
          // repository, so the honest answer is an empty map — `null` would be a read
          // that failed, which is a different thing and one the app rightly trips over.
          return {};
        case 'list_folder_liths':
          // A fixture row's folder, listed flat. Empty is a real answer from Rust, and the
          // one that makes each row with a path an orphan — which is the state that puts
          // the modal on the sheet.
          return [];
        case 'lock_credentials':
          // Nothing is open to close: this only drops the grant a load left behind.
          state.granted = false;
          return { ...state, count: entries.length };
        default:
          // Everything else: no answer, which every caller already treats as
          // "absent". Recents sidecars and backup coverage land here.
          return null;
      }
    };
    // Let a test read back what was asked, from outside the page.
    window.__lithicVault = { calls: [] };
    window.__TAURI__ = {
      core: {
        invoke: (command, args) => {
          window.__lithicVault.calls.push({ command, args });
          try {
            return Promise.resolve(answer(command, args));
          } catch (error) {
            // A command that refuses has to reject the way Rust's does.
            return Promise.reject(error);
          }
        }
      },
      event: { listen: () => Promise.resolve(() => {}) }
    };
  }, { secretSentences: SECRET_SENTENCES, ...config });

// --- driving the page -------------------------------------------------------

const settle = (page, ms = 260) => page.evaluate((wait) => new Promise((done) => setTimeout(done, wait)), ms);

/**
 * Type a PIN the way it is meant to be entered: into the first box, by keyboard,
 * the sixth character being the submit. Driving the boxes one at a time would
 * photograph six inputs rather than the entry method.
 */
async function typePin(page, container, pin) {
  const boxes = await page.$$(`${container} .pin-box`);
  if (boxes.length !== 6) throw new Error(`${container} expected six PIN boxes, saw ${boxes.length}`);
  await boxes[0].click();
  await page.keyboard.type(pin);
}

/**
 * Click one of a dialog's action buttons, by its label.
 *
 * By label rather than by position because the same dialog offers different actions
 * in different states, and scoped to a dialog because a confirmation opened on top
 * of one repeats the word that opened it.
 */
async function clickAction(page, scope, label) {
  await page.evaluate((selector, text) => {
    const button = [...document.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);
    if (!button) throw new Error(`no ${selector} saying ${text}`);
    button.click();
  }, scope, label);
}

/**
 * Drive the self-host backup dialog to its repository picker, through the stand-in
 * instance: the device flow's first two steps, then the person at github.com typing
 * the code, which is the one part nothing can imitate from this side.
 *
 * Settled before it returns, so a pane photographs the picker rather than a spinner
 * over one.
 */
async function reachRepoPicker(page) {
  await page.click('.heading .sync-button');
  await page.waitForSelector('.git-sync-modal');
  await clickAction(page, '.git-sync-modal .modal-action', 'Connect to GitHub');
  await page.waitForSelector('.git-sync-modal .user-code-display');
  stub.authorize();
  await page.waitForSelector('.git-sync-modal .repo-card.create', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('.git-sync-modal .sync-progress') === null);
}

/** The vault manager opens from the bookmark dialog, which owns the same addresses. */
async function openVaultManager(page) {
  await page.click('.action-pair .bookmark-button');
  await page.waitForSelector('.vault-manager-button');
  await page.click('.vault-manager-button');
  await page.waitForSelector('.vault-modal');
}

/**
 * Press the key on one bookmark row.
 *
 * It is the only way a login is written, so a pane about writing one starts here: for
 * an address with nothing saved it opens the dialog below, and for one the vault holds
 * it opens the list instead. The address is the row's own either way.
 */
async function openRowKey(page, label) {
  await page.evaluate((text) => {
    const row = [...document.querySelectorAll('.bookmark-row')].find((node) => node.textContent.includes(text));
    if (!row) throw new Error(`no bookmark row for ${text}`);
    row.querySelector('.vault-row-button').click();
  }, label);
  await page.waitForSelector('.credential-offer-user');
  await settle(page, 260);
}

/** Type the one login the dialog describes, and let the instance answer. */
async function typeOfferedLogin(page, waitMs) {
  await page.type('.credential-offer-user', 'keeper');
  await page.type('.credential-offer-password', 's3cret');
  await settle(page, waitMs);
}

/** Open a bookmarked instance by its label, the way a cursor would. */
async function openBookmark(page, label) {
  await page.evaluate((text) => {
    const row = [...document.querySelectorAll('.bookmark-row')].find((node) => node.textContent.includes(text));
    if (!row) throw new Error(`no bookmark row for ${text}`);
    row.querySelector('.bookmark-name').click();
  }, label);
}

// --- the sheets -------------------------------------------------------------

/**
 * A pane is one state, photographed once.
 *
 *   name    the PNG's name, and so its label on the sheet. Numbered, because the
 *           numbering is the reading order.
 *   mode    'tauri' installs the stand-in for Rust and opens the desktop app;
 *           'self-host' and 'webapp' are what the artifact resolves to otherwise.
 *   seed    declarative fixtures, applied before the app reads anything.
 *   drive   what a person would do to get here.
 *   expect  the selector that proves the state arrived. If this never appears the
 *           pane fails loudly, so a sheet cannot show an empty pane silently.
 *   clip    crop to this element (plus `pad`) instead of the whole viewport, which
 *           is how the dialog panes stay comparable at a readable size.
 *   modal   the dialog this pane photographs, named by its `aria-labelledby` id — or its
 *           own `aria-label`, for the one entry that has no heading to point at. The
 *           walk asserts the dialog is in the DOM before the shot, and every claim is
 *           what the coverage report at the end of the run is built from.
 */
const SHEETS = [
  {
    id: 'launcher-phone',
    title: 'Launcher, phone',
    tile: '4x',
    panes: [
      {
        name: '010-webapp-empty',
        view: 'phone',
        expect: '.action-pair'
      },
      {
        name: '020-webapp-recents',
        view: 'phone',
        seed: {
          recents: [handleRow('notes.lith'), handleRow('ideas.lith'), handleRow('recipes.lith')],
          caches: { 'search_cache_notes.lith': cache([{ title: 'A', text: 'note text' }]) },
          meta: { 'search_cache_meta_notes.lith': history() }
        },
        expect: '.recent-row'
      },
      {
        name: '030-webapp-scrolling',
        view: 'phone',
        seed: { recents: Array.from({ length: 20 }, (_, index) => handleRow(`overflow-${index}.lith`)) },
        expect: '.recent-row'
      },
      {
        name: '040-fallback-marked',
        view: 'phone',
        storage: 'index-db',
        seed: {
          recents: [browserRow('fallback.lith'), browserRow('second.lith'), browserRow('third.lith')],
          caches: { 'search_cache_fallback.lith': cache([{ title: 'A', text: 'text' }]) },
          meta: { 'search_cache_meta_fallback.lith': history() }
        },
        expect: '.browser-only-button'
      },
      {
        name: '050-fallback-no-matches',
        view: 'phone',
        storage: 'index-db',
        seed: { recents: [browserRow('fallback.lith')] },
        drive: async (page) => {
          await page.type('input[aria-label="Search recent Liths"]', 'zzz');
          await settle(page, 400);
        },
        expect: '.recent-list .empty'
      },
      {
        name: '060-new-lith-entry',
        view: 'phone',
        modal: 'Enter a title',
        drive: async (page) => {
          await page.evaluate(() => {
            [...document.querySelectorAll('button')].find((node) => node.textContent.includes('New Blank Lith')).click();
          });
          await page.waitForSelector('.new-lith-inline');
        },
        expect: '.new-lith-inline'
      },
      {
        name: '070-new-lith-taken',
        view: 'phone',
        modal: 'Enter a title',
        seed: { recents: [handleRow('notes.lith')] },
        drive: async (page) => {
          await page.evaluate(() => {
            [...document.querySelectorAll('button')].find((node) => node.textContent.includes('New Blank Lith')).click();
          });
          await page.waitForSelector('.new-lith-inline');
          await page.type('input[aria-label="Lith file name"]', 'notes.lith');
          await settle(page, 300);
        },
        expect: '.new-lith-warn'
      }
    ]
  },
  {
    id: 'launcher-desktop',
    title: 'Launcher, desktop',
    tile: '3x',
    panes: [
      {
        name: '210-webapp-empty',
        view: 'wide',
        expect: '.action-pair'
      },
      {
        name: '220-webapp-recents',
        view: 'wide',
        seed: {
          recents: [handleRow('notes.lith'), handleRow('ideas.lith')],
          caches: { 'search_cache_notes.lith': cache([{ title: 'A', text: 'note text' }]) },
          meta: { 'search_cache_meta_notes.lith': history(), 'search_cache_meta_ideas.lith': history() }
        },
        expect: '.history-download-icon'
      },
      {
        name: '230-webapp-cached-search',
        view: 'wide',
        seed: {
          recents: [handleRow('notes.lith')],
          caches: {
            'search_cache_archive.lith': cachedArchive
          }
        },
        drive: async (page) => {
          await page.type('input[aria-label="Search recent Liths"]', 'distinctive');
          await settle(page, 500);
        },
        expect: '.cache-preview'
      },
      {
        // The same cache, asked for by the note's name: the title is content, so it
        // matches, and its mark is the install button's blue rather than the amber
        // the body context uses. The stamps are the same fixture's `created`,
        // `modified` and `type`, none of which is searchable surface.
        name: '231-webapp-title-match',
        view: 'wide',
        seed: {
          recents: [handleRow('notes.lith')],
          caches: {
            'search_cache_archive.lith': cachedArchive
          }
        },
        drive: async (page) => {
          await page.type('input[aria-label="Search recent Liths"]', 'Archive');
          await settle(page, 500);
        },
        expect: '.cache-preview-title-mark'
      },
      {
        name: '240-fallback-marked',
        view: 'wide',
        storage: 'index-db',
        seed: {
          recents: [browserRow('fallback.lith'), browserRow('second.lith')],
          caches: { 'search_cache_fallback.lith': cache([{ title: 'A', text: 'text' }]) },
          meta: { 'search_cache_meta_fallback.lith': history() }
        },
        expect: '.browser-only-button'
      },
      {
        // Honest about what this is: no server is reachable over `file://`, so this
        // is the self-host *chrome* — no bookmark tile, the mark as a live control,
        // the list's empty state — not a populated instance.
        name: '250-self-host-chrome',
        view: 'wide',
        mode: 'self-host',
        expect: '.recent-section'
      },
      {
        name: '260-tauri-bookmark-keys',
        view: 'wide',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }]
        },
        drive: async (page) => {
          await page.waitForSelector('.bookmark-row .vault-row-button');
          await settle(page, 300);
        },
        expect: '.vault-row-button'
      },
      {
        // A hit from another instance's own cache, standing beside the bookmark row that
        // leads to it: the same panel, in the same place, with the same marked preview a
        // match inside one of this device's own Liths gets. One hit per instance is the
        // whole of it — this search orients, and the instance's own launcher is where the
        // rest of the matches are read.
        name: '261-instance-hit-search',
        view: 'wide',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }]
        },
        drive: async (page) => {
          await page.type('input[aria-label="Search recent Liths"]', 'Archive');
          await settle(page, 600);
        },
        expect: '.bookmark-row .cache-preview mark.cache-preview-title-mark'
      }
    ]
  },
  {
    // The per-wiki version history, which is a Lith's own business rather than an
    // instance's: what the launcher recorded of *this* document, newest first, and the
    // only way back to any of it.
    id: 'history',
    title: 'Version history — the chain, its badges, and the only way back',
    tile: '3x',
    panes: [
      {
        // A full save and the edits recorded after it. The badges are the whole of the
        // explanation: the newest entry is what the row opened, and the rest are steps
        // off it.
        name: '610-chain-full-and-steps',
        view: 'wide',
        modal: 'history-title',
        seed: {
          recents: [handleRow('notes.lith')],
          caches: { 'search_cache_notes.lith': cache([{ title: 'A', text: 'note text' }]) },
          meta: { 'search_cache_meta_notes.lith': versionChain() }
        },
        drive: async (page) => {
          await page.click('.cache-history-button');
          await page.waitForSelector('.history-list li');
          await settle(page, 300);
        },
        clip: '.history-modal',
        expect: '.history-badge.delta'
      },
      {
        // Saved after a change that came from outside this device, so the launcher
        // re-anchored its chain at what it found rather than diffing against a stale
        // HEAD. The only badge that means somebody else wrote this.
        name: '620-after-a-sync',
        view: 'wide',
        modal: 'history-title',
        seed: {
          recents: [handleRow('notes.lith')],
          caches: { 'search_cache_notes.lith': cache([{ title: 'A', text: 'note text' }]) },
          meta: { 'search_cache_meta_notes.lith': driftedChain() }
        },
        drive: async (page) => {
          await page.click('.cache-history-button');
          await page.waitForSelector('.history-badge.sync');
          await settle(page, 300);
        },
        clip: '.history-modal',
        expect: '.history-badge.sync'
      },
      {
        // A wiki with unsaved edits: the same control, marked, because opening it is
        // the recovery the history holds — and the reason the row is worth clicking at
        // all before the file is opened.
        name: '630-unsaved-edits-mark',
        view: 'wide',
        seed: {
          recents: [handleRow('notes.lith'), handleRow('ideas.lith')],
          caches: { 'search_cache_notes.lith': cache([{ title: 'A', text: 'note text' }]) },
          meta: {
            'search_cache_meta_notes.lith': versionChain(),
            'dirty_state_notes.lith': { ts: SAVED_AT, tiddlers: [{ title: 'A', text: 'unsaved' }] }
          }
        },
        expect: '.cache-history-button.dirty'
      },
      {
        // The mark on a browser-only row opens this same dialog, and this is where a
        // touch screen reads the claim the mark can only carry as a title. One pane per
        // way in, because the two rows look nothing alike.
        name: '640-fallback-note',
        view: 'wide',
        modal: 'history-title',
        storage: 'index-db',
        seed: {
          recents: [browserRow('fallback.lith'), browserRow('second.lith')],
          caches: { 'search_cache_fallback.lith': cache([{ title: 'A', text: 'text' }]) },
          meta: { 'search_cache_meta_fallback.lith': versionChain() }
        },
        drive: async (page) => {
          await page.click('.browser-only-button');
          await page.waitForSelector('.browser-only-history-note');
          await settle(page, 300);
        },
        clip: '.history-modal',
        expect: '.browser-only-history-note'
      }
    ]
  },
  {
    id: 'vault-closed',
    title: 'Saved Instance Logins — the manager, before the PIN',
    tile: '2x',
    panes: [
      {
        // No vault at all. There is nothing to open and nothing to write here: a login
        // is saved for an instance you are already pointing at, so this says what the
        // dialog is for in one line rather than offering a form that would take any
        // address at all — and the key on the row that writes one says the rest.
        name: '310-no-vault-pointer',
        view: 'dialog',
        modal: 'vault-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: { exists: false, pin: PIN, entries: [], path: VAULT_PATH },
        drive: openVaultManager,
        clip: '.vault-modal',
        expect: '.vault-sub'
      },
      {
        name: '320-one-saved-before-the-pin',
        view: 'dialog',
        modal: 'vault-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
          path: VAULT_PATH
        },
        drive: openVaultManager,
        clip: '.vault-modal',
        expect: '.vault-count'
      },
      {
        name: '330-wrong-pin',
        view: 'dialog',
        modal: 'vault-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
          path: VAULT_PATH
        },
        drive: async (page) => {
          await openVaultManager(page);
          await typePin(page, '.vault-unlock-pin', 'ZZZZZZ');
          await settle(page, 400);
        },
        clip: '.vault-modal',
        expect: '.status-line.error'
      },
      {
        // The PIN's own toggle, riding in the label row of the field it reveals — the
        // only check a PIN typed once, at a dialog whose business is opening, ever gets.
        name: '340-pin-reveal-toggle',
        view: 'dialog',
        modal: 'vault-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
          path: VAULT_PATH
        },
        drive: async (page) => {
          await openVaultManager(page);
          await typePin(page, '.vault-unlock-pin', '1TH1C');
          await page.evaluate(() => document.querySelector('.vault-unlock-pin .vault-reveal input').click());
          await settle(page, 300);
        },
        clip: '.vault-modal',
        expect: '.vault-unlock-pin .vault-reveal input:checked'
      }
    ]
  },
  {
    id: 'vault-open',
    title: 'Saved Instance Logins — the list, and the dialog that writes one',
    tile: '4x',
    panes: [
      {
        name: '410-two-logins',
        view: 'dialog',
        modal: 'vault-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [
            { origin: 'https://personal.lithic.uk', user: 'keeper' },
            { origin: 'https://www.foobar.com', user: 'keeper' }
          ],
          path: VAULT_PATH
        },
        drive: async (page) => {
          await openVaultManager(page);
          await typePin(page, '.vault-unlock-pin', PIN);
          await settle(page, 500);
        },
        clip: '.vault-modal',
        expect: '.vault-list li'
      },
      {
        name: '420-per-row-verdicts',
        view: 'dialog',
        modal: 'vault-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [
            { origin: 'https://personal.lithic.uk', user: 'keeper' },
            { origin: 'https://www.foobar.com', user: 'keeper' }
          ],
          path: VAULT_PATH,
          verdicts: { 'https://personal.lithic.uk': 'accepted', 'https://www.foobar.com': 'refused' },
          details: LOGIN_DETAILS
        },
        drive: async (page) => {
          await openVaultManager(page);
          await typePin(page, '.vault-unlock-pin', PIN);
          await settle(page, 500);
          await page.evaluate(() => {
            for (const button of document.querySelectorAll('.vault-list .vault-test')) button.click();
          });
          await settle(page, 500);
        },
        clip: '.vault-modal',
        expect: '.vault-check.refused'
      },
      {
        // A row's key, for an address nothing is saved for: the address arrives with
        // the row, so there is no field anywhere that would accept any other one. The
        // instance is asked about what is typed here, which is the only thing that can
        // tell a mistyped password from a correct one.
        name: '430-row-key-refused',
        view: 'dialog',
        modal: 'credential-offer-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
          path: VAULT_PATH,
          verdicts: { 'https://www.foobar.com': 'refused' },
          details: LOGIN_DETAILS
        },
        drive: async (page) => {
          await openRowKey(page, 'www.foobar.com');
          await typeOfferedLogin(page, 1200);
        },
        clip: '.vault-modal',
        expect: '.vault-check-line.refused'
      },
      {
        name: '440-row-key-accepted',
        view: 'dialog',
        modal: 'credential-offer-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
          path: VAULT_PATH,
          verdicts: { 'https://wiki.foobar.com': 'accepted' },
          details: LOGIN_DETAILS
        },
        drive: async (page) => {
          await openRowKey(page, 'wiki.foobar.com');
          await typeOfferedLogin(page, 1200);
        },
        clip: '.vault-modal',
        expect: '.vault-check-line.accepted'
      },
      {
        // The one state that only exists between the question and its answer.
        name: '450-row-key-checking',
        view: 'dialog',
        modal: 'credential-offer-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
          path: VAULT_PATH,
          verdicts: { 'https://wiki.foobar.com': 'accepted' },
          details: LOGIN_DETAILS,
          checkDelayMs: 20000
        },
        drive: async (page) => {
          await openRowKey(page, 'wiki.foobar.com');
          await typeOfferedLogin(page, 900);
        },
        clip: '.vault-modal',
        expect: '.vault-check-line.busy'
      },
      {
        // The recovery path, and now the only way the PIN changes: destroying the vault
        // is what a forgotten PIN costs, so it is asked about rather than done. It is
        // also the one control that takes no PIN, which is exactly why it needs asking.
        name: '460-forget-confirm',
        view: 'dialog',
        modal: 'confirm-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
          path: VAULT_PATH
        },
        drive: async (page) => {
          await openVaultManager(page);
          await typePin(page, '.vault-unlock-pin', PIN);
          await settle(page, 500);
          await page.evaluate(() =>
            [...document.querySelectorAll('.vault-modal .modal-action')]
              .find((node) => node.textContent.includes('Forget Everything'))
              .click()
          );
          await page.waitForSelector('.confirm-modal');
          await settle(page, 300);
        },
        clip: '.confirm-modal',
        expect: '.confirm-modal'
      },
      {
        // The shape before anything is typed: the offer an instance made while it was
        // opening, with both answers — and no PIN, because half of them write nothing.
        name: '470-offer-before-typing',
        view: 'dialog',
        modal: 'credential-offer-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
          path: VAULT_PATH,
          details: LOGIN_DETAILS
        },
        drive: async (page) => {
          await openBookmark(page, 'www.foobar.com');
          await page.waitForSelector('#credential-offer-title');
          await settle(page, 300);
        },
        clip: '.vault-modal',
        expect: '.credential-offer-pin'
      },
      {
        name: '480-offer-refused',
        view: 'dialog',
        modal: 'credential-offer-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
          path: VAULT_PATH,
          verdicts: { 'https://www.foobar.com': 'refused' },
          details: LOGIN_DETAILS
        },
        drive: async (page) => {
          await openBookmark(page, 'www.foobar.com');
          await page.waitForSelector('#credential-offer-title');
          await page.type('.credential-offer-user', 'keeper');
          await page.type('.credential-offer-password', 's3cret');
          await settle(page, 1200);
        },
        clip: '.vault-modal',
        expect: '.vault-check-line.refused'
      },
      {
        // First run, and the only place a PIN is chosen: the dialog that writes the first
        // login is the one that gets the vault's secret, so there is no separate setup.
        name: '490-offer-first-run',
        view: 'dialog',
        modal: 'credential-offer-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: { exists: false, pin: PIN, entries: [], path: VAULT_PATH, details: LOGIN_DETAILS },
        drive: async (page) => {
          await openBookmark(page, 'www.foobar.com');
          await page.waitForSelector('#credential-offer-title');
          await settle(page, 300);
        },
        clip: '.vault-modal',
        expect: '.credential-offer-pin-confirm'
      },
      {
        // The three bands, and why a word is shown at all rather than only when
        // something is wrong: each alphabet costs its own number, and that number is the
        // word's tooltip. Digits, then letters, then both.
        name: '500-first-run-weak',
        view: 'dialog',
        modal: 'credential-offer-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: { exists: false, pin: PIN, entries: [], path: VAULT_PATH, details: LOGIN_DETAILS },
        drive: async (page) => {
          await openBookmark(page, 'www.foobar.com');
          await page.waitForSelector('#credential-offer-title');
          await typePin(page, '.credential-offer-pin', '123456');
          await settle(page, 400);
        },
        clip: '.vault-modal',
        expect: '.vault-band.weak'
      },
      {
        name: '510-first-run-average',
        view: 'dialog',
        modal: 'credential-offer-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: { exists: false, pin: PIN, entries: [], path: VAULT_PATH, details: LOGIN_DETAILS },
        drive: async (page) => {
          await openBookmark(page, 'www.foobar.com');
          await page.waitForSelector('#credential-offer-title');
          await typePin(page, '.credential-offer-pin', 'LITHIC');
          await settle(page, 400);
        },
        clip: '.vault-modal',
        expect: '.vault-band.average'
      },
      {
        name: '520-first-run-strong',
        view: 'dialog',
        modal: 'credential-offer-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: { exists: false, pin: PIN, entries: [], path: VAULT_PATH, details: LOGIN_DETAILS },
        drive: async (page) => {
          await openBookmark(page, 'www.foobar.com');
          await page.waitForSelector('#credential-offer-title');
          await typePin(page, '.credential-offer-pin', PIN);
          await settle(page, 400);
        },
        clip: '.vault-modal',
        expect: '.vault-band.strong'
      }
    ]
  },
  {
    // Everything the other four sheets do not reach. These are the dialogs met on the way
    // to something else — bookmarking a server, naming this instance's icon, recovering
    // edits that never reached a file, being told a Lith has gone missing, pointing the
    // folder at GitHub — and only the history and vault sheets had any of them.
    id: 'modals',
    title: 'The rest of the dialogs — bookmarking, the icon, unsaved edits, orphans, sync',
    tile: '4x',
    panes: [
      {
        // How a server gets into the list at all, and the only dialog that owns the same
        // thing the vault manager does: an address.
        name: '710-add-bookmark',
        view: 'dialog',
        modal: 'bookmark-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
          path: VAULT_PATH
        },
        drive: async (page) => {
          await page.click('.action-pair .bookmark-button');
          await page.waitForSelector('.bookmark-modal');
          await settle(page, 300);
        },
        clip: '.bookmark-modal',
        expect: '.bookmark-modal'
      },
      {
        // The one refusal this dialog can raise without a server to ask, and so the one
        // error state of it a sheet can show: the address is not an HTTP address at all.
        name: '720-add-bookmark-not-http',
        view: 'dialog',
        modal: 'bookmark-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: { exists: true, pin: PIN, entries: [], path: VAULT_PATH },
        drive: async (page) => {
          await page.click('.action-pair .bookmark-button');
          await page.waitForSelector('.bookmark-modal');
          await page.type('input[aria-label="Self-hosted instance URL"]', 'ftp://foobar.com');

          await page.evaluate(() =>
            [...document.querySelectorAll('.bookmark-modal .modal-action')]
              .find((node) => node.textContent.includes('Save Bookmark'))
              .click()
          );
          await settle(page, 400);
        },
        clip: '.bookmark-modal',
        expect: '.bookmark-modal .status-line.error'
      },
      {
        // The per-instance prompt, which is a different dialog from the manager's PIN:
        // this one is about one address, it is asked on every load of that instance, and
        // it carries no list, no Forget Everything and no way past it.
        name: '730-instance-unlock',
        view: 'dialog',
        modal: 'instance-unlock-title',
        mode: 'tauri',
        seed: { bookmarks: BOOKMARKS },
        rust: {
          exists: true,
          pin: PIN,
          entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
          path: VAULT_PATH
        },
        drive: async (page) => {
          await openBookmark(page, 'personal.lithic.uk');
          await page.waitForSelector('.instance-unlock-pin');
          await settle(page, 300);
        },
        clip: '.vault-modal',
        expect: '.instance-unlock-pin'
      },
      {
        // The icon this deployment is known by — the only dialog in the launcher that
        // exists for one mode.
        name: '740-instance-icon',
        view: 'dialog',
        modal: 'emoji-title',
        mode: 'self-host',
        drive: async (page) => {
          await page.click('.brand-icon-wrap.pickable');
          await page.waitForSelector('.emoji-modal');
          await settle(page, 300);
        },
        clip: '.emoji-modal',
        expect: '.emoji-grid'
      },
      {
        // The same backup dialog the desktop app has, opened on a server. Photographed
        // over `file://`, so the instance cannot be asked anything and this is the state
        // that proves it: the server's copy, and the one line about the instance not
        // answering. The two lines the desktop dialog owns (`Folder`, and the order to
        // save a Lith to disk first) are deliberately absent. The other two halves of
        // this dialog — the picker and the connected view — are the `server` panes below,
        // which need an instance that answers.
        name: '745-instance-github-sync',
        view: 'dialog',
        modal: 'gitsync-title',
        mode: 'self-host',
        drive: async (page) => {
          await page.click('.heading .sync-button');
          await page.waitForSelector('.git-sync-modal');
          await settle(page, 300);
        },
        clip: '.git-sync-modal',
        expect: '.git-sync-modal .modal-action'
      },
      {
        // The picker, which is the one state of this dialog that is a decision rather
        // than a step: the repositories the instance can see, split into the ones Lithic
        // made and the rest, with a fresh one offered above both. Shot through the
        // stand-in instance, because over `file://` there is nothing on the other end to
        // list — which is why this state had no picture before it.
        name: '746-instance-github-sync-repos',
        view: 'dialog',
        modal: 'gitsync-title',
        mode: 'self-host',
        server: true,
        drive: (page) => reachRepoPicker(page),
        clip: '.git-sync-modal',
        expect: '.git-sync-modal .repo-card'
      },
      {
        // A backed-up instance, settled: the repository it is on, when it last synced
        // by its own clock, and the one thing a connected instance can be told, which is
        // to stop. Pointing it at another repository is that, then connecting again.
        name: '747-instance-github-sync-connected',
        view: 'dialog',
        modal: 'gitsync-title',
        mode: 'self-host',
        server: true,
        drive: async (page) => {
          await reachRepoPicker(page);
          await clickAction(page, '.git-sync-modal .modal-action', 'Start Sync');
          await page.waitForFunction(() =>
            document.querySelector('.git-sync-modal .sync-progress') === null &&
            [...document.querySelectorAll('.git-sync-modal .modal-action')]
              .some((node) => node.textContent.trim() === 'Disconnect')
          );
        },
        clip: '.git-sync-modal',
        expect: '.git-sync-modal .modal-action'
      },
      {
        // Edits the launcher captured and never saw saved. Reachable here because a
        // browser-storage Lith mounts from its own cached copy — the same mount path a
        // file takes — so the recovery gate runs, and this is what it asks.
        name: '750-unsaved-edits',
        view: 'dialog',
        modal: 'dirty-title',
        storage: 'index-db',
        seed: {
          recents: [browserRow('notes.lith')],
          caches: { 'search_cache_notes.lith': cache([{ title: 'A', text: 'note text' }]) },
          meta: {
            'dirty_state_notes.lith': {
              ts: SAVED_AT,
              tiddlers: Array.from({ length: 10 }, (_, index) => ({
                title: `Scratch ${index + 1}`,
                text: `edit ${index + 1}`
              }))
            }
          }
        },
        drive: async (page) => {
          await page.click('.recent-row .recent-name');
          await page.waitForSelector('.dirty-modal');
          await settle(page, 300);
        },
        clip: '.dirty-modal',
        expect: '.dirty-tiddler-list li'
      },
      {
        // Backing the folder up to GitHub. The token path is opened in the pane on
        // purpose: a closed `<details>` hides half of what this dialog offers, and what a
        // review needs to see is everything it can ask for.
        name: '770-github-sync',
        view: 'dialog',
        modal: 'gitsync-title',
        mode: 'tauri',
        rust: { exists: false, pin: PIN, entries: [], path: VAULT_PATH },
        seed: { recents: [diskRow('notes.lith')] },
        drive: async (page) => {
          await page.click('.sync-button');
          await page.waitForSelector('.git-sync-modal');
          await page.evaluate(() => document.querySelector('.git-sync-modal .git-sync-advanced summary').click());
          await settle(page, 300);
        },
        clip: '.git-sync-modal',
        expect: '.git-sync-advanced'
      }
    ]
  }
];

// --- running a pane ---------------------------------------------------------

/** Write the fixtures a pane declares, then reload so the app reads them. */
async function applySeed(page, seed) {
  if (seed.bookmarks) {
    await page.evaluate((entries) => {
      localStorage.setItem('bookmarkedInstances', JSON.stringify(entries));
    }, seed.bookmarks);
  }
  // Keys are the store's own: `recentFiles` for the rows, `search_cache_<name>` for a
  // Lith's cached content and `search_cache_meta_<name>` for its recorded versions.
  const writes = { ...(seed.recents ? { recentFiles: seed.recents } : {}), ...(seed.caches ?? {}), ...(seed.meta ?? {}) };
  if (Object.keys(writes).length > 0) {
    await page.evaluate(async (entries) => {
      const request = indexedDB.open('keyval-store', 1);
      await new Promise((ok, fail) => {
        request.onerror = () => fail(request.error);
        request.onsuccess = () => ok();
      });
      const db = request.result;
      await new Promise((ok, fail) => {
        const tx = db.transaction('keyval', 'readwrite');
        for (const [key, value] of Object.entries(entries)) tx.objectStore('keyval').put(value, key);
        tx.oncomplete = ok;
        tx.onerror = () => fail(tx.error);
      });
      db.close();
    }, writes);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
}

/**
 * The pane's URL: the artifact, with whatever the state needs said in the query.
 *
 * From disk, except for a `server` pane — which is served by the stand-in instance
 * on a loopback origin, because a same-origin `/api/github/*` is the only way the
 * backup dialog's live states exist at all.
 */
function paneUrl(pane) {
  const params = [];
  if (pane.mode) params.push(`mode=${pane.mode}`);
  if (pane.storage) params.push(`storage=${pane.storage}`);
  const base = pane.server ? `${stub.origin}/launcher.html` : `file://${ARTIFACT}`;
  return `${base}${params.length ? `?${params.join('&')}` : ''}`;
}

/** Crop to the pane's element, if it asked for one, expanded by a little air. */
async function clipFor(page, pane, view) {
  if (!pane.clip) return undefined;
  const box = await page.$eval(pane.clip, (node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  const pad = pane.pad ?? 20;
  const x = Math.max(0, Math.floor(box.x - pad));
  const y = Math.max(0, Math.floor(box.y - pad));
  const clip = {
    x,
    y,
    width: Math.min(view.width - x, Math.ceil(box.width + pad * 2)),
    height: Math.min(view.height - y, Math.ceil(box.height + pad * 2))
  };
  if (box.height + pad * 2 > view.height) {
    console.warn(`  ! ${pane.name}: the element is taller than the viewport, so this pane is cropped`);
  }
  return clip;
}

/** Photograph one pane. Throws with the pane's name if its state never arrived. */
async function runPane(browser, pane) {
  const view = VIEW[pane.view ?? 'phone'];
  const errors = [];
  const noise = (text) =>
    text.includes('Failed to load resource') ||
    text.includes('ERR_FILE_NOT_FOUND') ||
    text.includes('ERR_FAILED') ||
    (text.includes('Access to manifest') && text.includes('CORS policy'));
  const context = await browser.createBrowserContext();
  try {
    const page = await context.newPage();
    page.on('pageerror', (error) => {
      if (!noise(error.message)) errors.push(error.message);
    });
    page.on('console', (message) => {
      if (message.type() === 'error' && !noise(message.text())) errors.push(message.text());
    });
    await page.setViewport(view);
    if (pane.mode === 'tauri') {
      await installRust(page, { details: LOGIN_DETAILS, ...pane.rust });
    }
    await page.goto(paneUrl(pane), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main.container', { timeout: 10000 });
    if (pane.seed) await applySeed(page, pane.seed);
    await settle(page);
    if (pane.drive) await pane.drive(page);
    const clip = await clipFor(page, pane, view);
    try {
      await page.waitForSelector(pane.expect, { timeout: 8000 });
    } catch (error) {
      // A pane that never reached its state is still worth looking at: what
      // rendered instead is usually the answer, and the commands the page asked
      // for are the other half of it. Both are kept, then the pane fails.
      await page.screenshot({
        path: join(RAW_DIR, `${pane.name}-unreached.png`),
        clip,
        captureBeyondViewport: false
      });
      const asked = await page.evaluate(() =>
        (window.__lithicVault?.calls ?? []).map((call) => call.command).join(', ')
      );
      throw new Error(
        `${error.message.split('\n')[0]}\n      saw: ${await page.evaluate(() =>
        [...document.querySelectorAll('.vault-check-line, .vault-check')]
          .map((node) => `${node.className}: ${node.textContent.trim()}`)
          .join(' | ') || 'no verdict element at all'
      )}\n      asked Rust for: ${asked || 'nothing'}\n      console: ${errors.join(' | ') || 'clean'}`
      );
    }
    // The walk, for a pane that claims a dialog: reaching the state asked for is not the
    // same as reaching the dialog, and a claim nobody checks is a claim that drifts. Read
    // from the DOM rather than inferred from `expect`, because `expect` is a fragment of
    // the state and this is the thing the coverage report counts.
    if (pane.modal) {
      const mounted = await page.evaluate((name) => {
        if (document.querySelector(`[aria-labelledby="${name}"]`)) return true;
        return [...document.querySelectorAll('[aria-label]')].some(
          (node) => node.getAttribute('aria-label') === name
        );
      }, pane.modal);
      if (!mounted) throw new Error(`this state arrived without the "${pane.modal}" dialog in it`);
    }
    // The words as they render, which the PNG cannot be searched and a copy
    // review should not have to squint at. Read from the same element the pane is
    // cropped to, so the deck and the picture describe the same thing.
    const text = await page.evaluate((selector) => {
      const node = selector ? document.querySelector(selector) : document.body;
      return (node?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
    }, pane.clip ?? null);
    await page.screenshot({
      path: join(RAW_DIR, `${pane.name}.png`),
      clip,
      captureBeyondViewport: false
    });
    return { pane, errors, text };
  } finally {
    await context.close();
  }
}

// --- dialog coverage --------------------------------------------------------

/**
 * Dialogs no pane draws, and why not.
 *
 * Every entry is a deliberate gap, and each is a fact about the launcher rather than
 * about the gallery: the dialog exists and is reachable, just not from anything this
 * harness can drive. A dialog in neither a pane nor this map is reported as a gap nobody
 * explained — which is what makes a modal added to the launcher turn up in the report the
 * next time the gallery runs, instead of going unnoticed until somebody remembers it
 * should be on a sheet.
 */
const UNPHOTOGRAPHED = {
  'collision-title':
    'needs a second writer on a live server: it appears only when somebody else holds the lock on a remote Lith, and there is no server under `file://`.',
  'orphan-title':
    'is gated behind a rebuild scan, and the scan reads the world it is about: on disk a folder listing from Rust, on a server the file list. A fixture has neither — seeding the caches the scan then looks for does not produce an orphan, because the scan never gets that far — so this dialog is reachable by hand and not by this harness. A pane for it means teaching the mock to answer the listing, not seeding a state.'
};

/**
 * Every dialog the launcher declares, read out of `App.svelte`.
 *
 * The source is the only complete list: a dialog is in the DOM only while it is open, so
 * nothing at runtime can enumerate them, and a check that asked a page would see exactly
 * the dialogs the panes had already opened.
 *
 * A dialog is named by its `aria-labelledby` id — or, for the one inline entry that has no
 * heading to point at, its own `aria-label`. Either way the name is what a pane's `modal`
 * claim has to say, which is what makes the two halves of this comparable.
 */
async function dialogsInSource() {
  const source = await readFile(resolve('launcher-ui/src/App.svelte'), 'utf8');
  const found = new Map();
  source.split('\n').forEach((line, index) => {
    if (!line.includes('role="dialog"')) return;
    const named = /aria-labelledby="([^"]+)"/.exec(line) ?? /aria-label="([^"]+)"/.exec(line);
    if (named && !found.has(named[1])) found.set(named[1], index + 1);
  });
  return found;
}

/** Who draws what, and what nothing draws. */
function dialogCoverage(dialogs, drawn) {
  const entries = [...dialogs].map(([id, line]) => {
    const panes = drawn.get(id) ?? [];
    return panes.length > 0 ? { id, panes } : { id, panes, gap: UNPHOTOGRAPHED[id] ?? null, line };
  });
  // The other half of the same mistake: a claim for a dialog the source no longer
  // declares, which is a pane photographing something that has been renamed or removed.
  const stale = [...drawn]
    .filter(([id]) => !dialogs.has(id))
    .map(([id, panes]) => ({ id, panes }));
  const unexplained = entries.filter((entry) => entry.panes.length === 0 && !entry.gap).map((entry) => entry.id);
  const width = entries.filter((entry) => entry.panes.length > 0).length;
  const lines = [
    '# Dialog coverage',
    '',
    `${dialogs.size} dialogs in \`launcher-ui/src/App.svelte\`, and the pane that draws each.`,
    'Written by `npm run gallery`, where the walk is the sheet: a pane that claims a',
    'dialog has to find it in the DOM before it takes its picture.',
    ''
  ];
  for (const entry of entries) {
    if (entry.panes.length > 0) lines.push(`- \`${entry.id}\` — ${entry.panes.join(', ')}`);
    else if (entry.gap) lines.push(`- \`${entry.id}\` — no pane: ${entry.gap}`);
    else lines.push(`- \`${entry.id}\` (App.svelte:${entry.line}) — **no pane, and no reason given**`);
  }
  for (const entry of stale) {
    lines.push(`- \`${entry.id}\` — claimed by ${entry.panes.join(', ')}, but no such dialog in the source`);
  }
  lines.push('', `${width} of ${dialogs.size} drawn by a pane.`);
  const gaps = entries.filter((entry) => entry.gap).length;
  return { text: `${lines.join('\n')}\n`, entries, stale, unexplained, gaps, drawn: width, total: dialogs.size };
}

// --- tiling -----------------------------------------------------------------

/**
 * Tile one sheet. Labels are attempted first and dropped if ImageMagick has no
 * font it can draw with — a sheet without names is still worth looking at, and a
 * hard failure here would throw away the whole run.
 */
async function montage(sheet, files) {
  const out = join(OUT_DIR, `sheet-${sheet.id}.png`);
  const base = ['montage', '-background', '#121212', '-tile', sheet.tile, '-geometry', '+14+14'];
  const labelled = ['-label', '%t', '-pointsize', '15', '-fill', '#cfc7bb'];
  try {
    await run('magick', [...base, ...labelled, ...files, out], { maxBuffer: 1 << 28 });
  } catch (error) {
    console.warn(`  ! montage could not draw labels (${error.message.split('\n')[0]}); tiling without them`);
    await run('magick', [...base, ...files, out], { maxBuffer: 1 << 28 });
  }
  return out;
}

/**
 * Every pane's words, in reading order, as one document.
 *
 * Separated from the images on purpose: tiling is for judging shape and weight,
 * and this is for judging the sentence — which is easier to fix as a list of
 * lines than as a picture of one. The state each line belongs to is the heading,
 * so a rewrite can cite where it came from.
 */
function copyDeck(sheets, results) {
  const lines = [
    '# Launcher copy deck',
    '',
    'Every state the gallery draws, in reading order, as the words render. Generated',
    'by `npm run gallery` — edit the launcher, not this file.',
    ''
  ];
  for (const sheet of sheets) {
    lines.push(`## ${sheet.title}`, '');
    for (const entry of results[sheet.id] ?? []) {
      lines.push(`### ${entry.pane.name}`, '');
      const text = (entry.text ?? '').replace(/\n/g, '\n> ');
      lines.push(text ? `> ${text}` : '> _(nothing rendered)_', '');
    }
  }
  return `${lines.join('\n')}\n`;
}

/** A page that shows every sheet, so a review is one tab rather than four files. */
function contactPage(sheets, results, artifact, coverage) {
  const dialogRows = coverage.entries
    .map((entry) => {
      const note = entry.gap ?? (entry.line ? `no pane, and no reason given (App.svelte:${entry.line})` : '');
      return `      <li><code>${entry.id}</code> — ${entry.panes.length > 0 ? entry.panes.join(', ') : note}</li>`;
    })
    .join('\n');
  const rows = sheets
    .map((sheet) => {
      const panes = (results[sheet.id] ?? [])
        .map((entry) => `<li><b>${entry.pane.name}</b> — <code>${entry.pane.expect}</code></li>`)
        .join('\n');
      return `  <section>
    <h2>${sheet.title}</h2>
    <img src="sheet-${sheet.id}.png" alt="${sheet.title}" />      <ol>${panes}</ol>
  </section>`;

    })
    .join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Lithic launcher — UI gallery</title>
    <style>
      body { margin: 0; padding: 32px; background: #121212; color: #e7e1e9;
             font: 15px/1.6 system-ui, sans-serif; }
      h1 { margin: 0 0 24px; }
      h2 { margin: 0 0 14px; font-size: 1.1rem; color: #f0c674; }
      section { margin: 0 0 56px; }
      img { display: block; max-width: 100%; border: 1px solid #333; border-radius: 6px; }
      ol { margin: 14px 0 0; padding-left: 22px; color: #b9b3bd; font-size: 0.86rem; }
      code { color: #8ab4f8; }
      .artifact { margin: -14px 0 32px; color: #8f8f8f; font-size: 0.86rem; }
    </style>
  </head>
  <body>
    <h1>Lithic launcher — UI gallery</h1>
    <p class="artifact">Shooting <code>${artifact}</code> — the words are in <a href="copy-deck.md">copy-deck.md</a>, the dialog list in <a href="modal-coverage.md">modal-coverage.md</a></p>
  <section>
    <h2>Dialogs — every one the launcher declares, and the pane that draws it</h2>
    <ol>
${dialogRows}
    </ol>
  </section>
${rows}
  </body>
</html>
`;
}

// --- entry point ------------------------------------------------------------

if (!existsSync(ARTIFACT)) {
  console.error(`No launcher artifact at ${ARTIFACT}.`);
  console.error('Build one first: node scripts/build-launcher.mjs [destination]');
  process.exit(1);
}

const filter = process.argv.slice(2).filter((arg) => !arg.startsWith('-') && !arg.includes('='));
const sheets = filter.length > 0 ? SHEETS.filter((sheet) => filter.some((word) => sheet.id.includes(word))) : SHEETS;
if (sheets.length === 0) {
  console.error(`No sheet matches ${filter.join(', ')}. Sheets: ${SHEETS.map((sheet) => sheet.id).join(', ')}`);
  process.exit(1);
}

await rm(RAW_DIR, { recursive: true, force: true });
await mkdir(RAW_DIR, { recursive: true });

// Serves this run's artifact and the instance's CGI, so the self-host backup flow
// has somewhere to be driven. One for the run: the panes that use it each start
// from a fresh page, and the flow resets its own authorization on every code.
stub = await startSelfHostStub({ artifact: ARTIFACT });

const browser = await puppeteer.launch({
  headless: process.env.GALLERY_HEADED === '1' ? false : 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

const results = {};
const failures = [];
/** Which panes drew which dialog, accumulated as the walk runs. */
const drawnDialogs = new Map();
let drawn = 0;

try {
  for (const sheet of sheets) {
    results[sheet.id] = [];
    const files = [];
    for (const pane of sheet.panes) {
      try {
        const { errors, text } = await runPane(browser, pane);
        files.push(join(RAW_DIR, `${pane.name}.png`));
        results[sheet.id].push({ pane, text });
        if (pane.modal) drawnDialogs.set(pane.modal, [...(drawnDialogs.get(pane.modal) ?? []), pane.name]);
        drawn += 1;
        const flag = errors.length > 0 ? `  (${errors.length} console error${errors.length === 1 ? '' : 's'})` : '';
        console.log(`  ✓ ${pane.name}${flag}`);
        for (const error of errors) console.log(`      ${error}`);
      } catch (error) {
        failures.push(`${pane.name}: ${error.message.split('\n')[0]}`);
        console.error(`  ✗ ${pane.name}:${error.message.startsWith('Waiting for') ? '' : ` ${error.message.split('\n')[0]}`}`);
        for (const line of error.message.split('\n').slice(1)) console.error(`   ${line}`);
      }
    }
    if (files.length > 0) {
      const sheetPath = await montage(sheet, files);
      console.log(`  → ${sheetPath} (${files.length} panes)`);
    }
  }
} finally {
  await browser.close();
  await stub.close();
}

const coverage = dialogCoverage(await dialogsInSource(), drawnDialogs);
await writeFile(join(OUT_DIR, 'index.html'), contactPage(sheets, results, ARTIFACT, coverage), 'utf8');
await writeFile(join(OUT_DIR, 'copy-deck.md'), copyDeck(sheets, results), 'utf8');
await writeFile(join(OUT_DIR, 'modal-coverage.md'), coverage.text, 'utf8');
console.log(`\n${drawn} pane${drawn === 1 ? '' : 's'} drawn across ${sheets.length} sheet${sheets.length === 1 ? '' : 's'}.`);
console.log(
  `Dialogs: ${coverage.drawn} of ${coverage.total} drawn by a pane — ` +
    `${coverage.gaps} with a reason, ${coverage.unexplained.length} with none.`
);
for (const id of coverage.unexplained) {
  console.error(`! ${id} is in the launcher, in no pane, and explained nowhere — add a pane, or say why in UNPHOTOGRAPHED`);
}
for (const entry of coverage.stale) {
  console.error(`! ${entry.id} is claimed by ${entry.panes.join(', ')}, but the source declares no such dialog`);
}
console.log(`Coverage: ${join(OUT_DIR, 'modal-coverage.md')}`);
console.log(`Artifact: ${ARTIFACT}`);
console.log(`Open ${join(OUT_DIR, 'index.html')} for the lot.`);
if (failures.length > 0) {
  console.error(`\n${failures.length} pane${failures.length === 1 ? '' : 's'} never reached the state asked for:`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
