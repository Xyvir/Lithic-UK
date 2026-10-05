#!/usr/bin/env node
/**
 * The sync pin, proved against the artifacts it builds rather than argued for in a comment.
 *
 * `launcher-ui/src/sync-pin.ts` is where the four pins are defined and `--sync=` on
 * `scripts/build-launcher.mjs` is where they are asked for. What only a build can show is the
 * part a reader cannot check by reading: that a pinned build *sheds* what it was pinned away
 * from. So this builds `github` and `iroh` into a scratch directory and greps each artifact for
 * markers only one prong's code carries:
 *
 *   - `lithic-device-sync-identity` is a storage key in `launcher-ui/src/device-sync.ts`, and
 *     `wasm_bindgen` is the wasm-bindgen glue's own marker. Both are absent from a `github`
 *     build because `vite.config.ts` resolves `device-sync` (and the panel) to stand-ins there,
 *     so the module and its dynamic import of `lithic-sync/lithic_sync.js` are never in the
 *     graph. This is what keeps a repository-only build from carrying 37 kB of engine glue.
 *   - `gitsync-title` is the repository dialog's own id and `github_device_poll` is the device
 *     flow's command. Both are absent from an `iroh` build because the pin is substituted as a
 *     literal (`define`), so every branch on it folds and the dialog, its setup screens and the
 *     modules only they reach are dropped. This is what keeps a device-only build from carrying
 *     25 kB of repository dialogs.
 *
 * The default (`auto`) is checked the other way round, against the committed
 * `src/launcher.html`: it has to carry both halves, because it is the artifact every
 * distribution is served and the one that asks the host which prong it has. Its freshness is
 * `scripts/check-launcher-artifact.mjs`'s business, so a stale artifact is reported as such
 * rather than as a pin failure.
 *
 *   node scripts/check-sync-pin.mjs
 *
 * Exit 0 = the pins shed what they say they shed and the published artifact carries both.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const builder = join(repoRoot, 'scripts', 'build-launcher.mjs');
const published = join(repoRoot, 'src', 'launcher.html');

/** Strings only one prong's code carries. Each is a name the build cannot rename away. */
const DEVICE_MARKERS = ['lithic-device-sync-identity', 'wasm_bindgen'];
const GITHUB_MARKERS = ['gitsync-title', 'github_device_poll'];

const scratch = mkdtempSync(join(tmpdir(), 'lithic-sync-pin-'));
let failures = 0;

function fail(message) {
  failures += 1;
  console.error(`FAIL ${message}`);
}

/** Build one pin into the scratch directory and hand back the artifact's text. */
function build(pin) {
  const destination = join(scratch, `${pin}.html`);
  const build = spawnSync(process.execPath, [builder, `--sync=${pin}`, destination], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  });
  if (build.status !== 0) {
    const tail = `${build.stdout ?? ''}${build.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n  ');
    fail(`--sync=${pin} did not build:\n  ${tail}`);
    return null;
  }
  return { text: readFileSync(destination, 'utf8'), bytes: readFileSync(destination).length };
}

/** Whether every marker is (or is not) in an artifact, reported per marker. */
function check(name, text, markers, expected) {
  for (const marker of markers) {
    const found = text.includes(marker);
    if (found !== expected) {
      fail(`${name}: ${marker} is ${found ? 'present' : 'absent'} but should be ${expected ? 'present' : 'absent'}`);
    }
  }
}

try {
  if (!existsSync(published)) {
    console.error('FAIL src/launcher.html is missing. Run: npm run build:launcher');
    process.exit(1);
  }

  const github = build('github');
  if (github) {
    // The repository prong is the whole build, and device sync is not in it in any form.
    check('github', github.text, GITHUB_MARKERS, true);
    check('github', github.text, DEVICE_MARKERS, false);
    console.log(`github  ${github.bytes.toLocaleString('en-US')} bytes: repository prong only, no engine glue`);
  }

  const iroh = build('iroh');
  if (iroh) {
    // The device prong and the wasm glue it loads, with no repository control anywhere.
    check('iroh', iroh.text, DEVICE_MARKERS, true);
    check('iroh', iroh.text, GITHUB_MARKERS, false);
    console.log(`iroh    ${iroh.bytes.toLocaleString('en-US')} bytes: device prong only, no repository dialog`);
  }

  if (github && iroh && iroh.bytes <= github.bytes) {
    // Not a rule about the two prongs, just a tripwire: the number this gate prints is only
    // worth reading if it is measured, and a size that inverts says the markers above lie.
    fail(`the iroh build (${iroh.bytes}) is not larger than the github build (${github.bytes})`);
  }

  const auto = readFileSync(published, 'utf8');
  check('auto (committed)', auto, GITHUB_MARKERS, true);
  check('auto (committed)', auto, DEVICE_MARKERS, true);
  console.log(`auto    ${readFileSync(published).length.toLocaleString('en-US')} bytes: both prongs, and the one asking the host`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`FAIL ${failures} pin ${failures === 1 ? 'check' : 'checks'} did not hold.`);
  process.exit(1);
}
console.log('OK — the pins shed what they say they shed, and the published artifact keeps both.');
