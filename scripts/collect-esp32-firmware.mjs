#!/usr/bin/env node
/**
 * Gather the five images the launcher's flash offer writes to a blank board.
 *
 *   node scripts/collect-esp32-firmware.mjs [--build-dir <dir>] [--out <dir>]
 *
 * PlatformIO leaves four of them in the build directory; `boot_app0.bin` ships
 * inside the Arduino framework package instead, which is why the fifth cannot be
 * taken from the build tree. Everything lands in one directory with the exact names
 * `launcher-ui/src/esp32-flash.ts` fetches, so the release upload and the offer
 * cannot disagree about a filename.
 *
 * The limits are the gaps between the regions `esp32/partitions.csv` fixes. They are
 * repeated here rather than imported because this runs under plain node before the
 * launcher's modules are installed: if a region moves, change it here and in
 * ESP32_REGIONS together.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

/** Where the images come from, per file, and the room each one has. */
const IMAGES = [
  { file: 'bootloader.bin', from: 'build', limit: 0x7000 },
  { file: 'partitions.bin', from: 'build', limit: 0x6000 },
  { file: 'boot_app0.bin', from: 'framework', limit: 0x2000 },
  { file: 'firmware.bin', from: 'build', limit: 0x140000 },
  { file: 'littlefs.bin', from: 'build', limit: 0x2b0000 }
];

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const buildDir = path.resolve(argument('build-dir', 'esp32/.pio/build/esp32dev'));
const outDir = path.resolve(argument('out', 'esp32-firmware'));
const coreDir = process.env.PLATFORMIO_CORE_DIR ?? path.join(homedir(), '.platformio');

if (!existsSync(buildDir)) {
  console.error(`${path.relative(process.cwd(), buildDir)} is missing. Build it first:`);
  console.error('  pio run --project-dir esp32 && pio run --project-dir esp32 --target buildfs');
  process.exit(1);
}

/**
 * The Arduino framework's package name carries the core version, so it is found by
 * prefix rather than spelled out. `boot_app0.bin` is the OTA data block that tells
 * the ROM which application slot to boot.
 */
function bootApp0Path() {
  const packages = path.join(coreDir, 'packages');
  if (!existsSync(packages)) return null;
  for (const name of readdirSync(packages)) {
    if (!name.startsWith('framework-arduinoespressif32')) continue;
    const candidate = path.join(packages, name, 'tools', 'partitions', 'boot_app0.bin');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const bootApp0 = bootApp0Path();
if (IMAGES.some((image) => image.from === 'framework') && !bootApp0) {
  console.error(`boot_app0.bin is not under ${path.join(coreDir, 'packages')}.`);
  console.error('Run a build first: PlatformIO installs the framework as part of it.');
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let failed = false;
for (const image of IMAGES) {
  const source = image.from === 'framework' ? bootApp0 : path.join(buildDir, image.file);
  if (!source || !existsSync(source)) {
    console.error(`${image.file}: missing (${source ?? 'no framework package'})`);
    failed = true;
    continue;
  }
  const bytes = statSync(source).size;
  if (bytes === 0) {
    console.error(`${image.file}: empty`);
    failed = true;
    continue;
  }
  if (bytes > image.limit) {
    console.error(`${image.file}: ${bytes} bytes, region holds ${image.limit}`);
    failed = true;
    continue;
  }
  copyFileSync(source, path.join(outDir, image.file));
  console.log(`${image.file.padEnd(15)} ${String(bytes).padStart(8)} bytes of ${image.limit}`);
}

if (failed) {
  console.error('Not every image could be collected, so nothing was published.');
  process.exit(1);
}
console.log(`Wrote ${IMAGES.length} images to ${path.relative(process.cwd(), outDir)}`);
