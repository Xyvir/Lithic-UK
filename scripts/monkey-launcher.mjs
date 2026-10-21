#!/usr/bin/env node
/**
 * The monkey: an unscripted-input harness for the single-file launcher.
 *
 * Everything else in `scripts/` drives the launcher the way a person does, one expected
 * state at a time. This drives it the way nobody does: it finds every entry box the
 * launcher draws, fills each one with garbage, and reports what happened. The classes of
 * failure it exists for are the ones a written test never asks about, because nobody
 * thought to write them down:
 *
 *   * a field that accepts something and then crashes the app on the next keystroke,
 *   * a value that comes back out as markup (`{@html}` where a bind was meant),
 *   * a dialog that cannot be dismissed once a field holds a certain character,
 *   * a name or address that passes a field with no guardrail at all, and reads as
 *     nonsense later in a row, a save dialog or a `recents.txt`,
 *   * a keystroke sequence that leaves the launcher with no way back.
 *
 * LOCAL ONLY, BY DECISION. It is not wired into any workflow and it must not be: a fuzz
 * run is noisy by nature, it takes a browser, and a red build because a random seed found
 * a real crash teaches people to press retry rather than to fix the crash. The dependency
 * runs the other way: a crash it finds becomes a case in `scripts/test-puppeteer-launcher.mjs`,
 * which does run in CI. `scripts/pre-push-check.mjs` fails if a workflow names this file.
 *
 *   npm run monkey:launcher             # the committed artifact, desktop surfaces
 *   npm run monkey:launcher:headed      # watch it happen
 *   node scripts/monkey-launcher.mjs --mode=webapp --rounds=6 --seed=1234
 *   node scripts/monkey-launcher.mjs --list        # what would be fuzzed, then stop
 *   node scripts/monkey-launcher.mjs --verbose     # one line per value, as it goes
 *   node scripts/monkey-launcher.mjs --only=bookmark   # one surface, after a change to it
 *   node scripts/monkey-launcher.mjs --keyboard    # the key storms alone
 *   node scripts/monkey-launcher.mjs --strict      # a guardrail gap is a failure too
 *
 * Exit 0 when no invariant broke. Exit 1 when one did, naming the surface, the box, the
 * payload and what went wrong, in the same words as the report it writes.
 *
 * WHAT IT CANNOT SEE
 *
 * The artifact is booted over `file://` with a stand-in for Rust, so a behaviour that
 * lives in a Rust command is only ever seen through the answer the stand-in gives. What a
 * mount or a save does with a hostile name is therefore not covered here; this covers the
 * page, its fields, its dialogs and its pure name and address arithmetic.
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer';

// --- what this run is -------------------------------------------------------

const argv = process.argv.slice(2);
const flags = argv.filter((arg) => arg.startsWith('--'));
const positional = argv.filter((arg) => !arg.startsWith('--'));

/** `--name=value` and bare `--name`, where a bare flag reads as `true`. */
function flagValue(name, fallback) {
  const hit = flags.find((flag) => flag === `--${name}` || flag.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const [, value] = hit.split('=');
  return value === undefined ? true : value;
}

const ARTIFACT = resolve(positional[0] ?? 'src/launcher.html');
const MODE = String(flagValue('mode', 'tauri'));
const ROUNDS = Number(flagValue('rounds', 3));
const SEED = Number(flagValue('seed', Math.floor(Date.now() / 1000) % 100000));
const HEADED = flags.includes('--headed') || process.env.HEADED === '1';
const STRICT = flags.includes('--strict');
const LIST_ONLY = flags.includes('--list');
const KEEP_PROFILE = flags.includes('--keep-profile');
const ONLY = flagValue('only', null);
const VERBOSE = flags.includes('--verbose');
const KEYBOARD_ONLY = flags.includes('--keyboard');
const KEYBOARD = !flags.includes('--no-keyboard');
const REPORT_DIR = resolve('scratch/monkey');
const PROFILE_DIR = resolve(`scratch/monkey-profile-${SEED}`);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const URL = (artifact) => `file://${artifact}?mode=${MODE}`;

if (!['tauri', 'webapp'].includes(MODE)) {
  console.error(`FAIL - --mode=${MODE} is not a mode. Use tauri (desktop surfaces) or webapp (the browser fallback).`);
  process.exit(2);
}
if (!existsSync(ARTIFACT)) {
  console.error(`FAIL - ${ARTIFACT} does not exist. Build one with: npm run build:launcher`);
  process.exit(2);
}

const bytes = readFileSync(ARTIFACT);
const DIGEST = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const SIZE_KB = Math.round(bytes.byteLength / 1024);

/**
 * A stale artifact is worth saying out loud rather than failing on: this harness is run by
 * hand, often right after an edit, and fuzzing the previous build's bytes is a wasted run
 * that looks exactly like a clean one.
 *
 * Uncommitted sources are the signal rather than modification times: a checkout sets an
 * arbitrary mtime on every file, so an mtime comparison reports every clone as stale. What
 * is actually true is that a launcher source changed and `src/launcher.html` has not been
 * rebuilt since, which is what `git status` answers and what `npm run check:push` refuses
 * to publish.
 */
function artifactAgeWarning() {
  const status = spawnSync('git', ['status', '--porcelain', 'launcher-ui/src'], { encoding: 'utf8' });
  if (status.status !== 0 || !status.stdout.trim()) return null;
  return 'launcher-ui/src has uncommitted changes, so these artifact bytes may predate them. Rebuild with npm run build:launcher to fuzz the edit.';
}

// --- seeded randomness ------------------------------------------------------

/** mulberry32: the same seed is the same run, which is what makes a finding repeatable. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const random = mulberry32(SEED);

function shuffled(list) {
  const out = [...list];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [out[index], out[other]] = [out[other], out[index]];
  }
  return out;
}

// --- what gets typed --------------------------------------------------------

/** Every kind a plain text payload is allowed to be fed to. */
const TEXT_KINDS = ['text', 'name', 'search', 'url', 'git', 'secret'];

const text = (id, value, why, kinds = TEXT_KINDS) => ({ id, value, why, kinds });

/**
 * The corpus.
 *
 * Each entry is a class of input a field can meet in the wild rather than a random
 * string: what matters is the shape (a line break, a separator, a scheme, a rune outside
 * the BMP) because the guardrail it probes is shaped the same way. `why` is what the
 * report would print beside a finding, so the corpus explains itself.
 */
const PAYLOADS = [
  text('empty', '', 'an empty field, where a name or an address is required'),
  text('space', '   ', 'whitespace only, which trims to empty'),
  text('trailing-space', 'notes ', 'a trailing space, which Windows keeps and a path comparison does not'),
  text('trailing-dot', 'notes.', 'a trailing dot, which Windows resolves to the same file'),
  text('newline', 'two\nlines', 'a line break, in a name that may end up line-oriented (recents.txt)'),
  text('crlf', 'a\r\nb', 'a CRLF pair, the same hazard on Windows'),
  text('tab', 'a\tb', 'a tab, which looks like padding in a row'),
  text('nul', 'a\u0000b', 'a NUL, which a filename cannot hold'),
  text('control', 'a\u0001\u0007\u001bb', 'control characters, including ESC, which some terminals read'),
  text('traversal', '../../etc/passwd', 'a path walking out of whatever directory it is put in'),
  text('windows-path', 'C:\\Windows\\system32\\notes', 'an absolute Windows path where a name belongs'),
  text('reserved', 'CON', 'a Windows device name, which cannot be a file'),
  text('dots', '...', 'dots only, which normalizes to nothing useful'),
  text('extension-only', '.lith', 'an extension with no stem'),
  text('long', 'A'.repeat(2000), 'a name longer than most filesystems and every list row allow'),
  text('emoji', '🔥🗿🧪', 'emoji outside the BMP'),
  text('family-emoji', '👨‍👩‍👧‍👦', 'a ZWJ sequence, which is one glyph and seven code points'),
  text('rtl', 'ملف عربي', 'right-to-left text, which flips the run it lands in'),
  text('combining', 'e\u0301\u0301\u0301a', 'stacked combining marks'),
  text('homoglyph', 'ѕсоtt', 'Cyrillic letters that read as Latin'),
  text('markup-img', '<img src=x onerror="window.__monkeyPwned=1">', 'markup that runs code if it is ever rendered as markup'),
  text('markup-svg', '<svg onload="window.__monkeyPwned=1">', 'the same, in a shape a sanitizer often misses'),
  text('markup-script', '<script>window.__monkeyPwned=1</script>', 'a script tag typed into a text field'),
  text('svelte', '{#if true}{@html "<b>"}{/if}', 'Svelte template syntax, for a field interpolated somewhere unsafe'),
  text('tiddly', '<<now "0hh:0mm">> [all[tiddlers]]', 'wikitext, which the launcher injects into a wiki on mount'),
  text('regex', '.*[]()\\^$|+?', 'regex metacharacters, for a filter built out of a field'),
  text('format', '%s%d{0}$1', 'format specifiers'),
  text('json', '{"title":"x","text":"y"}', 'JSON, which a naive writer may parse'),
  text('scheme-javascript', 'javascript:alert(1)', 'a scheme that runs script, in a field that takes an address', ['url']),
  text('scheme-data', 'data:text/html,<script>window.__monkeyPwned=1</script>', 'an inline document with script in it', ['url']),
  text('scheme-file', 'file:///C:/Windows/win.ini', 'the local disk, from an address field', ['url']),
  text('scheme-ftp', 'ftp://other.example', 'a scheme the app cannot fetch, behind a spelled-out scheme', ['url']),
  text('url-bare', 'example.test', 'a bare host, which the address field is meant to prefix', ['url']),
  text('url-no-host', 'https://', 'a scheme with no host', ['url']),
  text('url-port', 'example.test:99999', 'a port number no URL parser accepts', ['url']),
  text('url-idn', 'https://еxample.test', 'a Cyrillic е in the host, which reads as ASCII', ['url']),
  text('git-ok', 'owner/repo', 'the shape the repository field wants', ['git']),
  text('git-extra', 'owner/repo/extra', 'one separator too many', ['git']),
  text('git-dotdot', '../../repo', 'a repository path walking upward', ['git']),
  text('git-space', 'own er/re po', 'spaces in both halves', ['git']),
  text('git-remote', 'https://github.com/owner/repo.git', 'a clone URL where owner/name belongs', ['git']),
  text('pin-digits', '123456', 'six digits, the ordinary PIN', ['pin']),
  text('pin-alpha', 'ABCXYZ', 'the other alphabet the boxes accept', ['pin']),
  text('pin-mixed', 'a1B2c3', 'mixed case and digits', ['pin']),
  text('pin-symbol', '!@#$%^', 'symbols only, which no PIN box should take', ['pin']),
  text('pin-fullwidth', '１２３４５６', 'fullwidth digits, which look like digits and are not ASCII', ['pin']),
  text('pin-emoji', '🔒🔒🔒🔒🔒🔒', 'emoji, one code point each and four bytes in UTF-8', ['pin']),
  text('pin-long', '0123456789abcdefghij', 'a pasted run longer than the six boxes', ['pin'])
];

const poolFor = (kind) => PAYLOADS.filter((payload) => payload.kinds.includes(kind));

// --- the surfaces and what is reachable in them -----------------------------

const sleep = (page, ms) =>
  page.evaluate((wait) => new Promise((done) => setTimeout(done, wait)), ms);

/**
 * The launcher draws its entry boxes in dialogs, and a dialog is its own state.
 *
 * Each surface below is a way in (through the control a person presses), the element that
 * scopes it, and the control that dismisses it. `close` is the × rather than Escape,
 * because the × is the dismissal the launcher promises every dialog it draws.
 *
 * When a surface cannot be reached the run says so and carries on: a dialog that has
 * stopped opening is worth knowing about, but it is not the same finding as a crash.
 */
const SURFACES = [
  {
    id: 'new-lith',
    title: 'the name a new Lith is given',
    open: async (page) => {
      await page.click('.new-blank-button');
      await page.waitForSelector('.new-lith-inline', { timeout: 4000 });
    },
    scope: '.new-lith-inline',
    close: '.new-lith-close',
    kind: () => 'name'
  },
  {
    id: 'search',
    title: 'the Recents search box',
    open: async (page) => {
      await page.waitForSelector('.recent-search', { timeout: 4000 });
    },
    scope: '.recent-search-wrap',
    close: null,
    kind: () => 'search'
  },
  {
    id: 'bookmark',
    title: 'the bookmark address box',
    open: async (page) => {
      await page.click('.action-pair .bookmark-button');
      await page.waitForSelector('.bookmark-modal', { timeout: 4000 });
    },
    scope: '.bookmark-modal',
    close: '.bookmark-modal .modal-close',
    kind: () => 'url'
  },
  {
    id: 'git-sync',
    title: 'the GitHub backup dialog',
    open: async (page) => {
      await page.click('.heading .sync-button');
      await page.waitForSelector('.git-sync-modal', { timeout: 4000 });
      // The repository and token fields live in the dialog's advanced section, which is
      // collapsed. A person opens it to paste a token, so a harness that cannot would not
      // be covering the box at all.
      await page.evaluate(() => {
        for (const details of document.querySelectorAll('.git-sync-modal details')) details.open = true;
      });
      await sleep(page, 150);
    },
    scope: '.git-sync-modal',
    close: '.git-sync-modal .modal-close',
    kind: (box) => (box.type === 'password' ? 'secret' : 'git')
  },
  {
    id: 'vault',
    title: 'the vault PIN',
    open: async (page) => {
      await page.click('.action-pair .bookmark-button');
      await page.waitForSelector('.vault-manager-button', { timeout: 4000 });
      await page.click('.vault-manager-button');
      await page.waitForSelector('.vault-unlock-pin', { timeout: 4000 });
    },
    scope: '.vault-modal',
    needs: '#vault-title',
    close: '.vault-modal .modal-close',
    kind: () => 'pin'
  },
  {
    id: 'credential',
    title: 'the saved-login offer',
    open: async (page) => {
      // The key that writes a login rides on a bookmark row, and a row only exists in the
      // dialog that manages addresses. Reopening that dialog first is what a person does,
      // and it is also what makes the surface reachable again after a completed PIN closed
      // the offer on top of it.
      if (!(await page.$('.bookmark-row .vault-row-button'))) {
        await page.click('.action-pair .bookmark-button');
        await page.waitForSelector('.bookmark-row .vault-row-button', { timeout: 4000 });
      }
      await page.evaluate(() => {
        const key = document.querySelector('.bookmark-row .vault-row-button');
        if (key) key.click();
      });
      await page.waitForSelector('.credential-offer-user', { timeout: 4000 });
    },
    scope: '.vault-modal',
    needs: '#credential-offer-title',
    close: '.vault-modal .modal-close',
    kind: (box) => (box.type === 'pin' ? 'pin' : box.type === 'password' ? 'secret' : 'text')
  }
];

// --- the page-side half -----------------------------------------------------

/**
 * Installed before the artifact's own script runs, and serialised into the page, so it
 * closes over nothing.
 *
 * Three things: a stand-in for the Rust side (the launcher asks what the platform can do
 * before it draws anything, and `?mode=tauri` is the documented way to be the desktop app
 * over `file://`), a collector for the failures a page-level listener cannot see (an
 * unhandled rejection inside a promise chain), and a mutation watcher that notices typed
 * markup becoming real markup.
 */
function installStandIn(config) {
  const calls = [];
  window.__monkeyCalls = calls;
  const answer = (command, args) => {
    calls.push({ command, args });
    switch (command) {
      case 'platform_capabilities':
        return {
          os: 'windows',
          install: true,
          launch_entry: 'start-menu',
          git_sync: true,
          credentials: true,
          local_files: true,
          instance_auth: true,
          package_managed: false,
          install_supported: true
        };
      case 'install_offer_status':
        // Dismissed, so the install offer is not a surface in every run.
        return { installed: false, dismissed: true };
      case 'install_status':
        return { installed: false, state: 'uninstalled' };
      case 'install_update_check':
        return { available: false };
      case 'credentials_status':
      case 'lock_credentials':
        return config.vault;
      case 'credential_coverage':
      case 'git_sync_coverage':
        return {};
      case 'list_credentials':
      case 'read_recents_sidecar':
      case 'instance_cache_search':
        return [];
      case 'git_sync_folder':
        return { folder: config.folder, overridden: false };
      default:
        return null;
    }
  };
  window.__TAURI__ = {
    core: {
      invoke: (command, args) => {
        try {
          return Promise.resolve(answer(command, args));
        } catch (error) {
          return Promise.reject(error);
        }
      }
    },
    event: { listen: () => Promise.resolve(() => {}) }
  };
  window.__monkey = { alive: true, errors: [], pwned: [], mutated: [] };
  const record = (message) => window.__monkey.errors.push(String(message));
  window.addEventListener('error', (event) => record(`window error: ${event.message || event.type}`));
  window.addEventListener('unhandledrejection', (event) =>
    record(`unhandled rejection: ${(event.reason && event.reason.message) || event.reason}`)
  );
  // Anything that reads this flag has run script that arrived through a text field.
  Object.defineProperty(window, '__monkeyPwned', {
    configurable: true,
    get() {
      window.__monkey.pwned.push('read');
      return 1;
    },
    set() {
      window.__monkey.pwned.push('written');
    }
  });
  const HAZARD = /<script|\sonerror=|\sonload=|__monkeyPwned/i;
  const watch = () => {
    if (!document.documentElement) return void setTimeout(watch, 0);
    new MutationObserver((records) => {
      for (const entry of records) {
        for (const node of entry.addedNodes) {
          if (node.nodeType !== 1) continue;
          const markup = node.outerHTML || '';
          if (HAZARD.test(markup)) window.__monkey.mutated.push(markup.slice(0, 200));
        }
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  watch();
}

/** One authored path per box, so a payload can be aimed at the box it was chosen for. */
function describeBoxes(scopeSelector, needsSelector) {
  let scope = needsSelector ? document.querySelector(needsSelector) : document.querySelector(scopeSelector);
  if (scope && needsSelector) scope = scope.closest(scopeSelector);
  if (!scope) return null;
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const pathOf = (element) => {
    const parts = [];
    let node = element;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) {
        parts.unshift(`#${node.id}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      if (typeof node.className === 'string' && node.className.trim()) {
        part += '.' + node.className.trim().split(/\s+/).slice(0, 2).join('.');
      }
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const boxes = [];
  const seenPins = new Set();
  for (const element of scope.querySelectorAll('input, textarea, [contenteditable="true"]')) {
    if (element.type === 'hidden' || element.type === 'radio' || element.type === 'checkbox') continue;
    if (element.disabled || !visible(element)) continue;
    // A PIN is one entry point drawn as six boxes: fuzzing the six would be the same field
    // reported six times, so the group is described once, at its first box.
    if (element.classList.contains('pin-box')) {
      const group = element.closest('.pin-boxes');
      if (!group || seenPins.has(group)) continue;
      seenPins.add(group);
      boxes.push({
        selector: pathOf(group.querySelector('.pin-box')),
        pin: true,
        tag: 'input',
        type: 'pin',
        count: group.querySelectorAll('.pin-box').length,
        label: group.querySelector('.pin-label')?.textContent?.trim() || group.getAttribute('aria-label') || 'PIN'
      });
      continue;
    }
    boxes.push({
      selector: pathOf(element),
      pin: false,
      tag: element.tagName.toLowerCase(),
      type: element.type || (element.getAttribute('contenteditable') === 'true' ? 'contenteditable' : ''),
      label:
        element.getAttribute('aria-label') ||
        element.getAttribute('placeholder') ||
        element.getAttribute('name') ||
        String(element.className || '')
    });
  }
  return boxes;
}

/** Type the payload, by keys where that is the point and by value where it is not. */
function setValue(selector, value) {
  const element = document.querySelector(selector);
  if (!element) return null;
  element.focus();
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  return element.value;
}

function readState(selector, pin) {
  const monkey = window.__monkey;
  if (!monkey || !monkey.alive) {
    return { gone: true, launcher: Boolean(document.querySelector('main.container')) };
  }
  const element = document.querySelector(selector);
  const value = pin
    ? [...document.querySelectorAll('.pin-boxes input')].map((box) => box.value).join('')
    : element
      ? element.value
      : null;
  return {
    gone: false,
    launcher: Boolean(document.querySelector('main.container')),
    value,
    // A field that re-renders under the caret is the fringe failure a fuzz pass is for:
    // the next keystroke goes nowhere and the value on screen is not the one being edited.
    focused: element ? document.activeElement === element : null,
    truncated: Boolean(element && element.maxLength > 0 && value && value.length >= element.maxLength),
    errors: monkey.errors.slice(),
    pwned: monkey.pwned.slice(),
    mutated: monkey.mutated.slice()
  };
}

// --- results ----------------------------------------------------------------

const runs = [];
const findings = [];
const notes = [];
/** One note per box that moved the caret out from under a payload, not one per value. */
const focusNotes = new Set();
/** One note per address a key storm tried to follow, not one per round. */
const keyboardNotes = new Set();
const pageErrors = [];
/** Every request this run refused, which is how a navigation shows up after the fact. */
const blocked = [];

function finding(severity, where, payload, detail) {
  findings.push({ severity, where, payload, detail });
}

/**
 * The browser's own noise over `file://`: a manifest, a favicon and a fixture host that
 * does not resolve all fail at the resource layer before any of this matters. Filtered by
 * the same rule as the Puppeteer suite, so the two agree on what a real error is.
 */
function isResourceNoise(text) {
  return (
    text.includes('Failed to load resource: net::ERR_FAILED') ||
    text.includes('Failed to load resource: net::ERR_FILE_NOT_FOUND') ||
    text.includes('Failed to load resource: net::ERR_NAME_NOT_RESOLVED') ||
    (text.includes('Access to manifest at') && text.includes('CORS policy')) ||
    // Mounting needs the engine beside the artifact, and a `file://` document may not
    // fetch one: the empty-name check starts a mount on purpose and this is what that
    // looks like. The failure it produces is reported as a document that did not open,
    // which is the honest reading over `file://`.
    (/Access to fetch at 'file:/.test(text) && text.includes('CORS policy'))
  );
}

/**
 * Get back to the launcher's own surface before opening anything.
 *
 * A payload can leave a dialog in a state its opener does not expect (a completed PIN
 * closes the offer, a failed submit leaves a held status), and opening on top of that
 * reads as "the dialog will not open" when what happened is that the previous dialog was
 * still up. Escape first because it is the launcher's universal way out; the × is the
 * other dismissal and is only reached if Escape did not work, which is itself a finding.
 */
async function ensureBase(page, surface) {
  // The search box is a filter on everything below it, and a payload left in it hides the
  // rows the next surface is opened through. Clearing it is what a person does before
  // looking for something else.
  await page.evaluate(() => {
    const box = document.querySelector('.recent-search');
    if (!box || !box.value) return;
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const busy = () =>
    page.evaluate(
      () => document.querySelectorAll('.modal-overlay').length > 0 || Boolean(document.querySelector('.new-lith-inline'))
    );
  if (!(await busy())) return null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.keyboard.press('Escape');
    await sleep(page, 120);
    if (!(await busy())) return null;
  }
  const clicked = await page.evaluate(() => {
    const close = document.querySelector('.modal-overlay .modal-close, .new-lith-close');
    if (!close) return false;
    close.click();
    return true;
  });
  await sleep(page, 150);
  if (!clicked || (await busy())) return `${surface.id}: a dialog stayed on screen and Escape did not close it`;
  return `${surface.id}: Escape did not close a dialog, but its x did`;
}

/**
 * Dismiss a surface through its own × and require that it actually went.
 *
 * This is the wedge check: a dialog that accepts a value and then cannot be closed is the
 * worst finding here, because the window it covers is the whole app.
 */
async function dismiss(page, surface) {
  if (!surface.close) return true;
  try {
    const control = await page.$(surface.close);
    if (!control) return true;
    await control.click();
    await page.waitForFunction(() => document.querySelectorAll('.modal-overlay').length === 0, {
      polling: 100,
      timeout: 2500
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * One payload into one box, and every invariant that can be judged from outside it.
 *
 * The surface is reopened for each payload rather than cleared: a field that keeps state
 * across a close would be its own finding, and reopening is the state a person arrives in.
 */
async function probe(page, surface, box, payload) {
  const outcome = {
    surface: surface.id,
    box: box.label,
    type: box.type,
    payload: payload.id,
    typed: '-',
    held: '-',
    problems: []
  };
  const errorsBefore = pageErrors.length;
  await page.evaluate(() => {
    const monkey = window.__monkey;
    if (!monkey) return;
    monkey.errors.length = 0;
    monkey.pwned.length = 0;
    monkey.mutated.length = 0;
  });
  const leftOver = await ensureBase(page, surface);
  if (leftOver) outcome.problems.push(leftOver);
  try {
    await surface.open(page);
    const target = await page.$(box.selector);
    if (!target) {
      outcome.problems.push('the box was not on screen after opening the surface');
      return outcome;
    }
    await target.click();
    await page.keyboard.down('Control');
    await page.keyboard.press('KeyA');
    await page.keyboard.up('Control');
    await page.keyboard.press('Backspace');
    // Real keys for anything typeable, because a field's own per-keystroke logic is half
    // of what is under test. A NUL or a 2000-character run is set instead: no keyboard can
    // produce the first, and the second would be 2000 events for no extra coverage.
    const byKeys = payload.value.length <= 120 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(payload.value);
    if (byKeys) await page.keyboard.type(payload.value, { delay: 0 });
    else await page.evaluate(setValue, box.selector, payload.value);
    outcome.typed = byKeys ? 'keys' : 'value';
    await sleep(page, 150);
    const state = await page.evaluate(readState, box.selector, box.pin);
    if (state.gone) {
      outcome.problems.push('the launcher document went away while the field held this value');
      return outcome;
    }
    outcome.held = typeof state.value === 'string' ? state.value.length : '?';
    if (!state.launcher) outcome.problems.push('the launcher stopped being the page');
    if (state.pwned.length > 0) outcome.problems.push('typed markup executed: the payload reached script');
    if (state.mutated.length > 0) outcome.problems.push(`typed markup became markup: ${state.mutated[0]}`);
    if (state.errors.length > 0) outcome.problems.push(`the page raised ${state.errors.join(' | ')}`);
    if (pageErrors.length > errorsBefore) {
      outcome.problems.push(`the browser reported ${pageErrors.slice(errorsBefore).join(' | ')}`);
    }
    if (state.truncated) outcome.note = 'truncated by maxlength';
    if (!box.pin && state.focused === false) {
      const where = `${surface.id} / ${box.label}`;
      if (!focusNotes.has(where)) {
        focusNotes.add(where);
        notes.push(`${where}: the caret left the box while it held a payload (first seen with ${payload.id}), so the next keystroke would go elsewhere`);
      }
    }
    if (!(await dismiss(page, surface))) outcome.problems.push('the × did not close the surface afterwards');
  } catch (error) {
    outcome.problems.push(`the probe threw: ${String(error.message).split('\n')[0]}`);
    await dismiss(page, surface).catch(() => {});
    await page.goto(URL(ARTIFACT), { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  return outcome;
}

// --- guardrails the repo already intends ------------------------------------

/**
 * Four claims the launcher already makes about its fields, restated as something that can
 * fail.
 *
 * Each one is observable through the page, and each one is a guardrail a person would
 * expect: a name that collides says so, an address that is not an address is refused, a
 * PIN takes only what a PIN can hold, an empty name still produces a document. They are
 * here rather than in the Puppeteer suite because they are only worth keeping if they
 * still hold after a fuzz pass has stirred the same dialogs up.
 */
const CHECKS = [
  {
    id: 'name-collision',
    title: 'a name already in Recents says so',
    claim: 'typing a name that already exists marks the check invalid, and typing past it clears the mark',
    run: async (page) => {
      await page.click('.new-blank-button');
      await page.waitForSelector('.new-lith-inline');
      await page.click('.new-lith-field input');
      await page.keyboard.type('fixture');
      await sleep(page, 350);
      const taken = await page.evaluate(
        () => Boolean(document.querySelector('.new-lith-check.invalid')) || Boolean(document.querySelector('.new-lith-warn'))
      );
      await page.keyboard.type('-two');
      await sleep(page, 350);
      const free = await page.evaluate(() => !document.querySelector('.new-lith-check.invalid'));
      return { taken, free };
    },
    verdict: (result) => result.taken && result.free,
    detail: (result) => `taken=${result.taken}, free=${result.free}`
  },
  {
    id: 'bookmark-scheme',
    // The bookmark affordance is drawn by the desktop app, and by a phone's browser. A
    // desktop browser is neither, so a run in that mode has no box to check rather than a
    // guardrail that failed.
    requires: 'tauri',
    title: 'an address that is not http(s) is refused',
    claim: 'a javascript: address shows an error and is not stored',
    run: async (page) => {
      await page.click('.action-pair .bookmark-button');
      await page.waitForSelector('.bookmark-modal');
      await page.click('.bookmark-modal input');
      await page.keyboard.type('javascript:alert(1)');
      await page.evaluate(() => document.querySelector('.bookmark-modal .modal-action').click());
      await sleep(page, 600);
      const message = await page.evaluate(
        () => document.querySelector('.bookmark-modal .status-line.error')?.textContent?.trim() || ''
      );
      const stored = await page.evaluate(() => localStorage.getItem('bookmarkedInstances') || '');
      return { message, stored: stored.includes('javascript:') };
    },
    verdict: (result) => Boolean(result.message) && !result.stored,
    detail: (result) => `message=${JSON.stringify(result.message)}, stored=${result.stored}`
  },
  {
    id: 'pin-alphabet',
    requires: 'tauri',
    title: 'a PIN box takes only what a PIN can hold',
    claim: 'symbols are refused, so six of them do not submit',
    run: async (page) => {
      await page.click('.action-pair .bookmark-button');
      await page.waitForSelector('.vault-manager-button');
      await page.click('.vault-manager-button');
      await page.waitForSelector('.vault-unlock-pin');
      const before = await page.evaluate(
        () => window.__monkeyCalls.filter((entry) => entry.command === 'list_credentials').length
      );
      await page.click('.vault-unlock-pin .pin-box');
      await page.keyboard.type('!@#$%^');
      await sleep(page, 400);
      const after = await page.evaluate(
        () => window.__monkeyCalls.filter((entry) => entry.command === 'list_credentials').length
      );
      const held = await page.evaluate(() =>
        [...document.querySelectorAll('.vault-unlock-pin .pin-box')].map((box) => box.value).join('')
      );
      return { submitted: after > before, held };
    },
    verdict: (result) => !result.submitted && result.held === '',
    detail: (result) => `submitted=${result.submitted}, held=${JSON.stringify(result.held)}`
  },
  {
    id: 'empty-name',
    title: 'an empty name still becomes a document with a name',
    claim: 'submitting with nothing typed starts a document rather than wedging, and the page survives it',
    run: async (page) => {
      await page.click('.new-blank-button');
      await page.waitForSelector('.new-lith-inline');
      await page.click('.new-lith-field input');
      await page.keyboard.press('Enter');
      await sleep(page, 1000);
      // A blank Lith is mounted from the engine, and over file:// that fetch is refused,
      // so the launcher reports a held failure rather than a document. What is asserted is
      // that it did not wedge: the inline dialog is gone and the launcher is still the page.
      return page.evaluate(() => ({
        inline: Boolean(document.querySelector('.new-lith-inline')),
        launcher: Boolean(document.querySelector('main.container')),
        status:
          document.querySelector('.status-line.error')?.textContent?.trim() ||
          document.querySelector('.status-line')?.textContent?.trim() ||
          document.querySelector('.mount-error')?.textContent?.trim() ||
          ''
      }));
    },
    verdict: (result) => result.launcher && !result.inline,
    detail: (result) => `launcher=${result.launcher}, dialogOpen=${result.inline}, status=${JSON.stringify(result.status)}`
  }
];

/**
 * The name and address arithmetic, fed the same corpus with no browser in the way.
 *
 * These two functions are the whole of the guardrail for the two fields that produce
 * something later (a filename, a stored address), and both are plain functions, so what a
 * hostile value *becomes* can be printed instead of inferred. A result carrying a path
 * separator or a control character is reported: not a crash, but a value that will read
 * as nonsense in a row, a save dialog or a line-oriented file.
 */
async function pureProbes() {
  const rows = [];
  try {
    const { normalizeLithName } = await import('../launcher-ui/src/legacy-saver.ts');
    const { normalizeInstanceUrl } = await import('../launcher-ui/src/bookmarks.ts');
    for (const payload of PAYLOADS.filter((entry) => entry.kinds.includes('name'))) {
      let result;
      try {
        result = normalizeLithName(payload.value);
      } catch (error) {
        result = `refused: ${error.message}`;
      }
      // A control character is the hazard worth failing on: a name that carries one is not
      // a filename anywhere, and it splits a line wherever a list is line-oriented. A path
      // separator is printed in the table instead of failed on, because whether `../` in a
      // suggested name is a bug depends on the writer, and a person can say so from the row.
      rows.push({
        fn: 'normalizeLithName',
        input: payload.value,
        result,
        separator: /[/\\]/.test(result),
        hazard: /[\u0000-\u001f]/.test(result)
      });
    }
    for (const payload of PAYLOADS.filter((entry) => entry.kinds.includes('url'))) {
      let result;
      try {
        result = normalizeInstanceUrl(payload.value);
      } catch (error) {
        result = `refused: ${error.message}`;
      }
      const refused = result.startsWith('refused:');
      rows.push({ fn: 'normalizeInstanceUrl', input: payload.value, result, refused, hazard: !refused && !/^https?:\/\//.test(result) });
    }
  } catch (error) {
    notes.push(`the pure guardrail probes were skipped: ${String(error.message).split('\n')[0]}`);
  }
  return rows;
}

// --- the run ----------------------------------------------------------------

async function refresher(page) {
  // A navigation already in flight can take the context out from under `goto`, which is
  // not a launcher fault and not something to fail a run on: the retry is the answer.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(URL(ARTIFACT), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('main.container', { timeout: 15000 });
      await sleep(page, 250);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(page, 400);
    }
  }
}

async function run() {
  const browser = await puppeteer.launch({
    headless: HEADED ? false : 'new',
    userDataDir: PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 900, height: 700 }
  });

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(4000);
    // Offline, like the artifact is promised to be. A mount reaches for the engine beside
    // the artifact first and then for the published one, and fetching that from
    // lithic.uk on a `file://` page would replace the document with a real wiki and end
    // the run. Refusing every request that is not local is what keeps this a page test.
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (/^(file|data|blob|about):/i.test(url)) return void request.continue();
      blocked.push(url);
      void request.abort();
    });
    page.on('pageerror', (error) => {
      if (!isResourceNoise(error.message)) pageErrors.push(error.message);
    });
    page.on('console', (message) => {
      if (message.type() !== 'error' || isResourceNoise(message.text())) return;
      pageErrors.push(message.text());
    });
    page.on('dialog', async (dialog) => {
      finding('FAIL', 'the page', '-', `a native ${dialog.type()} dialog appeared: ${dialog.message()}`);
      await dialog.dismiss();
    });
    await page.evaluateOnNewDocument(installStandIn, {
      vault: { exists: true, count: 1, path: 'C:/fixture/lithic-vault.json' },
      folder: 'C:/fixture'
    });

    await page.goto(URL(ARTIFACT), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main.container', { timeout: 15000 });

    // Two rows and a bookmark, so the Recents box, its rows and the dialog that manages an
    // address all exist to be fuzzed. A handle row is a row the launcher keeps (an
    // anonymous name is dropped), and it is the shape the browser's own picker hands over.
    await page.evaluate(() => {
      localStorage.setItem(
        'lithic-recent-liths',
        JSON.stringify([
          { name: 'fixture.lith', handle: { name: 'fixture.lith' } },
          { name: 'second.lith', handle: { name: 'second.lith' } }
        ])
      );
      localStorage.setItem(
        'bookmarkedInstances',
        JSON.stringify([{ url: 'https://instance.example', label: 'instance.example' }])
      );
    });
    await refresher(page);

    const ageWarning = artifactAgeWarning();
    if (ageWarning) notes.push(ageWarning);
    console.log(
      `monkey - ${ARTIFACT} (${SIZE_KB} KB, sha ${DIGEST}) in ${MODE} mode, seed ${SEED}, ${ROUNDS} round${ROUNDS === 1 ? '' : 's'} per box`
    );
    if (ageWarning) console.log(`  ! ${ageWarning}`);

    // --- discovery ----------------------------------------------------------

    const plan = [];
    for (const surface of SURFACES) {
      if (ONLY && surface.id !== ONLY) continue;
      let boxes = null;
      try {
        await surface.open(page);
        boxes = await page.evaluate(describeBoxes, surface.scope, surface.needs ?? null);
      } catch (error) {
        notes.push(`${surface.id}: could not be reached (${String(error.message).split('\n')[0]}), so nothing in it was fuzzed`);
      }
      if (!boxes || boxes.length === 0) {
        if (!notes.some((note) => note.startsWith(`${surface.id}:`))) {
          notes.push(`${surface.id}: open, but it draws no entry box this harness can see`);
        }
        await dismiss(page, surface);
        continue;
      }
      plan.push({ surface, boxes });
      await dismiss(page, surface);
    }

    if (LIST_ONLY) {
      for (const { surface, boxes } of plan) {
        console.log(`  ${surface.id} - ${surface.title}`);
        for (const box of boxes) {
          console.log(`     ${box.type.padEnd(9)} ${box.label}${box.pin ? ` (${box.count} boxes)` : ''}`);
          console.log(`     ${box.selector}`);
        }
      }
      for (const note of notes) console.log(`  ! ${note}`);
      return { listed: true, plan };
    }

    // --- the fuzz loop ------------------------------------------------------

    if (!KEYBOARD_ONLY) {
      for (const { surface, boxes } of plan) {
        for (const box of boxes) {
          const kind = surface.kind(box);
          if (kind === 'pin' && !box.pin) continue;
          const chosen = shuffled(poolFor(kind)).slice(0, Math.max(1, ROUNDS));
          for (const payload of chosen) {
            const outcome = await probe(page, surface, box, payload);
            runs.push(outcome);
            if (VERBOSE) {
              console.log(
                `  ${outcome.surface} / ${outcome.box} [${outcome.payload}] typed=${outcome.typed} held=${outcome.held}${
                  outcome.problems.length ? ` -> ${outcome.problems.join('; ')}` : ''
                }`
              );
            }
            for (const problem of outcome.problems) {
              finding('FAIL', `${surface.id} / ${box.label}`, payload.id, problem);
            }
          }
        }
      }

      // --- the deterministic guardrails ------------------------------------

      for (const check of CHECKS) {
        if (check.requires && check.requires !== MODE) {
          notes.push(`${check.id}: skipped, it is about the ${check.requires} surfaces and this run is ${MODE}`);
          continue;
        }
        let result;
        try {
          result = await check.run(page);
        } catch (error) {
          result = { error: String(error.message).split('\n')[0] };
        }
        const passed = !result.error && check.verdict(result);
        runs.push({
          surface: check.id,
          box: check.title,
          type: 'check',
          payload: 'check',
          typed: '-',
          held: '-',
          problems: passed ? [] : [result.error ?? check.detail(result)]
        });
        if (VERBOSE) console.log(`  check ${check.id}: ${passed ? 'ok' : 'GAP'} ${result.error ?? check.detail(result)}`);
        if (!passed) finding('GAP', check.id, 'check', `${check.claim} - saw ${result.error ?? check.detail(result)}`);
        // A check that submits or closes something leaves the page in a state the next one
        // does not expect, so the launcher is reloaded between them.
        await refresher(page);
      }
    }

    // --- the keyboard monkey ------------------------------------------------

    if (KEYBOARD) {
      const keys = ['Tab', 'Shift+Tab', 'Enter', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Home', 'End', ' ', '/', '#', '1', 'a'];
      for (let round = 0; round < 3; round += 1) {
        for (let press = 0; press < 12; press += 1) {
          const key = keys[Math.floor(random() * keys.length)];
          try {
            await page.keyboard.press(key);
          } catch {
            // A key the browser refuses is not a finding: the page is what is under test.
          }
        }
        await sleep(page, 200);
        let state;
        try {
          state = await page.evaluate(() => ({
            alive: Boolean(window.__monkey && window.__monkey.alive) && Boolean(document.querySelector('main.container')),
            errors: window.__monkey ? window.__monkey.errors.slice() : []
          }));
        } catch {
          // The document was replaced mid-evaluate, which is a navigation in flight.
          state = { alive: false, errors: [] };
        }
        if (!state.alive) {
          // Two ways to stop being the page, and only one of them is a fault. A blind Enter
          // lands on whatever Tab reached, and a bookmark row hands the window to its
          // instance on purpose, so a navigation the run refused is the launcher working.
          // A document that vanished with nothing to follow is the fault.
          const headed = blocked[blocked.length - 1];
          if (headed) {
            if (!keyboardNotes.has(headed)) {
              keyboardNotes.add(headed);
              notes.push(
                `keyboard: an unprompted Enter started a mount, and with no engine beside the artifact over file:// the launcher fell back to ${headed} (refused, as every non-local request is)`
              );
            }
          } else {
            finding('FAIL', 'keyboard', 'storm', `the launcher stopped being the page after ${(round + 1) * 12} unprompted keys`);
          }
          await refresher(page);
          continue;
        }
        if (state.errors.length > 0) {
          finding('FAIL', 'keyboard', 'storm', `unprompted keys raised ${state.errors.join(' | ')}`);
        }
        // Escape is the launcher's universal way out of a dialog, so after it nothing may
        // still be covering the page.
        try {
          for (let attempt = 0; attempt < 3; attempt += 1) await page.keyboard.press('Escape');
          await sleep(page, 200);
          const after = await page.evaluate(() => document.querySelectorAll('.modal-overlay').length);
          if (after > 0) {
            finding('FAIL', 'keyboard', 'storm', `Escape left ${after} dialog overlay(s) on screen after a key storm`);
          }
        } catch (error) {
          // The page moved under the escape keys. The reload below is the recovery; what
          // the keys did is already recorded by the round's own state check.
          notes.push(`keyboard: round ${round + 1} ended on a page this harness could not read (${String(error.message).split('\n')[0]})`);
        }
        // Enter on a focused button is a real press, so the page may be mid-mount by now. A
        // reload is cheaper than teaching the next round about it.
        await refresher(page);
      }
    }

    return { listed: false, plan };
  } finally {
    await browser.close();
    if (!KEEP_PROFILE) rmSync(PROFILE_DIR, { recursive: true, force: true });
  }
}

const outcome = await run();

for (const message of [...new Set(pageErrors)]) finding('FAIL', 'the page', '+', message);

if (outcome.listed) {
  process.exit(0);
}

// --- the pure guardrails ----------------------------------------------------

const PURE = await pureProbes();
const separators = PURE.filter((entry) => entry.separator);
if (separators.length > 0) {
  notes.push(
    `normalizeLithName keeps a path separator in ${separators.length} corpus value${separators.length === 1 ? '' : 's'} (see the table). Whether that is a bug depends on what writes the name, so it is reported rather than failed on.`
  );
}
for (const row of PURE.filter((entry) => entry.hazard)) {
  finding(
    'GAP',
    `pure / ${row.fn}`,
    'value',
    `${JSON.stringify(row.input)} becomes ${JSON.stringify(row.result)}: the name keeps a control character, which no filesystem accepts and every line-oriented list splits`
  );
}

// --- the report -------------------------------------------------------------

const failures = findings.filter((entry) => entry.severity === 'FAIL');
const gaps = findings.filter((entry) => entry.severity === 'GAP');
const clean = runs.filter((item) => item.problems.length === 0).length;

const cell = (value) => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, '\\n');
const lines = [
  `# Launcher monkey, ${STAMP}`,
  '',
  `- artifact: \`${ARTIFACT}\` (${SIZE_KB} KB, sha256 \`${DIGEST}\`)`,
  `- mode: \`${MODE}\`, seed \`${SEED}\`, ${ROUNDS} round${ROUNDS === 1 ? '' : 's'} per box`,
  `- ${runs.length} probes, ${clean} clean, ${failures.length} failure${failures.length === 1 ? '' : 's'}, ${gaps.length} guardrail gap${gaps.length === 1 ? '' : 's'}`,
  '',
  `Re-run the same run with \`node scripts/monkey-launcher.mjs --mode=${MODE} --seed=${SEED}\`.`,
  ''
];

if (failures.length + gaps.length > 0) {
  lines.push('## Findings', '');
  for (const entry of [...failures, ...gaps]) {
    lines.push(`### ${entry.severity} - ${entry.where} (${entry.payload})`, '', entry.detail, '');
  }
}

lines.push(
  '## What was typed, and what each field held',
  '',
  '| surface | box | payload | typed | held | problems |',
  '| --- | --- | --- | --- | --- | --- |'
);
for (const item of runs) {
  lines.push(
    `| ${cell(item.surface)} | ${cell(item.box)} (${cell(item.type)}) | ${cell(item.payload)} | ${cell(item.typed)} | ${cell(item.held)} | ${
      item.problems.length ? cell(item.problems.join('; ')) : '-'
    } |`
  );
}

if (PURE.length > 0) {
  lines.push('', '## The name and address arithmetic, on the same values', '', '| function | input | result |', '| --- | --- | --- |');
  for (const row of PURE) lines.push(`| ${row.fn} | \`${cell(row.input)}\` | \`${cell(row.result)}\` |`);
}

if (notes.length > 0) {
  lines.push('', '## Notes', '');
  for (const note of notes) lines.push(`- ${note}`);
}

lines.push(
  '',
  '## What this run does not cover',
  '',
  '- Anything a Rust command does with these values. The artifact is driven with a stand-in that answers the launcher the way the desktop app does, so a name reaching a file is out of scope here and belongs to the Rust tests.',
  '- Whether a hostile value *looks* wrong. Only a person can say that a row reading `../../x` is a bug rather than a name.',
  ''
);

mkdirSync(REPORT_DIR, { recursive: true });
const reportPath = join(REPORT_DIR, `report-${STAMP}.md`);
writeFileSync(reportPath, lines.join('\n'), 'utf8');

console.log('');
for (const entry of [...failures, ...gaps]) {
  console.log(`${entry.severity}  ${entry.where} [${entry.payload}]`);
  console.log(`      ${entry.detail}`);
}
for (const note of notes) console.log(`NOTE  ${note}`);
console.log('');
console.log(`${runs.length} probes: ${clean} clean, ${failures.length} failure(s), ${gaps.length} guardrail gap(s)`);
console.log(`report: ${reportPath}`);
console.log(`re-run: node scripts/monkey-launcher.mjs --mode=${MODE} --seed=${SEED}`);

process.exit(failures.length > 0 || (STRICT && gaps.length > 0) ? 1 : 0);
