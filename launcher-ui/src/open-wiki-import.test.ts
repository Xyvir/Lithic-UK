import assert from 'node:assert/strict';
import test from 'node:test';
import { importIntoOpenWiki } from './open-wiki-import.ts';
import type { PendingTiddler } from './pending-imports.ts';

/**
 * A rendered Lith, as much of it as the launcher reads: the tree core hangs under `rootWidget`,
 * with the page's importer a couple of levels in.
 *
 * The nesting is deliberate and it is the shape in the engine: `$tw.rootWidget` carries the
 * handlers the startup modules register on it, the page template node hangs beneath it, and the
 * navigator that handles `tm-import-tiddlers` is below that. A test that put the importer on the
 * root widget itself would pass while the real thing silently did nothing.
 */
function fakeWiki(): { tw: unknown; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const importer = {
    handleImportTiddlersEvent: () => true,
    dispatchEvent: (event: Record<string, unknown>) => {
      events.push(event);
    }
  };
  return { tw: { rootWidget: { children: [{ children: [importer] }] } }, events };
}

test('a Lith that has taken the window over imports the payload itself', () => {
  const wiki = fakeWiki();
  const tiddlers: PendingTiddler[] = [
    { title: 'An Article', tags: 'Dogear', 'stream-list': '[[An Article 1]]', type: 'text/vnd.tiddlywiki' },
    { title: 'An Article 1', text: '# Heading' }
  ];
  assert.equal(importIntoOpenWiki(tiddlers, wiki.tw), true);
  assert.equal(wiki.events.length, 1);
  // Named as a literal rather than through the module, because the name is core's and not this
  // module's: `$:/core/modules/widgets/navigator.js` listens for `tm-import-tiddlers`, and an
  // event under any other name builds no import view at all.
  assert.equal(wiki.events[0].type, 'tm-import-tiddlers');
  // The fields travel as JSON in `param`, which is the one field core reads (`parseJSONSafe` over
  // `event.param`), so a payload under any other name imports nothing.
  assert.equal(typeof wiki.events[0].param, 'string');
  assert.deepEqual(JSON.parse(wiki.events[0].param as string), tiddlers);
});

test('the root widget alone is never enough, because a message travels upwards', () => {
  // The trap this walk exists for. `$tw.rootWidget` is the tree's root and carries the handlers
  // the startup modules attach to it, so dispatching the message there looks right and does
  // nothing: core's `dispatchEvent` walks `parentWidget`, and there is nothing above the root.
  // A widget that can dispatch but does not handle the message is therefore a refusal.
  const dispatched: Array<Record<string, unknown>> = [];
  const tw = {
    rootWidget: {
      dispatchEvent: (event: Record<string, unknown>) => {
        dispatched.push(event);
      },
      children: [{ children: [{ children: [] }] }]
    }
  };
  assert.equal(importIntoOpenWiki([{ title: 'X', text: 'hi' }], tw), false);
  assert.equal(dispatched.length, 0, 'an import asked of a widget that cannot handle it is no import');
});

test('no Lith in the window leaves the payload where it was', () => {
  const tiddlers: PendingTiddler[] = [{ title: 'X', text: 'hi' }];
  const wiki = fakeWiki();
  // The launcher's own page, a window whose mount has not booted its wiki yet, and every shape of
  // a wiki that is not far enough along to take a message: each answers false, so the caller
  // queues the payload instead of dropping it into a window that cannot show it.
  for (const nothing of [null, undefined, {}, { rootWidget: {} }, { rootWidget: { children: [] } }, { rootWidget: { children: [{}, { children: [{}] }] } }]) {
    assert.equal(importIntoOpenWiki(tiddlers, nothing), false);
  }
  assert.equal(wiki.events.length, 0, 'nothing was sent to a wiki that was never asked');
});

test('a payload of nothing is not an import', () => {
  const wiki = fakeWiki();
  assert.equal(importIntoOpenWiki([], wiki.tw), false);
  assert.equal(wiki.events.length, 0, 'an import listing of no tiddlers is a page about nothing');
});

test('a Lith that refuses the message keeps the payload for the panel', () => {
  // Mid-boot is the case: `$tw` is there and the importer is rendered, and the message throws.
  // The share is still in hand afterwards, because that is what false means.
  const tw = {
    rootWidget: {
      children: [
        {
          handleImportTiddlersEvent: () => true,
          dispatchEvent: () => {
            throw new Error('the wiki is not ready');
          }
        }
      ]
    }
  };
  assert.equal(importIntoOpenWiki([{ title: 'X', text: 'hi' }], tw), false);
});
