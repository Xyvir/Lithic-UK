import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TID_SERIALIZE_RUNTIME } from './tid-serialize-runtime.ts';

/** Evaluate the runtime against a stubbed root and return the serializer. */
function loadRuntime(): (docTiddler: Record<string, unknown>) => string {
  const sandbox: Record<string, unknown> = {};
  // The runtime binds to `window` when defined, falling back to globalThis.
  new Function('window', 'globalThis', TID_SERIALIZE_RUNTIME)(sandbox, {});
  return sandbox.__LITHIC_TID_SERIALIZE__ as (docTiddler: Record<string, unknown>) => string;
}

test('tid runtime serializes plain header fields', () => {
  const serialize = loadRuntime();
  const out = serialize({ title: 'T', type: 'text/vnd.tiddlywiki', text: 'body' });
  assert.equal(out, 'type: text/vnd.tiddlywiki\n\nbody');
});

test('tid runtime strips the injected Dogear tag but keeps authored tags', () => {
  const serialize = loadRuntime();
  // Injected: tags listed in the bookkeeping field -> removed entirely.
  const injected = serialize({
    title: 'T',
    tags: 'Dogear',
    'lithic-tid-injected': 'tags type',
    'lithic-tid': 'yes',
    text: 'body'
  });
  assert.equal(injected, '\n\nbody');

  // User added a tag in the editor: Dogear drops, the authored tag stays.
  const edited = serialize({
    title: 'T',
    tags: 'Dogear Mine',
    'lithic-tid-injected': 'tags type',
    'lithic-tid': 'yes',
    text: 'body'
  });
  assert.equal(edited, 'tags: Mine\n\nbody');

  // Authored tags (nothing injected) serialize untouched.
  const authored = serialize({ title: 'T', tags: 'Mine', text: 'body' });
  assert.equal(authored, 'tags: Mine\n\nbody');
});

test('tid runtime drops the injected default type once it is unchanged', () => {
  const serialize = loadRuntime();
  const unchanged = serialize({
    title: 'T',
    type: 'text/markdown',
    'lithic-tid-injected': 'type',
    'lithic-tid': 'yes',
    text: 'body'
  });
  assert.equal(unchanged, '\n\nbody');

  // User changed the type in the editor: the new value persists.
  const changed = serialize({
    title: 'T',
    type: 'text/vnd.tiddlywiki',
    'lithic-tid-injected': 'type',
    'lithic-tid': 'yes',
    text: 'body'
  });
  assert.equal(changed, 'type: text/vnd.tiddlywiki\n\nbody');
});
