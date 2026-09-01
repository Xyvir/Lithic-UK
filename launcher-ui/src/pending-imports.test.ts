import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePayloadText,
  parseDroppedData,
  decodePayloadParam,
  tagRootDogear,
  mergePendingImports,
  isPayloadShareUrl,
  ephemeralIntegrationTiddlers
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
