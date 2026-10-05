/**
 * The launcher's side of device sync, on either prong.
 *
 * There are two engines behind one panel and this module is the only place that knows
 * it. The browser's is a wasm module built from the `sync` crate by
 * `sync/scripts/build-wasm-launcher.sh`, served as `launcher.wasm` beside
 * `src/launcher.html`, with its glue committed under `lithic-sync/` and bundled into
 * the launcher. The desktop app's is native: Rust links the same crate, keeps its
 * identity and its copies under the app's own state folder, and answers the same calls
 * over Tauri IPC with the same events. Which one a page gets is decided once, by
 * `deviceSyncSupport`: the app's own page is the only one the native engine is reachable
 * from, and everything else that can run an engine at all runs the browser's.
 *
 * The rules that hold on both prongs:
 *
 * - Nothing happens until it is needed. The glue is a dynamic import and the binary is
 *   fetched by the loader; on the native prong the first command is the start. A page
 *   that never opens the panel pays for neither, and a `file://` copy (whose fetches
 *   are refused) reports "unavailable" rather than failing at boot.
 * - One engine per page. Neither engine can be told to stop following the folder, so
 *   the session is a singleton: opening the panel twice must not deliver every event
 *   twice.
 * - The session holds no facts of its own. Every button asks the engine, and every line
 *   the panel draws comes from the state the session published.
 *
 * The engines differ in what they keep. The browser's is memory-only and the launcher's
 * own store is the durable copy, so the device's thirty-two byte identity is generated
 * once and kept in IndexedDB, and a reload rejoins with the same node id instead of
 * pairing again. The native engine keeps everything under the app's state folder, so
 * there the identity is Rust's and the pairing survives a relaunch on its own; the
 * session still remembers the ticket text it minted, because that is what the panel's
 * ticket box reads before anyone presses the button again.
 */

import { hasTauriInvoke, tauriInvoke, tauriListen } from './file-bridge.ts';
import { servedByApp } from './mode.ts';

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

/** Which engine a page runs: the app's own, or the one built into the bundle. */
export type SyncBackend = 'native' | 'browser';

/**
 * Whether this page can run an engine at all, and which one.
 *
 * The app's own page is the one place the native engine is reachable from: Rust refuses
 * IPC from a document outside the app's URL, so a bookmarked instance opened in the app's
 * window (which has the injected global too) is not one. Everything else that can run an
 * engine at all runs the browser's, which needs WebAssembly and the randomness the
 * identity is made of. `file` is deliberate rather than a failure: a launcher opened from
 * a USB stick has no origin to fetch its own sibling files from, which is also why
 * `file://` keeps the no-sync behaviour the desktop app and the PWA are for.
 */
export function deviceSyncSupport(): { ok: true; kind: SyncBackend } | { ok: false; reason: UnsupportedReason } {
  if (nativeBackend()) return { ok: true, kind: 'native' };
  if (typeof WebAssembly === 'undefined' || typeof fetch !== 'function') return { ok: false, reason: 'no-wasm' };
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') return { ok: false, reason: 'no-crypto' };
  if (typeof location !== 'undefined' && location.protocol === 'file:') return { ok: false, reason: 'file' };
  return { ok: true, kind: 'browser' };
}

/**
 * Whether this page is the app's own, with its commands reachable.
 *
 * The served location is the question rather than the injected global, because with
 * `withGlobalTauri` the global is in every document the app's window loads, an instance's
 * own launcher included, where an invoke is refused.
 */
function nativeBackend(): boolean {
  return typeof location !== 'undefined' && servedByApp(location) && hasTauriInvoke();
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

/** The event the app's own engine emits on. The driver listens in place of the glue's callback. */
export const NATIVE_EVENT = 'device-sync-event';

/**
 * Encode bytes for the Tauri IPC, which carries JSON and nothing else.
 *
 * In chunks: `String.fromCharCode` takes one argument per byte, and a whole Lith's worth
 * of them in one call is a stack overflow waiting to happen.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** The bytes a base64 string carries: the inverse of `bytesToBase64`, byte for byte. */
export function base64ToBytes(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * The native engine, as far as the session uses it: the browser surface over Tauri IPC.
 *
 * The node id is known before this is built (the start answers with it), and the rest is
 * one command per call, with bytes base64 because that is what the IPC can carry. The
 * commands are named for the panel's own vocabulary, and the keys of every answer are
 * the browser glue's, so nothing above this class branches on the prong.
 */
class NativeEngine implements SyncEngineLike {
  private readonly id: string;

  constructor(nodeId: string) {
    this.id = nodeId;
  }

  node_id(): string {
    return this.id;
  }

  share(): Promise<string> {
    return tauriInvoke<string>('device_sync_share');
  }

  join(ticket: string): Promise<void> {
    return tauriInvoke<void>('device_sync_join', { ticket });
  }

  entries(): Promise<RawEntry[]> {
    return tauriInvoke<RawEntry[]>('device_sync_entries');
  }

  async read(name: string): Promise<Uint8Array | undefined> {
    const encoded = await tauriInvoke<string | null>('device_sync_read', { name });
    return encoded === null ? undefined : base64ToBytes(encoded);
  }

  publish(name: string, bytes: Uint8Array): Promise<void> {
    return tauriInvoke<void>('device_sync_publish', { name, bytes: bytesToBase64(bytes) });
  }

  subscribe(callback: (event: unknown) => void): void {
    tauriListen<unknown>(NATIVE_EVENT, callback);
  }
}

/**
 * How the native engine is obtained. It takes no identity: the app's is Rust's, kept
 * under the app's own state folder, so it survives a cleared webview profile and never
 * crosses the IPC.
 */
export type NativeEngineFactory = (onEvent: (event: DeviceSyncEvent) => void) => Promise<SyncEngineLike>;

/**
 * The real native factory: subscribe first, then start.
 *
 * The order matters only for what a resumed pairing reports while it is attaching (a seed
 * or an external drift); the listener is registered before the first command so none of it
 * is missed, and the refresh that follows a start reads the list either way. A start that
 * fails takes the listener back down, because there is no engine for it to belong to.
 */
export const nativeEngineFactory: NativeEngineFactory = async (onEvent) => {
  const stopListening = tauriListen<unknown>(NATIVE_EVENT, (payload) => {
    const event = toEvent(payload);
    if (event) onEvent(event);
  });
  try {
    const started = await tauriInvoke<{ node_id?: unknown }>('device_sync_start');
    const nodeId = typeof started?.node_id === 'string' ? started.node_id : '';
    return new NativeEngine(nodeId);
  } catch (error) {
    stopListening?.();
    throw error;
  }
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
 * `start` is the whole lifecycle: it checks that this page can run an engine at all and
 * which one it is, gets it running (the identity and the module here, one command on the
 * native prong), and reads the folder once. Everything after that is a method that asks
 * the engine a question and folds the answer into the state the panel is drawing.
 */
export class DeviceSyncSession {
  private state: DeviceSyncState = EMPTY;
  private engine: SyncEngineLike | null = null;
  private starting: Promise<void> | null = null;
  private refreshing: Promise<void> | null = null;
  private readonly listeners = new Set<(state: DeviceSyncState) => void>();
  private readonly store: SyncStore;
  private readonly factory: EngineFactory;
  private readonly nativeFactory: NativeEngineFactory;
  private nativeEngine = false;

  // Fields are assigned in the body rather than declared as constructor parameters: the
  // unit tests run under Node's type stripping, which refuses a parameter property.
  constructor(
    store: SyncStore,
    factory: EngineFactory = wasmEngineFactory,
    nativeFactory: NativeEngineFactory = nativeEngineFactory
  ) {
    this.store = store;
    this.factory = factory;
    this.nativeFactory = nativeFactory;
  }

  /**
   * Whether this session drives the app's own engine. Known once `start` has run. The
   * panel reads it for the one place a prong shows through: how a copy is saved, which on
   * the app is a file the app writes rather than a download this page starts.
   */
  get native(): boolean {
    return this.nativeEngine;
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
      if (support.kind === 'native') {
        this.nativeEngine = true;
        this.engine = await this.nativeFactory((event) => this.handle(event));
      } else {
        const identity = await loadIdentity(this.store);
        this.engine = await this.factory(identity, (event) => this.handle(event));
      }
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
