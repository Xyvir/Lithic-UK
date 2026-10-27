#!/usr/bin/env node
/**
 * The board serves this repository's pages, not a copy of some earlier build.
 *
 *   node scripts/check-esp32-staged-pages.mjs
 *
 * `scripts/stage-esp32.mjs` gzips two pages and copies the service worker into `esp32/data`, and
 * PlatformIO packs whatever is in there into the littlefs image. So a staging step that wrote an
 * older page, or half a page, produces a board whose UI is not the UI in the repository, and the
 * only symptom of that is on a phone with no way to tell which copy it is reading.
 *
 * Each staged file is therefore compared with the file it came from: the two pages by inflating
 * them back to bytes, the worker byte for byte. The pages are gzipped on the way in, so this is
 * also the check that the compression round trip is exact.
 *
 * It runs where the staging has just happened: the firmware workflow calls it between `pio run`
 * (whose pre-script stages the pages) and `buildfs` (which packs them), so what is checked is the
 * set about to be baked into the image. It is not a pre-push check, and the difference is not a
 * matter of convenience: the committed `esp32/data` is whatever the last firmware build staged, so
 * it trails every release that rebuilds the light variant until the next one, and a comparison
 * before a push would fail on a tree in its ordinary state, with no remedy but re-staging pages
 * nothing is building.
 */
import { existsSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { gunzipSync } from 'node:zlib';

/** Where each staged file comes from, and whether it travelled gzipped. */
const STAGED = [
  { staged: 'esp32/data/src/launcher.html.gz', source: 'src/launcher.html', gzipped: true },
  { staged: 'esp32/data/src/lithic.html.gz', source: 'variants/lithic-light.html', gzipped: true },
  { staged: 'esp32/data/offline-service-worker.js', source: 'offline-service-worker.js', gzipped: false }
];

let failed = false;
for (const { staged, source, gzipped } of STAGED) {
  if (!existsSync(staged)) {
    console.error(`${staged}: missing. The build stages it, so a board built now would serve nothing.`);
    failed = true;
    continue;
  }
  if (!existsSync(source)) {
    console.error(`${source}: missing, so the staged copy has nothing to be compared with.`);
    failed = true;
    continue;
  }
  let stagedBytes;
  try {
    const raw = readFileSync(staged);
    stagedBytes = gzipped ? gunzipSync(raw) : raw;
  } catch (error) {
    // Not gzip at all, or a truncated member: either way the board would answer with bytes no
    // browser can render, which is worth its own sentence rather than a size comparison.
    console.error(`${staged}: cannot be read back (${error.message})`);
    failed = true;
    continue;
  }
  const sourceBytes = readFileSync(source);
  if (!stagedBytes.equals(sourceBytes)) {
    console.error(
      `${staged}: ${stagedBytes.length} bytes staged, ${sourceBytes.length} in ${source}. ` +
        'The staged copy is not this file, so the board would serve an older page.'
    );
    failed = true;
    continue;
  }
  console.log(`${staged.padEnd(40)} ${String(sourceBytes.length).padStart(8)} bytes, identical to ${source}`);
}

if (failed) {
  console.error('The staged pages are not the ones in this repository. Re-run the staging step.');
  process.exit(1);
}
console.log(`All ${STAGED.length} staged files match the files they came from.`);
