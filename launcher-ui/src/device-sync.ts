/**
 * The launcher's side of the browser sync engine.
 *
 * The engine is a wasm module built from the `sync` crate by
 * `sync/scripts/build-wasm-launcher.sh`, served as `launcher.wasm` beside
 * `src/launcher.html`, with its glue committed under `lithic-sync/` and bundled into
 * the launcher. This module is the only place that knows any of that: it loads the
 * module the first time device sync is actually used, keeps the device's identity in
 * the launcher's own store, and turns the engine's events into plain values a
 * component can hold.
 *
 * Four rules shape it.
 *
 * - Nothing is downloaded until it is needed. The glue is a dynamic import and the
 *   binary is fetched by the loader, so a page that never opens the panel pays for
 *   neither, and a `file://` copy (whose fetches are refused) or an instance that
 *   never shipped `launcher.wasm` reports "unavailable" rather than failing at boot.
 * - The identity belongs to the device, not to the session. Thirty-two bytes are
 *   generated once and kept in the launcher's IndexedDB, so a reload rejoins with the
 *   same node id instead of pairing again, and clearing site data means pairing again.
 * - One engine per page. The wasm surface registers a callback for the life of the
 *   module and offers no way to unregister it, so the session is a singleton: opening
 *   the panel twice must not deliver every event twice.
 * - The engine keeps nothing. Its replica is memory-only and the launcher's own store
 *   is the durable copy, so an entry that arrives is bytes to hand to the launcher
 *   rather than a file the engine now owns.
 */

/** The identity is a 32 byte seed, which is what the engine's `start` insists on. */
export const IDENTITY_BYTES = 32;

/** Where the device's identity and its minted ticket live in the launcher's store. */
export const IDENTITY_KEY = 'lithic-device-sync-identity';
export const TICKET_KEY = 'lithic-device-sync-ticket';

/**
 * Enough of the launcher's key/value store for this module to use it.
 *
 * Structural rather than imported (`storage.ts`'s `idb` satisfies it unchanged) so
 * the tests can hand in a Map and the module never reaches for IndexedDB itself.
 */
export interface SyncStore {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

/** One file in the paired folder, as the engine reports it. */
export interface SyncedEntry {
  name: string;
  size: number;
  hash: string;
  author: string;
  /** When it was written, in milliseconds: the engine counts microseconds since the epoch. */
  at: number;
}

/** What the folder did, translated from the wasm event object. */
export type DeviceSyncEvent =
  | { kind: 'remote-update'; name: string; from: string; base: Uint8Array | null; head: Uint8Array }
  | { kind: 'seeded'; name: string }
  | { kind: 'external-drift'; name: string }
  | { kind: 'peer-up'; from: string }
  | { kind: 'peer-down'; from: string }
  | { kind: 'failed'; name: string; reason: string };

/** Why device sync cannot run on this page. */
export type UnsupportedReason = 'file' | 'no-wasm' | 'no-crypto';

/**
 * Whether this page can run the engine at all.
 *
 * `file` is deliberate rather than a failure: a launcher opened from a USB stick has
 * no origin to fetch its own sibling files from, which is also why `file://` keeps the
 * no-sync behaviour the desktop app and the PWA are for.
 */
export function deviceSyncSupport(): { ok: true } | { ok: false; reason: UnsupportedReason } {
  if (typeof WebAssembly === 'undefined' || typeof fetch !== 'function') return { ok: false, reason: 'no-wasm' };
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') return { ok: false, reason: 'no-crypto' };
  if (typeof location !== 'undefined' && location.protocol === 'file:') return { ok: false, reason: 'file' };
  return { ok: true };
}

/**
 * A fresh identity, from the browser's own randomness.
 *
 * Passed in rather than read where it is used, so a test can hold a fixed seed.
 */
export function newIdentity(random: () => Uint8Array = randomBytes): Uint8Array {
  return random();
}

function randomBytes(): Uint8Array {
  const bytes = new Uint8Array(IDENTITY_BYTES);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** The stored identity, if what came back is one: IndexedDB can hand back either shape. */
export function asIdentity(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value.length === IDENTITY_BYTES ? value : null;
  if (value instanceof ArrayBuffer) return value.byteLength === IDENTITY_BYTES ? new Uint8Array(value) : null;
  return null;
}

/** The device's identity: what is stored, or a new one that is stored before it is used. */
export async function loadIdentity(store: SyncStore, random: () => Uint8Array = randomBytes): Promise<Uint8Array> {
  const stored = asIdentity(await store.get(IDENTITY_KEY));
  if (stored) return stored;
  const fresh = newIdentity(random);
  await store.set(IDENTITY_KEY, fresh);
  return fresh;
}

/** A pasted ticket, with the line breaks a chat window added taken out. */
export function normalizeTicket(text: string): string {
  return text.replace(/\s+/g, '');
}

/** One entry as the glue hands it over. Everything is `unknown` until it has been read. */
export interface RawEntry {
  name?: unknown;
  size?: unknown;
  hash?: unknown;
  author?: unknown;
  timestamp?: unknown;
}

/** The engine's entry object as the launcher's own value, or null when it is not one. */
export function toEntry(raw: unknown): SyncedEntry | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as RawEntry;
  if (typeof entry.name !== 'string' || entry.name === '') return null;
  return {
    name: entry.name,
    size: typeof entry.size === 'number' ? entry.size : 0,
    hash: typeof entry.hash === 'string' ? entry.hash : '',
    author: typeof entry.author === 'string' ? entry.author : '',
    at: typeof entry.timestamp === 'number' ? Math.round(entry.timestamp / 1000) : 0
  };
}

/** The engine's event object as the launcher's own value, or null when it names no kind. */
export function toEvent(raw: unknown): DeviceSyncEvent | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const event = raw as Record<string, unknown>;
  const name = typeof event.name === 'string' ? event.name : '';
  const from = typeof event.from === 'string' ? event.from : '';
  switch (event.kind) {
    case 'remote-update':
      return {
        kind: 'remote-update',
        name,
        from,
        base: event.base instanceof Uint8Array ? event.base : null,
        head: event.head instanceof Uint8Array ? event.head : new Uint8Array()
      };
    case 'seeded':
      return { kind: 'seeded', name };
    case 'external-drift':
      return { kind: 'external-drift', name };
    case 'peer-up':
      return { kind: 'peer-up', from };
    case 'peer-down':
      return { kind: 'peer-down', from };
    case 'failed':
      return { kind: 'failed', name, reason: typeof event.reason === 'string' ? event.reason : '' };
    default:
      return null;
  }
}

/** The engine, as far as this module uses it: exactly the wasm surface it exposes. */
export interface SyncEngineLike {
  node_id(): string;
  share(): Promise<string>;
  join(ticket: string): Promise<void>;
  entries(): Promise<RawEntry[]>;
  read(name: string): Promise<Uint8Array | undefined>;
  publish(name: string, bytes: Uint8Array): Promise<void>;
  subscribe(callback: (event: unknown) => void): void;
}

/**
 * How an engine is obtained: the real loader, or a stand-in in a test.
 *
 * `onEvent` is handed over rather than returned because the wasm surface has no way to
 * ask for events after `subscribe`, and the loader is where subscription happens.
 */
export type EngineFactory = (identity: Uint8Array, onEvent: (event: DeviceSyncEvent) => void) => Promise<SyncEngineLike>;

/** The engine's own address, beside whichever document loaded the launcher. */
export function wasmUrl(): URL {
  return new URL('launcher.wasm', document.baseURI);
}

/**
 * The real factory: the bundled glue, and the binary it is pointed at.
 *
 * The path is passed in rather than left to the glue's own default, so the file the
 * deployment must serve is named in one place that is not generated code.
 */
export const wasmEngineFactory: EngineFactory = async (identity, onEvent) => {
  const glue = await import('./lithic-sync/lithic_sync.js');
  await glue.default({ module_or_path: wasmUrl() });
  const engine = await glue.SyncEngine.start(identity);
  engine.subscribe((raw: unknown) => {
    const event = toEvent(raw);
    if (event) onEvent(event);
  });
  return engine;
};

/** Where the session is on its way from "not loaded" to "paired folder". */
export type DeviceSyncPhase = 'idle' | 'loading' | 'ready' | 'unavailable' | 'failed';

/** Everything the panel draws about the session. Replaced, never mutated. */
export interface DeviceSyncState {
  phase: DeviceSyncPhase;
  /** The engine's endpoint id, once it is running. */
  nodeId: string | null;
  /** This device's write ticket, whether it was minted now or remembered. */
  ticket: string | null;
  entries: SyncedEntry[];
  /** Peers seen since this page loaded, oldest first. */
  peers: string[];
  /** The last thing the folder did. */
  activity: DeviceSyncEvent | null;
  /** Why the session is unavailable or failed, or a failure that has since cleared. */
  error: string | null;
}

const EMPTY: DeviceSyncState = {
  phase: 'idle',
  nodeId: null,
  ticket: null,
  entries: [],
  peers: [],
  activity: null,
  error: null
};

/**
 * Read an entry, waiting for its content to land.
 *
 * The engine knows a file's name as soon as the entry arrives, but its bytes are
 * downloaded separately, and a read in between fails rather than answering empty. So
 * a pull is a retry loop rather than a single read: the caller asked for the file, and
 * "it is on its way" is not an answer to hand them.
 */
export async function readWhenReady(
  engine: SyncEngineLike,
  name: string,
  options: { attempts?: number; delayMs?: number; wait?: (ms: number) => Promise<void> } = {}
): Promise<Uint8Array | undefined> {
  const attempts = options.attempts ?? 40;
  const delayMs = options.delayMs ?? 750;
  const wait = options.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await engine.read(name);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts - 1) await wait(delayMs);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? `could not read ${name}`));
}

/**
 * One page's engine, and the state derived from it.
 *
 * `start` is the whole lifecycle: it checks that this page can run the engine at all,
 * loads the identity, loads the module, and reads the folder once. Everything after
 * that is a method that asks the engine a question and folds the answer into the state
 * the panel is drawing.
 */
export class DeviceSyncSession {
  private state: DeviceSyncState = EMPTY;
  private engine: SyncEngineLike | null = null;
  private starting: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly listeners = new Set<(state: DeviceSyncState) => void>();
  private readonly store: SyncStore;
  private readonly factory: EngineFactory;

  // Fields are assigned in the body rather than declared as constructor parameters: the
  // unit tests run under Node's type stripping, which refuses a parameter property.
  constructor(store: SyncStore, factory: EngineFactory = wasmEngineFactory) {
    this.store = store;
    this.factory = factory;
  }

  /** What the panel draws. A snapshot: the state object is replaced on every change. */
  get current(): DeviceSyncState {
    return this.state;
  }

  /** Follow the state. The returned function stops following. */
  follow(listener: (state: DeviceSyncState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Load the engine, once. Two calls are one call, including two concurrent ones. */
  start(): Promise<void> {
    if (!this.starting) this.starting = this.run();
    return this.starting;
  }

  private async run(): Promise<void> {
    const support = deviceSyncSupport();
    if (!support.ok) {
      this.patch({ phase: 'unavailable', error: support.reason });
      return;
    }
    this.patch({ phase: 'loading', error: null });
    try {
      const identity = await loadIdentity(this.store);
      this.engine = await this.factory(identity, (event) => this.handle(event));
      const ticket = await this.rememberedTicket();
      this.patch({ phase: 'ready', nodeId: this.engine.node_id(), ticket, error: null });
      await this.refresh();
    } catch (error) {
      this.patch({ phase: 'failed', error: message(error) });
    }
  }

  /** The ticket this device already minted, if it kept one. */
  private async rememberedTicket(): Promise<string | null> {
    try {
      const stored = await this.store.get(TICKET_KEY);
      return typeof stored === 'string' && stored.length > 0 ? stored : null;
    } catch {
      return null;
    }
  }

  /**
   * This device's ticket: the one it already had, or a freshly minted, remembered one.
   *
   * The engine waits for its home relay before minting (a ticket with no relay address
   * cannot be dialled by a browser), so this is the call that takes a moment, and it is
   * deliberately only on the button rather than on opening the panel.
   */
  async share(): Promise<string | null> {
    await this.start();
    const existing = this.state.ticket;
    if (existing) return existing;
    if (!this.engine) return null;
    try {
      const ticket = await this.engine.share();
      await this.store.set(TICKET_KEY, ticket);
      this.patch({ ticket, error: null });
      await this.refresh();
      return ticket;
    } catch (error) {
      this.patch({ error: message(error) });
      return null;
    }
  }

  /** Pair with another device from its ticket, then read the folder it brought. */
  async join(ticket: string): Promise<boolean> {
    await this.start();
    const cleaned = normalizeTicket(ticket);
    if (!cleaned) {
      this.patch({ error: 'empty-ticket' });
      return false;
    }
    if (!this.engine) return false;
    try {
      this.patch({ error: null });
      await this.engine.join(cleaned);
      await this.refresh();
      return true;
    } catch (error) {
      this.patch({ error: message(error) });
      return false;
    }
  }

  /** Write the bytes under a name. Publishing is explicit: nothing here saves on its own. */
  async publish(name: string, bytes: Uint8Array): Promise<boolean> {
    await this.start();
    if (!this.engine) return false;
    try {
      this.patch({ error: null });
      await this.engine.publish(name, bytes);
      await this.refresh();
      return true;
    } catch (error) {
      this.patch({ error: message(error) });
      return false;
    }
  }

  /** The folder's bytes for a name, waiting for content that is still downloading. */
  async pull(name: string): Promise<Uint8Array | undefined> {
    await this.start();
    if (!this.engine) return undefined;
    try {
      const bytes = await readWhenReady(this.engine, name);
      this.patch({ error: null });
      return bytes;
    } catch (error) {
      this.patch({ error: message(error) });
      return undefined;
    }
  }

  /** Read the folder again. Concurrent asks share one read, and the last one wins. */
  async refresh(): Promise<void> {
    if (!this.engine) return;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const entries = (await this.engine!.entries())
          .map((raw) => toEntry(raw))
          .filter((entry): entry is SyncedEntry => entry !== null)
          .sort((left, right) => left.name.localeCompare(right.name));
        this.patch({ entries, error: null });
      } catch (error) {
        this.patch({ error: message(error) });
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private handle(event: DeviceSyncEvent): void {
    const peers =
      event.kind === 'peer-up'
        ? [...this.state.peers.filter((peer) => peer !== event.from), event.from]
        : event.kind === 'peer-down'
          ? this.state.peers.filter((peer) => peer !== event.from)
          : this.state.peers;
    this.patch({ peers, activity: event });
    // An update or a seed changes what the folder holds, so the list is read again
    // rather than patched here: the engine is the only thing that knows the row.
    if (event.kind === 'remote-update' || event.kind === 'seeded' || event.kind === 'external-drift') {
      void this.refresh();
    }
  }

  private patch(change: Partial<DeviceSyncState>): void {
    this.state = { ...this.state, ...change };
    for (const listener of this.listeners) listener(this.state);
  }
}

let singleton: DeviceSyncSession | null = null;

/**
 * This page's session.
 *
 * One per page on purpose (see the module comment): the engine cannot be told to stop
 * following the folder, so a second session would be a second set of callbacks, and
 * everything the launcher draws would arrive twice.
 */
export function deviceSyncSession(store: SyncStore, factory: EngineFactory = wasmEngineFactory): DeviceSyncSession {
  if (!singleton) singleton = new DeviceSyncSession(store, factory);
  return singleton;
}

function message(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
