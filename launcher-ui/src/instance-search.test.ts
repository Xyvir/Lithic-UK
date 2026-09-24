import test from 'node:test';
import assert from 'node:assert/strict';
import { topHit, topHits, type InstanceCacheRead } from './instance-search.ts';

/** A cached wiki as the engine writes one: tiddler JSON. */
const wiki = (...tiddlers: Record<string, string>[]) => JSON.stringify(tiddlers);

const read = (origin: string, caches: { name: string; text: string }[]): InstanceCacheRead => ({
  origin,
  caches,
  truncated: false
});

test('a note found by its name outranks one found in its body', () => {
  // The body match is newer, and still loses: the name is what was typed.
  const instance = read('https://personal.lithic.uk', [
    { name: 'newer.lith', text: wiki({ title: 'Meeting', text: 'mentions blueprint once' }) },
    { name: 'older.lith', text: wiki({ title: 'Blueprint', text: 'nothing else here' }) }
  ]);

  const hit = topHit(instance, 'blueprint');
  assert.equal(hit?.name, 'older.lith');
  assert.equal(hit?.title, 'Blueprint');
  assert.equal(hit?.origin, 'https://personal.lithic.uk');
});

test('within a rank the instance\u2019s most recently saved wiki wins', () => {
  const instance = read('https://personal.lithic.uk', [
    { name: 'newest.lith', text: wiki({ title: 'Second', text: 'the needle again' }) },
    { name: 'older.lith', text: wiki({ title: 'First', text: 'the needle here' }) }
  ]);

  assert.equal(topHit(instance, 'needle')?.name, 'newest.lith');
});

test('an instance contributes one hit, not one per matching wiki', () => {
  const reads = {
    'https://personal.lithic.uk': read('https://personal.lithic.uk', [
      { name: 'a.lith', text: wiki({ title: 'A', text: 'needle' }) },
      { name: 'b.lith', text: wiki({ title: 'B', text: 'needle' }) }
    ]),
    'https://www.foobar.com': read('https://www.foobar.com', [
      { name: 'c.lith', text: wiki({ title: 'C', text: 'needle' }) }
    ])
  };

  const hits = topHits(reads, 'needle');
  assert.deepEqual(Object.keys(hits).sort(), ['https://personal.lithic.uk', 'https://www.foobar.com']);
  assert.equal(hits['https://personal.lithic.uk'].name, 'a.lith');
  assert.equal(hits['https://www.foobar.com'].name, 'c.lith');
});

test('an instance with nothing matching contributes nothing at all', () => {
  const reads = {
    'https://personal.lithic.uk': read('https://personal.lithic.uk', [
      { name: 'quiet.lith', text: wiki({ title: 'Quiet', text: 'nothing to see' }) }
    ]),
    // A stamp-only match is not a match: `created` is bookkeeping, not surface.
    'https://www.foobar.com': read('https://www.foobar.com', [
      { name: 'stamped.lith', text: wiki({ title: 'Box', created: '20260816020116648', text: 'silent' }) }
    ])
  };

  assert.deepEqual(topHits(reads, 'creat'), {});
  // Nor is a word that appears in neither of them.
  assert.deepEqual(topHits(reads, 'absent'), {});
});

test('no query and no caches both answer with nothing', () => {
  const reads = { 'https://personal.lithic.uk': read('https://personal.lithic.uk', [{ name: 'a.lith', text: wiki({ title: 'A', text: 'needle' }) }]) };
  assert.deepEqual(topHits(reads, ''), {});
  assert.deepEqual(topHits(reads, '   '), {});
  assert.deepEqual(topHits({}, 'needle'), {});
  assert.equal(topHit(read('https://personal.lithic.uk', []), 'needle'), null);
  // A cache that is not tiddler JSON is still searchable as one body of text.
  assert.equal(topHit(read('https://personal.lithic.uk', [{ name: 'page.html', text: '<html>a distinctive page</html>' }]), 'distinctive')?.name, 'page.html');
});

test('the hit carries the marked preview the launcher renders', () => {
  const hit = topHit(read('https://personal.lithic.uk', [{ name: 'notes.lith', text: wiki({ title: 'Archive Box', text: 'distinctive local findings' }) }]), 'Archive');
  assert.match(hit?.preview ?? '', /<mark class="cache-preview-title-mark">Archive<\/mark>/);
  assert.match(hit?.preview ?? '', /distinctive local findings/);
});
