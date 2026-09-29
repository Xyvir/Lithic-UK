#!/usr/bin/env node
/**
 * The self-host language pin's gate.
 *
 * `deploy/pin-launcher-locale.sh` is the one place a deployment can pin a language without
 * rebuilding the launcher: it rewrites the redirector and the install manifest that a server
 * hands out, and never the released artifact, which is what lets the pin survive the
 * autoupdate that replaces that artifact. It runs in a container, at boot, on somebody
 * else's machine, which is exactly the kind of code that rots quietly: the three strings it
 * matches on live in files this repository keeps editing, and a `sed` that stops matching
 * does not fail, it just stops pinning.
 *
 * So every claim it makes is checked here, against the real `index.html` and the real
 * `manifest.json`, in a scratch copy: the language reaches the redirect and the start URL
 * and nothing else does, a language is still forwarded for a visitor who brought one,
 * running it twice changes nothing the second time, a value that is not a language tag is
 * refused rather than written into a document, and no locale set is no change at all.
 *
 * Run it before pushing (`npm run check:push` does).
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const HELPER = 'deploy/pin-launcher-locale.sh';
/** What a shipped launcher document looks like to the pin: a path it must never touch. */
const LAUNCHER = '<!doctype html>\r\n<html lang="en">\r\n<head></head>\r\n<body>launcher</body>\r\n</html>\r\n';

const failures = [];

/** A scratch deployment: the two documents a server hands out, and the artifact it serves. */
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'lithic-locale-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  copyFileSync('index.html', join(dir, 'index.html'));
  copyFileSync('manifest.json', join(dir, 'manifest.json'));
  writeFileSync(join(dir, 'src', 'launcher.html'), LAUNCHER);
  return dir;
}

/** Run the pin against a scratch deployment. `locale` of null means the variable is unset. */
function pin(dir, locale = null) {
  const env = { ...process.env };
  if (locale === null) delete env.LITHIC_LOCALE;
  else env.LITHIC_LOCALE = locale;
  return spawnSync('bash', [HELPER, dir], { encoding: 'utf8', env });
}

const read = (dir, ...parts) => readFileSync(join(dir, ...parts), 'utf8');

function expect(name, ok, detail = '') {
  if (ok) return;
  failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

/**
 * Where the redirector would send this visitor.
 *
 * The pinned line is JavaScript, so it is read as JavaScript: the argument to
 * `location.replace` is lifted out of the document and called with a stub window, which is
 * the only way to say what a visitor actually arrives at rather than what the file looks
 * like. A document with no redirect at all answers null.
 */
function redirectFor(html, { search = '', hash = '' } = {}) {
  const match = html.match(/window\.location\.replace\((.*)\);/);
  if (!match) return null;
  return new Function('window', `return (${match[1]});`)({ location: { search, hash } });
}

const dir = sandbox();
try {
  const originalIndex = read(dir, 'index.html');
  const originalManifest = read(dir, 'manifest.json');

  const untouched = pin(dir);
  expect('no locale set leaves the redirector alone', read(dir, 'index.html') === originalIndex);
  expect('no locale set leaves the manifest alone', read(dir, 'manifest.json') === originalManifest);
  expect('no locale set is not a failure', untouched.status === 0, `exit ${untouched.status}`);

  const pinned = pin(dir, 'es');
  expect('pinning a language succeeds', pinned.status === 0, pinned.stderr.trim());
  const index = read(dir, 'index.html');
  const manifest = read(dir, 'manifest.json');

  expect('a bare visit arrives in the pinned language', redirectFor(index) === 'src/launcher.html?lang=es', String(redirectFor(index)));
  expect(
    'a visit that brought a query keeps it',
    redirectFor(index, { search: '?mode=self-host&q=notes' }) === 'src/launcher.html?mode=self-host&q=notes',
    String(redirectFor(index, { search: '?mode=self-host&q=notes' }))
  );
  expect(
    'a fragment survives the pin',
    redirectFor(index, { hash: '#row-3' }) === 'src/launcher.html?lang=es#row-3',
    String(redirectFor(index, { hash: '#row-3' }))
  );
  expect(
    'an installed app opens in the pinned language',
    manifest.includes('"start_url": "src/launcher.html?lang=es"'),
    manifest.match(/"start_url": "[^"]*"/)?.[0] ?? 'no start_url'
  );
  expect(
    'the manifest version that autoupdate rewrites is left exact',
    manifest.match(/"version": "([^"]+)"/)?.[1] === originalManifest.match(/"version": "([^"]+)"/)?.[1]
  );
  expect('the served launcher is not modified', read(dir, 'src', 'launcher.html') === LAUNCHER);

  const again = pin(dir, 'es');
  expect('pinning twice is not a failure', again.status === 0, again.stderr.trim());
  expect('pinning twice changes nothing the second time', read(dir, 'index.html') === index);
  expect('pinning twice leaves the redirect working', redirectFor(read(dir, 'index.html')) === 'src/launcher.html?lang=es');

  const before = { index, manifest };
  const hostile = pin(dir, 'es";alert(1)//');
  expect('a value that is not a language tag is refused', hostile.status === 2, `exit ${hostile.status}`);
  expect('a refused value is written nowhere', read(dir, 'index.html') === before.index && read(dir, 'manifest.json') === before.manifest);

  const entrypoint = readFileSync('deploy/entrypoint.sh', 'utf8');
  expect('the entrypoint runs the pin', entrypoint.includes('pin-launcher-locale.sh'));
  const image = readFileSync('deploy/Dockerfile', 'utf8');
  expect('the image carries the pin', image.includes('pin-launcher-locale.sh'));
  const serverBuild = readFileSync('.github/workflows/build-server.yml', 'utf8');
  expect('the server tarball carries the pin', serverBuild.includes('pin-launcher-locale.sh'));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error(`FAIL: ${failures.length} claim${failures.length === 1 ? '' : 's'} about the language pin did not hold.`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log('OK: the language pin rewrites the redirector and the install manifest, and nothing else.');
