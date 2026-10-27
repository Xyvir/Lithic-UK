import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parsePayloadText,
  parseDroppedData,
  decodePayloadParam,
  tagRootDogear,
  mergePendingImports,
  removePendingImport,
  queuePendingImports,
  replacingTitles,
  isPayloadShareUrl,
  pinCachedTiddler,
  sharedPayload,
  sharedTitle,
  SHARED_TITLE_LIMIT
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

test('removePendingImport drops one row and keeps the rest in order', () => {
  const queued = [{ title: 'A' }, { title: 'B' }, { title: 'C' }];
  assert.deepEqual(removePendingImport(queued, 1), [{ title: 'A' }, { title: 'C' }]);
  assert.equal(queued.length, 3);
});

// A queue can hold the same title twice, one per dropped file, so position is what the row's
// own control removes. Sorting by title would take both rows with one press.
test('removePendingImport removes one of two tiddlers sharing a title', () => {
  const queued = [{ title: 'Same', text: 'first' }, { title: 'Same', text: 'second' }];
  assert.deepEqual(removePendingImport(queued, 0), [{ title: 'Same', text: 'second' }]);
});

test('removePendingImport ignores a position outside the queue', () => {
  const queued = [{ title: 'Only' }];
  assert.equal(removePendingImport(queued, 4), queued);
  assert.equal(removePendingImport(queued, -1), queued);
});

test('queuePendingImports keeps the first copy of a title and refuses the later one', () => {
  const result = queuePendingImports([{ title: 'Notes', text: 'queued' }], [{ title: 'Notes', text: 'dropped' }]);
  assert.deepEqual(result.queued, [{ title: 'Notes', text: 'queued' }]);
  assert.deepEqual(result.refused, ['Notes']);
});

// One file can hold a title twice, so the refusal cannot only look at what was queued before.
test('queuePendingImports refuses a repeat inside the same batch', () => {
  const result = queuePendingImports([], [{ title: 'X', text: 'first' }, { title: 'Y' }, { title: 'X', text: 'second' }]);
  assert.deepEqual(result.queued, [{ title: 'X', text: 'first' }, { title: 'Y' }]);
  assert.deepEqual(result.refused, ['X']);
});

test('queuePendingImports keeps order and leaves both inputs untouched', () => {
  const existing = [{ title: 'A' }];
  const incoming = [{ title: 'B' }, { title: 'C' }];
  const result = queuePendingImports(existing, incoming);
  assert.deepEqual(result.queued.map((tiddler) => tiddler.title), ['A', 'B', 'C']);
  assert.deepEqual(existing, [{ title: 'A' }]);
  assert.deepEqual(incoming, [{ title: 'B' }, { title: 'C' }]);
});

// The wiki keys tiddlers by the exact title string, so a differently-cased title is a
// different tiddler and neither one replaces the other.
test('queuePendingImports treats a differently-cased title as its own tiddler', () => {
  const result = queuePendingImports([{ title: 'Notes' }], [{ title: 'notes' }]);
  assert.deepEqual(result.queued.map((tiddler) => tiddler.title), ['Notes', 'notes']);
  assert.deepEqual(result.refused, []);
});

test('queuePendingImports keeps untitled entries, which the mount drops', () => {
  const result = queuePendingImports([{ title: 'A' }], [{ text: 'no title' }, { title: 'A' }]);
  assert.equal(result.queued.length, 2);
  assert.deepEqual(result.refused, ['A']);
});

test('replacingTitles names queued tiddlers that would change the document', () => {
  const document = [{ title: 'Notes', text: 'mine' }, { title: 'Same', text: 'copy' }];
  const queue = [{ title: 'Notes', text: 'theirs' }, { title: 'Same', text: 'copy' }, { title: 'New', text: 'x' }];
  assert.deepEqual(replacingTitles(document, queue), ['Notes']);
});

// A missing field and an empty one are the same tiddler, so re-dropping an exported file back
// into its own document asks nothing when nothing changed.
test('replacingTitles ignores a copy identical to the one already held', () => {
  const document = [{ title: 'A', text: '', tags: 'x' }];
  const queue = [{ title: 'A', tags: 'x' }];
  assert.deepEqual(replacingTitles(document, queue), []);
});

test('replacingTitles ignores untitled entries and a document with no titles', () => {
  assert.deepEqual(replacingTitles([], [{ title: 'A' }]), []);
  assert.deepEqual(replacingTitles([{ title: 'A' }], [{ text: 'untitled' }]), []);
});

test('isPayloadShareUrl detects share links with payload params', () => {
  assert.equal(isPayloadShareUrl('https://lithic.uk/?json=abc'), true);
  assert.equal(isPayloadShareUrl('https://lithic.uk/?lith=abc'), true);
  assert.equal(isPayloadShareUrl('https://lithic.uk/?url=x'), true);
  assert.equal(isPayloadShareUrl('https://lithic.uk/'), false);
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

// The share the phone's own sheet hands this app, converted by the same function the desktop's
// "Open with" association uses. The expected tiddlers are written out rather than compared to that
// function's own output, so what is pinned is the shape a shared article lands in, node titles and
// nesting included.
test('sharedPayload makes the streams tree the desktop association makes', () => {
  const payload = sharedPayload('# Heading\n\tchild\n\nsecond', 'An Article');
  assert.deepEqual(payload, [
    {
      title: 'An Article',
      text: '',
      type: 'text/markdown',
      'stream-type': 'default',
      'stream-list': '[[An Article 1]] [[An Article 3]]',
      'lithic-scratch': 'yes',
      tags: 'Dogear'
    },
    {
      title: 'An Article 1',
      parent: 'An Article',
      'lithic-indent': '0',
      'lithic-gap': '0',
      type: 'text/markdown',
      'stream-type': 'default',
      text: '# Heading',
      'stream-list': '[[An Article 2]]'
    },
    {
      title: 'An Article 2',
      parent: 'An Article 1',
      'lithic-indent': '1',
      'lithic-gap': '0',
      type: 'text/markdown',
      'stream-type': 'default',
      text: 'child'
    },
    {
      title: 'An Article 3',
      parent: 'An Article',
      'lithic-indent': '0',
      'lithic-gap': '1',
      type: 'text/markdown',
      'stream-type': 'default',
      text: 'second'
    }
  ]);
});

test('sharedPayload names the note after the content when the sender offered no title', () => {
  assert.equal(sharedPayload('# Heading\n\nbody', '')[0].title, '# Heading');
  // A sender that offers whitespace has offered nothing, so the content names it.
  assert.equal(sharedPayload('Real line', '   ')[0].title, 'Real line');
  // Collapsed, so a title compared against another is compared on its text.
  assert.equal(sharedPayload('spaced   out', '')[0].title, 'spaced out');
});

// A node is named `<document> <n>` and the root points at it through a stream-list, so a bracketed
// name would break the one structure the tree has. Page titles carry brackets often enough that
// this is a rule about where a share comes from rather than a defensive extra.
test('sharedPayload keeps brackets in a sender title out of the stream list', () => {
  const payload = sharedPayload('body', 'Index of /[stuff]');
  assert.equal(payload[0].title, 'Index of / stuff');
  assert.equal(payload[0]['stream-list'], '[[Index of / stuff 1]]');
  assert.equal(payload[1].title, 'Index of / stuff 1');
});

test('sharedPayload keeps the whole body and cuts only an over-long title', () => {
  const body = '# ' + 'x'.repeat(SHARED_TITLE_LIMIT * 2);
  const payload = sharedPayload(body, '');
  assert.equal(payload[0].title.length, SHARED_TITLE_LIMIT);
  assert.equal(payload[1].text, body, 'the note holds the text as it was shared');
});

test('sharedPayload queues nothing for a share of nothing', () => {
  assert.deepEqual(sharedPayload('', ''), []);
  assert.deepEqual(sharedPayload('   \n\t ', ''), []);
});

// A share whose content is blank still has a name if the sender gave one, which is a document with
// a title and no nodes rather than a row the engine cannot store.
test('sharedPayload keeps a titled share whose body is blank', () => {
  assert.deepEqual(sharedPayload('', 'Named'), [
    { title: 'Named', text: '', type: 'text/markdown', 'stream-type': 'default', 'lithic-scratch': 'yes', tags: 'Dogear' }
  ]);
});

test('sharedTitle prefers the sender title and falls back to the first content line', () => {
  assert.equal(sharedTitle('From The Sender', 'From the content'), 'From The Sender');
  assert.equal(sharedTitle('', '\n\nFrom the content'), 'From the content');
  assert.equal(sharedTitle('', ''), '');
});

