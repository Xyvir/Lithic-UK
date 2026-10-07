import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectDefaultPlugins, defaultConfigPath } from '../../scripts/generate-default-plugins.mjs';

/**
 * The generator is the launcher's build input, so it is tested here, where the launcher's
 * tests run. Its two claims are the ones that were wrong in the hand-kept list it replaces:
 * a JSON plugin the build config never names must be in the result, and the build-time
 * compressor the config does name must not be.
 */

function fixture(config: unknown, extraTiddlers: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'lithic-plugins-'));
  writeFileSync(join(root, 'prod-tiddlywiki.info'), JSON.stringify(config));
  const tiddlers = join(root, 'wiki', 'tiddlers');
  mkdirSync(tiddlers, { recursive: true });
  for (const [name, tiddler] of Object.entries(extraTiddlers)) {
    writeFileSync(join(tiddlers, name), JSON.stringify(tiddler));
  }
  return root;
}

test('the generated list is the config plus the JSON plugins, minus build tooling', () => {
  const root = fixture({
    plugins: ['tiddlywiki/markdown', 'flibbles/uglify', 'flibbles/uglify-wizard', 'xyvir/lithic-core']
  }, {
    // What scripts/mirror.js writes for an external.yml entry of `type: json-plugin`: a
    // tiddler file rather than a plugin folder, which is why the config never names it.
    'quickview.json': { title: '$:/plugins/kookma/quickview', 'plugin-type': 'plugin' }
  });
  try {
    assert.deepEqual(collectDefaultPlugins({ root }), [
      'kookma/quickview',
      'tiddlywiki/markdown',
      'xyvir/lithic-core'
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tiddler that is not a plugin contributes no name', () => {
  const root = fixture({ plugins: ['xyvir/lithic-core'] }, {
    'note.json': { title: 'Some Note', text: 'hi' },
    'bundle.json': { title: '$:/plugins/not/installed', 'plugin-type': 'library' },
    'broken.json': '{ not json'
  });
  try {
    assert.deepEqual(collectDefaultPlugins({ root }), ['xyvir/lithic-core']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the config the build was given wins over the tracked prod config', () => {
  const root = fixture({ plugins: ['xyvir/lithic-core'] });
  try {
    // No generated config yet: the tracked prod config is the only one there is.
    assert.equal(defaultConfigPath(root), join(root, 'prod-tiddlywiki.info'));
    // CI writes this one before the launcher is built, so it describes the build in hand.
    writeFileSync(join(root, 'wiki', 'tiddlywiki.info'), JSON.stringify({ plugins: ['sq/streams'] }));
    assert.equal(defaultConfigPath(root), join(root, 'wiki', 'tiddlywiki.info'));
    assert.deepEqual(collectDefaultPlugins({ root }), ['sq/streams']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable config is an empty list rather than a failed launcher build', () => {
  const root = mkdtempSync(join(tmpdir(), 'lithic-plugins-'));
  try {
    assert.deepEqual(collectDefaultPlugins({ root }), []);
    // And an explicit path that names nothing is the same answer.
    assert.deepEqual(collectDefaultPlugins({ root, configPath: join(root, 'nope.info') }), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The invariant the whole change exists for, checked against the real inputs. The list is
// only a fallback (a mount reads the roots out of the base it is mounting), but a fallback
// that has stopped describing the engine is how a plugin bundle ends up inside a user's file.
// Skipped in a checkout with no built engine, like the parity test beside it.
test('the prod config describes every plugin the engine ships', () => {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const artifact = join(repoRoot, 'src', 'lithic.html');
  if (!existsSync(artifact)) return;
  const store = /<script class="tiddlywiki-tiddler-store" type="application\/json">([\s\S]*?)<\/script>/.exec(
    readFileSync(artifact, 'utf8')
  );
  assert.ok(store, 'the engine artifact carries its tiddler store');
  const shipped = [
    ...new Set(
      (JSON.parse(store[1]) as Array<Record<string, string>>)
        .filter((tiddler) => tiddler['plugin-type'] && tiddler.title?.startsWith('$:/plugins/'))
        .map((tiddler) => tiddler.title.replace('$:/plugins/', ''))
    )
  ];
  assert.ok(shipped.length > 20, 'sanity: the engine ships a plugin set');
  const generated = collectDefaultPlugins({ configPath: join(repoRoot, 'prod-tiddlywiki.info') });
  assert.deepEqual(
    shipped.filter((name) => !generated.includes(name)),
    [],
    'a plugin the engine ships must come out of the generated list, or it is saved into user files'
  );
});
