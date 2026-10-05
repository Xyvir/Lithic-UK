/**
 * The build-time sync pin, tested without building anything.
 *
 * What a pin *sheds* is proven by building it (`scripts/check-sync-pin.mjs`, which greps each
 * artifact for the markers only one prong's code carries); what the module says a pin means is
 * proven here, because that is what every caller reads. The two things worth holding down: an
 * unknown value is the default rather than a pin of its own, and the list of pins this module
 * knows is the list the build flag accepts, so a pin can never be added to one side alone.
 *
 * The defaults below are the values a page running outside a build sees (`auto`), which is also
 * what the unit tests themselves are: Node, no `location`, no substituted literal.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  SHOWS_DEVICE_SYNC,
  SHOWS_GITHUB_SYNC,
  SYNC_PINS,
  SYNC_PIN,
  isSyncPin,
  pinSurface,
  resolveSyncPin,
  type SyncPin
} from './sync-pin.ts';

test('a pin names itself and nothing else does', () => {
  for (const pin of SYNC_PINS) {
    assert.equal(isSyncPin(pin), true, pin);
    assert.equal(resolveSyncPin(pin), pin, pin);
  }
  // The fallback is for the shapes a value can have when nobody pinned anything: the flag
  // absent, an empty string, whitespace, and the environment variable of a shell that set it
  // to nothing. A typo is not among them: the build refuses that before Vite runs.
  for (const nothing of [undefined, null, '', '   ']) {
    assert.equal(resolveSyncPin(nothing), 'auto', JSON.stringify(nothing));
  }
  for (const notAPin of ['Auto', 'IROH', 'github ', 'all', 'off', 'true']) {
    assert.equal(isSyncPin(notAPin), false, notAPin);
  }
  // `github ` trims to a pin, which is what the flag does with what a shell hands it.
  assert.equal(resolveSyncPin('github '), 'github');
});

test('a pin says which prongs are compiled in', () => {
  assert.deepEqual(pinSurface('auto'), { github: true, device: true });
  assert.deepEqual(pinSurface('both'), { github: true, device: true });
  assert.deepEqual(pinSurface('github'), { github: true, device: false });
  assert.deepEqual(pinSurface('iroh'), { github: false, device: true });
});

test('the build flag accepts exactly the pins this module knows', () => {
  // The flag is read by `scripts/build-launcher.mjs`, which cannot import this module (it is
  // TypeScript, and the script is not built), so the two lists are kept in step by this test.
  // The pattern is deliberately narrow: it is the array's own declaration, so a pin moved into
  // a different shape fails here rather than passing on a stray match.
  const script = readFileSync(fileURLToPath(new URL('../../scripts/build-launcher.mjs', import.meta.url)), 'utf8');
  const declared = /const PIN_FOR_BUILD = \[([^\]]*)\];/.exec(script);
  assert.ok(declared, 'build-launcher.mjs should declare PIN_FOR_BUILD');
  const flagPins = declared[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);
  assert.deepEqual(flagPins, [...SYNC_PINS]);
});

test('a page outside a build reads the default pin', () => {
  // No `location` in Node, so no environment was consulted: the artifact pins answer with the
  // default's own surface, which is what keeps this module importable by every other test.
  assert.equal(SYNC_PIN, 'auto' satisfies SyncPin);
  assert.equal(SHOWS_GITHUB_SYNC, true);
  assert.equal(SHOWS_DEVICE_SYNC, true);
});
