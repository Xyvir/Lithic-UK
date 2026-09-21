import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLithToJSON, serializeJsonToLith } from './lithic-format.ts';

test('parses fields and text separated by the Lithic block delimiter', () => {
  const source = 'title: First\ntags: one two\n\nBody: keeps the colon\n⁂⁂⁂\ntitle: Second\n\nSecond body';
  assert.deepEqual(parseLithToJSON(source), [
    { title: 'First', tags: 'one two', text: 'Body: keeps the colon' },
    { title: 'Second', text: 'Second body' }
  ]);
});

test('parses CRLF blocks', () => {
  assert.deepEqual(parseLithToJSON('title: A\r\n\r\ntext\r\n⁂⁂⁂\r\ntitle: B'), [
    { title: 'A', text: 'text' },
    { title: 'B' }
  ]);
});

// Regression: the in-wiki exporter prefixes its first block with a blank line,
// and taking the first blank line as the field separator turned that whole
// field section into body text. The result was a tiddler with no title, which
// the engine refuses to boot around — the file looked corrupted rather than
// carrying one stray newline.
test('a leading blank line does not swallow the first block of fields', () => {
  const source = '\n\ntitle: First\ntype: text/markdown\n\nlith body\n⁂⁂⁂\n\n\ntitle: Second\n\nsecond body';
  assert.deepEqual(parseLithToJSON(source), [
    { title: 'First', type: 'text/markdown', text: 'lith body' },
    { title: 'Second', text: 'second body' }
  ]);
});

test('leading CRLF blank lines are tolerated too', () => {
  assert.deepEqual(parseLithToJSON('\r\n\r\ntitle: A\r\n\r\nbody'), [
    { title: 'A', text: 'body' }
  ]);
});

test('serializes fields in sorted order and tiddlers by title', () => {
  const result = serializeJsonToLith(JSON.stringify([
    { title: 'Zed', z: 'last', a: 'first', text: 'z text' },
    { title: 'Alpha', text: 'a text' }
  ]));
  assert.equal(result, 'title: Alpha\n\na text\n⁂⁂⁂\na: first\ntitle: Zed\nz: last\n\nz text');
});

test('places bulky tiddlers after regular tiddlers', () => {
  const result = serializeJsonToLith(JSON.stringify([
    { title: 'Alpha', type: 'image/png', text: 'image' },
    { title: 'Zulu', text: 'regular' }
  ]));
  assert.match(result, /^title: Zulu/);
  assert.match(result, /⁂⁂⁂\ntitle: Alpha/);
});

test('returns an empty string for invalid JSON', () => {
  assert.equal(serializeJsonToLith('{not-json'), '');
});
