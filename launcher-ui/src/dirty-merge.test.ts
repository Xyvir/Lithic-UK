import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeCaptureIntoDocument } from './dirty-merge.ts';
import { parseLithToJSON } from './lithic-format.ts';

const document = [
  'title: Home',
  'type: text/vnd.tiddlywiki',
  '',
  'the page as it was saved',
  '⁂⁂⁂',
  'title: Notes',
  'type: text/vnd.tiddlywiki',
  '',
  'older text',
  ''
].join('\r\n');

test('an edit replaces the copy the document holds and leaves the rest alone', () => {
  const merged = mergeCaptureIntoDocument(document, [
    { title: 'Notes', text: 'the edit that was never saved' }
  ]);
  assert.equal(merged.ok, true);
  assert.ok(merged.ok);
  assert.equal(merged.applied, 1);
  const tiddlers = parseLithToJSON(merged.text);
  assert.equal(tiddlers.length, 2, 'one title is still one tiddler');
  assert.equal(tiddlers.find((entry) => entry.title === 'Notes')?.text, 'the edit that was never saved');
  assert.equal(tiddlers.find((entry) => entry.title === 'Home')?.text, 'the page as it was saved');
});

test('an edit the document never held is added, so a new note survives too', () => {
  const merged = mergeCaptureIntoDocument(document, [{ title: 'Fresh', text: 'new' }]);
  assert.ok(merged.ok);
  const titles = parseLithToJSON(merged.text).map((entry) => entry.title).sort();
  assert.deepEqual(titles, ['Fresh', 'Home', 'Notes']);
});

test('the cache shape merges the same way as a file', () => {
  // A browser-only Lith's document is the cached array rather than a lith, and Merge has to
  // work there too: it is the one shape with no file to write back to.
  const cached = JSON.stringify([
    { title: 'Home', text: 'from the cache' },
    { title: 'Notes', text: 'older text' }
  ]);
  const merged = mergeCaptureIntoDocument(cached, [{ title: 'Home', text: 'edited' }]);
  assert.ok(merged.ok);
  const tiddlers = parseLithToJSON(merged.text);
  assert.equal(tiddlers.find((entry) => entry.title === 'Home')?.text, 'edited');
  assert.equal(tiddlers.find((entry) => entry.title === 'Notes')?.text, 'older text');
});

test('an empty document takes every edit and drops none', () => {
  // A blank Lith saved before anything was written is a real document, not an unreadable one,
  // in both shapes it comes in: no body at all, and the empty array a browser-only cache holds.
  const emptyArray = mergeCaptureIntoDocument('[]', [{ title: 'One', text: 'a' }]);
  assert.ok(emptyArray.ok);
  assert.deepEqual(parseLithToJSON(emptyArray.text).map((entry) => entry.title), ['One']);
  const merged = mergeCaptureIntoDocument('', [{ title: 'One', text: 'a' }, { title: 'Two', text: 'b' }]);
  assert.ok(merged.ok);
  assert.equal(merged.applied, 2);
  assert.deepEqual(parseLithToJSON(merged.text).map((entry) => entry.title).sort(), ['One', 'Two']);
});

test('a capture with nothing in it is refused rather than written', () => {
  assert.deepEqual(mergeCaptureIntoDocument(document, []), { ok: false, reason: 'empty' });
  assert.deepEqual(mergeCaptureIntoDocument(document, [{ title: '  ', text: 'x' }]), { ok: false, reason: 'empty' });
});

test('a document that parses to nothing is refused, not merged over', () => {
  // The failure this exists for: writing the edits as the whole file would leave a Lith
  // holding one note and none of the wiki it came from.
  assert.deepEqual(mergeCaptureIntoDocument('not a lith at all', [{ title: 'One' }]), { ok: false, reason: 'unreadable' });
  assert.deepEqual(mergeCaptureIntoDocument('{ "not": "an array" }', [{ title: 'One' }]), { ok: false, reason: 'unreadable' });
  assert.deepEqual(mergeCaptureIntoDocument('[not json', [{ title: 'One' }]), { ok: false, reason: 'unreadable' });
});

test('the merged text is what a save writes: no trailing newline, delimiters between tiddlers', () => {
  const merged = mergeCaptureIntoDocument(document, [{ title: 'Notes', text: 'edited' }]);
  assert.ok(merged.ok);
  assert.equal(merged.text.endsWith('\n'), false);
  // The separator is the serializer's own, which is what every save writes, so a merged file
  // and a saved one are the same shape rather than two dialects of lith.
  assert.equal(merged.text.includes('\n⁂⁂⁂\n'), true);
  // And it round-trips, which is the property the mount and the trail both depend on.
  assert.equal(parseLithToJSON(merged.text).length, 2);
});
