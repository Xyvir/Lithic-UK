import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALE, LOCALE_TAG, copy, decks, matchLanguage, resolveLocale } from './copy.ts';

test('Node reads the deck in English, since there is no environment to read', () => {
  // The guards in `copy.ts` exist for this: `location`, `window` and `navigator` are all
  // undefined under `node --test`, and a resolver that assumed otherwise would take the
  // whole suite down rather than answer.
  assert.equal(LOCALE, 'en');
  assert.equal(LOCALE_TAG, 'en-GB');
});

test('a request in the query string outranks every pin', () => {
  assert.equal(resolveLocale({ search: '?lang=en', built: 'es', languages: ['es-ES'] }), 'en');
});

test('a build pin outranks the environment, so a language site speaks to everybody', () => {
  assert.equal(resolveLocale({ built: 'es', languages: ['en-GB'] }), 'es');
  assert.equal(resolveLocale({ built: 'es' }), 'es');
  // And the query string is the escape hatch from it, which is what keeps a forced build
  // from being a trap: somebody who cannot read the pinned language asks for the one they
  // can, and a self-hosted instance's own pin arrives the same way, as a query its
  // redirector brings for a visit that brought none.
  assert.equal(resolveLocale({ search: '?lang=en', built: 'es', languages: ['es-ES'] }), 'en');
});

test('an unpinned build follows the person rather than the artifact', () => {
  // Italian and Japanese are stands-ins for a language this build does not carry: a browser
  // that leads with one of those is still answered in the language it can say.
  assert.equal(resolveLocale({ languages: ['it-IT', 'es-ES'] }), 'es');
  assert.equal(resolveLocale({ languages: ['it-IT', 'en-GB'] }), 'en');
  assert.equal(resolveLocale({ languages: ['ja'] }), 'en');
  // And one it does carry is answered directly, from the machine's own report.
  assert.equal(resolveLocale({ languages: ['de-DE'] }), 'de');
  assert.equal(resolveLocale({ languages: ['fr-CA'] }), 'fr');
});

test('a request nobody can carry falls through instead of forcing English', () => {
  assert.equal(resolveLocale({ search: '?lang=ja', built: 'es' }), 'es');
  assert.equal(resolveLocale({ search: '?lang=ja', languages: ['es-MX'] }), 'es');
});

test('a language is read however somebody wrote it down', () => {
  assert.equal(resolveLocale({ built: ' ES ' }), 'es');
  assert.equal(resolveLocale({ search: '?lang=ES' }), 'es');
  assert.equal(resolveLocale({ search: '?lang=es' }), 'es');
  assert.equal(resolveLocale({ search: '?lang=FR' }), 'fr');
  assert.equal(resolveLocale({ built: ' DE ' }), 'de');
  assert.equal(resolveLocale(), 'en');
});

test('a tag reaches the language it belongs to, region and script and all', () => {
  assert.equal(matchLanguage(['es-419']), 'es');
  assert.equal(matchLanguage(['es_MX']), 'es');
  assert.equal(matchLanguage(['ES']), 'es');
  assert.equal(matchLanguage(['de-AT']), 'de');
  assert.equal(matchLanguage(['de-CH']), 'de');
  assert.equal(matchLanguage(['fr-CA']), 'fr');
  assert.equal(matchLanguage(['FR']), 'fr');
  assert.equal(matchLanguage(['zh-Hant-TW']), undefined);
  assert.equal(matchLanguage(['pt-BR']), undefined);
});

test('the order is the person\u2019s own, so nothing is sorted on their behalf', () => {
  // Cascading means cascading: somebody whose first language is English wants English even
  // though this build can also say Spanish.
  assert.equal(matchLanguage(['es', 'en']), 'es');
  assert.equal(matchLanguage(['en', 'es']), 'en');
  assert.equal(matchLanguage(['de', 'fr']), 'de');
  assert.equal(matchLanguage(['fr', 'de']), 'fr');
});

test('every language this build carries is one a URL can ask for', () => {
  // Walked rather than listed, so the fifth language cannot arrive without the resolver
  // below being able to reach it.
  for (const id of Object.keys(decks)) {
    assert.equal(resolveLocale({ search: `?lang=${id}` }), id);
    assert.equal(resolveLocale({ built: id }), id);
  }
});

test('an empty or absent language list is not a language', () => {
  assert.equal(matchLanguage([]), undefined);
  assert.equal(matchLanguage(['', '   ']), undefined);
  assert.equal(matchLanguage(undefined), undefined);
  assert.equal(matchLanguage(null), undefined);
});

test('the tag a page declares is a real tag', () => {
  assert.match(LOCALE_TAG, /^[a-z]{2}-[A-Z]{2}$/);
});

/**
 * Every leaf in a deck, by the name it is read under.
 *
 * A deck is nested objects of strings and of functions that build a sentence from data, so
 * the walk has to stop at both. Anything else is a leaf somebody will meet as `[object
 * Object]` in the launcher, which is the failure this exists to catch.
 */
function leaves(node: unknown, path = ''): Array<[string, unknown]> {
  if (typeof node !== 'object' || node === null) return [[path, node]];
  return Object.entries(node).flatMap(([key, value]) =>
    leaves(value, path === '' ? key : `${path}.${key}`)
  );
}

test('every leaf of every deck is a non-empty string, or a function that builds one', () => {
  for (const [id, deck] of Object.entries(decks)) {
    const found = leaves(deck);
    assert.ok(found.length > 300, `the ${id} deck looks empty: ${found.length} leaves`);
    for (const [path, value] of found) {
      if (typeof value === 'string') {
        assert.ok(value.trim().length > 0, `${id}.${path} is an empty string`);
        continue;
      }
      assert.equal(typeof value, 'function', `${id}.${path} is neither a string nor a function`);
    }
  }
});

test('every deck says the same things in the same places', () => {
  // The type system already refuses a deck with a leaf missing or one too many, and this is
  // the same claim read at run time: a translation is only readable in the launcher if it
  // answers to exactly the names the components ask for.
  const english = leaves(decks.en).map(([path]) => path).sort();
  for (const [id, deck] of Object.entries(decks)) {
    assert.deepEqual(leaves(deck).map(([path]) => path).sort(), english, `the ${id} deck does not line up with English`);
  }
});
