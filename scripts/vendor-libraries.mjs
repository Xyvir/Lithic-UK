#!/usr/bin/env node
/**
 * scripts/vendor-libraries.mjs
 *
 * The updater for libraries baked INTO a Lithic plugin, the counterpart of `mirror.js`.
 *
 * `external.yml` covers third-party PLUGINS: they are fetched at build time into a gitignored
 * cache and never live in the repo. This covers the other shape: a library (pele, pdfjs-dist)
 * whose bytes are twiki-ized into a `.tid` inside a Lithic-authored plugin, so the plugin is
 * COMPLETE in the repo and the built wiki needs no network at all. Those bytes used to be
 * pasted in by hand, which meant three things nobody could answer later: which upstream file
 * they came from, which version they are, and whether the copy on disk still matches either.
 * `vendored.yml` is that answer and this script is what keeps it true.
 *
 *   node scripts/vendor-libraries.mjs            refresh every entry from upstream (latest)
 *   node scripts/vendor-libraries.mjs --check    offline: do the files match the lock?
 *   node scripts/vendor-libraries.mjs --dry-run  fetch and transform, write nothing
 *   node scripts/vendor-libraries.mjs --adopt    offline: seed the lock from what is in the repo
 *
 * Modes, and who runs which:
 *
 *   - refresh (default) is what the build runs, before `mirror.js` copies the plugins into the
 *     staging tree, so a prod build bakes upstream's newest release into the artifact. It runs
 *     on the same `main` push (and now the weekly schedule) that already stages a release pull
 *     request, which is where the resulting diff is reviewed. There is no second PR.
 *   - `--check` is the local gate and needs no network: a vendored `.tid` edited by hand, or a
 *     lock that no longer describes the tree, fails here rather than in a release.
 *   - `--adopt` is the bootstrap. It hashes what the repo already holds, so the mechanism can
 *     be switched on for files that predate it without inventing an upstream version for them.
 *
 * Pinning is OPT-IN, deliberately: an entry with no `pin:` follows upstream's latest release
 * every run, which is the point of the mechanism, and an entry with `pin:` is frozen at that
 * version until somebody removes the pin. The lock always records what was actually written,
 * so "latest" still leaves a trail: the release pull request shows the version in the lock diff
 * and the numbers in the job summary.
 *
 * What is written is the whole tiddler: the front matter already in the target file is kept
 * verbatim (title, type, module-type: those are Lithic's decisions about the module, not
 * upstream's), and the body is the fetched file, line endings normalized to CRLF, with the
 * entry's declared transform applied. Nothing else is touched, and there is no trailing newline
 * (see the `.tid` rule in agents.md).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const DEFAULT_MANIFEST = path.join(REPO_ROOT, 'vendored.yml');
const DEFAULT_LOCK = path.join(REPO_ROOT, 'vendored-lock.json');
const REGISTRY = 'https://registry.npmjs.org';
const FETCH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------------------
// Text and tiddler shape
// ---------------------------------------------------------------------------------------

/**
 * Every newline this script writes is CRLF.
 *
 * Repo `.tid` files are CRLF (agents.md), and the vendored bundles are no exception even
 * though upstream publishes them with LF, which is why the very first sync converts the line
 * endings. Getting this wrong is a whole-file diff on every run, so it is one function.
 */
export function normalizeNewlines(text) {
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
}

/**
 * Split a tiddler into the front matter (everything before the first blank line) and the body.
 *
 * `frontMatter` keeps its own line endings and does NOT include the blank separator; `body` is
 * the rest with any leading blank lines removed. A file with no blank line has no body, which
 * is what a broken target looks like, so the caller can say so instead of overwriting it.
 */
export function splitTiddler(text) {
  const normalized = normalizeNewlines(text);
  const separator = normalized.indexOf('\r\n\r\n');
  if (separator === -1) return { frontMatter: normalized, body: '' };
  const frontMatter = normalized.slice(0, separator);
  const body = normalized.slice(separator + 4).replace(/^(?:\r\n)+/, '');
  return { frontMatter, body };
}

/** The tiddler a fetched body becomes: the kept front matter, a blank line, the body. */
export function buildTiddler(frontMatter, body) {
  const front = normalizeNewlines(frontMatter).replace(/(?:\r\n)+$/, '');
  const content = normalizeNewlines(body).replace(/(?:\r\n)+$/, '');
  return `${front}\r\n\r\n${content}`;
}

/** The hash `--check` compares, and the one the lock records for the body alone. */
export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Apply an entry's declared transform.
 *
 * The manifest carries the transform as data rather than naming a function in this file, so a
 * new library needs no code: `replace` pairs are applied first (each one must be present, so an
 * upstream rename is a failed sync rather than a silently skipped edit) and `append` lines are
 * then added at the end. Both are the two things a twiki-ization actually needs.
 */
export function applyTransform(body, transform) {
  if (!transform) return body;
  // Normalized here as well as in the caller: `append` decides where the library's last line is
  // by looking for trailing newlines, and a body that still carries the upstream's LF ends would
  // survive that look and leave a blank gap before the appended line.
  let out = normalizeNewlines(body);
  for (const pair of transform.replace ?? []) {
    const from = String(pair.from);
    const to = String(pair.to);
    if (!out.includes(from)) {
      throw new Error(`transform replacement not found: ${JSON.stringify(from)}`);
    }
    out = out.split(from).join(to);
  }
  const lines = (transform.append ?? []).map(String);
  if (lines.length > 0) {
    out = `${out.replace(/(?:\r\n)+$/, '')}\r\n${lines.join('\r\n')}`;
  }
  return out;
}

/**
 * The declarations that make a fetched body plausible, checked before anything is written.
 *
 * An upstream package can be renamed, hijacked or replaced by a stub, and a build that quietly
 * bakes in 300 bytes of nothing is worse than one that fails. These are the cheapest possible
 * assertions (substrings and a size floor) and they belong to the entry, because only the entry
 * knows what its library looks like.
 */
export function assertLooksRight(entry, body) {
  const problems = [];
  const bytes = Buffer.byteLength(body, 'utf8');
  if (entry.minBytes && bytes < entry.minBytes) {
    problems.push(`${entry.name}: fetched body is ${bytes} bytes, under the ${entry.minBytes} byte floor`);
  }
  for (const needle of entry.expect ?? []) {
    if (!body.includes(String(needle))) {
      problems.push(`${entry.name}: fetched body does not contain ${JSON.stringify(String(needle))}`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------------------
// npm registry, tarballs and version comparison
// ---------------------------------------------------------------------------------------

/** Numeric segments only, which is all a semver precedence question needs here. */
export function compareVersions(a, b) {
  const left = String(a).split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const right = String(b).split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = Number.isFinite(left[index]) ? left[index] : 0;
    const r = Number.isFinite(right[index]) ? right[index] : 0;
    if (l !== r) return l > r ? 1 : -1;
  }
  return 0;
}

/** The version an unpinned entry should follow. */
export function latestVersion(packument) {
  const latest = packument?.['dist-tags']?.latest;
  if (typeof latest !== 'string' || !latest) {
    throw new Error('registry answer has no dist-tags.latest');
  }
  return latest;
}

/** Everything the fetch needs about one published version, or a clear failure. */
export function resolvedPackage(packument, version) {
  const published = packument?.versions?.[version];
  if (!published) {
    throw new Error(`${packument?.name ?? 'package'} has no published version ${version}`);
  }
  const tarball = published.dist?.tarball;
  if (!tarball) throw new Error(`${packument.name}@${version} has no tarball in the registry answer`);
  return { tarball, integrity: published.dist?.integrity ?? null, shasum: published.dist?.shasum ?? null };
}

/**
 * One file out of a `.tar.gz`, by exact path inside the archive.
 *
 * npm tarballs are plain ustar under gzip, so the format is a 512-byte header per entry (name,
 * size as octal at 124, type flag at 156, 155 bytes of prefix at 345) followed by the data
 * padded to 512. Only regular files are considered, and long-name (pax/GNU) headers are skipped
 * like any other entry they head. Written by hand rather than shelled out to `tar` so the build
 * behaves the same on the Ubuntu runner and on a Windows checkout, which is the machine this
 * gate runs on.
 */
export function extractTarEntry(gzipped, wantedPath) {
  const tar = zlib.gunzipSync(gzipped);
  const wanted = wantedPath.replace(/^\.?\//, '');
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = Number.parseInt(header.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 0);
    const name = prefix ? `${prefix}/${rawName}` : rawName;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if ((type === '0' || type === '\0' || type === '') && name.replace(/^\.?\//, '') === wanted) {
      return tar.subarray(dataStart, dataEnd);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return null;
}

function verifyTarballIntegrity(bytes, { integrity, shasum }, label) {
  if (integrity && integrity.startsWith('sha512-')) {
    const digest = crypto.createHash('sha512').update(bytes).digest('base64');
    if (`sha512-${digest}` !== integrity) {
      throw new Error(`${label}: tarball does not match the registry's sha512 integrity`);
    }
    return;
  }
  if (shasum) {
    const digest = crypto.createHash('sha1').update(bytes).digest('hex');
    if (digest !== shasum) throw new Error(`${label}: tarball does not match the registry's sha1 shasum`);
  }
}

async function fetchBytes(url, label) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'lithic-vendor-libraries' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${label}: ${response.status} ${response.statusText} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

function isNetworkFailure(error) {
  const message = String(error?.message ?? error);
  return /fetch failed|ENOTFOUND|EAI_AGAIN|ECONN|ETIMEDOUT|socket|network|aborted|timeout/i.test(message);
}

// ---------------------------------------------------------------------------------------
// Entry pipeline
// ---------------------------------------------------------------------------------------

function entrySourceLabel(entry, version) {
  if (entry.package) return `${entry.package}@${version} ${entry.file ?? ''}`.trim();
  return `${entry.url}`;
}

/** Fetch one entry from upstream and return the tiddler text it should become. */
async function renderEntry(entry, { pinOverride, log }) {
  let version = pinOverride ?? entry.pin ?? null;
  let integrity = null;
  let sourceUrl = entry.url ?? null;

  if (entry.package) {
    const packumentUrl = `${REGISTRY}/${encodeURIComponent(entry.package).replace(/%40/g, '@')}`;
    const packument = JSON.parse((await fetchBytes(packumentUrl, `${entry.name}: registry`)).toString('utf8'));
    if (!version) version = latestVersion(packument);
    const resolved = resolvedPackage(packument, version);
    sourceUrl = resolved.tarball;
    integrity = resolved;
    log(`${entry.name}: ${entry.package}@${version}${entry.pin ? ' (pinned)' : ''}`);
    const tarball = await fetchBytes(sourceUrl, `${entry.name}: tarball`);
    verifyTarballIntegrity(tarball, integrity, entry.name);
    if (!entry.file) throw new Error(`${entry.name}: an npm entry must name the file inside the package`);
    const extracted = extractTarEntry(tarball, `package/${entry.file.replace(/^\.?\//, '')}`);
    if (!extracted) throw new Error(`${entry.name}: ${entry.file} is not in ${entry.package}@${version}`);
    const text = extracted.toString('utf8');
    return { version, sourceUrl, sourceText: text, label: entrySourceLabel(entry, version) };
  }

  if (!entry.url) throw new Error(`${entry.name}: needs either package + file, or url`);
  // A URL entry has no version to discover: it is the same address every run, and the lock is
  // what says whether its bytes moved.
  const bytes = await fetchBytes(entry.url, `${entry.name}: url`);
  return {
    version: version ?? null,
    sourceUrl,
    sourceText: bytes.toString('utf8'),
    label: entrySourceLabel(entry, version ?? 'unversioned')
  };
}

/** Read the target's front matter, refusing a file that has none. */
export function readTargetFrontMatter(absoluteTarget, name) {
  if (!fs.existsSync(absoluteTarget)) {
    throw new Error(`${name}: target is missing (${absoluteTarget}); the front matter it should keep is not there`);
  }
  const { frontMatter } = splitTiddler(fs.readFileSync(absoluteTarget, 'utf8'));
  if (!/^title:/m.test(frontMatter)) {
    throw new Error(`${name}: target has no title: line in its front matter (${absoluteTarget})`);
  }
  return frontMatter;
}

// ---------------------------------------------------------------------------------------
// Lockfile
// ---------------------------------------------------------------------------------------

function readLock(lockPath) {
  if (!fs.existsSync(lockPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (error) {
    throw new Error(`${path.relative(REPO_ROOT, lockPath)} is not valid JSON: ${error.message}`);
  }
}

function writeLock(lockPath, lock) {
  const ordered = Object.fromEntries(Object.keys(lock).sort().map((key) => [key, lock[key]]));
  fs.writeFileSync(lockPath, `${JSON.stringify(ordered, null, 2)}\n`);
}

// ---------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------

const colors = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (text) => (colors ? `\x1b[2m${text}\x1b[0m` : text);
const bold = (text) => (colors ? `\x1b[1m${text}\x1b[0m` : text);

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Refresh every entry.
 *
 * Returns the summary rows so the caller can publish them: a weekly run that changes a version
 * has to say so somewhere a reviewer looks, and a job summary is that place.
 */
export async function refresh({ manifest, lockPath, only, dryRun, bestEffort, pinOverrides, log: say }) {
  const lock = readLock(lockPath);
  const rows = [];
  const failures = [];
  for (const entry of manifest) {
    if (only && !only.includes(entry.name)) continue;
    const absoluteTarget = path.join(REPO_ROOT, entry.target);
    const previous = lock[entry.name] ?? null;
    try {
      const fetched = await renderEntry(entry, { pinOverride: pinOverrides?.[entry.name], log: say });
      const frontMatter = readTargetFrontMatter(absoluteTarget, entry.name);
      const body = normalizeNewlines(fetched.sourceText);
      const transformed = applyTransform(body, entry.transform);
      const problems = assertLooksRight(entry, transformed);
      if (problems.length > 0) throw new Error(problems.join('; '));
      const text = buildTiddler(frontMatter, transformed);
      const bodyHash = sha256(splitTiddler(text).body);
      const current = fs.existsSync(absoluteTarget) ? fs.readFileSync(absoluteTarget, 'utf8') : '';
      const changed = current !== text;
      if (changed && !dryRun) fs.writeFileSync(absoluteTarget, text);
      // A version of `unrecorded` is the bootstrap state (see --adopt), not a version, so it
      // must not read as "major jump" in the summary a reviewer sees.
      const previousVersion = previous?.version && /^\d/.test(previous.version) ? previous.version : null;
      const major = Boolean(
        previousVersion &&
          compareVersions(fetched.version ?? '0', previousVersion) !== 0 &&
          String(fetched.version ?? '').split('.')[0] !== previousVersion.split('.')[0]
      );
      const fromTo = previousVersion
        ? `${previousVersion} -> ${fetched.version ?? 'unversioned'}`
        : `${fetched.version ?? 'unversioned'}`;
      rows.push({
        name: entry.name,
        version: fetched.version ?? 'unversioned',
        from: previousVersion,
        target: entry.target,
        changed,
        dryRun,
        major,
        status: dryRun ? (changed ? 'would update' : 'up to date') : changed ? 'updated' : 'up to date',
        detail: fromTo
      });
      if (!dryRun) {
        // `fetchedAt` is kept when nothing moved, so a weekly run that found nothing new leaves
        // the lock byte-identical: a timestamp that churns every run turns "did anything change"
        // into a question the lock diff cannot answer.
        const upstreamHash = sha256(fetched.sourceText);
        const unchanged =
          previous &&
          previous.version === fetched.version &&
          previous.upstreamSha256 === upstreamHash &&
          previous.bodySha256 === bodyHash;
        lock[entry.name] = {
          source: fetched.label,
          version: fetched.version,
          url: fetched.sourceUrl,
          target: entry.target,
          upstreamSha256: upstreamHash,
          bodySha256: bodyHash,
          fetchedAt: unchanged ? previous.fetchedAt : new Date().toISOString()
        };
      }
      say(`${changed ? (dryRun ? '~' : '*') : ' '} ${entry.name}: ${fromTo}${changed ? '' : dim(' (unchanged)')}`);
    } catch (error) {
      const message = String(error?.message ?? error);
      const network = isNetworkFailure(error);
      if (bestEffort && network) {
        say(`! ${entry.name}: ${message}${dim(' (kept the bytes already in the repo)')}`);
        rows.push({
          name: entry.name,
          version: previous?.version ?? 'unversioned',
          from: previous?.version ?? null,
          target: entry.target,
          changed: false,
          dryRun,
          status: 'kept (upstream unreachable)',
          detail: message
        });
        continue;
      }
      failures.push(`${entry.name}: ${message}`);
      rows.push({
        name: entry.name,
        version: 'unknown',
        from: previous?.version ?? null,
        target: entry.target,
        changed: false,
        dryRun,
        status: 'FAILED',
        detail: message
      });
    }
  }
  if (!dryRun && failures.length === 0) writeLock(lockPath, lock);
  return { rows, failures };
}

/**
 * Offline integrity: the file on disk is the file the lock describes.
 *
 * This is the half that catches the thing the mechanism exists to prevent, a vendored `.tid`
 * edited in place. It also catches a lock that no longer lists the manifest's entries, a pin
 * that disagrees with what was written, and a target whose front matter lost its title.
 */
/**
 * One entry's offline verification, against an absolute target.
 *
 * Exported so the test can point it at a temp directory: the rule it enforces (the body on disk
 * is the body the lock describes) is the whole point of the lock, and it is worth a test that
 * does not depend on the real plugins being untouched.
 */
export function verifyEntry(entry, recorded, absoluteTarget) {
  if (!recorded) throw new Error('no vendored-lock.json entry: run node scripts/vendor-libraries.mjs or --adopt');
  if (recorded.target !== entry.target) {
    throw new Error(`lock targets ${recorded.target}, the manifest targets ${entry.target}`);
  }
  if (entry.pin && recorded.version !== entry.pin) {
    throw new Error(`pinned to ${entry.pin}, the lock says ${recorded.version}`);
  }
  readTargetFrontMatter(absoluteTarget, entry.name);
  const text = fs.readFileSync(absoluteTarget, 'utf8');
  // The shape complaint comes first: a file that ends with a newline would otherwise be reported
  // as a body-hash mismatch, which points at the wrong thing.
  if (/[\r\n]$/.test(text)) throw new Error('the tiddler ends with a newline');
  const { body } = splitTiddler(text);
  if (sha256(body) !== recorded.bodySha256) {
    throw new Error('the body on disk is not the body the lock describes (edited by hand, or never refreshed)');
  }
  const problems = assertLooksRight(entry, body);
  if (problems.length > 0) throw new Error(problems.join('; '));
  return body;
}

/**
 * One entry's adoption: the lock record for the bytes already in the tree.
 *
 * `version` is the pin when there is one, else whatever the lock already said, else
 * `unrecorded`. That last value is honest rather than a guess: the file predates the manifest and
 * nothing in it names a version, so the first refresh is what fills that in for real.
 */
export function adoptEntry(entry, previous, absoluteTarget) {
  readTargetFrontMatter(absoluteTarget, entry.name);
  const text = fs.readFileSync(absoluteTarget, 'utf8');
  const { body } = splitTiddler(text);
  const problems = assertLooksRight(entry, body);
  if (problems.length > 0) throw new Error(problems.join('; '));
  return {
    source: previous?.source ?? `${entry.package ?? entry.url ?? entry.name} (adopted from the repo)`,
    version: entry.pin ?? previous?.version ?? 'unrecorded',
    url: previous?.url ?? entry.url ?? null,
    target: entry.target,
    upstreamSha256: previous?.upstreamSha256 ?? null,
    bodySha256: sha256(body),
    fetchedAt: previous?.fetchedAt ?? new Date().toISOString()
  };
}

export function check({ manifest, lockPath }) {
  const lock = readLock(lockPath);
  const problems = [];
  const rows = [];
  for (const entry of manifest) {
    const absoluteTarget = path.join(REPO_ROOT, entry.target);
    const recorded = lock[entry.name];
    try {
      verifyEntry(entry, recorded, absoluteTarget);
      rows.push({ name: entry.name, version: recorded.version ?? 'unversioned', status: 'ok', detail: entry.target });
    } catch (error) {
      problems.push(`${entry.name}: ${String(error?.message ?? error)}`);
      rows.push({ name: entry.name, version: recorded?.version ?? 'unknown', status: 'FAILED', detail: String(error?.message ?? error) });
    }
  }
  const names = new Set(manifest.map((entry) => entry.name));
  for (const name of Object.keys(lock)) {
    if (!names.has(name)) problems.push(`${name}: lock entry has no manifest entry`);
  }
  return { rows, problems };
}

/**
 * Seed the lock from what the repo already holds, with no network.
 *
 * The vendored files predate this script, so the honest first record is a hash of the bytes in
 * the tree rather than an invented upstream version. The first refresh replaces it with a real
 * one, and until then `--check` still does its job: it can tell that nobody edited the file.
 */
export function adopt({ manifest, lockPath }) {
  const lock = readLock(lockPath);
  const rows = [];
  const problems = [];
  for (const entry of manifest) {
    const absoluteTarget = path.join(REPO_ROOT, entry.target);
    try {
      lock[entry.name] = adoptEntry(entry, lock[entry.name], absoluteTarget);
      rows.push({ name: entry.name, version: lock[entry.name].version, status: 'adopted', detail: entry.target });
    } catch (error) {
      problems.push(`${entry.name}: ${String(error?.message ?? error)}`);
      rows.push({ name: entry.name, version: 'unknown', status: 'FAILED', detail: String(error?.message ?? error) });
    }
  }
  if (problems.length === 0) writeLock(lockPath, lock);
  return { rows, problems };
}

/** The markdown the workflow step summary and the log both carry. */
export function renderSummary(rows, { title }) {
  const lines = [`### ${title}`, '', '| library | version | result | note |', '| --- | --- | --- | --- |'];
  for (const row of rows) {
    // The note is what a reviewer reads first: a version that moved, a body that moved under
    // the same version, or why the row failed.
    const note = row.major
      ? `major jump: ${row.detail}`
      : row.from && row.version && row.from !== row.version
        ? `${row.from} -> ${row.version}`
        : row.from && row.changed
          ? `content changed at ${row.version}`
          : row.detail ?? '';
    lines.push(`| ${row.name} | ${row.version} | ${row.status} | ${String(note).replace(/\|/g, '\\|')} |`);
  }
  const changed = rows.filter((row) => row.changed).length;
  lines.push('', changed === 0 ? 'No vendored bytes changed.' : `${changed} vendored file${changed === 1 ? '' : 's'} changed.`);
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = {
    check: false,
    adopt: false,
    dryRun: false,
    bestEffort: false,
    only: null,
    summary: null,
    manifest: DEFAULT_MANIFEST,
    lock: DEFAULT_LOCK,
    pins: {}
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--check') options.check = true;
    else if (arg === '--adopt') options.adopt = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--best-effort') options.bestEffort = true;
    else if (arg === '--only') options.only = (options.only ?? []).concat(argv[++index] ?? '');
    else if (arg === '--summary') options.summary = argv[++index];
    else if (arg === '--manifest') options.manifest = path.resolve(argv[++index]);
    else if (arg === '--lock') options.lock = path.resolve(argv[++index]);
    else if (arg === '--pin') {
      const pair = String(argv[++index] ?? '');
      const [name, version] = pair.split('=');
      if (!name || !version) throw new Error(`--pin wants name=version, got ${JSON.stringify(pair)}`);
      options.pins[name] = version;
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`unknown argument ${arg}`);
    }
  }
  if (options.check && options.adopt) throw new Error('--check and --adopt are different questions');
  return options;
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) throw new Error(`${path.relative(REPO_ROOT, manifestPath)} is missing`);
  const parsed = loadYaml(fs.readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${path.relative(REPO_ROOT, manifestPath)} must be a list of entries`);
  const seen = new Set();
  for (const entry of parsed) {
    if (!entry?.name) throw new Error('every vendored entry needs a name');
    if (seen.has(entry.name)) throw new Error(`duplicate vendored entry ${entry.name}`);
    seen.add(entry.name);
    if (!entry.target) throw new Error(`${entry.name}: every entry needs a target .tid`);
    if (!entry.package && !entry.url) throw new Error(`${entry.name}: needs package + file, or url`);
    if (entry.package && !entry.file) throw new Error(`${entry.name}: an npm entry needs the file inside the package`);
  }
  return parsed;
}

const USAGE = `Usage: node scripts/vendor-libraries.mjs [options]

  (no option)     fetch every entry from upstream and rewrite its tiddler
  --check         offline: the files on disk must match vendored-lock.json
  --adopt         offline: seed the lock from what the repo already holds
  --dry-run       fetch and transform, write nothing (says what would change)
  --only <name>   one entry (repeatable)
  --pin <name=v>  pretend the entry is pinned to that version (for reproduction)
  --best-effort   an unreachable upstream keeps the repo's bytes (CI); integrity
                  and plausibility failures still fail
  --summary <p>   write the markdown summary to a path as well as stdout
  --manifest <p>  a different manifest (default vendored.yml)
  --lock <p>      a different lock (default vendored-lock.json)`;

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    log(String(error.message));
    log(USAGE);
    return 2;
  }
  if (options.help) {
    log(USAGE);
    return 0;
  }

  let manifest;
  try {
    manifest = readManifest(options.manifest);
  } catch (error) {
    log(`FAIL ${String(error.message)}`);
    return 1;
  }

  if (options.check) {
    const { rows, problems } = check({ manifest, lockPath: options.lock });
    for (const row of rows) log(`${row.status === 'ok' ? ' ' : 'x'} ${row.name}: ${row.detail}`);
    if (problems.length > 0) {
      log(bold(`\nFAIL ${problems.length} vendored librar${problems.length === 1 ? 'y' : 'ies'} out of step:`));
      for (const problem of problems) log(`  - ${problem}`);
      log('  Run: node scripts/vendor-libraries.mjs   (or --adopt for a file that predates the manifest)');
      return 1;
    }
    log(bold(`\nOK - ${rows.length} vendored librar${rows.length === 1 ? 'y' : 'ies'} match the lock.`));
    return 0;
  }

  if (options.adopt) {
    const { rows, problems } = adopt({ manifest, lockPath: options.lock });
    for (const row of rows) log(`${row.status === 'adopted' ? ' ' : 'x'} ${row.name}: ${row.version}`);
    if (problems.length > 0) {
      log(bold(`\nFAIL ${problems.length} entr${problems.length === 1 ? 'y' : 'ies'} could not be adopted:`));
      for (const problem of problems) log(`  - ${problem}`);
      return 1;
    }
    log(bold('\nOK - the lock now describes the bytes in the repo.'));
    return 0;
  }

  log(bold(options.dryRun ? 'Vendored libraries: dry run' : 'Vendored libraries: refresh'));
  const { rows, failures } = await refresh({
    manifest,
    lockPath: options.lock,
    only: options.only,
    dryRun: options.dryRun,
    bestEffort: options.bestEffort,
    pinOverrides: options.pins,
    log: (message) => log(dim(`  ${message}`))
  });
  const summary = renderSummary(rows, { title: options.dryRun ? 'Vendored libraries (dry run)' : 'Vendored libraries' });
  if (options.summary) fs.writeFileSync(options.summary, summary);
  log(`\n${summary}`);
  if (failures.length > 0) {
    log(bold(`FAIL ${failures.length} vendored librar${failures.length === 1 ? 'y' : 'ies'} could not be refreshed:`));
    for (const failure of failures) log(`  - ${failure}`);
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().then((code) => process.exit(code));
}
