/**
 * The launcher's driver for device sync, tested without a browser and without the app.
 *
 * The engines' own sync is proven elsewhere (the crate's tests and smoke script, and the
 * launcher's browser pass); nothing here loads wasm or reaches Rust. What is pinned is the
 * half the launcher owns: which engine a page gets, the identity generated once and kept,
 * a ticket remembered rather than minted twice, the engine's entry and event objects read
 * as values rather than trusted, a read that is still downloading retried instead of
 * reported as an error, the commands the native prong sends and the shapes it accepts,
 * and the state a component draws saying what actually happened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSearchCacheText, listWikiVersions, saveIrohVersion } from './storage.ts';
import {
  DeviceSyncSession,
  IDENTITY_BYTES,
  IDENTITY_KEY,
  PAIRING_KEY,
  TICKET_KEY,
  asIdentity,
  base64ToBytes,
  bytesToBase64,
  deviceSyncSession,
  deviceSyncSupport,
  loadIdentity,
  normalizeTicket,
  readWhenReady,
  toEntry,
  toEvent,
  type DeviceSyncEvent,
  type EngineFactory,
  type RawEntry,
  type SyncEngineLike,
  type SyncStore
} from './device-sync.ts';

/** The launcher's key/value store, in memory. */
class MemoryStore implements SyncStore {
  private data = new Map<string, unknown>();
  keys(): Promise<IDBValidKey[]> {
    return Promise.resolve([...this.data.keys()]);
  }
  get<T = unknown>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.data.get(key) as T | undefined);
  }
  set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
    return Promise.resolve();
  }
  del(key: string): Promise<void> {
    this.data.delete(key);
    return Promise.resolve();
  }
}

/** A stand-in engine that records what it was asked and answers what the test set up. */
class FakeEngine implements SyncEngineLike {
  calls: string[] = [];
  tickets = 0;
  rows: RawEntry[] = [];
  bytes = new Map<string, Uint8Array>();
  readsToFail = 0;
  private listener: ((event: unknown) => void) | null = null;

  node_id(): string {
    return 'node-a';
  }
  share(): Promise<string> {
    this.calls.push('share');
    this.tickets += 1;
    return Promise.resolve(`ticket-${this.tickets}`);
  }
  join(ticket: string): Promise<void> {
    this.calls.push(`join:${ticket}`);
    return Promise.resolve();
  }
  entries(): Promise<RawEntry[]> {
    this.calls.push('entries');
    return Promise.resolve(this.rows);
  }
  read(name: string): Promise<Uint8Array | undefined> {
    this.calls.push(`read:${name}`);
    if (this.readsToFail > 0) {
      this.readsToFail -= 1;
      return Promise.reject(new Error('the content of x is not available yet: encode error'));
    }
    return Promise.resolve(this.bytes.get(name));
  }
  publish(name: string, bytes: Uint8Array): Promise<void> {
    this.calls.push(`publish:${name}`);
    this.bytes.set(name, bytes);
    return Promise.resolve();
  }
  subscribe(callback: (event: unknown) => void): void {
    this.listener = callback;
  }
  /** What the engine would emit, delivered to whoever subscribed. */
  emit(event: unknown): void {
    this.listener?.(event);
  }
}

/**
 * The app's own page, with a stand-in for the bridge Rust injects.
 *
 * `servedByApp` is what makes a page the app's, and `__TAURI__` is what makes its
 * commands reachable, so both are installed here and taken back down when the test ends.
 */
interface FakeTauri {
  /** Every command the page asked, in order, with the arguments it sent. */
  invokes: Array<{ command: string; args?: Record<string, unknown> }>;
  /** What the next `device_sync_start` and friends answer. Throwing is a refusal. */
  answer: (command: string, args?: Record<string, unknown>) => unknown;
  /** The event handler the page registered, and how often one was taken back down. */
  listener: ((message: { payload: unknown }) => void) | null;
  unlistened: number;
}

async function withAppPage<T>(run: (tauri: FakeTauri) => Promise<T>): Promise<T> {
  const beforeLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
  const beforeTauri = Object.getOwnPropertyDescriptor(globalThis, '__TAURI__');
  const tauri: FakeTauri = { invokes: [], listener: null, unlistened: 0, answer: () => null };
  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'https:', hostname: 'tauri.localhost', pathname: '/launcher.html' },
    configurable: true
  });
  Object.defineProperty(globalThis, '__TAURI__', {
    value: {
      core: {
        invoke: (command: string, args?: Record<string, unknown>) => {
          tauri.invokes.push({ command, args });
          try {
            return Promise.resolve(tauri.answer(command, args));
          } catch (error) {
            return Promise.reject(error);
          }
        }
      },
      event: {
        listen: (event: string, handler: (message: { payload: unknown }) => void) => {
          tauri.listener = handler;
          return Promise.resolve(() => {
            tauri.unlistened += 1;
            tauri.listener = null;
          });
        }
      }
    },
    configurable: true
  });
  try {
    return await run(tauri);
  } finally {
    if (beforeLocation) Object.defineProperty(globalThis, 'location', beforeLocation);
    else delete (globalThis as { location?: unknown }).location;
    if (beforeTauri) Object.defineProperty(globalThis, '__TAURI__', beforeTauri);
    else delete (globalThis as { __TAURI__?: unknown }).__TAURI__;
  }
}

function sessionWith(options: { store?: MemoryStore; engine?: FakeEngine; events?: DeviceSyncEvent[]; reloadBrowser?: () => void } = {}) {
  const store = options.store ?? new MemoryStore();
  const engine = options.engine ?? new FakeEngine();
  let factoryCalls = 0;
  const factory: EngineFactory = async (identity, onEvent) => {
    factoryCalls += 1;
    assert.equal(identity.length, IDENTITY_BYTES);
    engine.subscribe((raw: unknown) => {
      const event = toEvent(raw);
      if (event) onEvent(event);
    });
    return engine;
  };
  return { store, engine, session: new DeviceSyncSession(store, factory, undefined, options.reloadBrowser), factoryCalls: () => factoryCalls };
}

test('a new identity is 32 bytes and is kept, so the next boot reuses it', async () => {
  const store = new MemoryStore();
  const first = await loadIdentity(store, () => new Uint8Array(IDENTITY_BYTES).fill(7));
  assert.equal(first.length, IDENTITY_BYTES);
  assert.equal(first[0], 7);
  assert.deepEqual(await store.get(IDENTITY_KEY), first);

  // A second load answers what was stored rather than asking for randomness again, which
  // is the whole point: the node id a peer paired with must survive a reload.
  let asked = 0;
  const again = await loadIdentity(store, () => {
    asked += 1;
    return new Uint8Array(IDENTITY_BYTES).fill(9);
  });
  assert.equal(asked, 0);
  assert.deepEqual(again, first);
});

test('a stored identity of the wrong size is replaced rather than used', async () => {
  const store = new MemoryStore();
  await store.set(IDENTITY_KEY, new Uint8Array(8));
  const identity = await loadIdentity(store, () => new Uint8Array(IDENTITY_BYTES).fill(3));
  assert.equal(identity.length, IDENTITY_BYTES);
  assert.deepEqual(await store.get(IDENTITY_KEY), identity);
});

test('an identity reads back as whichever shape storage handed over', () => {
  const bytes = new Uint8Array(IDENTITY_BYTES).fill(1);
  assert.deepEqual(asIdentity(bytes), bytes);
  assert.deepEqual(asIdentity(bytes.buffer), bytes);
  assert.equal(asIdentity(new Uint8Array(4)), null);
  assert.equal(asIdentity('nope'), null);
  assert.equal(asIdentity(undefined), null);
});

test('a pasted ticket loses the whitespace a chat window added', () => {
  assert.equal(normalizeTicket('  docaaqbc\n def  '), 'docaaqbcdef');
  assert.equal(normalizeTicket(''), '');
});

test('an entry is read as a value, and anything else is refused', () => {
  // The timestamp is microseconds since the epoch, and the launcher draws milliseconds.
  assert.deepEqual(toEntry({ name: 'a.lith', size: 12, hash: 'h', author: 'node-a', timestamp: 1_700_000_000_000_000 }), {
    name: 'a.lith',
    size: 12,
    hash: 'h',
    author: 'node-a',
    at: 1_700_000_000_000
  });
  assert.deepEqual(toEntry({ name: 'a.lith' }), { name: 'a.lith', size: 0, hash: '', author: '', at: 0 });
  assert.equal(toEntry({ size: 12 }), null);
  assert.equal(toEntry('a.lith'), null);
  assert.equal(toEntry(null), null);
});

test('every event kind maps to a plain value, and an unknown kind is dropped', () => {
  const head = new Uint8Array([1, 2]);
  const first = toEvent({ kind: 'remote-update', name: 'a.lith', from: 'node-b', base: new Uint8Array([0]), head, at: 1_700_000_000_000_000 });
  assert.deepEqual(first, {
    kind: 'remote-update',
    name: 'a.lith',
    from: 'node-b',
    base: new Uint8Array([0]),
    head,
    at: 1_700_000_000_000
  });
  assert.deepEqual(toEvent({
    kind: 'remote-update', name: 'a.lith', from: 'node-b',
    base: bytesToBase64(new Uint8Array([3, 4])), head: bytesToBase64(head), at: 1_700_000_000_000_000
  }), {
    kind: 'remote-update', name: 'a.lith', from: 'node-b',
    base: new Uint8Array([3, 4]), head, at: 1_700_000_000_000
  });

  // A first publish has no base, and the glue answers with undefined rather than an id.
  const firstVersion = toEvent({ kind: 'remote-update', name: 'a.lith', from: 'node-b', head, at: 1_700_000_000_000_000 });
  assert.equal((firstVersion as { base: unknown }).base, null);
  assert.equal((firstVersion as { at: number }).at, 1_700_000_000_000);
  assert.deepEqual(toEvent({ kind: 'seeded', name: 'a.lith' }), { kind: 'seeded', name: 'a.lith' });
  assert.deepEqual(toEvent({ kind: 'external-drift', name: 'a.lith' }), { kind: 'external-drift', name: 'a.lith' });
  assert.deepEqual(toEvent({ kind: 'peer-up', from: 'node-b' }), { kind: 'peer-up', from: 'node-b' });
  assert.deepEqual(toEvent({ kind: 'peer-down', from: 'node-b' }), { kind: 'peer-down', from: 'node-b' });
  assert.deepEqual(toEvent({ kind: 'failed', name: 'a.lith', reason: 'refused' }), {
    kind: 'failed',
    name: 'a.lith',
    reason: 'refused'
  });
  assert.equal(toEvent({ kind: 'something-new' }), null);
  assert.equal(toEvent(null), null);
});

test('a file:// page reports device sync unavailable rather than loading anything', () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { protocol: 'file:' }, configurable: true });
  try {
    assert.deepEqual(deviceSyncSupport(), { ok: false, reason: 'file' });
  } finally {
    if (before) Object.defineProperty(globalThis, 'location', before);
    else delete (globalThis as { location?: unknown }).location;
  }
  // Node has no `location` at all, and that is not a refusal: it is the browser's engine.
  assert.deepEqual(deviceSyncSupport(), { ok: true, kind: 'browser' });
});

test('an unavailable session never reaches the engine', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', { value: { protocol: 'file:' }, configurable: true });
  try {
    const { session, factoryCalls } = sessionWith();
    await session.start();
    assert.equal(session.current.phase, 'unavailable');
    assert.equal(session.current.error, 'file');
    assert.equal(factoryCalls(), 0);
  } finally {
    if (before) Object.defineProperty(globalThis, 'location', before);
    else delete (globalThis as { location?: unknown }).location;
  }
});

test('starting reads the identity, the folder, and a ticket it already kept', async () => {
  const store = new MemoryStore();
  await store.set(PAIRING_KEY, 'kept-ticket');
  await store.set(TICKET_KEY, 'own-share-ticket');
  const engine = new FakeEngine();
  engine.rows = [{ name: 'b.lith', size: 2, hash: 'hb', author: 'node-a', timestamp: 2_000_000 }, { name: 'a.lith', size: 1 }];
  const { session } = sessionWith({ store, engine });

  await session.start();
  assert.equal(session.current.phase, 'ready');
  assert.equal(session.current.nodeId, 'node-a');
  assert.equal(session.current.ticket, 'own-share-ticket');
  assert.equal(await store.get(PAIRING_KEY), 'kept-ticket');
  assert.equal(session.current.paired, true);
  assert.ok(engine.calls.includes('join:kept-ticket'));
  // Sorted, so the panel's list does not move when the engine's order changes.
  assert.deepEqual(session.current.entries.map((entry) => entry.name), ['a.lith', 'b.lith']);
  assert.deepEqual(await store.get(IDENTITY_KEY) instanceof Uint8Array, true);
  // Starting twice is starting once.
  await session.start();
  assert.equal(engine.calls.filter((call) => call === 'entries').length, 1);
});

test('a ticket is minted once and remembered, not minted again on every look', async () => {
  const { store, engine, session } = sessionWith();
  await session.start();
  assert.equal(await session.share(), 'ticket-1');
  assert.equal(await store.get(TICKET_KEY), 'ticket-1');
  assert.equal(await store.get(PAIRING_KEY), 'ticket-1');
  assert.equal(await session.share(), 'ticket-1');
  assert.equal(engine.tickets, 1);
});

test('sharing is unavailable after joining another device', async () => {
  const { engine, session } = sessionWith();
  await session.start();
  assert.equal(await session.join('peer-ticket'), true);
  assert.equal(await session.share(), null);
  assert.equal(engine.tickets, 0);
  assert.deepEqual(engine.calls.filter((call) => call.startsWith('join:')), ['join:peer-ticket']);
});

test('unpair waits for a pending join, then detaches that pairing', async () => {
  let reloaded = false;
  const { engine, session, store } = sessionWith({ reloadBrowser: () => { reloaded = true; } });
  await session.start();
  let finishJoin!: () => void;
  engine.join = (ticket) => {
    engine.calls.push(`join:${ticket}`);
    return new Promise<void>((resolve) => { finishJoin = resolve; });
  };
  const joining = session.join('peer-ticket');
  await Promise.resolve();
  assert.equal(typeof finishJoin, 'function');
  const unpairing = session.unpair();
  finishJoin();
  assert.equal(await joining, true);
  assert.equal(await unpairing, true);
  assert.equal(session.current.paired, false);
  assert.equal(await store.get(PAIRING_KEY), undefined);
  assert.equal(reloaded, true);
  assert.ok(!engine.calls.includes('unpair'));
});

test('a failed browser pairing save detaches and clears the incomplete ticket', async () => {
  const store = new MemoryStore();
  const originalSet = store.set.bind(store);
  store.set = (key, value) => key === PAIRING_KEY
    ? Promise.reject(new Error('storage refused'))
    : originalSet(key, value);
  let reloaded = false;
  const { engine, session } = sessionWith({ store, reloadBrowser: () => { reloaded = true; } });
  await session.start();
  assert.equal(await session.join('peer-ticket'), false);
  assert.equal(session.current.paired, false);
  assert.equal(session.current.error, 'storage refused');
  assert.equal(await store.get(PAIRING_KEY), undefined);
  assert.equal(await store.get(TICKET_KEY), undefined);
  assert.ok(!engine.calls.includes('unpair'));
  assert.equal(reloaded, true);
});

test('joining normalizes and persists the ticket; unpair forgets it and keeps identity', async () => {
  let reloaded = false;
  const { engine, session, store } = sessionWith({ reloadBrowser: () => { reloaded = true; } });
  engine.rows = [{ name: 'a.lith' }];
  await session.start();
  assert.equal(await session.join('  doc abc\n'), true);
  assert.ok(engine.calls.includes('join:docabc'));
  assert.deepEqual(session.current.entries.map((entry) => entry.name), ['a.lith']);
  assert.equal(session.current.paired, true);
  assert.equal(await store.get(PAIRING_KEY), 'docabc');
  assert.equal(await session.unpair(), true);
  assert.equal(session.current.paired, false);
  assert.equal(await store.get(PAIRING_KEY), undefined);
  assert.equal(await store.get(TICKET_KEY), undefined);
  assert.ok(await store.get(IDENTITY_KEY) instanceof Uint8Array);
  assert.equal(reloaded, true);
  assert.ok(!engine.calls.includes('unpair'), 'the shipped browser binding has no detach method');

  assert.equal(await session.join('   '), false);
  assert.equal(session.current.error, 'empty-ticket');
});

test('publishing hands the bytes to the engine and answers whether it landed', async () => {
  const { engine, session } = sessionWith();
  await session.start();
  const bytes = new Uint8Array([1, 2, 3]);
  assert.equal(await session.publish('a.lith', bytes), true);
  assert.deepEqual(engine.bytes.get('a.lith'), bytes);

  engine.publish = () => Promise.reject(new Error('refused'));
  assert.equal(await session.publish('a.lith', bytes), false);
  assert.equal(session.current.error, 'refused');
});

test('a pull waits for content that is still downloading', async () => {
  const engine = new FakeEngine();
  engine.bytes.set('a.lith', new Uint8Array([9]));
  engine.readsToFail = 2;
  const waits: number[] = [];
  const bytes = await readWhenReady(engine, 'a.lith', {
    attempts: 5,
    delayMs: 4,
    wait: (ms) => {
      waits.push(ms);
      return Promise.resolve();
    }
  });
  assert.deepEqual(bytes, new Uint8Array([9]));
  assert.deepEqual(waits, [4, 4]);
});

test('a pull that never lands answers the engine’s own failure', async () => {
  const engine = new FakeEngine();
  engine.readsToFail = 10;
  await assert.rejects(
    readWhenReady(engine, 'a.lith', { attempts: 3, delayMs: 1, wait: () => Promise.resolve() }),
    /not available yet/
  );
});

test('an update from a peer refreshes the list and moves the peer set', async () => {
  const engine = new FakeEngine();
  engine.rows = [{ name: 'a.lith' }];
  const { session } = sessionWith({ engine });
  await session.start();

  engine.rows = [{ name: 'a.lith' }, { name: 'b.lith' }];
  engine.emit({ kind: 'peer-up', from: 'node-b' });
  engine.emit({ kind: 'remote-update', name: 'b.lith', from: 'node-b', head: new Uint8Array([1]), at: 1_700_000_000_000_000 });
  // The refresh the event asked for is not awaited by the event, so the list is read
  // again from the session rather than assumed to have landed.
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(session.current.entries.map((entry) => entry.name), ['a.lith', 'b.lith']);
  assert.deepEqual(session.current.peers, ['node-b']);
  assert.equal(session.current.activity?.kind, 'remote-update');

  engine.emit({ kind: 'peer-down', from: 'node-b' });
  assert.deepEqual(session.current.peers, []);
});

test('following the session answers the current state first and stops when asked', async () => {
  const { session } = sessionWith();
  const seen: string[] = [];
  const stop = session.follow((state) => seen.push(state.phase));
  await session.start();
  stop();
  assert.equal(seen[0], 'idle');
  assert.ok(seen.includes('loading'));
  assert.ok(seen.includes('ready'));
  const after = seen.length;
  await session.share();
  assert.equal(seen.length, after);
});

test('browser unpair clears its ticket and restarts without losing local identity', async () => {
  const store = new MemoryStore();
  const identity = new Uint8Array(IDENTITY_BYTES).fill(12);
  await store.set(IDENTITY_KEY, identity);
  await store.set(PAIRING_KEY, 'saved-ticket');
  const engines: FakeEngine[] = [];
  const factory: EngineFactory = async (_identity, onEvent) => {
    const engine = new FakeEngine();
    engine.subscribe((raw) => {
      const event = toEvent(raw);
      if (event) onEvent(event);
    });
    engines.push(engine);
    return engine;
  };
  let reloaded = false;
  const session = new DeviceSyncSession(store, factory, undefined, () => { reloaded = true; });
  await session.start();
  assert.equal(session.current.paired, true);
  assert.equal(engines.length, 1);
  assert.equal(await session.unpair(), true);
  assert.equal(engines.length, 1);
  assert.equal(reloaded, true);
  assert.equal(session.current.paired, false);
  assert.equal(await store.get(PAIRING_KEY), undefined);
  assert.deepEqual(await store.get(IDENTITY_KEY), identity);
});

test('received Iroh versions update the searchable cache and History Trail', async () => {
  const store = new MemoryStore();
  const first = JSON.stringify([{ title: 'A', text: 'first' }]);
  const second = JSON.stringify([{ title: 'A', text: 'second' }]);
  await saveIrohVersion('notes.lith', first, 1_700_000_000_000, store);
  await saveIrohVersion('notes.lith', second, 1_700_000_000_001, store);
  assert.equal(await getSearchCacheText('notes.lith', store), second);
  const versions = await listWikiVersions('notes.lith', store);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].external, true);
  assert.equal(versions[0].isBase, true);
  assert.equal((await store.get('search_cache_meta_notes.lith') as { versions: unknown[] }).versions.length, 2);
});

test('the page has one session, because the engine cannot be told to stop', () => {
  const first = deviceSyncSession(new MemoryStore());
  const second = deviceSyncSession(new MemoryStore());
  assert.equal(first, second);
});

test('the app page gets the native engine, and needs no wasm of its own', async () => {
  await withAppPage(async () => {
    assert.deepEqual(deviceSyncSupport(), { ok: true, kind: 'native' });
  });
  // Back outside the app, and that is the browser's engine rather than a refusal.
  assert.deepEqual(deviceSyncSupport(), { ok: true, kind: 'browser' });
});

test('a page on the app url with no bridge is not a native one', async () => {
  // The global is missing (a test harness, an embedding): the page falls back to the
  // browser's checks rather than promising commands nothing answers.
  const before = Object.getOwnPropertyDescriptor(globalThis, 'location');
  Object.defineProperty(globalThis, 'location', {
    value: { protocol: 'tauri:', hostname: 'localhost', pathname: '/launcher.html' },
    configurable: true
  });
  try {
    assert.deepEqual(deviceSyncSupport(), { ok: true, kind: 'browser' });
  } finally {
    if (before) Object.defineProperty(globalThis, 'location', before);
    else delete (globalThis as { location?: unknown }).location;
  }
});

test('a native session asks Rust for the engine and never loads the browser one', async () => {
  await withAppPage(async (tauri) => {
    let reads = 0;
    tauri.answer = (command) => {
      switch (command) {
        case 'device_sync_start':
          return { node_id: 'node-app' };
        case 'device_sync_status':
          return { paired: false, peers: 0 };
        case 'device_sync_unpair':
          return null;
        case 'device_sync_share':
          return 'ticket-app';
        case 'device_sync_entries':
          return [{ name: 'a.lith', size: 3, hash: 'h', author: 'node-app', timestamp: 3_000_000 }];
        case 'device_sync_read':
          reads += 1;
          // The content is still downloading: the first read fails the way the native
          // engine fails, and the driver waits rather than reporting it.
          if (reads === 1) throw new Error('the content of a.lith is not available yet');
          return bytesToBase64(new Uint8Array([1, 2, 3]));
        default:
          return null;
      }
    };

    const engine = new FakeEngine();
    let browserFactoryCalls = 0;
    const browserFactory: EngineFactory = () => {
      browserFactoryCalls += 1;
      return Promise.resolve(engine);
    };
    const session = new DeviceSyncSession(new MemoryStore(), browserFactory);

    await session.start();
    assert.equal(session.native, true);
    assert.equal(browserFactoryCalls, 0);
    assert.equal(session.current.phase, 'ready');
    assert.equal(session.current.nodeId, 'node-app');
    assert.deepEqual(session.current.entries.map((entry) => entry.name), ['a.lith']);

    assert.equal(await session.join(' docabc\n'), true);
    assert.equal(session.current.ticket, null);
    assert.equal(await session.share(), null, 'one device cannot switch documents by sharing after it joins');
    assert.equal(await session.publish('b.lith', new Uint8Array([9, 8])), true);
    assert.deepEqual(await session.pull('a.lith'), new Uint8Array([1, 2, 3]));
    assert.equal(reads, 2, 'the failed read should have been retried');

    // The commands the native engine sends, and the arguments that cross in each
    // direction: a normalized ticket in, base64 bytes out.
    const commands = tauri.invokes.map((call) => call.command);
    assert.equal(commands[0], 'device_sync_start');
    assert.ok(commands.includes('device_sync_entries'));
    assert.deepEqual(
      tauri.invokes.find((call) => call.command === 'device_sync_join')?.args,
      { ticket: 'docabc' }
    );
    assert.deepEqual(
      tauri.invokes.find((call) => call.command === 'device_sync_publish')?.args,
      { name: 'b.lith', bytes: bytesToBase64(new Uint8Array([9, 8])) }
    );
    assert.ok(commands.includes('device_sync_status'));

    // The events arrive on the name Rust emits, and land in the state the panel reads.
    assert.ok(tauri.listener, 'the driver should have subscribed before starting');
    tauri.listener?.({ payload: { kind: 'peer-up', from: 'node-b' } });
    assert.equal(await session.unpair(), true);
    assert.ok(tauri.invokes.some((call) => call.command === 'device_sync_unpair'));
    tauri.listener?.({ payload: { kind: 'peer-up', from: 'node-b' } });
    assert.deepEqual(session.current.peers, ['node-b']);
    tauri.listener?.({ payload: { kind: 'remote-update', name: 'a.lith', from: 'node-b' } });
    assert.equal(session.current.activity?.kind, 'remote-update');
  });
});

test('a native start that fails takes its listener back down', async () => {
  await withAppPage(async (tauri) => {
    tauri.answer = () => {
      throw new Error('this machine has no state folder for device sync');
    };
    const session = new DeviceSyncSession(new MemoryStore());
    await session.start();
    assert.equal(session.current.phase, 'failed');
    assert.match(String(session.current.error), /state folder/);
    assert.equal(tauri.unlistened, 1);
  });
});

test('bytes survive the base64 round trip the IPC needs', () => {
  const cases = [
    new Uint8Array(0),
    new Uint8Array([0]),
    new Uint8Array([0, 255, 128, 63]),
    // One byte past the chunk boundary, because the encoder works in chunks.
    new Uint8Array(0x8000 + 1).map((_, index) => index % 251)
  ];
  for (const bytes of cases) {
    assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  }
  const hello = new TextEncoder().encode('hello');
  assert.equal(bytesToBase64(hello), 'aGVsbG8=');
  assert.deepEqual(base64ToBytes('aGVsbG8='), hello);
});
