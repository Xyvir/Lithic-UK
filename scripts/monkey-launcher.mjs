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
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
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
/** How many opening fixtures to try: a count, `all`, or `off`. */
const MOUNTS = String(flagValue('mounts', 4));
const DROPS = !flags.includes('--no-drop');
const PAYLOAD_URLS = !flags.includes('--no-payload-urls');
const SPAM = !flags.includes('--no-spam');
const MOUNT_TIMEOUT = Number(flagValue('mount-timeout', 20000));
const REPORT_DIR = resolve('scratch/monkey');
const PROFILE_DIR = resolve(`scratch/monkey-profile-${SEED}`);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
/**
 * The artifact as a `file://` address. Deliberately not named `URL`: shadowing the global
 * constructor is how the little server below silently answered 400 for every request.
 */
const artifactUrl = (artifact) => `file://${artifact}?mode=${MODE}`;

if (!Number.isFinite(Number(flagValue('rounds', 3))) || ROUNDS < 1) {
  console.error('FAIL - --rounds needs a number of at least 1.');
  process.exit(2);
}
if (!['off', 'all'].includes(MOUNTS) && !(Number(MOUNTS) >= 1)) {
  console.error(`FAIL - --mounts=${MOUNTS} names no fixture count. Use a number, \`all\` or \`off\`.`);
  process.exit(2);
}

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

/**
 * Wait, in the page rather than here.
 *
 * A timer is not an assertion: a document that navigates while it runs has done nothing
 * wrong, and a rejected wait would end the phase instead of the pause.
 */
const sleep = (page, ms) =>
  page.evaluate((wait) => new Promise((done) => setTimeout(done, wait)), ms).catch(() => {});

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
  /**
   * The Rust side, unless this page is meant to be the browser launcher.
   *
   * `bridge: false` is how the opening phases say so: a mount over the loopback origin is the
   * browser's own path through the picker, and a stand-in answering every command with `null`
   * makes the launcher take the desktop route and quietly do nothing instead.
   */
  if (config.bridge !== false) {
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
  }
  window.__monkey = { alive: true, errors: [], pwned: [], mutated: [] };
  /**
   * One authored path per element, so a control or a box can be aimed at after a re-render.
   *
   * Defined on the window rather than beside the callers because the page-side functions in
   * this file are serialised into the document individually: one of them cannot see another's
   * scope, and this is the one piece both of them need.
   */
  window.__monkeyPath = (element) => {
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
  const pathOf = (element) => window.__monkeyPath(element);
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

/** The browser's own picker, answered from this run's fixtures instead of a disk. */
function installPicker() {
  /** How many times the page asked for a file, which is how a phase tells "ignored" from "asked". */
  window.__monkeyPickCalls = 0;
  window.showOpenFilePicker = async () => {
    window.__monkeyPickCalls += 1;
    // What a picker answers is part of what a person can do with the launcher, and the two
    // answers nobody types are the interesting ones: the user cancelling, and the picker
    // itself refusing. The page has to survive both, and `busy` has to come back off.
    const mode = window.__monkeyPickMode;
    if (mode === 'cancel') {
      const aborted = new Error('The user aborted a request.');
      aborted.name = 'AbortError';
      throw aborted;
    }
    if (mode === 'throw') throw new Error('the picker refused to open');
    const pick = window.__monkeyPick;
    if (!pick) return [];
    const blob = await (await fetch(pick.url)).blob();
    const file = new File([blob], pick.name, { type: 'text/plain' });
    // The launcher asks twice, once for the name and once for the bytes. A real handle answers
    // both from the same file, so this one does too.
    return [{ name: file.name, getFile: async () => file }];
  };
}

/** Every control the page draws, with a path that survives a re-render. */
function listControls() {
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  return [...document.querySelectorAll('button, a[href], [role="button"]')]
    .filter((element) => !element.disabled && visible(element))
    .map((element) => ({
      selector: window.__monkeyPath(element),
      label:
        (element.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) ||
        element.getAttribute('aria-label') ||
        String(element.className || element.tagName)
    }));
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
    await page.goto(artifactUrl(ARTIFACT), { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  return outcome;
}

/**
 * Refuse every request that is not local, keeping a list of what was refused.
 *
 * The artifact's promise is that it runs with no network, so the run is offline by
 * construction. Only the phases that need the engine behind the artifact allow an origin of
 * this process's own, and nothing else.
 */
async function guardExternal(page, allowed = []) {
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = request.url();
    if (/^(file|data|blob|about):/i.test(url)) return void request.continue();
    if (allowed.some((prefix) => url.startsWith(prefix))) return void request.continue();
    blocked.push(url);
    void request.abort();
  });
}

/** An evaluate that a navigation cannot blow up, because a page under test may move. */
async function safeEvaluate(page, fn, ...args) {
  try {
    return await page.evaluate(fn, ...args);
  } catch (error) {
    return { unreadable: String(error.message).split('\n')[0] };
  }
}

/**
 * Press every control the page draws, then hammer Enter and Escape.
 *
 * A field test clicks what it means to click. This clicks everything, once, in whatever order
 * the page drew it, and then presses the two keys a person reaches for fastest until the page
 * gives up or does not. What it is looking for is the wedge: a control whose effect cannot be
 * undone by Escape, or by closing the dialog it opened.
 */
async function spamControls(page) {
  // Read through the navigation-proof helper: the phase before this one presses Enter at
  // whatever a Tab landed on, and a mount that is still in flight can take the document away
  // between two lines. Skipping the phase is honest; crashing the report is not.
  const controls = await safeEvaluate(page, listControls);
  if (controls.unreadable) {
    notes.push(`controls: the page moved before the spam phase (${controls.unreadable}), so it was skipped`);
    return;
  }
  if (controls.length === 0) {
    notes.push('controls: the launcher drew no pressable control, which is odd enough to say out loud');
    return;
  }
  notes.push(`controls: pressed ${controls.length}: ${controls.map((control) => control.label).join(' | ')}`);
  /** A key press during a navigation throws; that is the page moving, not a fault. */
  const press = async (key) => {
    try {
      await page.keyboard.press(key);
    } catch {
      // Nothing to judge: the document under the keys has already been replaced.
    }
  };
  // A press that navigates is a press doing its job (`Back to the main launcher` is a
  // route), so the context going away is read as a navigation rather than a failure.
  const NAVIGATED = /Execution context was destroyed|Cannot find context|detached Frame/i;
  for (const control of controls.slice(0, 14)) {
    const before = page.url();
    const result = await safeEvaluate(page, (selector) => {
      const element = document.querySelector(selector);
      if (!element) return 'gone';
      element.click();
      return 'pressed';
    }, control.selector);
    if (result === 'gone') continue;
    await sleep(page, 250);
    const state = await safeEvaluate(page, () => ({
      alive: Boolean(window.__monkey && window.__monkey.alive) && Boolean(document.querySelector('main.container')),
      errors: window.__monkey ? window.__monkey.errors.slice() : [],
      overlays: document.querySelectorAll('.modal-overlay').length
    }));
    if (state.unreadable) {
      if (NAVIGATED.test(state.unreadable)) {
        notes.push(`controls: ${control.label} navigated the page, which is what it is for`);
      } else {
        finding('FAIL', 'controls', control.label, `the page could not be read after one press: ${state.unreadable}`);
      }
      await refresher(page);
      continue;
    }
    if (!state.alive && page.url() !== before) {
      // Two controls here are routes rather than dialogs: the way back out of a mounted
      // wiki, and a bookmark that hands the window to its own instance. A press that took
      // the address somewhere else is the control working, offline or not.
      notes.push(`controls: ${control.label} navigated away, which is what it is for`);
    } else if (!state.alive) {
      // The address did not move and the launcher is still not the page: that is the wedge
      // this phase exists to find, and no navigation explains it.
      finding('FAIL', 'controls', control.label, 'the launcher stopped being the page after one press');
    }
    if (state.errors.length > 0) finding('FAIL', 'controls', control.label, `one press raised ${state.errors.join(' | ')}`);
    // Escape is the way out of anything this page opens, and the x is the other half.
    await press('Escape');
    await sleep(page, 150);
    let left = await safeEvaluate(page, () => document.querySelectorAll('.modal-overlay').length);
    if (typeof left === 'number' && left > 0) {
      await safeEvaluate(page, () => {
        const close = document.querySelector('.modal-overlay .modal-close, .new-lith-close');
        if (close) close.click();
        return true;
      });
      await sleep(page, 150);
      left = await safeEvaluate(page, () => document.querySelectorAll('.modal-overlay').length);
    }
    if (typeof left === 'number' && left > 0) {
      finding('FAIL', 'controls', control.label, `what it opened could not be closed: ${left} overlay(s) left after Escape and the x`);
    }
    await refresher(page);
  }

  // The hammer: the two keys people actually press hard, alternating, with no pause to think.
  for (let index = 0; index < 12; index += 1) {
    await press(index % 3 === 2 ? 'Escape' : 'Enter');
    await sleep(page, 60);
  }
  const hammered = await safeEvaluate(page, () => ({
    alive: Boolean(window.__monkey && window.__monkey.alive) && Boolean(document.querySelector('main.container')),
    errors: window.__monkey ? window.__monkey.errors.slice() : [],
    overlays: document.querySelectorAll('.modal-overlay').length
  }));
  if (!hammered.alive && !hammered.unreadable) {
    finding('FAIL', 'controls', 'Enter and Escape', 'twelve presses of the two keys people press fastest left the launcher');
  }
  if (hammered.errors && hammered.errors.length > 0) {
    finding('FAIL', 'controls', 'Enter and Escape', `the hammer raised ${hammered.errors.join(' | ')}`);
  }
  if (typeof hammered.overlays === 'number' && hammered.overlays > 0) {
    notes.push(`controls: the Enter/Escape hammer left ${hammered.overlays} dialog overlay(s) open, which a person would then have to close by hand`);
  }
  await refresher(page);
}

/**
 * Open the fixtures three ways: through the picker, by dropping one on the page, and from a
 * link that carries tiddlers in its query string.
 *
 * The engine is served from this process, so a mount really boots instead of failing on a
 * refused fetch, and the judgement is the same in every case: the page must end as either the
 * wiki or the launcher, never blank, never with a payload's script running in the launcher's own
 * chrome.
 */
async function runOpenings(browser, served) {
  const origin = served.origin;
  const context = await browser.createBrowserContext();
  const mountErrors = [];
  let page;
  try {
    // A real paste is the one input a keystroke cannot imitate, so the clipboard is allowed
    // here. A browser that refuses the permission costs the phase its realism, never the run.
    await context.overridePermissions(origin, ['clipboard-read', 'clipboard-write']).catch(() => {});
    page = await context.newPage();
    page.setDefaultTimeout(4000);
    page.on('pageerror', (error) => {
      if (!isResourceNoise(error.message)) mountErrors.push(error.message);
    });
    page.on('console', (message) => {
      if (message.type() !== 'error' || isResourceNoise(message.text())) return;
      // This run's picker hands over a closure rather than a real handle, and the recent-list
      // write is refused because a function cannot be structured-cloned. That is this harness,
      // not the launcher, and letting it into every phase's error list makes them all fail for
      // the same wrong reason.
      if (/could not be cloned/i.test(message.text())) return;
      mountErrors.push(message.text());
    });
    await guardExternal(page, [origin]);
    await page.evaluateOnNewDocument(installStandIn, {
      vault: { exists: false, count: 0, path: 'C:/fixture/lithic-vault.json' },
      folder: 'C:/fixture',
      // Browser mount, not the desktop app: see `installStandIn`.
      bridge: false
    });
    await page.evaluateOnNewDocument(installPicker);

    const base = `${origin}/launcher.html?mode=webapp`;
    /**
     * Put the launcher back on screen, and say what happened if it will not come.
     *
     * A mount legitimately replaces the document, so every opening starts from a reload. When
     * the reload does not draw the launcher, the useful thing is the state it *did* draw: a
     * blank page, a wiki that stayed, or an artifact that did not boot are three different
     * faults, and a bare selector timeout names none of them.
     */
    const open = async () => {
      await page.goto(base, { waitUntil: 'domcontentloaded' });
      try {
        await page.waitForSelector('main.container', { timeout: 15000 });
      } catch (error) {
        const state = await safeEvaluate(page, () => ({
          title: document.title,
          url: location.href,
          wiki: Boolean(window.$tw && window.$tw.wiki),
          rendered: Boolean(document.querySelector('.tc-page-container, .tc-story-river, .tc-tiddler-frame')),
          body: (document.body?.innerHTML ?? '').slice(0, 120),
          monkey: Boolean(window.__monkey),
          errors: window.__monkey ? window.__monkey.errors.slice(0, 2) : []
        }));
        throw new Error(
          `the launcher did not come back: ${state.unreadable ?? JSON.stringify(state)}`
        );
      }
      await sleep(page, 250);
    };
    /**
     * Wait for the engine, and say whether it arrived *whole*.
     *
     * `$tw.wiki` on its own is not the answer: a document that breaks mid-store leaves a
     * half-built `$tw` behind, so the check asks for the method a booted wiki answers rather
     * than for the object a broken one happens to have created.
     */
    const boot = async (timeout = MOUNT_TIMEOUT) => {
      try {
        await page.waitForFunction(
          () => Boolean(window.$tw && window.$tw.wiki && typeof window.$tw.wiki.getTiddlerText === 'function'),
          { polling: 200, timeout }
        );
        return true;
      } catch {
        return false;
      }
    };
    const describePage = async () =>
      safeEvaluate(page, () => ({
        url: location.href.slice(0, 120),
        title: document.title,
        body: (document.body?.innerHTML ?? '').slice(0, 120),
        wiki: Boolean(window.$tw && window.$tw.wiki && typeof window.$tw.wiki.getTiddlerText === 'function'),
        rendered: Boolean(document.querySelector('.tc-page-container, .tc-story-river, .tc-tiddler-frame')),
        launcher: Boolean(document.querySelector('main.container')),
        pwned: window.__monkey ? window.__monkey.pwned.slice() : [],
        errors: window.__monkey ? window.__monkey.errors.slice() : [],
        status: document.querySelector('.status-line.error, .mount-error, .status-line')?.textContent?.trim() || ''
      }));

    // --- through the picker -------------------------------------------------

    for (const fixture of chosenFixtures()) {
      await open();
      await page.evaluate((pick) => {
        window.__monkeyPick = pick;
      }, { url: `${origin}/fuzz/${fixture.id}`, name: `${fixture.id}.lith` });
      const errorsBefore = mountErrors.length;
      const started = Date.now();
      await page.evaluate(() => document.querySelector('.mount-button')?.click());
      const booted = await boot();
      const elapsed = Date.now() - started;
      const state = await describePage();
      const size = Math.round(Buffer.byteLength(textOf(fixture)) / 1024);
      const row = {
        surface: 'mount',
        box: labelOf(fixture),
        type: `${size} KB`,
        payload: booted ? 'booted' : 'no boot',
        typed: `${elapsed}ms`,
        held: state.rendered ? 'rendered' : state.launcher ? 'launcher' : 'blank',
        problems: []
      };
      const fresh = mountErrors.slice(errorsBefore);
      if (state.unreadable) {
        row.problems.push(`the page could not be read: ${state.unreadable}`);
      } else if (!state.wiki && !state.launcher) {
        row.problems.push('the page ended as neither the wiki nor the launcher');
      }
      if (state.wiki && !state.rendered && !state.launcher) {
        // The engine is there and answered as a wiki, yet the document drew neither a page
        // nor the launcher: the mount wrote a document it could not finish reading.
        row.problems.push('the engine booted but the page drew nothing');
      }
      if (fixture.id === 'valid' && !booted) {
        // The launcher says why it gave up on its own status line, so quote it rather than
        // making the reader guess between a missing engine and a slow one.
        row.problems.push(
          `a well-formed Lith did not boot${state.status ? ` (${state.status})` : ''}, so the rest of this pass proves nothing`
        );
      }
      if (state.pwned && state.pwned.length > 0) {
        notes.push(`mount ${fixture.id}: the payload's markup ran inside the wiki, which is the engine rendering a document rather than a launcher fault`);
      }
      // The recent list is written through the picked handle, and this run's handle is a
      // closure around a `File`: structured cloning refuses a function, so the write fails
      // every time. That is the stand-in talking, not the launcher, and saying it once is
      // enough for a reader not to go looking for a bug that lives here.
      const real = fresh.filter((text) => !/could not be cloned/i.test(text));
      if (fresh.length > real.length && !notes.some((note) => note.includes('stand-in handle'))) {
        notes.push('mount: the recent-list write is refused because the stand-in handle is a function, which the harness causes rather than the launcher');
      }
      if (!booted && real.length > 0) {
        notes.push(`mount ${fixture.id}: the engine did not boot (${real[0]})`);
      } else if (booted && real.length > 0) {
        notes.push(`mount ${fixture.id}: the engine booted and reported ${real.slice(0, 2).join(' | ')}`);
      }
      runs.push(row);
      for (const problem of row.problems) finding('FAIL', `mount / ${labelOf(fixture)}`, `${size} KB`, problem);
      if (VERBOSE) console.log(`  mount ${fixture.id} [${size} KB] ${row.payload} ${row.held} ${row.typed}`);
    }

    // --- by dropping one on the page ----------------------------------------

    if (DROPS) {
      const ids = ['valid', 'controls', 'script-body'];
      for (const id of ids) {
        const fixture = LITH_FIXTURES.find((entry) => entry.id === id);
        await open();
        await page.evaluate(async (pick) => {
          const text = await (await fetch(pick.url)).text();
          const transfer = new DataTransfer();
          transfer.items.add(new File([text], pick.name, { type: 'text/plain' }));
          window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
        }, { url: `${origin}/fuzz/${id}`, name: `${id}.lith` });
        await sleep(page, 400);
        const dropped = await describePage();
        if (dropped.unreadable) {
          finding('FAIL', `drop / ${fixture.label}`, `${id}.lith`, `the launcher could not be read after the drop: ${dropped.unreadable}`);
          continue;
        }
        runs.push({
          surface: 'drop',
          box: fixture.label,
          type: 'queued',
          payload: dropped.launcher ? 'launcher survived' : 'left the launcher',
          typed: '-',
          held: dropped.status || '-',
          problems: dropped.launcher ? [] : ['the drop left the launcher']
        });
        if (!dropped.launcher) finding('FAIL', `drop / ${fixture.label}`, `${id}.lith`, 'the drop left the launcher');
        if (dropped.pwned && dropped.pwned.length > 0) {
          finding('FAIL', `drop / ${fixture.label}`, `${id}.lith`, 'a dropped payload reached script in the launcher');
        }
        // A dropped Lith is queued rather than opened: it merges into the next mount, which is
        // the path a hostile tiddler actually reaches the engine through.
        await page.evaluate(() => document.querySelector('.new-blank-button')?.click());
        await page.waitForSelector('.new-lith-inline', { timeout: 4000 }).catch(() => {});
        await page.keyboard.press('Enter');
        const booted = await boot();
        const merged = await describePage();
        runs.push({
          surface: 'drop + open',
          box: fixture.label,
          type: 'merged',
          payload: booted ? 'booted' : 'no boot',
          typed: '-',
          held: merged.rendered ? 'rendered' : merged.launcher ? 'launcher' : 'blank',
          problems: []
        });
        if (!booted) notes.push(`drop + open ${id}: the queued tiddlers did not reach a booted engine`);
        if (merged.pwned && merged.pwned.length > 0) {
          notes.push(`drop + open ${id}: a queued payload's markup ran inside the wiki, which is the engine rendering a document`);
        }
      }
    }

    // --- from a link that carries tiddlers -----------------------------------

    if (PAYLOAD_URLS) {
      const cases = [
        { id: 'bad-base64', value: 'not base64!!' },
        { id: 'not-json', value: Buffer.from('this is not json').toString('base64') },
        { id: 'hostile-tiddlers', value: Buffer.from(JSON.stringify([{ title: '<img src=x onerror="window.__monkeyPwned=1">', text: 'x' }])).toString('base64') },
        { id: 'large-json', value: Buffer.from(`[${'x'.repeat(200_000)}]`).toString('base64') }
      ];
      for (const item of cases) {
        // The payload query is read on mount, so the page has to be loaded rather than only
        // opened; the launcher's own boot is what parses it.
        await page.goto(`${base}&json=${encodeURIComponent(item.value)}`, { waitUntil: 'domcontentloaded' }).catch(() => {});
        await sleep(page, 600);
        const state = await describePage();
        runs.push({
          surface: 'link',
          box: `?json=${item.id}`,
          type: `${item.value.length} chars`,
          payload: state.launcher ? 'launcher survived' : 'left the launcher',
          typed: '-',
          held: state.status || '-',
          problems: []
        });
        if (!state.launcher && !state.wiki) {
          // A blank page is three different faults, so quote what it actually is: a refused
          // navigation shows the previous URL, a failed boot shows the error page's body.
          finding(
            'FAIL',
            `link / ${item.id}`,
            '?json=',
            `a link carrying tiddlers left a blank page (${JSON.stringify({ url: state.url, title: state.title, body: state.body })})`
          );
        }
        if (state.pwned && state.pwned.length > 0) {
          finding('FAIL', `link / ${item.id}`, '?json=', 'a payload in the address reached script in the launcher');
        }
      }
    }

    // --- the edges a person reaches by accident ------------------------------

    /** One row per edge, in the same table as the files, because it judges the same page. */
    const edgeRow = ({ id, label, outcome, held, problems = [] }) => {
      runs.push({ surface: 'edge', box: label, type: id, payload: outcome, typed: '-', held, problems });
      for (const problem of problems) finding('FAIL', `edge / ${label}`, id, problem);
      if (VERBOSE) console.log(`  edge ${id}: ${outcome} ${held}${problems.length ? ` | ${problems.join('; ')}` : ''}`);
    };
    /** The Mount control is the launcher's own answer to "is it still working?". */
    const mountIdle = () =>
      page
        .waitForFunction(
          () => {
            const button = document.querySelector('.mount-button');
            return Boolean(button) && !button.disabled;
          },
          { polling: 100, timeout: 30000 }
        )
        .then(() => true)
        .catch(() => false);
    /** A page that says something in the status line, with what it said. */
    const waitForSaid = async (timeout = 8000) => {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const said = await safeEvaluate(
          page,
          () => document.querySelector('.status-line, .mount-error, .status-line.error')?.textContent?.trim() ?? ''
        );
        if (typeof said === 'string' && said.length > 0) return said;
        await sleep(page, 200);
      }
      return '';
    };
    const pickFixture = (id) =>
      page.evaluate(
        (pick) => {
          window.__monkeyPickMode = 'mount';
          window.__monkeyPick = pick;
        },
        { url: `${origin}/fuzz/${id}`, name: `${id}.lith` }
      );
    /**
     * Press Mount, but only once the launcher is idle.
     *
     * The button is disabled while the page is loading its own lists, and a press into a disabled
     * control is silently dropped: a phase that clicks the moment the container appears reports a
     * mount that never happened, and blames the launcher for it. Waiting is what makes the press
     * mean the thing the phase is testing.
     */
    const clickMount = async () => {
      await page
        .waitForFunction(
          () => {
            const button = document.querySelector('.mount-button');
            return Boolean(button) && !button.disabled;
          },
          { polling: 100, timeout: 15000 }
        )
        .catch(() => {});
      await page.evaluate(() => document.querySelector('.mount-button')?.click());
    };

    // A picker answered by cancellation. Nothing is opened, and the one thing that matters is
    // that the control comes back: a `busy` flag left on is the launcher refusing every later
    // press with no way to tell why.
    {
      await open();
      await page.evaluate(() => {
        window.__monkeyPickMode = 'cancel';
      });
      const errorsBefore = mountErrors.length;
      await clickMount();
      const idle = await mountIdle();
      await sleep(page, 200);
      const state = await describePage();
      const problems = [];
      if (!idle) problems.push('cancelling the picker left the Mount control disabled');
      if (!state.launcher) problems.push('the launcher was not the page afterwards');
      const fresh = mountErrors.slice(errorsBefore);
      if (fresh.length > 0) problems.push(`cancelling raised ${fresh[0]}`);
      edgeRow({
        id: 'picker-cancel',
        label: 'the picker is cancelled',
        outcome: idle ? 'back to idle' : 'stuck busy',
        held: state.launcher ? 'launcher' : 'left the launcher',
        problems
      });
    }

    // A picker that refuses. The page falls back to the classic input, which a person then
    // cancels by closing the chooser, and that answer has to land it back at idle too.
    {
      await open();
      await page.evaluate(() => {
        window.__monkeyPickMode = 'throw';
        // The fallback input is created and clicked without ever being attached to the page, so
        // the chooser it opens is only observable where the browser sees it. This answers the
        // press the way a person closing the chooser does: no files, so `change` fires empty.
        window.__monkeyFileInput = null;
        const click = HTMLInputElement.prototype.click;
        HTMLInputElement.prototype.click = function patched() {
          if (this.type === 'file') {
            window.__monkeyFileInput = this;
            setTimeout(() => this.dispatchEvent(new Event('change', { bubbles: true })), 50);
            return;
          }
          return click.call(this);
        };
      });
      await clickMount();
      await sleep(page, 500);
      const appeared = await page.evaluate(() => Boolean(window.__monkeyFileInput));
      const idle = await mountIdle();
      const state = await describePage();
      const problems = [];
      if (!appeared) problems.push('a picker that threw offered no fallback chooser to cancel');
      if (!idle) problems.push('the fallback chooser being cancelled left the Mount control disabled');
      if (!state.launcher) problems.push('the launcher was not the page afterwards');
      edgeRow({
        id: 'picker-throw',
        label: 'the picker refuses to open',
        outcome: appeared ? 'fallback chooser' : 'no chooser',
        held: state.launcher ? 'launcher' : 'left the launcher',
        problems
      });
    }

    // An engine that is not there at all: every candidate answers 404, so the launcher has to
    // say so and stay usable rather than sit on an empty document.
    {
      served.missEngine(true);
      try {
        await open();
        await pickFixture('valid');
        await clickMount();
        // Read the line only after the mount has stopped working: the first thing it says is
        // "Opening", which is true and says nothing about whether the engine was found.
        const idle = await mountIdle();
        const said = await waitForSaid(2000);
        const state = await describePage();
        const problems = [];
        const where = JSON.stringify({ url: state.url, title: state.title, body: state.body, status: state.status });
        if (!said) problems.push(`a mount with no engine anywhere said nothing at all ${where}`);
        if (!state.launcher) problems.push(`a mount with no engine left the launcher ${where}`);
        if (!idle) problems.push(`the Mount control stayed disabled after the engine failed ${where}`);
        edgeRow({
          id: 'engine-missing',
          label: 'the engine answers 404 everywhere',
          outcome: said ? 'said so' : 'silent',
          held: said.slice(0, 60) || state.status || '-',
          problems
        });
      } finally {
        served.missEngine(false);
      }
    }

    // An engine that takes 25 seconds. The wait itself is the test: the page has to still be the
    // launcher while it waits, and Escape has to work before the answer arrives.
    {
      await page.goto(`${origin}/slow/launcher.html?mode=webapp`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('main.container', { timeout: 15000 });
      await pickFixture('valid');
      const errorsBefore = mountErrors.length;
      await clickMount();
      await sleep(page, 1500);
      const waiting = await describePage();
      await page.keyboard.press('Escape').catch(() => {});
      await page.keyboard.press('Escape').catch(() => {});
      await sleep(page, 300);
      const escaped = await describePage();
      // The engine answers after 25 seconds, so the wait is that plus whatever the boot costs.
      const booted = await boot(MOUNT_TIMEOUT + SLOW_ENGINE_MS);
      const final = await describePage();
      const problems = [];
      if (!waiting.launcher) problems.push('the launcher was not the page while the engine was still loading');
      if (waiting.unreadable) problems.push(`the page could not be read during the wait: ${waiting.unreadable}`);
      if (escaped.unreadable) problems.push(`Escape during the wait left a page that could not be read: ${escaped.unreadable}`);
      if (!final.wiki && !final.launcher) problems.push('the slow engine ended as neither the wiki nor the launcher');
      const fresh = mountErrors.slice(errorsBefore);
      if (fresh.length > 0) problems.push(`waiting raised ${fresh[0]}`);
      edgeRow({
        id: 'engine-slow',
        label: 'the engine takes 25 seconds',
        outcome: booted ? 'booted late' : 'never booted',
        held: final.wiki ? 'wiki' : final.launcher ? 'launcher' : 'blank',
        problems
      });
    }

    // Two presses of the same control, in the same tick: the cheapest way to mount twice.
    {
      await open();
      await pickFixture('valid');
      const errorsBefore = mountErrors.length;
      await page.evaluate(() => {
        const button = document.querySelector('.mount-button');
        button?.click();
        button?.click();
      });
      const booted = await boot();
      const state = await describePage();
      const problems = [];
      if (!booted) problems.push('a double press did not mount at all');
      if (!state.wiki && !state.launcher) problems.push('a double press ended as neither the wiki nor the launcher');
      const fresh = mountErrors.slice(errorsBefore);
      if (fresh.length > 0) problems.push(`a double press raised ${fresh[0]}`);
      edgeRow({
        id: 'double-mount',
        label: 'Mount is pressed twice in one tick',
        outcome: booted ? 'one mount' : 'no mount',
        held: state.wiki ? 'wiki' : state.launcher ? 'launcher' : 'blank',
        problems
      });
    }

    // A dropped instance backup. `handleDrop` reads a `.json` as this device's own store before
    // it reads it as a tiddler array, and that branch had never been entered by a harness.
    {
      await open();
      const backup = JSON.stringify({
        format: 'lithic-instance-backup',
        version: 1,
        exportedAt: new Date(0).toISOString(),
        source: { mode: 'local', origin: null },
        recents: [{ name: 'imported.lith', text: 'title: Imported\n\nhello' }],
        wikis: [{ name: 'imported.lith', history: [], cache: null }],
        bookmarks: []
      });
      await page.evaluate(async (json) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([json], 'lithic-instance-backup.json', { type: 'application/json' }));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }, backup);
      await sleep(page, 900);
      const state = await safeEvaluate(page, () => ({
        launcher: Boolean(document.querySelector('main.container')),
        rows: [...document.querySelectorAll('.recent-row')].map((row) => row.textContent?.trim() ?? ''),
        status: document.querySelector('.status-line')?.textContent?.trim() ?? ''
      }));
      const problems = [];
      if (state.unreadable) problems.push(`the page could not be read after the backup: ${state.unreadable}`);
      else {
        if (!state.launcher) problems.push('dropping a backup left the launcher');
        if (!state.rows.some((row) => row.includes('imported.lith'))) {
          problems.push(`a dropped backup put no row in the list (${state.status || 'no status'})`);
        }
      }
      edgeRow({
        id: 'drop-backup',
        label: 'a dropped instance backup',
        outcome: state.rows?.some?.((row) => row.includes('imported.lith')) ? 'one row restored' : 'no row',
        held: (state.status || '-').slice(0, 60),
        problems
      });
    }

    // A drop of something the launcher does not open. It is ignored, which is defensible, and
    // silent, which is worth printing: the person sees a drop do nothing and has no way to ask.
    {
      await open();
      const dropped = await safeEvaluate(page, async () => {
        const forms = [
          new File(['plain notes'], 'notes.txt', { type: 'text/plain' }),
          new File(['{"not":"a tiddler array"}'], 'broken.json', { type: 'application/json' }),
          new File([''], 'folder-without-extension', { type: '' })
        ];
        const seen = [];
        for (const file of forms) {
          const transfer = new DataTransfer();
          transfer.items.add(file);
          window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
          await new Promise((done) => setTimeout(done, 200));
          seen.push({
            name: file.name,
            status: document.querySelector('.status-line, .mount-error')?.textContent?.trim() ?? '',
            rows: document.querySelectorAll('.recent-row').length
          });
        }
        return { alive: Boolean(document.querySelector('main.container')), seen };
      });
      const problems = [];
      if (dropped.unreadable) problems.push(`the page could not be read after the drops: ${dropped.unreadable}`);
      else if (!dropped.alive) problems.push('a dropped file the launcher does not open took the launcher away');
      const quiet = (dropped.seen ?? []).filter((entry) => !entry.status).map((entry) => entry.name);
      if (quiet.length > 0) {
        notes.push(`edge: a dropped ${quiet.join(', ')} is ignored without saying so; whether that wants a notice is a copy decision, not a crash`);
      }
      edgeRow({
        id: 'drop-other',
        label: 'a dropped .txt, a broken .json and an extensionless file',
        outcome: quiet.length === 0 ? 'said something' : `${quiet.length} ignored silently`,
        held: dropped.alive ? 'launcher' : 'left the launcher',
        problems
      });
    }

    // One gesture carrying two documents. Both files are read, in the order the gesture held
    // them, and a row's own ✕ takes only that row: the two things a person does after dragging
    // several Liths at once.
    {
      await open();
      await page.evaluate(
        async (picks) => {
          const transfer = new DataTransfer();
          for (const pick of picks) {
            const text = await (await fetch(pick.url)).text();
            transfer.items.add(new File([text], pick.name, { type: 'text/plain' }));
          }
          window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
        },
        [
          { url: `${origin}/fuzz/valid`, name: 'first.lith' },
          { url: `${origin}/fuzz/controls`, name: 'second.lith' },
          // The same fixture again: its three titles are already queued, and the panel has to
          // refuse them rather than draw six rows for four tiddlers.
          { url: `${origin}/fuzz/valid`, name: 'third.lith' }
        ]
      );
      await sleep(page, 600);
      const queued = await safeEvaluate(page, () => ({
        titles: [...document.querySelectorAll('.pending-imports .pending-title')].map((node) => node.textContent.trim()),
        label: document.querySelector('.pending-imports .pending-remove')?.getAttribute('aria-label') ?? null,
        note: document.querySelector('.pending-imports .pending-note')?.textContent?.trim() ?? null,
        launcher: Boolean(document.querySelector('main.container'))
      }));
      const expected = ['Getting Started', 'Notes', 'Code', 'ctl'];
      const problems = [];
      if (queued.unreadable) problems.push(`the page could not be read after the drop: ${queued.unreadable}`);
      else if (!queued.launcher) problems.push('a drop carrying three documents took the launcher away');
      else if (JSON.stringify(queued.titles) !== JSON.stringify(expected)) {
        problems.push(`a drop carrying three documents queued ${JSON.stringify(queued.titles)} rather than ${JSON.stringify(expected)}`);
      } else if (queued.label !== 'Remove Getting Started') {
        problems.push(`the first row's ✕ named ${JSON.stringify(queued.label)} rather than the row it removes`);
      } else if (queued.note !== '3 copies skipped: their titles are already queued.') {
        problems.push(`a repeated file's copies were ${JSON.stringify(queued.note)} rather than named as three skipped`);
      }
      // The row's own control, not the header's: removing one must leave the others queued.
      await page.evaluate(() => document.querySelector('.pending-imports .pending-remove')?.click());
      await sleep(page, 250);
      const afterOne = await safeEvaluate(page, () => ({
        titles: [...document.querySelectorAll('.pending-imports .pending-title')].map((node) => node.textContent.trim())
      }));
      if (!afterOne.unreadable) {
        const expectedAfter = ['Notes', 'Code', 'ctl'];
        if (JSON.stringify(afterOne.titles) !== JSON.stringify(expectedAfter)) {
          problems.push(`one row's ✕ left ${JSON.stringify(afterOne.titles)} rather than ${JSON.stringify(expectedAfter)}`);
        }
      }
      edgeRow({
        id: 'drop-many',
        label: 'a drop carrying three documents, one of them twice',
        outcome: `${(queued.titles ?? []).length} queued, ${(afterOne.titles ?? []).length} after one removed`,
        held: queued.launcher ? 'launcher' : 'left the launcher',
        problems
      });
    }

    // A queued tiddler that would replace one inside the file being opened. The mount asks
    // first, and both answers are checked: declining has to leave the launcher and the queue
    // where they were, and accepting has to actually land the queued copy in the wiki.
    {
      await open();
      await page.evaluate(() => {
        const text = 'title: Getting Started\ntype: text/vnd.tiddlywiki\n\nthe queued body';
        const transfer = new DataTransfer();
        transfer.items.add(new File([text], 'queued.lith', { type: 'application/x-lith' }));
        window.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
      });
      await sleep(page, 300);
      const answer = (label) =>
        page.evaluate((wanted) => {
          [...document.querySelectorAll('.confirm-modal .modal-action')]
            .find((node) => node.textContent.trim() === wanted)
            ?.click();
        }, label);
      await pickFixture('valid');
      await clickMount();
      const asked = await page
        .waitForSelector('.confirm-modal', { timeout: 8000 })
        .then(() =>
          safeEvaluate(page, () => ({
            title: document.querySelector('.confirm-modal h2')?.textContent?.trim() ?? null,
            body: document.querySelector('.confirm-modal p')?.textContent?.trim() ?? null
          }))
        )
        .catch(() => null);
      const problems = [];
      if (!asked || asked.unreadable) problems.push('opening a Lith over a queued title asked nothing');
      else if (asked.title !== 'Replace a tiddler in this Lith?') {
        problems.push(`the question before the merge was ${JSON.stringify(asked.title)}`);
      }
      await answer('Cancel');
      await sleep(page, 400);
      const declined = await describePage();
      const queueAfter = await safeEvaluate(page, () => ({
        titles: [...document.querySelectorAll('.pending-imports .pending-title')].map((node) => node.textContent.trim())
      }));
      if (!declined.launcher) problems.push('declining the replacement took the launcher away');
      else if (JSON.stringify(queueAfter.titles ?? []) !== JSON.stringify(['Getting Started'])) {
        problems.push(`declining left the queue as ${JSON.stringify(queueAfter.titles)} rather than untouched`);
      }
      await pickFixture('valid');
      await clickMount();
      await page.waitForSelector('.confirm-modal', { timeout: 8000 }).catch(() => {});
      await answer('Replace');
      const booted = await boot();
      const carried = await safeEvaluate(page, () => {
        try {
          return String(window.$tw?.wiki?.getTiddlerText?.('Getting Started') ?? '');
        } catch {
          return '';
        }
      });
      if (!booted) problems.push('accepting the replacement never booted the engine');
      else if (carried !== 'the queued body') {
        problems.push(`the queued copy did not land in the wiki (${JSON.stringify(carried)})`);
      }
      edgeRow({
        id: 'merge-collision',
        label: 'opening a Lith that already holds a queued title',
        outcome: asked ? 'asked, declined, then replaced' : 'asked nothing',
        held: booted ? 'wiki' : 'launcher',
        problems
      });
    }

    // A shared tiddler over a URL, which is the other half of `?json=` and a fetch the launcher
    // makes itself. The payload mounts a blank wiki and queues what it carried.
    {
      await page.goto(`${base}&url=${encodeURIComponent(`${origin}/payload/remote`)}`, { waitUntil: 'domcontentloaded' });
      const booted = await boot();
      // The launcher's own panel is the launcher's chrome, and a `?url=` payload mounts a blank
      // wiki before queueing it: where the tiddler has to arrive is the wiki itself.
      const state = await safeEvaluate(page, () => ({
        launcher: Boolean(document.querySelector('main.container')),
        carried: (() => {
          try {
            return String(window.$tw?.wiki?.getTiddlerText?.('RemoteTiddler') ?? '');
          } catch {
            return '';
          }
        })()
      }));
      const problems = [];
      if (!booted) problems.push('a ?url= payload did not boot the blank wiki');
      if (state.unreadable) problems.push(`the page could not be read after the payload: ${state.unreadable}`);
      else if (!state.carried) problems.push('a ?url= payload carried no tiddler into the wiki');
      edgeRow({
        id: 'url-payload',
        label: 'tiddlers shared over a URL',
        outcome: booted ? 'booted' : 'no boot',
        held: state.carried ? `carried ${JSON.stringify(state.carried.slice(0, 30))}` : '-',
        problems
      });
    }

    // A paste, with the clipboard really set, and an IME composition, which is how the name field
    // is used in half the world. Both are judged the way a field always is: the value arrives,
    // nothing in it becomes markup, and the launcher is still there.
    {
      await open();
      await page.click('.new-blank-button');
      await page.waitForSelector('.new-lith-inline');
      await page.click('.new-lith-field input');
      // A clipboard write needs the document focused, and a background tab is not.
      await page.bringToFront().catch(() => {});
      const hostile = 'pasted </script><img src=x onerror="window.__monkeyPwned=1">';
      await page.evaluate(async (text) => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          // Left to the note below: the paste is only realistic if the clipboard took it.
        }
      }, hostile);
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyV');
      await page.keyboard.up('Control');
      await sleep(page, 300);
      const pasted = await page.evaluate(() => ({
        value: document.querySelector('.new-lith-field input')?.value ?? '',
        pwned: window.__monkey ? window.__monkey.pwned.slice() : [],
        alive: Boolean(document.querySelector('main.container'))
      }));
      const pasteLanded = pasted.value.includes('onerror');
      if (!pasteLanded) {
        notes.push('edge: the clipboard could not be driven headlessly, so the paste phase ran as a keystroke-free no-op');
      }
      const composed = await page.evaluate(() => {
        const input = document.querySelector('.new-lith-field input');
        if (!input) return { value: null };
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.focus();
        input.value = 'み';
        input.dispatchEvent(new CompositionEvent('compositionstart', { data: 'm', bubbles: true }));
        input.value = 'みょうじ';
        input.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'みょうじ', bubbles: true }));
        input.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'みょうじ', isComposing: true }));
        input.dispatchEvent(new CompositionEvent('compositionend', { data: 'みょうじ', bubbles: true }));
        return { value: input.value, alive: Boolean(document.querySelector('main.container')) };
      });
      const problems = [];
      if (!pasted.alive) problems.push('a paste took the launcher away');
      if (pasted.pwned.length > 0) problems.push('a pasted payload reached script');
      if (composed.value === null) problems.push('the composition ended with no field to compose into');
      else if (composed.value !== 'みょうじ') problems.push(`the composed name arrived as ${JSON.stringify(composed.value)}`);
      if (!composed.alive) problems.push('an IME composition took the launcher away');
      edgeRow({
        id: 'paste-ime',
        label: 'a paste and an IME composition',
        outcome: pasteLanded ? 'paste landed' : 'paste not drivable',
        held: JSON.stringify((composed.value ?? '').slice(0, 12)),
        problems
      });
    }

    // A thousand rows and a hundred-kilobyte query, which is what a launcher accumulates after a
    // year of use. The judgement is that it still draws and still answers, not that it is fast:
    // nothing here has a budget, and a bound invented now would fail on a slower machine.
    {
      await page.evaluate(() => {
        localStorage.setItem(
          'lithic-recent-liths',
          JSON.stringify(Array.from({ length: 1000 }, (_value, index) => ({ name: `row-${index}.lith`, text: 'title: x' })))
        );
        localStorage.setItem(
          'lithic-bookmarks',
          JSON.stringify(Array.from({ length: 50 }, (_value, index) => ({ url: `https://instance-${index}.example`, label: `i${index}` })))
        );
      });
      const started = Date.now();
      await open();
      const drawn = Date.now() - started;
      const search = await page.evaluate(async (query) => {
        const box = document.querySelector('.recent-search');
        if (!box) return { missing: true };
        const at = Date.now();
        box.value = query;
        box.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise((done) => setTimeout(done, 600));
        return {
          typed: box.value.length,
          elapsed: Date.now() - at,
          rows: document.querySelectorAll('.recent-row').length,
          alive: Boolean(document.querySelector('main.container'))
        };
      }, 'x'.repeat(100_000));
      const problems = [];
      if (search.missing) problems.push('a thousand rows left no search box to type in');
      else {
        if (!search.alive) problems.push('a hundred-kilobyte query took the launcher away');
        if (search.rows > 0) problems.push(`a query nothing matches still drew ${search.rows} row(s)`);
      }
      edgeRow({
        id: 'accumulated',
        label: '1000 rows, 50 bookmarks and a 100 KB query',
        outcome: `drawn in ${drawn}ms`,
        held: search.missing ? 'no search box' : `${search.rows} rows, answered in ${search.elapsed}ms`,
        problems
      });
      notes.push('edge: the accumulated-state timing is reported, not asserted, because no budget for it has been decided');
    }

    // Storage that refuses the write. The cache is what makes an offline launcher work, and a
    // mount must not become a failure just because the copy cannot be kept.
    {
      await open();
      await page.evaluateOnNewDocument(() => {
        // Only the write is refused: the store still opens, which is what a full disk does.
        // Only the cache is refused. A full disk is this: the launcher's own store still works,
        // the copy of the wiki cannot be kept, and the mount has to survive it.
        const put = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = function refuse(value, key) {
          const at = typeof key === 'string' ? key : String(value && value.name ? value.name : '');
          if (at.startsWith('search_cache')) {
            throw new DOMException('the disk is full', 'QuotaExceededError');
          }
          return put.call(this, value, key);
        };
      });
      // `open()` loads the next document, which is the one the patch applies to, and settles it
      // before anything presses a control. A press into a page that has just drawn its first
      // frame lands before the handler exists, which reads as a launcher ignoring the click.
      await open();
      const probe = await page.evaluate(() => {
        window.__monkeySeenClicks = 0;
        const button = document.querySelector('.mount-button');
        button?.addEventListener('click', () => {
          window.__monkeySeenClicks += 1;
        }, { capture: true });
        return { picker: typeof window.showOpenFilePicker, button: Boolean(button), disabled: Boolean(button?.disabled) };
      });
      await pickFixture('valid');
      await clickMount();
      const early = await page.evaluate(() => ({
        clicks: window.__monkeySeenClicks ?? -1,
        picks: window.__monkeyPickCalls ?? -1,
        disabled: Boolean(document.querySelector('.mount-button')?.disabled)
      }));
      const booted = await boot();
      const state = await describePage();
      const problems = [];
      const where = JSON.stringify({ probe, early,
        url: state.url,
        status: state.status,
        errors: state.errors.slice(0, 2),
        asked: await page.evaluate(() => ({
          picks: window.__monkeyPickCalls ?? -1,
          disabled: Boolean(document.querySelector('.mount-button')?.disabled)
        })),
        said: await page.evaluate(
          () => (document.querySelector('main.container')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 240)
        )
      });
      if (!booted) problems.push(`a mount whose cache write fails did not boot ${where}`);
      if (!state.wiki && !state.launcher) problems.push(`a refused cache write ended as neither the wiki nor the launcher ${where}`);
      edgeRow({
        id: 'storage-full',
        label: 'the cache refuses to write',
        outcome: booted ? 'booted anyway' : 'did not boot',
        held: state.wiki ? 'wiki' : state.launcher ? 'launcher' : 'blank',
        problems
      });
    }
  } finally {
    await context.close().catch(() => {});
  }
}

// --- guardrails the repo already intends ------------------------------------

/**
 * Five claims the launcher already makes about its fields, restated as something that can
 * fail.
 *
 * Each one is observable through the page, and each one is a guardrail a person would
 * expect: a name that collides says so, a name that has to be changed says so, an address that
 * is not an address is refused, a PIN takes only what a PIN can hold, an empty name still
 * produces a document. They are here rather than in the Puppeteer suite because they are only
 * worth keeping if they still hold after a fuzz pass has stirred the same dialogs up.
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
    id: 'name-rewrite',
    title: 'a name the launcher has to change says so',
    claim: 'typing a path shows the name it will be saved under, and an ordinary name shows nothing',
    run: async (page) => {
      await page.click('.new-blank-button');
      await page.waitForSelector('.new-lith-inline');
      await page.click('.new-lith-field input');
      // A separator is the case the rules merge: `a/b` and `a-b` both arrive at `a-b.lith`.
      await page.keyboard.type('a/b');
      await sleep(page, 350);
      const notice = await page.evaluate(() => document.querySelector('.new-lith-rename')?.textContent?.trim() ?? null);
      await page.evaluate(() => {
        const input = document.querySelector('.new-lith-field input');
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await page.keyboard.type('notes');
      await sleep(page, 350);
      const quiet = await page.evaluate(() => document.querySelector('.new-lith-rename') === null);
      await page.click('.new-lith-close');
      return { notice, quiet };
    },
    verdict: (result) => Boolean(result.notice) && result.notice.includes('a-b.lith') && !result.notice.includes('a/b') && result.quiet,
    detail: (result) => `notice=${JSON.stringify(result.notice)}, quietForPlainName=${result.quiet}`
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
 * hostile value *becomes* can be printed instead of inferred. A result carrying a control
 * character or a path separator is reported. The separator row is now an inverted assertion:
 * the name is sanitized to Windows' rules, so a separator surviving means that rule was
 * weakened rather than that the value was unlucky.
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

// --- what gets opened ------------------------------------------------------

/**
 * Opening is the half a field test cannot reach from a text box: a Lith is bytes, and bytes
 * arrive from a picker, a drop, or a link.
 *
 * The page is served over a loopback origin for these phases, because a mount needs the
 * engine beside the artifact and a `file://` document may not fetch one. Everything is still
 * local: the server is this process, on port 0, and every other request is refused.
 */
const DELIMITER = '\u2042\u2042\u2042';

/** A `.lith` file: headers, a blank line, the body, and the triple asterism between tiddlers. */
function lithFile(tiddlers) {
  return tiddlers
    .map((tiddler) => {
      const headers = Object.entries(tiddler)
        .filter(([key]) => key !== 'text')
        .map(([key, value]) => `${key}: ${value}`)
        .join('\n');
      return `${headers}\n\n${tiddler.text ?? ''}`;
    })
    .join(`\n${DELIMITER}\n`);
}

const BASE_TIDDLERS = [
  { title: 'Getting Started', text: 'A line of text.\n\n* one\n* two' },
  { title: 'Notes', tags: 'note', text: 'Some notes.' },
  { title: 'Code', type: 'text/x-python', text: 'print("hi")' }
];

const randomText = (length, rnd) => {
  const parts = [];
  for (let index = 0; index < length; index += 1) parts.push(String.fromCharCode(1 + Math.floor(rnd() * 255)));
  return parts.join('');
};

/**
 * One seeded mutation of a valid Lith, labelled with what it did.
 *
 * The point is not a random byte soup (that is the `binary` fixture) but a file that is *nearly*
 * a Lith: a truncation in the middle of a header, a delimiter run with no tiddlers, a body that
 * grew a NUL. Those are the shapes a parser meets when a write was interrupted or a file was
 * edited by hand, and they are where an index-of arithmetic goes wrong.
 */
/**
 * A seeded mutation of a valid Lith, made of one to three edits rather than one.
 *
 * One edit per seed was the first version, and it was too shallow to be worth a new round: a
 * hundred seeds produced a hundred near-identical files. Stacking edits is what produces the
 * shapes a real broken file has (a doubled header *and* a lost delimiter), and every operator
 * here is a thing a hand-edit, a merge conflict or a half-finished write really leaves.
 */
function mutate(text, rnd) {
  const operators = [
    ['flipped one character', (source) => {
      const at = Math.floor(rnd() * source.length);
      return source.slice(0, at) + String.fromCharCode(Math.floor(rnd() * 0xffff)) + source.slice(at + 1);
    }],
    ['junk spliced into the middle', (source) => {
      const at = Math.floor(rnd() * source.length);
      return source.slice(0, at) + '\u0000\u001b[31m<<now>>{]\u3300' + source.slice(at);
    }],
    ['truncated at half', (source) => source.slice(0, Math.floor(source.length * 0.5))],
    ['truncated mid-header', (source) => {
      const at = source.indexOf('title:') + 9;
      return source.slice(0, at);
    }],
    ['every delimiter doubled', (source) => source.split(DELIMITER).join(`${DELIMITER}${DELIMITER}`)],
    ['every delimiter removed', (source) => source.split(DELIMITER).join('')],
    ['CRLF everywhere', (source) => source.replace(/\n/g, '\r\n')],
    ['newlines removed', (source) => source.replace(/\n/g, ' ')],
    ['titles stripped', (source) => source.replace(/^title:.*$/gm, '')],
    ['a second title on every tiddler', (source) => source.replace(/^title: (.*)$/gm, 'title: $1\ntitle: dup')],
    ['a second tiddler whose title differs only by case', (source) =>
      `${source}\n${DELIMITER}\ntitle: ${BASE_TIDDLERS[0].title.toUpperCase()}\n\nsecond`],
    ['a delimiter inside a body', (source) => {
      const at = source.indexOf('\n\n');
      const cut = at >= 0 ? at + 2 + Math.floor((source.length - at) * 0.4) : Math.floor(source.length / 2);
      return `${source.slice(0, cut)}\n${DELIMITER}\n${source.slice(cut)}`;
    }],
    ['a space before every header colon', (source) => source.replace(/^([a-z-]+):/gm, '$1 :')],
    ['a byte-order mark in front', (source) => `\ufeff${source}`],
    ['the delimiter inside a title', (source) => source.replace(/^title: (.*)$/m, `title: $1 ${DELIMITER} trailing`)],
    ['no newline at the end', (source) => source.replace(/\n+$/, '')],
    ['tabs where the blank lines were', (source) => source.replace(/\n\n/g, '\n\t\n')]
  ];
  // One to three operators, drawn without replacement, so a seed can produce a file with two
  // things wrong with it. The label names every edit, which is what makes a failure in the
  // report reproducible rather than mysterious.
  const wanted = 1 + Math.floor(rnd() * 3);
  const remaining = [...operators];
  const chosen = [];
  while (chosen.length < wanted && remaining.length > 0) {
    chosen.push(...remaining.splice(Math.floor(rnd() * remaining.length), 1));
  }
  let mutated = text;
  for (const [, apply] of chosen) mutated = apply(mutated);
  return { label: chosen.map(([name]) => name).join(', then '), text: mutated };
}

/**
 * The corpus of files the launcher can be asked to open.
 *
 * Each one is a thing a person can really have: an interrupted write, a file edited by hand, a
 * document from somebody else, a wiki that grew until it stopped fitting anywhere sensible.
 */
const LITH_FIXTURES = [
  { id: 'valid', label: 'a well-formed Lith', note: 'the control: if this one does not open, nothing below means anything', build: () => lithFile(BASE_TIDDLERS) },
  { id: 'empty', label: 'a 0-byte file', note: 'the file a failed write leaves behind', build: () => '' },
  { id: 'delimiters', label: 'nothing but delimiters', note: '40 separators and no tiddler between them', build: () => DELIMITER.repeat(40) },
  { id: 'no-title', label: 'a tiddler with no title', note: 'the one header the format requires', build: () => 'text: no title here\n\nbody' },
  { id: 'duplicate-titles', label: 'two tiddlers with one title', note: 'the last writer wins, or something throws', build: () => lithFile([{ title: 'x', text: '1' }, { title: 'x', text: '2' }]) },
  { id: 'markup-title', label: 'a title that is markup', note: 'a title is drawn in rows; if it is ever interpolated as HTML, this runs', build: () => lithFile([{ title: '<img src=x onerror="window.__monkeyPwned=1">', text: 'x' }]) },
  { id: 'bracket-title', label: 'a title with filter brackets', note: '`]]` and `[[` in the one string filters are built from', build: () => lithFile([{ title: 'a]] b [[c', text: 'x' }]) },
  { id: 'controls', label: 'NUL, ESC and DEL in a body', note: 'what a binary got pasted into a text field leaves', build: () => lithFile([{ title: 'ctl', text: 'a\u0000b\u001b[31mc\u007f' }]) },
  { id: 'binary', label: 'random bytes read as text', note: 'a broken UTF-8 sequence in every field', build: (rnd) => randomText(4000, rnd) },
  { id: 'script-body', label: 'script and an image handler in a body', note: 'a tiddler body is rendered; whether this runs is the engine\'s answer, not the launcher\'s', build: () => lithFile([{ title: 'evil', text: '<script>window.__monkeyPwned=1</script><img src=x onerror="window.__monkeyPwned=1">' }]) },
  { id: 'huge-body', label: 'one 8 MB tiddler', note: 'a wiki that outgrew every list it is shown in', build: () => lithFile([{ title: 'huge', text: 'x'.repeat(8_000_000) }]) },
  { id: 'many-tiddlers', label: '2000 small tiddlers', note: 'the delimiter scan at scale', build: () => lithFile(Array.from({ length: 2000 }, (_value, index) => ({ title: `n${index}`, text: 'y' }))) },
  { id: 'mutated', label: 'a seeded mutation of a valid Lith', note: 'nearly a Lith, which is what an interrupted write leaves', build: (rnd) => mutate(lithFile(BASE_TIDDLERS), rnd) }
];

/**
 * Fixture text, built once per run and kept by the little server below.
 *
 * A build answers a string, or `{ text, label }` where the file was made by mutating one and the
 * label names what was done to it. The label travels into the report, because "a seeded mutation"
 * on its own is not enough to reproduce the file that broke something.
 */
const fixtureBuilt = new Map();
function built(fixture) {
  if (!fixtureBuilt.has(fixture.id)) {
    const result = fixture.build(random);
    fixtureBuilt.set(fixture.id, typeof result === 'string' ? { text: result, label: '' } : result);
  }
  return fixtureBuilt.get(fixture.id);
}
function textOf(fixture) {
  return built(fixture).text;
}
/** What a fixture is called in the report, saying what was done if it was made by mutating one. */
function labelOf(fixture) {
  const { label } = built(fixture);
  return label ? `${fixture.label} (${label})` : fixture.label;
}

/** Which fixtures this run opens: the control always, then a seeded sample of the rest. */
function chosenFixtures() {
  if (MOUNTS === 'off') return [];
  const control = LITH_FIXTURES.find((fixture) => fixture.id === 'valid');
  if (MOUNTS === 'all') return [control, ...LITH_FIXTURES.filter((fixture) => fixture !== control)];
  const rest = shuffled(LITH_FIXTURES.filter((fixture) => fixture !== control));
  return [control, ...rest.slice(0, Math.max(0, Number(MOUNTS) - 1))];
}

/** The engine beside the artifact, which is what a mount fetches. */
function enginePath() {
  const beside = join(dirname(ARTIFACT), 'lithic.html');
  if (existsSync(beside)) return beside;
  if (existsSync(resolve('src/lithic.html'))) return resolve('src/lithic.html');
  return null;
}

/**
 * A loopback origin serving the artifact, the engine and the fixtures.
 *
 * Not a stand-in instance: it answers four paths and nothing else, so a mount can read the
 * engine over the same origin rules a deployment uses without pretending to be one.
 */
/** How long the slow room takes to answer with an engine. */
const SLOW_ENGINE_MS = 25000;

async function startOrigin() {
  const engine = enginePath();
  const state = { engineMissing: false };
  if (!engine) return null;
  const engineBytes = readFileSync(engine);
  const send = (response, type, body) => {
    response.writeHead(200, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
    response.end(body);
  };
  // A `?json=` payload is tiddlers carried in a URL, and the interesting sizes are past the
  // 16 KB request line Node allows by default. The limit here is the harness's, so it is
  // raised rather than being mistaken for the launcher refusing an address.
  const server = createServer({ maxHeaderSize: 512 * 1024 }, (request, response) => {
    let path = '/';
    try {
      path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    } catch (error) {
      // Say what could not be parsed: this server exists to be trusted, so a request it
      // cannot route is a fact about the harness rather than about the launcher.
      response.writeHead(400).end(`bad request: ${JSON.stringify(request.url)} (${String(error.message)})`);
      return;
    }
    // Three rooms, because the engine's own failures are reached by changing where the page is:
    // `/` is the ordinary one, `/slow` makes the first engine answer take 25 seconds, and
    // `/noengine` has no engine under it at all. The launcher resolves its engine beside the
    // page first and then at the origin root, so the root paths are part of the answer too.
    const parts = path.split('/').filter(Boolean);
    const room = parts.length > 1 ? parts[0] : '';
    const file = parts[parts.length - 1] ?? '';
    const known = room === '' || room === 'slow' || room === 'noengine';
    if (known && file === 'launcher.html') return send(response, 'text/html; charset=utf-8', bytes);
    if (file === 'lithic.html') {
      // The launcher asks beside the page first and at the origin root after, so "no engine"
      // has to cover all four candidates, `/src/` included.
      if (room === 'noengine' || ((room === '' || room === 'src') && state.engineMissing)) {
        return response.writeHead(404, { 'Content-Type': 'text/plain' }).end('no engine here');
      }
      if (room === 'slow') {
        // Long enough that a person would give up, which is the point: the launcher has to
        // stay a launcher while it waits, and the way out has to work before the answer comes.
        return setTimeout(() => send(response, 'text/html; charset=utf-8', engineBytes), SLOW_ENGINE_MS);
      }
      return send(response, 'text/html; charset=utf-8', engineBytes);
    }
    if (path === '/payload/remote') {
      // What a `?url=` link fetches: tiddlers as a JSON array, the shape the launcher parses.
      return send(
        response,
        'application/json; charset=utf-8',
        JSON.stringify([{ title: 'RemoteTiddler', text: 'shared over a url' }])
      );
    }
    if (path.startsWith('/fuzz/')) {
      const fixture = LITH_FIXTURES.find((entry) => entry.id === path.slice('/fuzz/'.length));
      if (fixture) return send(response, 'text/plain; charset=utf-8', textOf(fixture));
    }
    response.writeHead(404).end('not found');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((done) => server.close(() => done())),
    /** Make the root engine answer 404, for the no-engine phase. */
    missEngine: (missing) => {
      state.engineMissing = Boolean(missing);
    }
  };
}

// --- the run ----------------------------------------------------------------

async function refresher(page) {
  // A navigation already in flight can take the context out from under `goto`, which is
  // not a launcher fault and not something to fail a run on: the retry is the answer. And a
  // reload that never lands is a note rather than a throw, because every caller's next move
  // is an evaluate that already copes with a page it cannot read: one unreachable page must
  // not take the whole report down with it.
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(artifactUrl(ARTIFACT), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('main.container', { timeout: 15000 });
      await sleep(page, 250);
      return true;
    } catch (error) {
      last = error;
      await sleep(page, 400);
    }
  }
  notes.push(`refresher: the launcher would not come back after three reloads (${String(last?.message).split('\n')[0]}), so the next step saw another page`);
  return false;
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
    await guardExternal(page);
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

    await page.goto(artifactUrl(ARTIFACT), { waitUntil: 'domcontentloaded' });
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
      for (const fixture of LITH_FIXTURES) {
        console.log(`  mount ${fixture.id} - ${fixture.label}`);
        console.log(`     ${fixture.note}`);
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

    // --- pressing everything ------------------------------------------------

    if (SPAM && !KEYBOARD_ONLY) {
      try {
        await spamControls(page);
      } catch (error) {
        // Same rule as the opening phases: a phase that cannot finish is a finding, and the
        // report still has to print.
        finding('FAIL', 'controls', '-', String(error.message).split('\n')[0]);
      }
    }

    // --- opening what the picker, a drop and a link can hand over -------------

    if (MOUNTS !== 'off' || DROPS || PAYLOAD_URLS) {
      const served = await startOrigin();
      if (!served) {
        notes.push('the opening phases were skipped: no lithic.html beside the artifact, so a mount has no engine to boot');
      } else {
        notes.push(`opening phases served from ${served.origin} for this run only`);
        try {
          await runOpenings(browser, served);
        } catch (error) {
          // A phase that cannot finish is a finding, not the end of the run: the report is the
          // whole point, and an uncaught error here used to take it down with the phase.
          finding('FAIL', 'openings', '-', String(error.message).split('\n')[0]);
        } finally {
          await served.close();
        }
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
    `normalizeLithName keeps a path separator in ${separators.length} corpus value${separators.length === 1 ? '' : 's'} (see the table). Names are sanitized to Windows' rules now, so a separator here means that rule was weakened.`
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
