import test from 'node:test';
import assert from 'node:assert/strict';
import { lithTitle, matchMarkup, titleMatches, showsForQuery, titleMarkup } from './name-match.ts';

test('a title is a name without its extension', () => {
  assert.equal(lithTitle('abcd.lith'), 'abcd');
  assert.equal(lithTitle('lithography.lith'), 'lithography');
  assert.equal(lithTitle('my.notes.lith'), 'my.notes');
  assert.equal(lithTitle('scratchpad'), 'scratchpad');
  // Only the last suffix is an extension, and a leading dot is part of the name.
  assert.equal(lithTitle('notes.lith.json'), 'notes.lith');
  assert.equal(lithTitle('.hidden'), '.hidden');
});

/**
 * The rule the search box is about: an extension is on every row in the list, so
 * matching it answers "everything" about a query that named a word.
 */
test('the extension is not searchable', () => {
  assert.equal(titleMatches('abcd.lith', 'lith'), false);
  assert.equal(titleMatches('lithography.lith', 'lith'), true);
  assert.equal(titleMatches('solo.html', 'html'), false);
  assert.equal(titleMatches('abcd.lith', 'abcd.lith'), false);
  // The word still matches wherever it sits in the name, suffix aside.
  assert.equal(titleMatches('my.lith.notes.lith', 'lith.notes'), true);
});

test('a match is case-insensitive, and whitespace around the query is the user’s', () => {
  assert.equal(titleMatches('Launcher_Scratchpad.lith', 'scr'), true);
  assert.equal(titleMatches('Launcher_Scratchpad.lith', 'SCR'), true);
  assert.equal(titleMatches('abcd.lith', '  cd  '), true);
  assert.equal(titleMatches('abcd.lith', 'zzz'), false);
});

test('an empty query lists everything rather than nothing', () => {
  assert.equal(showsForQuery('abcd.lith', ''), true);
  assert.equal(showsForQuery('abcd.lith', '   '), true);
  assert.equal(showsForQuery('abcd.lith', 'abc'), true);
  assert.equal(showsForQuery('abcd.lith', 'lith'), false);
  // A query that only matches the extension of *another* name is no match here.
  assert.equal(showsForQuery('notes.html', 'lith'), false);
});

test('the matched run is marked in place, and the rest of the name is untouched', () => {
  assert.equal(
    titleMarkup('launcher_scratchpad.lith', 'scr'),
    'launcher_<mark class="name-match">scr</mark>atchpad.lith'
  );
  assert.equal(
    titleMarkup('Launcher_Scratchpad.lith', 'scr'),
    'Launcher_<mark class="name-match">Scr</mark>atchpad.lith'
  );
  // Every occurrence, because a second one left plain reads as another word.
  assert.equal(
    titleMarkup('scratch_scratchpad.lith', 'scr'),
    '<mark class="name-match">scr</mark>atch_<mark class="name-match">scr</mark>atchpad.lith'
  );
});

test('nothing is marked where nothing matched, and an empty query marks nothing', () => {
  assert.equal(titleMarkup('abcd.lith', 'lith'), 'abcd.lith');
  assert.equal(titleMarkup('abcd.lith', ''), 'abcd.lith');
  // The name still shows in full, extension and all: only the mark is withheld.
  assert.equal(titleMarkup('abcd.lith', 'zzz'), 'abcd.lith');
});

/**
 * A row's name is a file name, so it can carry the characters that would otherwise
 * be markup, and the caller draws this string as HTML.
 */
test('a name that looks like markup is escaped, marked or not', () => {
  assert.equal(titleMarkup('a&b<c>.lith', ''), 'a&amp;b&lt;c&gt;.lith');
  assert.equal(
    titleMarkup('a&b<c>.lith', 'b'),
    'a&amp;<mark class="name-match">b</mark>&lt;c&gt;.lith'
  );
  assert.equal(titleMarkup('quote"s.lith', 'quote'), '<mark class="name-match">quote</mark>&quot;s.lith');
});

/**
 * An instance's address is marked by the same rule a name is.
 *
 * A bookmark row draws the address the query was typed against, so the mark is what makes
 * a filtered list read as an answer rather than as a shorter list. Nothing in an address is
 * an extension, so nothing is held back from the mark: the scheme is markable, which is the
 * only difference from a file name and the reason this half is its own function.
 */
test('an address is marked the way a name is', () => {
  assert.equal(
    matchMarkup('personal.lithic.uk', 'lith'),
    'personal.<mark class="name-match">lith</mark>ic.uk'
  );
  assert.equal(
    matchMarkup('https://lithic.lithic.uk', 'lithic'),
    'https://<mark class="name-match">lithic</mark>.<mark class="name-match">lithic</mark>.uk'
  );
  assert.equal(
    matchMarkup('wiki.foobar.com', 'FOOBAR'),
    'wiki.<mark class="name-match">foobar</mark>.com'
  );
  // The same three answers a name gets: no match is the value untouched, an empty query
  // marks nothing, and the spaces somebody typed around the query are not part of it.
  assert.equal(matchMarkup('wiki.foobar.com', 'zzz'), 'wiki.foobar.com');
  assert.equal(matchMarkup('wiki.foobar.com', ''), 'wiki.foobar.com');
  assert.equal(
    matchMarkup('wiki.foobar.com', '  bar  '),
    'wiki.foo<mark class="name-match">bar</mark>.com'
  );
});

/**
 * A value that looks like markup is escaped whether or not it is marked, because the
 * caller draws the result as HTML. An address is no exception: a query is the person's,
 * and a label could be anything a stored bookmark carried.
 */
test('an address that looks like markup is escaped too', () => {
  assert.equal(matchMarkup('a&b<c>.example', 'b'), 'a&amp;<mark class="name-match">b</mark>&lt;c&gt;.example');
  assert.equal(matchMarkup('quote"s.example', 'zzz'), 'quote&quot;s.example');
  assert.equal(matchMarkup('quote"s.example', 'quote'), '<mark class="name-match">quote</mark>&quot;s.example');
});

/** Strip the marks and the escapes, leaving the text a row actually reads as. */
function stripped(markup: string): string {
  return markup
    .replace(/<mark class="name-match">/g, '')
    .replace(/<\/mark>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * The displayed value survives the marking: strip the marks and every character of the
 * original is still there, for any query. A mark can only ever change where the characters
 * are dressed, never which ones are drawn.
 */
test('the markup spells the name back', () => {
  for (const [name, query] of [
    ['Launcher_Scratchpad.lith', 'scr'],
    ['lithography.lith', 'lith'],
    ['mine.lith', 'e.li'],
    ['abcd.lith', 'zzz'],
    ['plain', 'lai']
  ] as const) {
    assert.equal(stripped(titleMarkup(name, query)), name, `${name} / ${query}`);
  }
});

test('the markup spells the address back too', () => {
  for (const [address, query] of [
    ['personal.lithic.uk', 'lith'],
    ['https://wiki.foobar.com', 'foo'],
    ['personal.lithic.uk', 'zzz'],
    ['personal.lithic.uk', '']
  ] as const) {
    assert.equal(stripped(matchMarkup(address, query)), address, `${address} / ${query}`);
  }
});
