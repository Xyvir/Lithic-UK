import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePayloadText,
  parseDroppedData,
  decodePayloadParam,
  tagRootDogear,
  mergePendingImports,
  isPayloadShareUrl,
  ephemeralIntegrationTiddlers,
  pinCachedTiddler
} from './pending-imports.ts';

test('parsePayloadText parses JSON arrays and lith monoliths', () => {
  assert.deepEqual(parsePayloadText('[{"title":"A","text":"hi"}]'), [{ title: 'A', text: 'hi' }]);
  assert.deepEqual(parsePayloadText('title: A\n\nbody text'), [{ title: 'A', text: 'body text' }]);
});

test('parseDroppedData requires JSON arrays for .json files', () => {
  assert.deepEqual(parseDroppedData('[{"title":"A"}]', false), [{ title: 'A' }]);
  assert.deepEqual(parseDroppedData('not json', false), []);
  assert.deepEqual(parseDroppedData('title: A\n\nbody', true), [{ title: 'A', text: 'body' }]);
});

test('decodePayloadParam accepts raw JSON and base64 payloads', () => {
  const raw = '[{"title":"Shared","text":"payload"}]';
  const decoded = decodePayloadParam(raw);
  assert.ok(decoded);
  assert.equal(decoded![0].title, 'Shared');
  assert.ok(decoded![0].tags?.includes('Dogear'), 'root payload tiddler is tagged Dogear');

  const fromB64 = decodePayloadParam(Buffer.from(raw).toString('base64'));
  assert.deepEqual(fromB64, decoded);
  assert.equal(decodePayloadParam('garbage'), null);
});

test('tagRootDogear tags only the root tiddler and preserves existing tags', () => {
  const tagged = tagRootDogear([{ title: 'Root' }, { title: 'Child' }]);
  assert.ok(tagged[0].tags?.includes('Dogear'));
  assert.equal(tagged[1].tags, undefined);
  const merged = tagRootDogear([{ title: 'Root', tags: 'Foo' }]);
  assert.match(merged[0].tags!, /Foo/);
  assert.ok(merged[0].tags!.split(' ').includes('Dogear'));
});

test('mergePendingImports concatenates without mutating the source', () => {
  const a = [{ title: 'A' }];
  const merged = mergePendingImports(a, [{ title: 'B' }]);
  assert.deepEqual(merged, [{ title: 'A' }, { title: 'B' }]);
  assert.equal(a.length, 1);
});

test('isPayloadShareUrl detects share links with payload params', () => {
  assert.equal(isPayloadShareUrl('https://lithic.uk/?json=abc'), true);
  assert.equal(isPayloadShareUrl('https://lithic.uk/?lith=abc'), true);
  assert.equal(isPayloadShareUrl('https://lithic.uk/?url=x'), true);
  assert.equal(isPayloadShareUrl('https://lithic.uk/'), false);
});

test('ephemeral integration tiddlers are present and uniquely titled', () => {
  const tiddlers = ephemeralIntegrationTiddlers();
  assert.equal(tiddlers.length, 3);
  const titles = tiddlers.map((t) => t.title);
  assert.equal(new Set(titles).size, titles.length);
  assert.ok(titles.some((title) => title.includes('action-ephemeral')));
});

test('ephemeral codeblock-override suppresses run button on txt and untyped blocks', () => {
  const tiddlers = ephemeralIntegrationTiddlers();
  const override = tiddlers.find((t) => t.title.includes('codeblock-override'))!;
  assert.ok(override, 'codeblock-override tiddler missing');
  // The ephemeral run branch must exclude txt/text/plaintext/plain and the
  // undeclared-language case, in a single filter run (AND semantics).
  assert.match(override.text, /\[<language>!match\[jspython\]!match\[txt\]!match\[text\]!match\[plaintext\]!match\[plain\]!match\[\]\]/);
  // The local jspython branch keeps its plain match so jsipython still runs.
  assert.match(override.text, /\[<language>match\[jspython\]\]/);
});

test('ephemeral resolver supports local-tray probing with paper-light fallback', () => {
  const tiddlers = ephemeralIntegrationTiddlers();
  const action = tiddlers.find((t) => t.title.includes('action-ephemeral'))!;
  assert.ok(action, 'action-ephemeral tiddler missing');
  // local-tray mode: probe loopback tray first...
  assert.match(action.text, /mode === "local-tray"/);
  assert.match(action.text, /_probeEphemeralTray/);
  assert.match(action.text, /127\.0\.0\.1:8787/);
  assert.match(action.text, /__EPHEMERAL_LOCAL_BASE__/);
  // ...then fall through to the public swarm discovery.
  assert.match(action.text, /Tray not running: fall through to the paper-light public swarm/);
  // Loopback POSTs prefer the native (Tauri) HTTP client when available.
  assert.match(action.text, /_ephemeralHttp/);
  // Keep the legacy branches: same-origin for self-host, swarm for paper-light.
  assert.match(action.text, /mode !== "paper-light" && mode !== "local-tray"/);
  assert.match(action.text, /No bastion server found in swarm\.json/);
});

const pinCache = JSON.stringify([
  { title: 'First', text: 'alpha' },
  { title: 'Target', text: 'match here', tags: 'Journal' },
  { title: 'Last', text: 'omega' }
]);

test('pinCachedTiddler returns only the matching tiddler tagged Dogear', () => {
  const payload = pinCachedTiddler(pinCache, 'Target');
  assert.ok(payload);
  assert.equal(payload!.length, 1);
  assert.equal(payload![0].title, 'Target');
  assert.equal(payload![0].text, 'match here');
  assert.equal(payload![0].tags, 'Journal Dogear');
});

test('pinCachedTiddler avoids duplicate Dogear tags and preserves arrays', () => {
  const cache = JSON.stringify([{ title: 'X', tags: ['A', 'Dogear'] }]);
  const payload = pinCachedTiddler(cache, 'X');
  assert.ok(payload);
  assert.equal(payload![0].tags, 'A Dogear');
});

test('pinCachedTiddler returns null for unknown titles and invalid cache text', () => {
  assert.equal(pinCachedTiddler(pinCache, 'Missing'), null);
  assert.equal(pinCachedTiddler('not json at all', 'Target'), null);
  assert.equal(pinCachedTiddler('{"title":"solo object"}', 'solo object'), null);
});
