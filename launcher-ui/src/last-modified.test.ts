import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedStamp, modifiedTitle } from './last-modified.ts';
import { copy } from './copy.ts';

test('a cache record answers the moment it was written, preferring the number', () => {
  // The number is the field that cannot be misread, so it wins even when the locale string
  // beside it says a different minute: one of the two is the copy's own record and the other
  // is a display string, and only the first is a fact.
  assert.equal(
    cachedStamp({ backupTimestamp: Date.UTC(2026, 9, 21, 14, 35), lastModified: '1/1/1999, 00:00:00' }),
    Date.UTC(2026, 9, 21, 14, 35)
  );
  // A copy written before the number existed still answers, from the string it has.
  const legacy = new Date(Date.UTC(2026, 9, 21, 14, 35));
  assert.equal(cachedStamp({ lastModified: legacy.toLocaleString('en-US') }), legacy.getTime());
  // A spelling this machine cannot read is null rather than a guess: `21/10/2026` is
  // unambiguous to a person and ambiguous to `Date.parse`, and a tooltip is not the place to
  // decide whether the middle number is a month.
  assert.equal(cachedStamp({ lastModified: '21/10/2026, 14:35:00' }), null);
});

test('a record that cannot name a moment is not read as 1970', () => {
  // A tooltip that says 1970 is worse than no tooltip, so every shape of "no answer" is null.
  assert.equal(cachedStamp(null), null);
  assert.equal(cachedStamp(undefined), null);
  assert.equal(cachedStamp({}), null);
  assert.equal(cachedStamp({ lastModified: '   ' }), null);
  assert.equal(cachedStamp({ lastModified: 'not a date' }), null);
  assert.equal(    cachedStamp({ backupTimestamp: 0 }), null);
  assert.equal(cachedStamp({ backupTimestamp: Number.NaN }), null);
});

test('the hover is the deck’s sentence, with the date and the time inside it', () => {
  const stamp = Date.UTC(2026, 9, 21, 14, 35);
  const title = modifiedTitle(stamp, 'en-GB');
  assert.ok(title, 'a real moment draws a sentence');
  // The label comes from the copy deck rather than from this module, so a translation moves
  // the whole sentence and this check follows it.
  assert.ok(title!.startsWith(copy.row.lastModified('')), `the hover does not use the deck: ${title}`);
  // The year and the minutes are in every locale's medium/short rendering, whatever the
  // machine's own timezone does to the hour.
  assert.match(title!, /2026/);
  assert.match(title!, /:35/);
  // One line: the tooltip is a title attribute, and a date on a second line would be cut off.
  assert.ok(!title!.includes('\n'));
});

test('a stamp that is not a moment draws no hover at all', () => {
  assert.equal(modifiedTitle(null, 'en-GB'), null);
  assert.equal(modifiedTitle(undefined, 'en-GB'), null);
  assert.equal(modifiedTitle(0, 'en-GB'), null);
  assert.equal(modifiedTitle(-1, 'en-GB'), null);
  assert.equal(modifiedTitle(Number.NaN, 'en-GB'), null);
});
