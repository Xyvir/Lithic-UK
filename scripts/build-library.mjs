#!/usr/bin/env node
/**
 * Publish the Lithic plugins as a TiddlyWiki plugin library.
 *
 *   npm run build:library
 *
 * Loads every plugin under wiki/local-plugins (minus archive/) from the staging tree,
 * then runs TiddlyWiki's own library recipe (the one its pluginlibrary edition uses):
 * --makelibrary bundles them, --savelibrarytiddlers writes one JSON per plugin plus the
 * catalogue, and --rendertiddler writes index.html. The output lands in docs/library/,
 * which GitHub Pages serves beside docs/index.html (the white-label wiki that carries
 * the drag-and-drop tiddler).
 *
 * Needs the staging tree (npm run mirror, then flatten-plugins.js). It does not hit the
 * network. The library holds only local-plugins, not the external plugins, which are
 * fetched at build time and would make the output depend on remote hosts.
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const localPlugins = path.join(repoRoot, 'wiki', 'local-plugins');
const pluginsStage = path.join(repoRoot, 'wiki', 'plugins');
const themesStage = path.join(repoRoot, 'wiki', 'themes');
const editionDir = path.join(repoRoot, 'wiki', 'library-edition');
const outputDir = path.join(repoRoot, 'docs', 'library');

if (!existsSync(path.join(repoRoot, 'node_modules', 'tiddlywiki', 'tiddlywiki.js'))) {
  console.error('node_modules/tiddlywiki is missing. Run `npm ci` first.');
  process.exit(1);
}
if (!existsSync(pluginsStage)) {
  console.error('wiki/plugins is missing. Run `npm run mirror` and flatten-plugins.js first.');
  process.exit(1);
}

// Every local-plugins entry except archive/, as its plugin title and its author/name path.
const plugins = readdirSync(localPlugins)
  .filter((name) => name !== 'archive' && statSync(path.join(localPlugins, name)).isDirectory())
  .map((name) => {
    const info = JSON.parse(readFileSync(path.join(localPlugins, name, 'plugin.info'), 'utf8'));
    return { title: info.title, name: info.title.replace(/^\$:\/plugins\//, '') };
  })
  .sort((a, b) => a.title.localeCompare(b.title));

if (plugins.length === 0) {
  console.error('No plugins found under wiki/local-plugins.');
  process.exit(1);
}

// A clean edition every run, so nothing from a previous library lingers.
rmSync(editionDir, { recursive: true, force: true });
mkdirSync(editionDir, { recursive: true });
writeFileSync(
  path.join(editionDir, 'tiddlywiki.info'),
  JSON.stringify(
    {
      description: 'Lithic plugin library',
      plugins: ['tiddlywiki/pluginlibrary', ...plugins.map((p) => p.name)],
      themes: [],
      build: {
        library: [
          '--makelibrary', '$:/UpgradeLibrary',
          '--savelibrarytiddlers', '$:/UpgradeLibrary', plugins.map((p) => `[[${p.title}]]`).join(' '), 'recipes/library/tiddlers/', '$:/UpgradeLibrary/List',
          '--savetiddler', '$:/UpgradeLibrary/List', 'recipes/library/tiddlers.json',
          '--rendertiddler', '$:/plugins/tiddlywiki/pluginlibrary/library.template.html', 'index.html', 'text/plain',
        ],
      },
    },
    null,
    2,
  ) + '\n',
);

const result = spawnSync(
  process.execPath,
  [path.join(repoRoot, 'node_modules', 'tiddlywiki', 'tiddlywiki.js'), editionDir, '--build', 'library'],
  {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: {
      ...process.env,
      TIDDLYWIKI_PLUGIN_PATH: pluginsStage,
      TIDDLYWIKI_THEME_PATH: themesStage,
    },
  },
);
if (result.status !== 0) {
  console.error(`${result.stdout ?? ''}${result.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n'));
  process.exit(1);
}

// Publish the output: recipes/library/* and index.html, under docs/library/.
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
cpSync(path.join(editionDir, 'output'), outputDir, { recursive: true });

const libDir = path.join(outputDir, 'recipes', 'library', 'tiddlers');
const count = existsSync(libDir) ? readdirSync(libDir).filter((f) => f.endsWith('.json')).length : 0;
console.log(`library: ${count} plugin files written to docs/library (${plugins.length} expected)`);
if (count !== plugins.length) {
  console.error('plugin count mismatch: some local-plugins did not reach the library.');
  process.exit(1);
}
