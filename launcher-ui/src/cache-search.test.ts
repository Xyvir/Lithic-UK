import test from 'node:test';
import assert from 'node:assert/strict';
import { searchCachedWiki, searchCachedWikis } from './cache-search.ts';

test('finds cached wiki text and returns highlighted context', () => {
  const result = searchCachedWiki('[{"title":"Research Note","text":"A useful local finding"}]', 'local');
  assert.equal(result.matched, true);
  assert.equal(result.title, 'Research Note');
  assert.match(result.preview, /<mark>local<\/mark>/);
});

test('does not match empty or absent queries', () => {
  assert.deepEqual(searchCachedWiki('{"title":"Note","text":"hello"}', ''), { matched: false, preview: '' });
  assert.equal(searchCachedWiki('{"title":"Note","text":"hello"}', 'missing').matched, false);
});

test('a query only in a tiddler\u2019s stamps is not a match', () => {
  // The exact shape a real cache has, and the exact complaint: `te` occurs in the
  // word creaTE d (and inside `text/vnd.tiddlywiki`), so a match was reported and
  // the panel then printed the entry's JSON — the matched field was not the body.
  const cached = JSON.stringify([
    {
      title: 'BP 1230 Avenue of the Americas',
      created: '20260816020116648',
      modified: '20260816020116648',
      type: 'text/vnd.tiddlywiki',
      text: 'corner office, second floor'
    }
  ]);

  assert.deepEqual(searchCachedWiki(cached, 'te'), { matched: false, preview: '' });
  assert.deepEqual(searchCachedWiki(cached, '20260816020116648'), { matched: false, preview: '' });
  assert.deepEqual(searchCachedWiki(cached, 'tiddlywiki'), { matched: false, preview: '' });
  // The body is still searchable, and the name is too.
  assert.equal(searchCachedWiki(cached, 'corner').matched, true);
  assert.equal(searchCachedWiki(cached, 'avenue').matched, true);
});

 test('marks the matched title, keeping the case it was written in', () => {
  const cached = JSON.stringify([{ title: 'Archive Note', text: 'cached content' }]);
  const result = searchCachedWiki(cached, 'archive');

  assert.equal(result.matched, true);
  assert.equal(result.title, 'Archive Note');
  assert.match(result.preview, /<mark class="cache-preview-title-mark">Archive<\/mark>/);
});

test('a title-only match opens on the head of the body, unmarked', () => {
  const cached = JSON.stringify([{ title: 'Distinctive Title', text: 'ordinary body text' }]);
  const result = searchCachedWiki(cached, 'distinctive');

  assert.equal(result.matched, true);
  assert.match(result.preview, /<mark class="cache-preview-title-mark">Distinctive<\/mark>/);
  assert.match(result.preview, /ordinary body text/);
  assert.doesNotMatch(result.preview, /<mark>ordinary/);
});

test('picks the tiddler whose body matched, not merely the first one', () => {
  const cached = JSON.stringify([
    { title: 'First', text: 'nothing to see' },
    { title: 'Second', text: 'the needle sits here' }
  ]);
  const result = searchCachedWiki(cached, 'needle');

  assert.equal(result.title, 'Second');
  assert.match(result.preview, /<mark>needle<\/mark>/);
});

test('a cache that is not tiddler JSON matches on its whole text', () => {
  const monolith = '<html><body>a distinctive monolith page</body></html>';
  const result = searchCachedWiki(monolith, 'monolith');

  assert.equal(result.matched, true);
  assert.equal(result.title, undefined);
  assert.match(result.preview, /<mark>monolith<\/mark>/);
  assert.equal(searchCachedWiki(monolith, 'absent').matched, false);
});

test('searches cached wikis independently of their recent-file handles', () => {
  const matches = searchCachedWikis([
    { name: 'known.lith', text: '[{"title":"Known","text":"local note"}]' },
    { name: 'cached-only.lith', text: '[{"title":"Archive","text":"needle in cached data"}]' }
  ], 'needle');

  assert.deepEqual(Object.keys(matches), ['cached-only.lith']);
  assert.equal(matches['cached-only.lith'].title, 'Archive');
  assert.match(matches['cached-only.lith'].preview, /<mark>needle<\/mark>/);
});
