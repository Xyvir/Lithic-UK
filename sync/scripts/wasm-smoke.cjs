#!/usr/bin/env node
// End-to-end smoke for the browser build of lithic-sync.
//
// Build the module first, then run this file with Node 22 or newer:
//
//   cargo build --target wasm32-unknown-unknown --no-default-features --features wasm
//   wasm-bindgen --target nodejs --out-dir target/wasm-node \
//       target/wasm32-unknown-unknown/debug/lithic_sync.wasm
//   node scripts/wasm-smoke.cjs
//
// Two engines run in one process and pair over the n0 relay service, the
// only transport a browser endpoint has. Both subscribe, so the test proves
// the subscribe surface delivers a remote update as an event, not only that
// read() eventually sees the bytes. If the relay service is unreachable the
// pair never syncs and the wait below fails; start, share, publish and read
// on a single engine still run.
//
// LITHIC_WASM_GLUE points at the generated glue, for non-default output dirs.

const path = require('node:path');

const glue =
  process.env.LITHIC_WASM_GLUE ||
  path.join(__dirname, '..', 'target', 'wasm-node', 'lithic_sync.js');
const { SyncEngine } = require(glue);

let failures = 0;

function check(name, ok, detail) {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail === undefined ? '' : `: ${detail}`}`);
  }
}

function equal(name, actual, expected) {
  check(
    name,
    actual === expected,
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

async function waitFor(name, probe, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await probe()) {
      console.log(`  ok   ${name}`);
      return true;
    }
    if (Date.now() >= deadline) {
      check(name, false, `timed out after ${timeoutMs}ms`);
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

const decode = (bytes) => (bytes && new TextDecoder().decode(bytes)) || undefined;
const encode = (text) => new TextEncoder().encode(text);

// A file may be listed before its content has finished downloading, and
// read() reports that as an error; keep polling until it lands.
async function readableText(engine, name) {
  try {
    return decode(await engine.read(name));
  } catch {
    return undefined;
  }
}

(async () => {
  const eventsA = [];
  const eventsB = [];

  console.log('start A under the fixed identity');
  const a = await SyncEngine.start(new Uint8Array(32).fill(7));
  const nodeA = a.node_id();
  check('A.node_id is an endpoint id', /^[0-9a-f]{64}$/.test(nodeA), nodeA);
  a.subscribe((event) => eventsA.push(event));

  console.log('share');
  const ticket = await a.share();
  check(
    'share returns a ticket',
    typeof ticket === 'string' && ticket.length > 40,
    typeof ticket === 'string' ? ticket.slice(0, 24) : typeof ticket,
  );

  console.log('publish and read on A');
  await a.publish('notes.lith', encode('v1'));
  equal('read returns the published bytes', decode(await a.read('notes.lith')), 'v1');
  equal('read of a missing file is undefined', await a.read('missing.lith'), undefined);

  const entriesA = await a.entries();
  check('entries lists the one file', Array.isArray(entriesA) && entriesA.length === 1, JSON.stringify(entriesA));
  if (entriesA[0]) {
    equal('entry name', entriesA[0].name, 'notes.lith');
    equal('entry size', entriesA[0].size, 2);
  }

  console.log('start B under a second fixed identity and join');
  const b = await SyncEngine.start(new Uint8Array(32).fill(9));
  const nodeB = b.node_id();
  check('B has its own endpoint id', nodeB !== nodeA);
  b.subscribe((event) => eventsB.push(event));
  await b.join(ticket);
  check('join returned', true);

  console.log('wait for B to sync the file');
  await waitFor('B reads v1 after joining', async () => (await readableText(b, 'notes.lith')) === 'v1');
  await waitFor('B was handed a remote-update event', () =>
    eventsB.some((event) => event.kind === 'remote-update' && event.name === 'notes.lith'),
  );
  const updateB = eventsB.find((event) => event.kind === 'remote-update' && event.name === 'notes.lith');
  if (updateB) {
    equal('B event head', decode(updateB.head), 'v1');
    equal('B event from', updateB.from, nodeA);
  }

  console.log('B publishes v2 and A follows');
  await b.publish('notes.lith', encode('v2'));
  await waitFor('A reads v2', async () => (await readableText(a, 'notes.lith')) === 'v2');
  await waitFor('A was handed a remote-update event', () =>
    eventsA.some((event) => event.kind === 'remote-update' && event.name === 'notes.lith'),
  );
  const updateA = eventsA.find((event) => event.kind === 'remote-update' && event.name === 'notes.lith');
  if (updateA) {
    equal('A event head', decode(updateA.head), 'v2');
    equal('A event base', decode(updateA.base), 'v1');
    equal('A event from', updateA.from, nodeB);
  }

  console.log(failures === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failures} failures)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error('SMOKE FAILED:', error);
  process.exit(1);
});
