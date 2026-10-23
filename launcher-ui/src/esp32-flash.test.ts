import test from 'node:test';
import assert from 'node:assert/strict';
import type { FlashOptions } from 'esptool-js';
import {
  ESP32_CONFIG_REGION,
  ESP32_PASSWORD_MAX,
  ESP32_PASSWORD_MIN,
  ESP32_REGIONS,
  checkEsp32Image,
  esp32ConfigImage,
  esp32FlashPlan,
  esp32ImageUrl,
  esp32PasswordOk,
  fetchEsp32Images,
  flashLithicAppliance,
  normalizeEsp32Password,
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

/** Everything a run writes: the published images plus the settings it builds here. */
function images(): Esp32Image[] {
  return ESP32_REGIONS.map((region) => ({
    file: region.file,
    address: region.address,
    data: region.generated ? esp32ConfigImage('correct horse') : imageBytes(region.file)
  }));
}

const PLAN_ADDRESSES = [0x1000, 0x8000, 0xe000, 0x10000, 0x150000, 0x3f0000];

test('the images are written at the offsets the partition table fixes', () => {
  assert.deepEqual(
    ESP32_REGIONS.map((region) => [region.file, region.address]),
    [
      ['bootloader.bin', 0x1000],
      ['partitions.bin', 0x8000],
      ['boot_app0.bin', 0xe000],
      ['firmware.bin', 0x10000],
      ['littlefs.bin', 0x150000],
      ['config.bin', 0x3f0000]
    ]
  );
  // The filesystem ends where the settings block begins, and the block ends at 4 MB.
  const littlefs = ESP32_REGIONS.find((region) => region.file === 'littlefs.bin');
  assert.ok(littlefs);
  assert.equal(littlefs.address + littlefs.limit, ESP32_CONFIG_REGION.address);
  assert.equal(ESP32_CONFIG_REGION.address + ESP32_CONFIG_REGION.limit, 0x400000);
});

test('the settings block is the text /config.txt holds, with the chosen password', () => {
  const text = new TextDecoder().decode(esp32ConfigImage('  correct horse  '));
  assert.equal(text, '# Written by the launcher when this board was flashed.\npass=correct horse\n');
  // The firmware writes this same text to the file, so it has to parse as one.
  assert.ok(text.split('\n').includes('pass=correct horse'));
});

test('a password the board cannot use is refused before anything is written', () => {
  assert.throws(() => esp32ConfigImage('short'), /8 to 63/);
  assert.throws(() => esp32ConfigImage('x'.repeat(ESP32_PASSWORD_MAX + 1)), /8 to 63/);
  assert.throws(() => esp32ConfigImage('long enough\nsecond line'), /8 to 63/);
  assert.equal(esp32PasswordOk('x'.repeat(ESP32_PASSWORD_MIN)), true);
  assert.equal(esp32PasswordOk('short'), false);
  assert.equal(esp32PasswordOk(''), false);
  assert.equal(normalizeEsp32Password('  correct horse  '), 'correct horse');
  // The spaces around it are trimmed for the person rather than turned into a
  // password nobody can type back in.
  assert.equal(esp32PasswordOk('  correct horse  '), true);
});

test('every published image is fetched from one fixed address a page is allowed to read', () => {
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
    PLAN_ADDRESSES
  );

  const overlapping = [...images(), { file: 'second-firmware.bin', address: 0x10000, data: imageBytes('firmware.bin') }];
  assert.throws(() => esp32FlashPlan(overlapping), /overlaps/);
});

test('the plan refuses an address nothing belongs at', () => {
  const stray = [...images(), { file: 'stray.bin', address: 0x2000, data: new Uint8Array([1, 2, 3]) }];
  assert.throws(() => esp32FlashPlan(stray), /nothing belongs/);
});

test('a download asks for the published images and leaves the settings block alone', async () => {
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
  assert.deepEqual(fetched.map((image) => image.file), [
    'bootloader.bin',
    'partitions.bin',
    'boot_app0.bin',
    'firmware.bin',
    'littlefs.bin'
  ]);
  assert.deepEqual(requested, fetched.map((image) => image.file));
  assert.equal(seen.length, fetched.length);
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
    PLAN_ADDRESSES
  );
  // A blank board is the offer's subject, and the chip's own settings survive.
  assert.equal(flash.eraseAll, true);
  assert.equal(flash.compress, true);
  assert.equal(flash.flashMode, 'keep');
  assert.equal(flash.flashFreq, 'keep');
  assert.equal(flash.flashSize, 'keep');
});

test('progress is measured across the whole plan and names the file at its address', async () => {
  const reported: Array<{ written: number; file: string }> = [];
  await writeEsp32({
    // Deliberately not in address order: the names a report carries belong to the
    // plan, which is sorted, not to the order the images arrived in.
    images: [...images()].reverse(),
    loader: {
      main: async () => 'ESP32',
      writeFlash: async (options) => {
        for (let index = 0; index < 6; index += 1) options.reportProgress?.(index, 4, 4);
      }
    },
    onProgress: (progress) => reported.push({ written: progress.written, file: progress.file })
  });

  assert.equal(reported.length, 6);
  assert.deepEqual(reported.map((entry) => entry.file), [
    'bootloader.bin',
    'partitions.bin',
    'boot_app0.bin',
    'firmware.bin',
    'littlefs.bin',
    'config.bin'
  ]);
  for (let index = 1; index < reported.length; index += 1) {
    assert.ok(reported[index].written > reported[index - 1].written);
  }
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

  await assert.rejects(flashLithicAppliance({ password: 'correct horse', fetchImpl: fetcher }), /Web Serial is not available/);
  assert.equal(fetched, 0);
});
