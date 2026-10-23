/**
 * The one-time ESP32 flash offer: a blank board becomes a Lithic appliance.
 *
 * `esptool-js` speaks the ROM download protocol and writes bytes at an address. It
 * carries no filesystem, so it cannot produce the littlefs image the board serves its
 * pages from, and it cannot write a file into one. That image, the bootloader, the
 * partition table, the OTA block and the application are all built by the ESP32
 * project's own PlatformIO build, published beside each other, and written here at the
 * offsets `esp32/partitions.csv` fixes.
 *
 * The one thing built here rather than published is the board's own settings. A blank
 * board arrives with a password nobody chose, so the dialog asks for one and this module
 * turns it into a text block written to the `cfg` partition in the same flash. The
 * firmware reads that block at boot and turns it into `/config.txt`, which is why no
 * filesystem work is needed on this side.
 *
 * This is the single runtime read from another host anywhere in the launcher, and it
 * is the exception `agents.md` names: everything else the launcher needs is in the
 * file it already opened. A failed read is reported and nothing else happens.
 */
import { ESPLoader, Transport } from 'esptool-js';
import type { FlashOptions } from 'esptool-js';
import { copy } from './copy.ts';

/**
 * Where the five images live: one fixed branch, force-pushed by the firmware workflow,
 * read through `raw.githubusercontent.com`.
 *
 * Not the release assets that same workflow publishes, although they are the better
 * address to look at: a page cannot read them. GitHub answers a release download with
 * a redirect to a storage host, and neither hop sends an `Access-Control-Allow-Origin`
 * header, so every browser rejects the read as a network failure before a byte arrives.
 * `raw.githubusercontent.com` does send it. The branch is a distribution channel rather
 * than a record of versions, so it is replaced in place on every build, and the images
 * are still checked against their own magic and their region's size below.
 */
export const ESP32_IMAGE_BASE =
  'https://raw.githubusercontent.com/Xyvir/Lithic-UK/esp32-firmware';

/** One flash region: the file written there, its address, and the room it has. */
export interface Esp32Region {
  file: string;
  address: number;
  limit: number;
  /**
   * The first bytes a real image starts with. Bootloader and application images begin
   * with the ESP image magic `0xe9`; a partition table begins `0xaa 0x50`. A CDN's HTML
   * error page does not, which is what this catches before anything touches a chip.
   */
  magic: readonly number[];
  /**
   * Written by this module rather than downloaded: the board's own settings, which
   * cannot be published because they belong to one person and one board.
   */
  generated?: boolean;
}

/** Where the password the dialog asks for is written, outside the filesystem. */
export const ESP32_CONFIG_REGION: Esp32Region = {
  file: 'config.bin',
  address: 0x3f0000,
  limit: 0x10000,
  magic: [],
  generated: true
};

/**
 * The layout read off `esp32/partitions.csv`: the bootloader, the partition table, the
 * OTA data block and the application fill the space below the filesystem, which owns
 * the next 2.6 MB, and the `cfg` block owns the 64 KB after that. The limits are the
 * gaps between the regions, so a wrong image fails before it can be written over its
 * neighbour.
 */
export const ESP32_REGIONS: readonly Esp32Region[] = [
  { file: 'bootloader.bin', address: 0x1000, limit: 0x7000, magic: [0xe9] },
  { file: 'partitions.bin', address: 0x8000, limit: 0x6000, magic: [0xaa, 0x50] },
  { file: 'boot_app0.bin', address: 0xe000, limit: 0x2000, magic: [] },
  { file: 'firmware.bin', address: 0x10000, limit: 0x140000, magic: [0xe9] },
  { file: 'littlefs.bin', address: 0x150000, limit: 0x2a0000, magic: [] },
  ESP32_CONFIG_REGION
];

/** One image held in memory, ready to be handed to the loader. */
export interface Esp32Image {
  file: string;
  address: number;
  data: Uint8Array;
}

/** What the dialog watches a flash through. */
export type Esp32Stage = 'downloading' | 'connecting' | 'writing' | 'done';

export interface Esp32FlashProgress {
  file: string;
  written: number;
  total: number;
}

export function esp32ImageUrl(file: string): string {
  return `${ESP32_IMAGE_BASE}/${file}`;
}

/**
 * The line a run shows while it is at this stage.
 *
 * Here rather than in a component because two pages draw the same run: the manager's dialog,
 * in a browser that has a serial port, and the flash-only page the desktop app opens in one
 * that does (`?flash=1`). One mapping is one place for the stages to stay in step.
 */
export function esp32StageLine(stage: Esp32Stage): string {
  switch (stage) {
    case 'downloading':
      return copy.esp32.downloading;
    case 'connecting':
      return copy.esp32.connecting;
    case 'writing':
      return copy.esp32.writing;
    default:
      return copy.esp32.done;
  }
}

/** How far through the write a report is, as a whole percentage of every image's bytes. */
export function esp32Percent(progress: Esp32FlashProgress): number {
  return progress.total > 0 ? Math.min(100, Math.round((progress.written / progress.total) * 100)) : 0;
}

export function esp32Region(file: string): Esp32Region {
  const region = ESP32_REGIONS.find((candidate) => candidate.file === file);
  if (!region) throw new Error(`unknown ESP32 image ${file}`);
  return region;
}

/**
 * Reject anything that is not the image its region expects. The length is checked
 * against the gap to the next region rather than against the partition, so an image
 * that would spill over its neighbour cannot be written at all.
 */
export function checkEsp32Image(region: Esp32Region, data: Uint8Array): void {
  if (data.length === 0) throw new Error(`${region.file}: empty image`);
  if (data.length > region.limit) {
    throw new Error(`${region.file}: ${data.length} bytes, region holds ${region.limit}`);
  }
  const wrong = region.magic.some((byte, index) => data[index] !== byte);
  if (wrong) throw new Error(`${region.file}: not an ESP image`);
}

/** WPA2's own floor, and the longest passphrase it accepts. */
export const ESP32_PASSWORD_MIN = 8;
export const ESP32_PASSWORD_MAX = 63;

/**
 * The password the board will store, which is what was typed without the spaces
 * around it: the firmware trims both ends of a config value, so a trailing space
 * would be a password nobody could type back in.
 */
export function normalizeEsp32Password(raw: string): string {
  return raw.trim();
}

/** Whether the dialog may flash with this password. */
export function esp32PasswordOk(raw: string): boolean {
  const password = normalizeEsp32Password(raw);
  return (
    password.length >= ESP32_PASSWORD_MIN &&
    password.length <= ESP32_PASSWORD_MAX &&
    !/[\u0000-\u001f\u007f]/.test(password)
  );
}

/**
 * The `cfg` block: the two lines `/config.txt` holds, with the password the person
 * chose. Written as bytes because the loader has no filesystem, and the firmware
 * writes the same text to `/config.txt` on the first boot.
 */
export function esp32ConfigImage(password: string): Uint8Array {
  const board = normalizeEsp32Password(password);
  if (!esp32PasswordOk(board)) {
    throw new Error(`the board password needs ${ESP32_PASSWORD_MIN} to ${ESP32_PASSWORD_MAX} characters`);
  }
  return new TextEncoder().encode(
    `# Written by the launcher when this board was flashed.\npass=${board}\n`
  );
}

/**
 * Download every published image, in layout order. The generated block is made here
 * rather than fetched, so it is not in this loop. The fetch is the offer's one network
 * read; anything that fails names the file so the dialog can say which one.
 */
export async function fetchEsp32Images(
  fetchImpl: typeof fetch = fetch,
  onProgress?: (file: string, index: number, count: number) => void
): Promise<Esp32Image[]> {
  const images: Esp32Image[] = [];
  const published = ESP32_REGIONS.filter((region) => !region.generated);
  for (const [index, region] of published.entries()) {
    onProgress?.(region.file, index + 1, published.length);
    const response = await fetchImpl(esp32ImageUrl(region.file));
    if (!response.ok) throw new Error(`${region.file}: HTTP ${response.status}`);
    const data = new Uint8Array(await response.arrayBuffer());
    checkEsp32Image(region, data);
    images.push({ file: region.file, address: region.address, data });
  }
  return images;
}

/**
 * The array `writeFlash` takes: address order, every image checked against its own
 * region. Sorted here rather than trusted, because the addresses are the whole
 * contract with the chip.
 */
export function esp32FlashPlan(images: readonly Esp32Image[]): FlashOptions['fileArray'] {
  const plan = [...images].sort((left, right) => left.address - right.address);
  let end = 0;
  for (const image of plan) {
    const region = ESP32_REGIONS.find((candidate) => candidate.address === image.address);
    if (!region) throw new Error(`nothing belongs at ${image.address.toString(16)}`);
    checkEsp32Image(region, image.data);
    if (image.address < end) throw new Error(`${image.file} overlaps the image before it`);
    end = image.address + image.data.length;
  }
  return plan.map((image) => ({ data: image.data, address: image.address }));
}

/** The part of `ESPLoader` this module uses, so a test can stand in for it. */
export interface Esp32Loader {
  main(): Promise<unknown>;
  writeFlash(options: FlashOptions): Promise<void>;
}

export interface WriteEsp32Options {
  loader: Esp32Loader;
  images: readonly Esp32Image[];
  /** A blank board is the offer's subject, so an erase is the default. */
  eraseAll?: boolean;
  onProgress?: (progress: Esp32FlashProgress) => void;
}

/**
 * Sync with the chip and write the plan in one `writeFlash`, which erases and writes
 * region by region. `keep` for mode, frequency and size leaves the board's own flash
 * settings alone; the image set is what is being replaced, not the chip's identity.
 */
export async function writeEsp32(options: WriteEsp32Options): Promise<void> {
  const plan = esp32FlashPlan(options.images);
  // The plan is the address-ordered list, so the names a progress report carries have
  // to come from that list rather than from the order the images arrived in.
  const ordered = [...options.images].sort((left, right) => left.address - right.address);
  const sizes = ordered.map((image) => image.data.length);
  const totals = sizes.map((_, index) => sizes.slice(0, index + 1).reduce((sum, size) => sum + size, 0));
  const grandTotal = totals[totals.length - 1] ?? 1;

  await options.loader.main();
  await options.loader.writeFlash({
    fileArray: plan,
    flashMode: 'keep',
    flashFreq: 'keep',
    flashSize: 'keep',
    eraseAll: options.eraseAll ?? true,
    compress: true,
    reportProgress: (fileIndex, written, total) => {
      const before = fileIndex > 0 ? totals[fileIndex - 1] : 0;
      options.onProgress?.({
        file: ordered[fileIndex]?.file ?? '',
        written: before + Math.min(written, total),
        total: grandTotal
      });
    }
  });
}

/**
 * Web Serial is Chromium only. The offer reads this to choose between its own dialog and handing
 * the page to a Chromium browser, which is what a window without the API has left.
 */
export function serialFlashSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serial' in navigator && Boolean(navigator.serial);
}

/** A terminal that says nothing: the loader's chatter belongs in a console, not a dialog. */
const quietTerminal = {
  clean: () => {},
  write: () => {},
  writeLine: () => {}
};

export interface FlashLithicOptions {
  fetchImpl?: typeof fetch;
  /** The WiFi password the person chose, flashed into the `cfg` partition. */
  password: string;
  onStage?: (stage: Esp32Stage, detail: string) => void;
  onProgress?: (progress: Esp32FlashProgress) => void;
}

/**
 * The offer end to end: fetch the images, ask for a port, write them, reset into the
 * new firmware, and let go of the port either way. A blank board needs no buttons
 * pressed; the loader's own reset sequence puts it in download mode.
 */
export async function flashLithicAppliance(options: FlashLithicOptions): Promise<void> {
  const { fetchImpl = fetch, onStage, onProgress } = options;
  // Asked before the download rather than after it: a browser with no serial port would
  // otherwise pull about four megabytes and only then say it cannot reach a board. That is
  // also what a run outside a Chromium browser used to report as a download failure.
  if (!serialFlashSupported()) throw new Error('Web Serial is not available in this browser');
  const images = await fetchEsp32Images(fetchImpl, (file, index, count) =>
    onStage?.('downloading', `${index}/${count} ${file}`)
  );
  images.push({
    file: ESP32_CONFIG_REGION.file,
    address: ESP32_CONFIG_REGION.address,
    data: esp32ConfigImage(options.password)
  });
  onStage?.('connecting', '');
  const port = await navigator.serial.requestPort();
  const transport = new Transport(port, true);
  try {
    const loader = new ESPLoader({
      transport,
      baudrate: 460800,
      romBaudrate: 115200,
      terminal: quietTerminal
    });
    onStage?.('writing', '');
    await writeEsp32({ loader, images, onProgress });
    await loader.after('hard_reset');
    onStage?.('done', '');
  } finally {
    await transport.disconnect();
  }
}
