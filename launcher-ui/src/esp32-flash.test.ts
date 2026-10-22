import test from 'node:test';
import assert from 'node:assert/strict';
import type { FlashOptions } from 'esptool-js';
import {
  ESP32_REGIONS,
  checkEsp32Image,
  esp32FlashPlan,
  esp32ImageUrl,
  fetchEsp32Images,
  flashLithicAppliance,
  serialFlashSupported,
  writeEsp32,
  type Esp32Image
} from './esp32-flash.ts';

/** Bytes that pass the region's own magic check. */
function imageBytes(file: string, length = 4): Uint8Array {
  const region = ESP32_REGIONS.find((candidate) => candidate.file === file);
  assert.ok(region, `${file} is a known region`);
  const bytes = new Uint8Array(Math.max(length, region.magic.length || 1));
  bytes.set(region.magic, 0);
  return bytes;
}

function images(): Esp32Image[] {
  return ESP32_REGIONS.map((region) => ({
    file: region.file,
    address: region.address,
    data: imageBytes(region.file)
  }));
}

test('the five images are written at the offsets the partition table fixes', () => {
  assert.deepEqual(
    ESP32_REGIONS.map((region) => [region.file, region.address]),
    [
      ['bootloader.bin', 0x1000],
      ['partitions.bin', 0x8000],
      ['boot_app0.bin', 0xe000],
      ['firmware.bin', 0x10000],
      ['littlefs.bin', 0x150000]
    ]
  );
  // The filesystem owns the rest of the flash, and its limit is the partition's size.
  const littlefs = ESP32_REGIONS[ESP32_REGIONS.length - 1];
  assert.equal(littlefs.address + littlefs.limit, 0x400000);
});

test('every image is fetched from one fixed address a page is allowed to read', () => {
  const url = esp32ImageUrl('firmware.bin');
  assert.equal(url, 'https://raw.githubusercontent.com/Xyvir/Lithic-UK/esp32-firmware/firmware.bin');
  // Not a release download: GitHub sends no CORS header on those, so a page cannot read
  // one however healthy the release is. Pinned because it is the whole reason for the branch.
  assert.ok(!url.includes('/releases/download/'), 'release assets are unreadable from a page');
});

test('an image that is not an ESP image is refused before it reaches a chip', () => {
  const region = ESP32_REGIONS[0];
  assert.throws(() => checkEsp32Image(region, new TextEncoder().encode('<html>404</html>')), /not an ESP image/);
  assert.throws(() => checkEsp32Image(region, new Uint8Array(0)), /empty image/);
  // A partition table that is really a bootloader is refused too.
  assert.throws(() => checkEsp32Image(ESP32_REGIONS[1], new Uint8Array([0xe9, 0, 0, 0])), /not an ESP image/);
});

test('an image larger than its region is refused', () => {
  const firmware = ESP32_REGIONS.find((region) => region.file === 'firmware.bin');
  assert.ok(firmware);
  const tooBig = new Uint8Array(firmware.limit + 1);
  tooBig[0] = 0xe9;
  assert.throws(() => checkEsp32Image(firmware, tooBig), /region holds/);
});

test('the plan sorts by address and refuses an overlap', () => {
  const plan = esp32FlashPlan([...images()].reverse());
  assert.deepEqual(
    plan.map((entry) => entry.address),
    [0x1000, 0x8000, 0xe000, 0x10000, 0x150000]
  );

  const overlapping = [...images(), { file: 'second-firmware.bin', address: 0x10000, data: imageBytes('firmware.bin') }];
  assert.throws(() => esp32FlashPlan(overlapping), /overlaps/);
});

test('the plan refuses an address nothing belongs at', () => {
  const stray = [...images(), { file: 'stray.bin', address: 0x2000, data: new Uint8Array([1, 2, 3]) }];
  assert.throws(() => esp32FlashPlan(stray), /nothing belongs/);
});

test('a download reports progress per file and keeps the layout order', async () => {
  const requested: string[] = [];
  const seen: string[] = [];
  const fetched = await fetchEsp32Images(
    (async (url: string | URL | Request) => {
      const file = String(url).split('/').pop() ?? '';
      requested.push(file);
      return { ok: true, status: 200, arrayBuffer: async () => imageBytes(file).buffer } as Response;
    }) as typeof fetch,
    (file) => seen.push(file)
  );
  assert.deepEqual(fetched.map((image) => image.file), ESP32_REGIONS.map((region) => region.file));
  assert.deepEqual(requested, ESP32_REGIONS.map((region) => region.file));
  assert.equal(seen.length, ESP32_REGIONS.length);
});

test('a missing asset names the file it could not download', async () => {
  await assert.rejects(
    fetchEsp32Images((async () => ({ ok: false, status: 404 }) as Response) as typeof fetch),
    /bootloader\.bin: HTTP 404/
  );
});

test('the write hands one plan to one writeFlash call', async () => {
  const calls: FlashOptions[] = [];
  await writeEsp32({
    images: images(),
    loader: {
      main: async () => 'ESP32',
      writeFlash: async (options) => {
        calls.push(options);
      }
    }
  });

  assert.equal(calls.length, 1);
  const flash = calls[0];
  assert.deepEqual(
    flash.fileArray.map((entry) => entry.address),
    [0x1000, 0x8000, 0xe000, 0x10000, 0x150000]
  );
  // A blank board is the offer's subject, and the chip's own settings survive.
  assert.equal(flash.eraseAll, true);
  assert.equal(flash.compress, true);
  assert.equal(flash.flashMode, 'keep');
  assert.equal(flash.flashFreq, 'keep');
  assert.equal(flash.flashSize, 'keep');
});

test('progress is measured across the whole plan, not per file', async () => {
  const reported: number[] = [];
  await writeEsp32({
    images: images(),
    loader: {
      main: async () => 'ESP32',
      writeFlash: async (options) => {
        // Two files done, each reporting its own bytes written.
        options.reportProgress?.(0, 4, 4);
        options.reportProgress?.(1, 4, 4);
      }
    },
    onProgress: (progress) => reported.push(progress.written)
  });

  assert.equal(reported.length, 2);
  assert.ok(reported[0] > 0 && reported[0] < reported[1]);
});

test('Web Serial is absent where there is no browser', () => {
  assert.equal(serialFlashSupported(), false);
});

test('a browser with no serial port is told so before anything is downloaded', async () => {
  let fetched = 0;
  const fetcher = (async () => {
    fetched += 1;
    return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0) } as Response;
  }) as typeof fetch;

  await assert.rejects(flashLithicAppliance({ fetchImpl: fetcher }), /Web Serial is not available/);
  assert.equal(fetched, 0);
});
