import test from 'node:test';
import assert from 'node:assert/strict';
import { lithTitle, titleMatches, showsForQuery, titleMarkup } from './name-match.ts';

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
 * be markup — and the caller draws this string as HTML.
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
 * The displayed name survives the marking: strip the marks and every character of the
 * original is still there, for any query.
 */
test('the markup spells the name back', () => {
  for (const [name, query] of [
    ['Launcher_Scratchpad.lith', 'scr'],
    ['lithography.lith', 'lith'],
    ['mine.lith', 'e.li'],
    ['abcd.lith', 'zzz'],
    ['plain', 'lai']
  ] as const) {
    const stripped = titleMarkup(name, query)
      .replace(/<mark class="name-match">/g, '')
      .replace(/<\/mark>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    assert.equal(stripped, name, `${name} / ${query}`);
  }
});
