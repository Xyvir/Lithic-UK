import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createLithSaver,
  normalizeLithName,
  getLithicUserFilter,
  installLegacyLithSaver,
  DEFAULT_PLUGINS
} from './legacy-saver.ts';

test('normalizes launcher names to one lith extension', () => {
  assert.equal(normalizeLithName('new'), 'new.lith');
  assert.equal(normalizeLithName('new.html'), 'new.lith');
  assert.equal(normalizeLithName('new.lith'), 'new.lith');
  assert.equal(normalizeLithName('new.json'), 'new.lith');
  assert.equal(normalizeLithName('.html'), 'untitled.lith');
});

test('builds accurate user tiddler filter excluding all 39 default plugins and core system spaces', () => {
  const filter = getLithicUserFilter();
  assert.match(filter, /\[all\[tiddlers\]!is\[system\]\]/);
  assert.match(filter, /!prefix\[\$:\/core\]/);
  assert.match(filter, /!prefix\[\$:\/themes\]/);
  assert.match(filter, /!prefix\[\$:\/temp\]/);
  assert.match(filter, /!prefix\[\$:\/state\]/);
  assert.match(filter, /-\[\[\$:\/plugins\/sq\/streams\]\]/);
  assert.match(filter, /-\[\[\$:\/plugins\/xyvir\/lithic-core\]\]/);
  assert.equal(DEFAULT_PLUGINS.length, 41);
});

// The injected tiddlers are re-created on every mount, so a copy in the file is
// stale the moment it is written. Measured before the fix: saving a one-tiddler
// wiki produced seven tiddlers, six of them the launcher's own.
test('a save excludes what the launcher itself injects', () => {
  const filter = getLithicUserFilter();
  assert.match(filter, /-\[prefix\[~\]\]/, 'launcher override tiddlers are marked with a leading ~');
  assert.match(filter, /-\[prefix\[\$:\/plugins\/lithic\/ephemeral\/\]\]/, 'the Ephemeral integration is not user content');
  assert.match(filter, /-\[\[\$:\/config\/OfficialPluginLibrary\]\]/, 'the bootstrap sets this flag itself');
});

// The list is hand-maintained while the engine's plugin set is whatever the wiki
// build produced, so they drift silently — lithic-patch-mermaid and lithic-save
// were both shipped in lithic.html and both absent here, which is how two plugin
// bundles ended up inside a saved one-tiddler wiki. Asserted against the shipped
// artifact so the next plugin addition fails here instead of in a user's file.
test('every plugin shipped in the engine is excluded from saves', () => {
  const artifact = fileURLToPath(new URL('../../src/lithic.html', import.meta.url));
  if (!existsSync(artifact)) return; // A checkout without the built engine.
  const store = /<script class="tiddlywiki-tiddler-store" type="application\/json">([\s\S]*?)<\/script>/.exec(
    readFileSync(artifact, 'utf8')
  );
  assert.ok(store, 'the engine artifact carries its tiddler store');
  const shipped = (JSON.parse(store[1]) as Array<Record<string, string>>)
    .filter((tiddler) => tiddler['plugin-type'] && tiddler.title?.startsWith('$:/plugins/'))
    .map((tiddler) => tiddler.title.replace('$:/plugins/', ''));
  assert.ok(shipped.length > 20, 'sanity: the engine ships a plugin set');
  assert.deepEqual(
    shipped.filter((name) => !DEFAULT_PLUGINS.includes(name)),
    [],
    'a plugin the engine ships must be in DEFAULT_PLUGINS or it is saved into user files'
  );
});

test('opens one Lithic picker with .lith mimetype and reuses the selected handle', async () => {
  let pickerCalls = 0;
  const writes: string[] = [];
  const picker = async (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => {
    pickerCalls++;
    assert.equal(options.suggestedName, 'new.lith');
    assert.deepEqual(options.types[0].accept, { 'application/x-lith': ['.lith'] });
    return {
      name: 'new.lith',
      async createWritable() {
        return {
          async write(value: string) { writes.push(value); },
          async close() {}
        };
      }
    };
  };

  let deletedTiddler = '';
  const mockTw = {
    wiki: {
      getTiddlersAsJson: (_filter: string) => '[{"title":"Today","text":"hello"}]',
      deleteTiddler: (title: string) => { deletedTiddler = title; }
    }
  };
  (globalThis as any).$tw = mockTw;

  const saver = createLithSaver({
    picker,
    getJson: () => '[{"title":"Today","text":"hello"}]'
  });

  const callbackErrors: unknown[] = [];
  saver('', '', (error) => callbackErrors.push(error));
  saver('', '', (error) => callbackErrors.push(error));

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pickerCalls, 1);
  assert.equal(writes.length, 2);
  assert.match(writes[0], /title: Today/);
  assert.equal(deletedTiddler, '$:/state/DisableAutoSaver');
  assert.deepEqual(callbackErrors, [null, null]);
});

test('createLithSaver passes the suggested name through to the picker', async () => {
  let seen: string | undefined;
  const picker = async (options: { suggestedName: string; types: Array<{ description: string; accept: Record<string, string[]> }> }) => {
    seen = options.suggestedName;
    return {
      name: options.suggestedName,
      async createWritable() {
        return { async write() {}, async close() {} };
      }
    };
  };

  const saver = createLithSaver({ picker, suggestedName: 'My Notes.lith' });
  const callbackErrors: unknown[] = [];
  saver('', '', (error) => callbackErrors.push(error));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(seen, 'My Notes.lith');
  assert.deepEqual(callbackErrors, [null]);
});

test('uses initial handle directly when mounted from disk without prompting picker', async () => {
  let pickerCalls = 0;
  const writes: string[] = [];
  const picker = async () => {
    pickerCalls++;
    throw new Error('Picker should not have been called');
  };

  const initialHandle = {
    name: 'notes.lith',
    async createWritable() {
      return {
        async write(value: string) { writes.push(value); },
        async close() {}
      };
    }
  };

  const saver = createLithSaver({
    initialHandle,
    picker,
    getJson: () => '[{"title":"MountedNote","text":"content"}]'
  });

  let saveError: unknown = 'init';
  saver('', '', (err) => { saveError = err; });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pickerCalls, 0);
  assert.equal(writes.length, 1);
  assert.match(writes[0], /title: MountedNote/);
  assert.equal(saveError, null);
});

test('installs custom saver synchronously on target window before tw.wiki exists', () => {
  const fakeWindow: any = {};
  installLegacyLithSaver(fakeWindow);

  assert.ok(fakeWindow.$tw);
  assert.ok(fakeWindow.$tw.customSaver);
  assert.equal(typeof fakeWindow.$tw.customSaver.save, 'function');
});

test('handles user cancellation (AbortError) gracefully without failing save callback', async () => {
  const abortError = new Error('The user aborted a request.');
  abortError.name = 'AbortError';

  const picker = async () => {
    throw abortError;
  };

  const saver = createLithSaver({ picker });
  let resultError: unknown = 'pending';

  saver('', '', (error) => {
    resultError = error;
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(resultError, null);
});
