import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCALE, LOCALE_TAG, copy, matchLanguage, resolveLocale } from './copy.ts';

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
  assert.equal(resolveLocale({ languages: ['fr-FR', 'es-ES'] }), 'es');
  assert.equal(resolveLocale({ languages: ['fr-FR', 'en-GB'] }), 'en');
  assert.equal(resolveLocale({ languages: ['de'] }), 'en');
});

test('a request nobody can carry falls through instead of forcing English', () => {
  assert.equal(resolveLocale({ search: '?lang=de', built: 'es' }), 'es');
  assert.equal(resolveLocale({ search: '?lang=de', languages: ['es-MX'] }), 'es');
});

test('a language is read however somebody wrote it down', () => {
  assert.equal(resolveLocale({ built: ' ES ' }), 'es');
  assert.equal(resolveLocale({ search: '?lang=ES' }), 'es');
  assert.equal(resolveLocale({ search: '?lang=es' }), 'es');
  assert.equal(resolveLocale(), 'en');
});

test('a tag reaches the language it belongs to, region and script and all', () => {
  assert.equal(matchLanguage(['es-419']), 'es');
  assert.equal(matchLanguage(['es_MX']), 'es');
  assert.equal(matchLanguage(['ES']), 'es');
  assert.equal(matchLanguage(['zh-Hant-TW']), undefined);
  assert.equal(matchLanguage(['pt-BR']), undefined);
});

test('the order is the person\u2019s own, so nothing is sorted on their behalf', () => {
  // Cascading means cascading: somebody whose first language is English wants English even
  // though this build can also say Spanish.
  assert.equal(matchLanguage(['es', 'en']), 'es');
  assert.equal(matchLanguage(['en', 'es']), 'en');
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

test('every leaf of the deck is a non-empty string, or a function that builds one', () => {
  const found = leaves(copy);
  assert.ok(found.length > 300, `the deck looks empty: ${found.length} leaves`);
  for (const [path, value] of found) {
    if (typeof value === 'string') {
      assert.ok(value.trim().length > 0, `${path} is an empty string`);
      continue;
    }
    assert.equal(typeof value, 'function', `${path} is neither a string nor a function`);
  }
});
