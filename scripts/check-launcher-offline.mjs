#!/usr/bin/env node
/**
 * Offline gate for the single-file launcher: `src/launcher.html`.
 *
 * The artifact is the whole app in one file — served by an instance, dropped on a
 * USB stick, opened from `file://` inside the desktop build — and its promise is
 * that it behaves the same with or without a network. A CDN reference, a font
 * from Google, a dynamically imported script, an image on somebody's host: any of
 * those turns "runs offline" into "runs, but looks like something else", and none
 * of them break the build or the smoke test. So this checks it directly.
 *
 * Two passes, because they catch different mistakes:
 *
 *   STATIC (always) — read the artifact as text and prove every *reference* in it
 *   is local. Two levels:
 *
 *     1. LOADS are never allowed to be external. A `src`/`href` on anything the
 *        engine fetches (script, link, img, iframe, source, track, object, embed,
 *        input, `use`), a CSS `@import`, a CSS `url(...)`: each must be `data:`,
 *        `blob:`, a relative path or a fragment. There is no allowlist here,
 *        because there is no version of this app that needs one.
 *     2. Every other absolute http(s) URL in the file — in a link a person
 *        clicks, in a thrown error, in a widget's endpoint — must be declared in
 *        `EXTERNAL` below, with a reason. A new host is a deliberate decision
 *        rather than something that arrives with a dependency.
 *
 *   RUNTIME (`--browser`) — boot the artifact over `file://` in headless Chrome
 *   with every non-local request aborted, drive a few interactions, and require
 *   that nothing external was even attempted. The static pass reads references;
 *   this proves the strings are not reaching for anything on the boot path.
 *
 * Usage:
 *   node scripts/check-launcher-offline.mjs                 # the committed artifact
 *   node scripts/check-launcher-offline.mjs ui-gallery/.build/launcher.html
 *   node scripts/check-launcher-offline.mjs --browser       # + the runtime pass
 *   node scripts/check-launcher-offline.mjs --list          # every URL, to review
 *
 * Exit 0 = self-contained; nonzero (with the reason) = fix before shipping.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const flags = argv.filter((arg) => arg.startsWith('-'));
const target = argv.find((arg) => !arg.startsWith('-'));
const ARTIFACT = resolve(target ?? 'src/launcher.html');
const BROWSER_PASS = flags.includes('--browser');
const LIST = flags.includes('--list');

/**
 * Every external URL the launcher is allowed to *name*, with the reason it is
 * there and what it is for. A host that is not listed here fails the gate: the
 * point is that a decision has to be made, not that URLs are banned.
 *
 * `kind` is the reviewer's summary; nothing reads it.
 */
const EXTERNAL = [
  {
    prefix: 'http://www.w3.org/',
    kind: 'namespace',
    why: 'XML and SVG namespaces (`xmlns=`). They look like addresses and are never fetched.'
  },
  {
    prefix: 'https://svelte.dev/',
    kind: 'message link',
    why: "Svelte's own error links, printed inside a thrown Error for whoever is reading a console."
  },
  {
    prefix: 'https://github.com/',
    kind: 'click target',
    why: 'The anchors a person clicks: the repository in the brand row, and the device-code page the sync dialog tells them to open.'
  },
  {
    prefix: 'https://lithic.uk/',
    kind: 'click target',
    why: 'The public site — the intro page and the full monolith download — reached by navigation, never by fetch on boot.'
  },
  {
    prefix: 'https://raw.githubusercontent.com/',
    kind: 'fetch',
    why: 'Two reads, both the ephemeral swarm widget: the bastion list in docs/swarm.json before a coderunner session, and intro.lith when the launcher is opened straight from file://, where no server exists to serve the intro. Offline both fail and the launcher carries on.'
  },
  {
    prefix: 'https://xyvir.github.io/',
    kind: 'fetch',
    why: 'The same swarm bastion list, from its Pages mirror.'
  },
  {
    prefix: 'https://instance.example',
    kind: 'placeholder',
    why: "Placeholder text in the bookmark dialog's address field, as the released artifact still spells it. It disappears on the next rebuild."
  }
];

/** Schemes that are not a network read: an inlined payload, or nothing at all. */
const LOCAL_SCHEME = /^(?:data:|blob:|about:)/i;
/** Anything with a scheme, and protocol-relative URLs, are somebody else's host. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** Elements whose attributes make the engine fetch something. */
const LOADING_TAGS = new Set([
  'script',
  'link',
  'img',
  'iframe',
  'frame',
  'source',
  'track',
  'audio',
  'video',
  'embed',
  'object',
  'input',
  'use',
  'image'
]);
/** The attributes on them that carry a URL. */
const LOADING_ATTRIBUTES = ['src', 'href', 'xlink:href', 'data', 'poster', 'formaction'];

function fail(lines) {
  console.error(`\ncheck-launcher-offline: ${lines.join('\n  ')}\n`);
  process.exit(1);
}

if (!existsSync(ARTIFACT)) {
  fail([`${ARTIFACT} is missing.`, 'Build it first: npm run build:launcher']);
}

const html = readFileSync(ARTIFACT, 'utf8');

/**
 * Every load in the file, local or not, as `{ url, tag, attribute }`.
 *
 * Read with regexes rather than a parser on purpose: this is a 400 KB single file
 * whose scripts contain HTML in strings (the saver's own template), and a parser
 * that is stricter than the browser would report the wrong file as broken.
 */
function loads() {
  const found = [];
  const tag = /<([a-zA-Z][-a-zA-Z0-9]*)\b([^>]*)>/g;
  const attribute = /([-a-zA-Z:]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let node;
  while ((node = tag.exec(html))) {
    const name = node[1].toLowerCase();
    if (!LOADING_TAGS.has(name)) continue;
    let attr;
    attribute.lastIndex = 0;
    while ((attr = attribute.exec(node[2]))) {
      if (!LOADING_ATTRIBUTES.includes(attr[1].toLowerCase())) continue;
      const url = (attr[2] ?? attr[3] ?? attr[4] ?? '').trim();
      if (url) found.push({ url, tag: name, attribute: attr[1].toLowerCase() });
    }
  }
  for (const match of html.matchAll(/@import\s+(?:url\()?\s*["']?([^"')]+)/gi)) {
    found.push({ url: match[1].trim(), tag: 'css', attribute: '@import' });
  }
  for (const match of html.matchAll(/url\(\s*["']?([^"')]+?)\s*["']?\s*\)/gi)) {
    const url = match[1].trim();
    if (!LOCAL_SCHEME.test(url) && !url.startsWith('#')) {
      found.push({ url, tag: 'css', attribute: 'url()' });
    }
  }
  return found;
}

/** Is this reference somebody else's host? */
const external = (url) => HAS_SCHEME.test(url) ? !LOCAL_SCHEME.test(url) : url.startsWith('//');

const all = loads();
const foreignLoads = all.filter((load) => external(load.url));

/**
 * Every absolute URL in the file, whether or not it loads anything, grouped so a
 * host is reported once with a count.
 *
 * The host has to start with an alphanumeric, so a scheme that is *completed* at
 * runtime — `https://${host}`, `'https://' + host` — is counted separately below
 * rather than reported as a host named `$`. Those are exactly the references this
 * pass cannot judge, which is what the runtime pass is for.
 */
function named() {
  const seen = new Map();
  for (const match of html.matchAll(/\bhttps?:\/\/[A-Za-z0-9][A-Za-z0-9._~%:/@!$&*+,;=()-]*/gi)) {
    const url = match[0].replace(/[.,;:)]+$/, '');
    seen.set(url, (seen.get(url) ?? 0) + 1);
  }
  return seen;
}

/**
 * Schemes with no host in the file at all: `https://${host}`, `'https://' + host`,
 * a `https://...` placeholder. Nothing here can judge those, and the count is
 * reported so the runtime pass is the thing that has to.
 */
const hostless = [...html.matchAll(/\bhttps?:\/\/(?![A-Za-z0-9])/g)].length;

const urls = named();
const declared = (url) => EXTERNAL.some((entry) => url.startsWith(entry.prefix) || url === entry.prefix.replace(/\/$/, ''));
const undeclared = [...urls.keys()].filter((url) => !declared(url));

if (LIST) {
  console.log(`\n${ARTIFACT} — ${urls.size} distinct external URLs\n`);
  for (const [url, count] of [...urls].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const entry = EXTERNAL.find((item) => url.startsWith(item.prefix));
    console.log(`  ${String(count).padStart(3)}  ${entry ? 'declared' : 'UNDECLARED'}  ${entry?.kind ?? '—'}  ${url.slice(0, 120)}`);
  }
  console.log('');
}

// --- the static verdict -----------------------------------------------------

const problems = [];
for (const load of foreignLoads) {
  problems.push(
    `external load: <${load.tag} ${load.attribute}="${load.url.slice(0, 100)}"> — every load in this file must be data:, blob:, relative or a fragment.`
  );
}
for (const url of undeclared) {
  problems.push(
    `undeclared external URL: ${url.slice(0, 140)}\n    Add it to EXTERNAL with the reason it is there, or remove the reference.`
  );
}
if (problems.length > 0) {
  fail([
    `${ARTIFACT} is not self-contained (${problems.length} problem${problems.length === 1 ? '' : 's'}):`,
    ...problems
  ]);
}

// Entries nothing matches are not failures — a URL can legitimately disappear —
// but a list that has rotted is worth saying out loud, because the next person
// reads it as a description of what the artifact contains.
const stale = EXTERNAL.filter((entry) => ![...urls.keys()].some((url) => url.startsWith(entry.prefix)));

console.log(`OK — ${ARTIFACT} names ${urls.size} external URLs, all declared, and loads nothing from any of them.`);
for (const entry of EXTERNAL) {
  const count = [...urls.keys()].filter((url) => url.startsWith(entry.prefix)).length;
  if (count > 0) console.log(`     ${entry.kind.padEnd(12)} ${entry.prefix} (${count})`);
}
for (const entry of stale) {
  console.log(`     ! declared but unused: ${entry.prefix} — keep or drop it deliberately`);
}
if (hostless > 0) {
  console.log(
    `     ${String(hostless).padStart(2)} \`https://\` with no host in the file (a placeholder, or a host added at runtime) — ` +
      'not judgeable here; --browser is what proves they stay local.'
  );
}

// --- the runtime pass -------------------------------------------------------

if (BROWSER_PASS) {
  const attempts = [];
  const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      const url = request.url();
      if (!/^(?:file|data|blob|about):/i.test(url)) {
        attempts.push(url);
        return void request.abort();
      }
      void request.continue();
    });
    await page.goto(`file://${ARTIFACT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('main.container', { timeout: 15000 });
    // A little of the app, so the pass is about more than one render: the search box
    // (when there is anything to search), the entry a new Lith is named in, and the
    // reload it leaves behind. Steps are guarded, because a first run has no recents
    // and this pass must not depend on the fixture a gallery pane gets.
    const steps = [
      async () => {
        const box = await page.$('input[aria-label="Search recent Liths"]');
        if (box) await box.type('offline');
      },
      async () => {
        await page.evaluate(() => {
          const button = [...document.querySelectorAll('button')].find((node) => node.textContent.includes('New Blank Lith'));
          button?.click();
        });
        await new Promise((done) => setTimeout(done, 300));
      },
      async () => page.keyboard.press('Escape'),
      async () => {
        await page.evaluate(() => document.querySelector('.brand-icon-wrap')?.click());
        await new Promise((done) => setTimeout(done, 300));
      }
    ];
    for (const step of steps) await step();
    await new Promise((done) => setTimeout(done, 600));
  } finally {
    await browser.close();
  }
  if (attempts.length > 0) {
    fail([
      `the launcher reached for the network on boot (${attempts.length} request${attempts.length === 1 ? '' : 's'}):`,
      ...[...new Set(attempts)].map((url) => `${url.slice(0, 140)}`)
    ]);
  }
  console.log('OK — booted over file:// and drove search + new-Lith with every non-local request aborted: nothing tried.');
}
