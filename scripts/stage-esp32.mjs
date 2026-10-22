#!/usr/bin/env node
/**
 * Stage the ESP32 filesystem from files already in this repository. No network.
 *
 *   node scripts/stage-esp32.mjs
 *
 * Writes into esp32/data/, which the firmware serves and PlatformIO packs into the
 * littlefs image:
 *   variants/lithic-light.html  -> data/src/lithic.html.gz
 *   src/launcher.html           -> data/src/launcher.html.gz
 *   offline-service-worker.js   -> data/offline-service-worker.js (plain, the route
 *                                  serves it with no Content-Encoding)
 *
 * The two pages are gzipped here and served with Content-Encoding: gzip, so the
 * browser inflates them and the device never does: the partition holds about twice
 * as much wiki that way. esp32/data/src/ is gitignored, so this runs before every
 * `pio run -t buildfs`, and PlatformIO calls it through
 * esp32/scripts/download_assets.py rather than asking anybody to remember.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const repoRoot = process.cwd();
const dataDir = path.join(repoRoot, 'esp32', 'data');
const srcDir = path.join(dataDir, 'src');

/** Pages the firmware serves gzipped, as [source in this repository, staged name]. */
const PAGES = [
  ['variants/lithic-light.html', 'lithic.html.gz'],
  ['src/launcher.html', 'launcher.html.gz']
];

/** Files served byte for byte, as [source in this repository, staged path]. */
const PLAIN = [['offline-service-worker.js', path.join(dataDir, 'offline-service-worker.js')]];

for (const [source] of [...PAGES, ...PLAIN]) {
  if (!existsSync(path.join(repoRoot, source))) {
    console.error(`${source} is missing. Build or pull it before staging the ESP32 filesystem.`);
    process.exit(1);
  }
}

mkdirSync(srcDir, { recursive: true });
for (const [source, target] of PAGES) {
  const raw = readFileSync(path.join(repoRoot, source));
  const gz = gzipSync(raw, { level: 9 });
  writeFileSync(path.join(srcDir, target), gz);
  console.log(
    `${source} -> esp32/data/src/${target} (${(raw.length / 1024).toFixed(0)} KB raw, ${(gz.length / 1024).toFixed(0)} KB gzipped)`
  );
}

for (const [source, target] of PLAIN) {
  const bytes = readFileSync(path.join(repoRoot, source));
  writeFileSync(target, bytes);
  console.log(`${source} -> ${path.relative(repoRoot, target)} (${(bytes.length / 1024).toFixed(0)} KB)`);
}
