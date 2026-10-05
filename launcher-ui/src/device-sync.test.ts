/**
 * The launcher's driver for the browser engine, tested without a browser.
 *
 * The engine's own sync is proven elsewhere (the crate's smoke script, and the launcher's
 * browser pass); nothing here loads wasm. What is pinned is the half the launcher owns: the
 * identity is generated once and kept, a ticket is remembered rather than minted twice, the
 * engine's entry and event objects are read as values rather than trusted, a read that is
 * still downloading is retried instead of reported as an error, and the state a component
 * draws says what actually happened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DeviceSyncSession,
  IDENTITY_BYTES,
  IDENTITY_KEY,
  TICKET_KEY,
  asIdentity,
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
  get<T = unknown>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.data.get(key) as T | undefined);
  }
  set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
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

function sessionWith(options: { store?: MemoryStore; engine?: FakeEngine; events?: DeviceSyncEvent[] } = {}) {
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
  return { store, engine, session: new DeviceSyncSession(store, factory), factoryCalls: () => factoryCalls };
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
  assert.deepEqual(toEvent({ kind: 'remote-update', name: 'a.lith', from: 'node-b', base: new Uint8Array([0]), head }), {
    kind: 'remote-update',
    name: 'a.lith',
    from: 'node-b',
    base: new Uint8Array([0]),
    head
  });
  // A first publish has no base, and the glue answers with undefined rather than an id.
  assert.equal((toEvent({ kind: 'remote-update', name: 'a.lith', from: 'node-b', head }) as { base: unknown }).base, null);
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
  // Node has no `location` at all, and that is not a refusal.
  assert.deepEqual(deviceSyncSupport(), { ok: true });
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
  await store.set(TICKET_KEY, 'kept-ticket');
  const engine = new FakeEngine();
  engine.rows = [{ name: 'b.lith', size: 2, hash: 'hb', author: 'node-a', timestamp: 2_000_000 }, { name: 'a.lith', size: 1 }];
  const { session } = sessionWith({ store, engine });

  await session.start();
  assert.equal(session.current.phase, 'ready');
  assert.equal(session.current.nodeId, 'node-a');
  assert.equal(session.current.ticket, 'kept-ticket');
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
  assert.equal(await session.share(), 'ticket-1');
  assert.equal(engine.tickets, 1);
});

test('joining normalizes the paste, and a failed join is a value with its reason', async () => {
  const { engine, session } = sessionWith();
  engine.rows = [{ name: 'a.lith' }];
  await session.start();
  assert.equal(await session.join('  doc abc\n'), true);
  assert.ok(engine.calls.includes('join:docabc'));
  assert.deepEqual(session.current.entries.map((entry) => entry.name), ['a.lith']);

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
  engine.emit({ kind: 'remote-update', name: 'b.lith', from: 'node-b', head: new Uint8Array([1]) });
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

test('the page has one session, because the engine cannot be told to stop', () => {
  const first = deviceSyncSession(new MemoryStore());
  const second = deviceSyncSession(new MemoryStore());
  assert.equal(first, second);
});
