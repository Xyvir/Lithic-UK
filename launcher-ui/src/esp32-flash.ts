/**
 * The one-time ESP32 flash offer: a blank board becomes a Lithic appliance.
 *
 * `esptool-js` speaks the ROM download protocol and writes bytes at an address. It
 * carries no filesystem, so it cannot produce the littlefs image the board serves its
 * pages from. That image, the bootloader, the partition table, the OTA block and the
 * application are all built by the ESP32 project's own PlatformIO build, published
 * beside each other, and written here at the offsets `esp32/partitions.csv` fixes.
 *
 * This is the single runtime read from another host anywhere in the launcher, and it
 * is the exception `agents.md` names: everything else the launcher needs is in the
 * file it already opened. A failed read is reported and nothing else happens.
 */
import { ESPLoader, Transport } from 'esptool-js';
import type { FlashOptions } from 'esptool-js';

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
}

/**
 * The layout read off `esp32/partitions.csv`: the bootloader, the partition table, the
 * OTA data block and the application fill the space below the filesystem, which owns
 * the rest of the 4 MB flash. The limits are the gaps between the regions, so a wrong
 * image fails before it can be written over its neighbour.
 */
export const ESP32_REGIONS: readonly Esp32Region[] = [
  { file: 'bootloader.bin', address: 0x1000, limit: 0x7000, magic: [0xe9] },
  { file: 'partitions.bin', address: 0x8000, limit: 0x6000, magic: [0xaa, 0x50] },
  { file: 'boot_app0.bin', address: 0xe000, limit: 0x2000, magic: [] },
  { file: 'firmware.bin', address: 0x10000, limit: 0x140000, magic: [0xe9] },
  { file: 'littlefs.bin', address: 0x150000, limit: 0x2b0000, magic: [] }
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

/**
 * Download every image, in layout order. The fetch is the offer's one network read;
 * anything that fails names the file so the dialog can say which one.
 */
export async function fetchEsp32Images(
  fetchImpl: typeof fetch = fetch,
  onProgress?: (file: string, index: number, count: number) => void
): Promise<Esp32Image[]> {
  const images: Esp32Image[] = [];
  for (const [index, region] of ESP32_REGIONS.entries()) {
    onProgress?.(region.file, index + 1, ESP32_REGIONS.length);
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
  const sizes = options.images
    .slice()
    .sort((left, right) => left.address - right.address)
    .map((image) => image.data.length);
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
        file: options.images[fileIndex]?.file ?? '',
        written: before + Math.min(written, total),
        total: grandTotal
      });
    }
  });
}

/**
 * Web Serial is Chromium only. This is what the manager's row is gated on, so the launcher
 * navigates a desktop app or a phone to a control its browser can never satisfy.
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
  onStage?: (stage: Esp32Stage, detail: string) => void;
  onProgress?: (progress: Esp32FlashProgress) => void;
}

/**
 * The offer end to end: fetch the images, ask for a port, write them, reset into the
 * new firmware, and let go of the port either way. A blank board needs no buttons
 * pressed; the loader's own reset sequence puts it in download mode.
 */
export async function flashLithicAppliance(options: FlashLithicOptions = {}): Promise<void> {
  const { fetchImpl = fetch, onStage, onProgress } = options;
  // Asked before the download rather than after it: a browser with no serial port would
  // otherwise pull about four megabytes and only then say it cannot reach a board. That is
  // also what a run outside a Chromium browser used to report as a download failure.
  if (!serialFlashSupported()) throw new Error('Web Serial is not available in this browser');
  const images = await fetchEsp32Images(fetchImpl, (file, index, count) =>
    onStage?.('downloading', `${index}/${count} ${file}`)
  );
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
