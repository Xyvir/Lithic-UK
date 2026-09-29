import test from 'node:test';
import assert from 'node:assert/strict';
import { gapCount, versionGap, type VersionGap } from './history-gap.ts';
import { decks } from './copy.ts';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

test('two versions stamped in the same instant are joined by nothing but the chevron', () => {
  for (const ms of [0, -1, -DAY, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(versionGap(ms), null, `${ms} should not draw a distance`);
  }
});

test('under a minute the gap is counted in seconds, and never as a bare zero', () => {
  assert.deepEqual(versionGap(4 * SECOND), { unit: 'seconds', value: 4 });
  assert.deepEqual(versionGap(59 * SECOND), { unit: 'seconds', value: 59 });
  assert.deepEqual(versionGap(SECOND), { unit: 'seconds', value: 1 });
  // Two saves a fraction of a second apart are still two saves, and `0 seconds later` is not
  // a distance anybody can read.
  assert.deepEqual(versionGap(400), { unit: 'seconds', value: 1 });
});

test('minutes up to the hour, and the last half minute before it is an hour', () => {
  assert.deepEqual(versionGap(60 * SECOND), { unit: 'minutes', value: 1 });
  assert.deepEqual(versionGap(4 * MINUTE), { unit: 'minutes', value: 4 });
  assert.deepEqual(versionGap(45 * MINUTE), { unit: 'minutes', value: 45 });
  assert.deepEqual(versionGap(59.5 * MINUTE), { unit: 'hours', value: 1 });
  assert.deepEqual(versionGap(60 * MINUTE), { unit: 'hours', value: 1 });
  assert.deepEqual(versionGap(90 * MINUTE), { unit: 'hours', value: 1.5 });
});

test('hours round to the nearest half, and the last one before a day is not 24 hours', () => {
  assert.deepEqual(versionGap(12 * HOUR), { unit: 'hours', value: 12 });
  assert.deepEqual(versionGap(12.2 * HOUR), { unit: 'hours', value: 12 });
  assert.deepEqual(versionGap(12.4 * HOUR), { unit: 'hours', value: 12.5 });
  assert.deepEqual(versionGap(23.9 * HOUR), { unit: 'days', value: 1 });
  assert.deepEqual(versionGap(30 * HOUR), { unit: 'days', value: 1.5 });
  assert.deepEqual(versionGap(3 * DAY), { unit: 'days', value: 3 });
  assert.deepEqual(versionGap(7 * DAY), { unit: 'days', value: 7 });
});

test('the count is written the way the locale writes numbers', () => {
  const half: VersionGap = { unit: 'hours', value: 1.5 };
  assert.equal(gapCount(half, 'en-GB'), '1.5');
  assert.equal(gapCount(half, 'es-ES'), '1,5');
  assert.equal(gapCount(half, 'fr-FR'), '1,5');
  assert.equal(gapCount(half, 'de-DE'), '1,5');
  assert.equal(gapCount({ unit: 'days', value: 12 }, 'de-DE'), '12');
});

test('every deck states every unit, and the count it was given is in the sentence', () => {
  const samples: VersionGap[] = [
    { unit: 'seconds', value: 4 },
    { unit: 'minutes', value: 1 },
    { unit: 'hours', value: 1.5 },
    { unit: 'days', value: 12 }
  ];
  for (const [id, deck] of Object.entries(decks)) {
    for (const sample of samples) {
      const count = gapCount(sample, id);
      const said = deck.dialogs.history.later[sample.unit](count);
      assert.ok(said.startsWith(count), `${id}.${sample.unit} does not lead with its count: ${said}`);
      assert.ok(
        said.trim().length > count.length,
        `${id}.${sample.unit} says no unit after the count: ${said}`
      );
    }
  }
});
