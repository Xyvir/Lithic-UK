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

test('searches cached wikis independently of their recent-file handles', () => {
  const matches = searchCachedWikis([
    { name: 'known.lith', text: '[{"title":"Known","text":"local note"}]' },
    { name: 'cached-only.lith', text: '[{"title":"Archive","text":"needle in cached data"}]' }
  ], 'needle');

  assert.deepEqual(Object.keys(matches), ['cached-only.lith']);
  assert.equal(matches['cached-only.lith'].title, 'Archive');
  assert.match(matches['cached-only.lith'].preview, /<mark>needle<\/mark>/);
});
