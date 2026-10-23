#!/usr/bin/env node
/**
 * Publish the Lithic plugins as a TiddlyWiki plugin library.
 *
 *   npm run build:library
 *
 * Loads every plugin under wiki/local-plugins (minus archive/) from the staging tree,
 * then runs TiddlyWiki's own library recipe (the one its pluginlibrary edition uses):
 * --makelibrary bundles them, --savelibrarytiddlers writes one JSON per plugin plus the
 * catalogue, and --rendertiddler writes index.html. The output lands in library/,
 * which GitHub Pages serves from the repo root beside index.html (the white-label wiki that carries
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
const outputDir = path.join(repoRoot, 'library');
const carrierDir = path.join(repoRoot, 'wiki', 'library-carrier');
const libraryUrl = 'https://lithic.uk/library/index.html';

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

// What the carrier installs, in a switched-off state. prod-tiddlywiki.info decides the order and
// which plugins count as shipped: adding a local plugin there is all it takes for the carrier to
// offer it, and the build fails loudly rather than silently carrying a stale list. A local plugin
// the library publishes but prod has not adopted yet is still carried, because the store sells it
// and the carrier is the store's front page.
const prodInfoPath = path.join(repoRoot, 'prod-tiddlywiki.info');
if (!existsSync(prodInfoPath)) {
  console.error('prod-tiddlywiki.info is missing; the carrier cannot know which plugins to offer.');
  process.exit(1);
}
const prodPlugins = JSON.parse(readFileSync(prodInfoPath, 'utf8')).plugins || [];
const localNames = plugins.map((p) => p.name);
const carriedNames = [
  ...prodPlugins.filter((name) => localNames.includes(name)),
  ...localNames.filter((name) => !prodPlugins.includes(name)),
];
if (carriedNames.length === 0) {
  console.error('No local plugin from wiki/local-plugins appears in prod-tiddlywiki.info.');
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

// Publish the output: recipes/library/* and index.html, under library/.
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });
cpSync(path.join(editionDir, 'output'), outputDir, { recursive: true });

// The carrier: a vanilla wiki (core plus the vanilla theme, so it looks like TiddlyWiki rather than
// bare core) whose one config tiddler points at the library above, so a user drags it into their
// wiki and gets the same Plugin Library entry Kookma's page offers. It opens on a Welcome tiddler
// (through $:/DefaultTiddlers) rather than on the core's GettingStarted, because the first thing a
// visitor needs is what this page is and the link that puts the library in their own wiki.
//
// Every plugin the store sells is also installed here and switched off through
// `$:/config/Plugins/Disabled/<title>`, which boot.js honours. That is what makes single plugins
// draggable: the Plugins table lists them as tiddlers, and dragging one into another wiki installs
// just that plugin. Switched off means the page a visitor lands on is plain vanilla, not Lithic.
rmSync(carrierDir, { recursive: true, force: true });
mkdirSync(path.join(carrierDir, 'tiddlers'), { recursive: true });
for (const name of carriedNames) {
  writeFileSync(
    path.join(carrierDir, 'tiddlers', `Disabled-${name.replace(/[^A-Za-z0-9._-]+/g, '-')}.tid`),
    // No trailing newline: boot.js trims this value, but the control panel's $reveal compares it
    // literally against "yes", so a trailing newline would leave every plugin showing as enabled.
    ['title: $:/config/Plugins/Disabled/$:/plugins/' + name, 'type: text/vnd.tiddlywiki', '', 'yes'].join('\n'),
  );
}
writeFileSync(
  path.join(carrierDir, 'tiddlers', 'LithicPluginLibrary.tid'),
  [
    'title: $:/config/LithicPluginLibrary',
    'tags: $:/tags/PluginLibrary',
    `url: ${libraryUrl}`,
    'caption: Lithic Plugin Library',
    '',
    'The Lithic plugin library, published at lithic.uk.',
    '',
  ].join('\n'),
);
// The carrier's first screen. `$:/DefaultTiddlers` is the supported way to say which tiddler a
// wiki opens on, and the title lives in the file's front matter, so the filename stays plain
// (`DefaultTiddlers.tid`), which is the part a Windows path cannot carry.
writeFileSync(
  path.join(carrierDir, 'tiddlers', 'Welcome.tid'),
  [
    'title: Welcome',
    'type: text/vnd.tiddlywiki',
    '',
    // `plugin-table` is the macro the Plugins tab renders; importing it is what lets this page
    // list the installed plugins without transcluding the whole control panel around them.
    '\\import [[$:/core/ui/ControlPanel/Plugins]]',
    '',
    '! Lithic Plugin Library',
    '',
    `The ${carriedNames.length} plugins that turn a plain TiddlyWiki into Lithic. They are installed`,
    'here but switched off, so this page stays vanilla.',
    '',
    '!! Install one plugin',
    '',
    'Drag a plugin from the list below into your own wiki to install just that one. Each row also',
    'opens to show what the plugin does.',
    '',
    // Every row is core's plugin-info component, whose outer element is a $link to the plugin
    // tiddler; a $link is draggable by default and carries that tiddler, so a row can be dropped
    // into another wiki as a plugin install.
    '<<plugin-table plugin>>',
    '',
    '!! Add the whole library instead',
    '',
    // Same mechanism one level up: this link carries the config tiddler that registers the library.
    '<$link to="$:/config/LithicPluginLibrary" class="tc-btn-big-green">Drag this link into a wiki</$link>',
    '',
    "The library then appears under ''Control Panel'' → ''Plugins'' → ''Get more plugins'', and every",
    'plugin can be added or removed from there. Keep this page and the wiki you are adding it to',
    'open side by side.',
    '',
  ].join('\n'),
);
writeFileSync(
  path.join(carrierDir, 'tiddlers', 'DefaultTiddlers.tid'),
  ['title: $:/DefaultTiddlers', 'type: text/vnd.tiddlywiki', '', '[[Welcome]]', ''].join('\n'),
);
// The name in the sidebar and the browser tab. Core falls back to its own "My TiddlyWiki", which
// would make the store's own page look like an empty notebook.
writeFileSync(
  path.join(carrierDir, 'tiddlers', 'SiteTitle.tid'),
  ['title: $:/SiteTitle', 'type: text/vnd.tiddlywiki', '', 'Lithic Plugin Library', ''].join('\n'),
);
// Core's own subtitle is "a non-linear personal web notebook", which rides along in the tab title.
writeFileSync(
  path.join(carrierDir, 'tiddlers', 'SiteSubtitle.tid'),
  ['title: $:/SiteSubtitle', 'type: text/vnd.tiddlywiki', '', 'the plugin store', ''].join('\n'),
);
writeFileSync(
  path.join(carrierDir, 'tiddlywiki.info'),
  JSON.stringify(
    {
      description: 'Lithic plugin store carrier',
      plugins: carriedNames,
      themes: ['tiddlywiki/vanilla'],
      build: {
        carrier: ['--render', '$:/core/save/all', 'plugin-store-carrier-wiki.html', 'text/plain'],
      },
    },
    null,
    2,
  ) + '\n',
);
const carrier = spawnSync(
  process.execPath,
  [path.join(repoRoot, 'node_modules', 'tiddlywiki', 'tiddlywiki.js'), carrierDir, '--build', 'carrier'],
  {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    // The carried plugins resolve out of the same staging tree the library build uses.
    env: { ...process.env, TIDDLYWIKI_PLUGIN_PATH: pluginsStage },
  },
);
if (carrier.status !== 0) {
  console.error(`${carrier.stdout ?? ''}${carrier.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n'));
  process.exit(1);
}
cpSync(path.join(carrierDir, 'output', 'plugin-store-carrier-wiki.html'), path.join(outputDir, 'plugin-store-carrier-wiki.html'));

const libDir = path.join(outputDir, 'recipes', 'library', 'tiddlers');
const count = existsSync(libDir) ? readdirSync(libDir).filter((f) => f.endsWith('.json')).length : 0;
console.log(`library: ${count} plugin files written to library (${plugins.length} expected)`);
if (count !== plugins.length) {
  console.error('plugin count mismatch: some local-plugins did not reach the library.');
  process.exit(1);
}
