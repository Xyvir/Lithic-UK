import test from 'node:test';
import assert from 'node:assert/strict';
import {
  escapePointerToken,
  unescapePointerToken,
  tiddlersToMap,
  mapToTiddlerArrayText,
  diffTiddlerMaps,
  applyTiddlerPatch,
  JSON_PATCH_RUNTIME
} from './json-patch.ts';

/** Evaluate the ES5 runtime string the same way the engine bootstrap will. */
function loadRuntime(): Record<string, any> {
  // The runtime picks its root via `typeof window !== 'undefined'`, so simply
  // supply a sandbox window — no text munging of the runtime needed.
  const sandbox: Record<string, any> = {};
  new Function('window', 'globalThis', JSON_PATCH_RUNTIME)(sandbox, sandbox);
  return sandbox.__LITHIC_JSON_PATCH__;
}

const runtime = loadRuntime();
assert.ok(runtime, 'JSON_PATCH_RUNTIME must define window.__LITHIC_JSON_PATCH__');

function assertParity(beforeText: string, afterText: string) {
  const before = tiddlersToMap(beforeText)!;
  const after = tiddlersToMap(afterText)!;
  const ops = diffTiddlerMaps(before, after);
  const moduleResult = mapToTiddlerArrayText(applyTiddlerPatch(before, ops));
  const runtimeOps = runtime.diffTiddlerMaps(before, after);
  const runtimeResult = runtime.mapToTiddlerArrayText(runtime.applyTiddlerPatch(before, runtimeOps));
  assert.deepEqual(ops, runtimeOps, 'ops differ between module and runtime');
  assert.equal(moduleResult, runtimeResult, 'materialized text differs between module and runtime');
  assert.equal(moduleResult, afterText, 'apply(diff(before, after)) must reconstruct after');
}

const wiki = JSON.stringify([
  { title: 'Welcome', tags: 'intro', text: 'hello world' },
  { title: 'Second', text: 'more content', modified: '2026-01-01' }
]);

test('diff of identical state produces no ops', () => {
  const map = tiddlersToMap(wiki)!;
  assert.deepEqual(diffTiddlerMaps(map, map), []);
});

test('field-level edit yields one tiny replace op', () => {
  const after = JSON.stringify([
    { title: 'Welcome', tags: 'intro', text: 'hello brave new world' },
    { title: 'Second', text: 'more content', modified: '2026-01-01' }
  ]);
  const ops = diffTiddlerMaps(tiddlersToMap(wiki)!, tiddlersToMap(after)!);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'replace');
  assert.equal(ops[0].path, '/Welcome/text');
});

test('added and removed tiddlers produce add/remove ops', () => {
  const after = JSON.stringify([{ title: 'Third', text: 'brand new' }]);
  const ops = diffTiddlerMaps(tiddlersToMap(wiki)!, tiddlersToMap(after)!);
  // Adds (after-titles) are emitted first, then removes (before-only titles).
  assert.deepEqual(
    ops.map((op) => op.op).sort(),
    ['add', 'remove', 'remove']
  );
});

test('added and removed fields inside a tiddler are tracked', () => {
  const after = JSON.stringify([
    { title: 'Welcome', text: 'hello world', created: '20260101' },
    { title: 'Second', text: 'more content' }
  ]);
  const ops = diffTiddlerMaps(tiddlersToMap(wiki)!, tiddlersToMap(after)!);
  const kinds = ops.map((op) => `${op.op} ${op.path}`).sort();
  assert.deepEqual(kinds, ['add /Welcome/created', 'remove /Second/modified', 'remove /Welcome/tags']);
});

test('titles and fields with JSON Pointer specials round-trip', () => {
  const before = JSON.stringify([{ title: 'a/b~c', text: 'x', '~odd': '1' }]);
  const after = JSON.stringify([{ title: 'a/b~c', text: 'y', '~odd': '2' }]);
  assertParity(before, after);
});

test('apply(diff) reconstructs the target text (module + runtime parity)', () => {
  const after = JSON.stringify([
    { title: 'Welcome', text: 'changed body', extra: 'field' },
    { title: 'Inserted', text: 'new tiddler' }
  ]);
  assertParity(wiki, after);
});

test('escaping helpers follow RFC 6901', () => {
  assert.equal(escapePointerToken('a/b~c'), 'a~1b~0c');
  assert.equal(unescapePointerToken('a~1b~0c'), 'a/b~c');
});

test('tiddlersToMap rejects non-array and non-tiddler payloads', () => {
  assert.equal(tiddlersToMap('not json'), null);
  assert.equal(tiddlersToMap('{"title":"x"}'), null);
  assert.deepEqual(tiddlersToMap('[{"nope":1}]'), {});
});

test('runtime tiddlersToMap matches module on garbage input', () => {
  assert.equal(runtime.tiddlersToMap('not json'), null);
  assert.deepEqual(Object.keys(runtime.tiddlersToMap(wiki)!), Object.keys(tiddlersToMap(wiki)!));
});
