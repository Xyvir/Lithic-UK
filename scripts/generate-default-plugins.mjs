/**
 * The plugin roots a save must not write into a user's document, derived from the inputs the
 * wiki build is actually configured with.
 *
 * The launcher's save filter excludes the plugins the *engine* ships, so a user's `.lith`
 * holds their own tiddlers and not a stale copy of the base's plugins. That set was a
 * hand-kept list in `launcher-ui/src/legacy-saver.ts`, and it drifted the way any list kept
 * by hand does: two plugin bundles (lithic-patch-mermaid, lithic-save) were shipped in the
 * engine and absent from the list, which put them inside a saved one-tiddler wiki.
 *
 * Which sources describe the engine, and which only look like they do, was measured rather
 * than assumed. On this repository the build config lists 42 plugins and the engine ships 41
 * roots, and the difference in each direction is one entry:
 *
 *   - `flibbles/uglify` is in the config and not in the engine, because it is the build-time
 *     compressor and the `$:/core/save/all` shadow in `wiki/local-plugins/lithic-save` strips
 *     it back out of the published artifact.
 *   - `kookma/quickview` is in the engine and not in the config, because `external.yml`
 *     declares it `type: json-plugin`: `scripts/mirror.js` installs it at `wiki/tiddlers/`,
 *     which TiddlyWiki loads directly, so it never appears in a plugin list.
 *
 * Config minus build-only tooling, plus the JSON plugins, is therefore exactly the engine's
 * set (verified against the tiddler store of the built artifact), and it is the rule this
 * script implements. `scripts/inject-launcher-plugins.js` does the same two-part read for the
 * archived legacy launcher, which is where the rule was first worked out. The committed
 * artifact's own store is read in addition, because the JSON plugins live in gitignored
 * staging and a checkout that has not mirrored must still produce the full list.
 *
 * The flattened staging tree under `wiki/plugins` looks like a better source and is not one:
 * measured at 170 roots against 41 shipped, because an `external.yml` entry of `type: plugins`
 * unpacks a whole plugin library there, and measured to *miss* the five `tiddlywiki/*` plugins
 * (markdown, freelinks, highlight, katex, dynaview) that the CLI loads from its own package
 * rather than from staging. A list built from it would exclude 129 names no engine carries
 * while leaving the base's own core plugins to be saved into a user's file.
 *
 * The mount itself is the first source of truth and this is the second: a launcher reads the
 * plugin roots out of the store of the very base it is mounting (`readEnginePluginRoots`), and
 * this list is what a base with no readable store falls back to.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Build-time tooling, named by the config and never present in a published artifact. */
const BUILD_ONLY = new Set(['flibbles/uglify', 'flibbles/uglify-wizard']);

const PLUGIN_PREFIX = '$:/plugins/';

/**
 * Plugin roots out of the tiddler store of the committed engine artifact.
 *
 * This is the only *tracked* record of what the engine ships: the build config is tracked but
 * does not describe the JSON plugins, and `wiki/tiddlers` (where those land) is gitignored
 * staging that exists only after `npm run mirror`. Without this source the list silently loses
 * `kookma/quickview` in every checkout that has not mirrored, which is why it is read here.
 *
 * It is the artifact of the *previous* release, so the list can name a plugin the next engine
 * no longer ships. That direction is deliberate and it is the safe one: an extra name excludes
 * a plugin that is not there (harmless), while a missing name writes the base's own plugin
 * into a user's document. The committed fallback list already carried that bias, and the
 * parity test in `legacy-saver.test.ts` tolerates over-coverage for the same reason.
 */
function rootsFromEngineArtifact(artifact) {
  if (!existsSync(artifact)) return [];
  try {
    const store = /<script class="tiddlywiki-tiddler-store" type="application\/json">([\s\S]*?)<\/script>/i.exec(
      readFileSync(artifact, 'utf8')
    );
    if (!store) return [];
    const tiddlers = JSON.parse(store[1]);
    if (!Array.isArray(tiddlers)) return [];
    return tiddlers
      .filter((tiddler) => tiddler && tiddler['plugin-type'] && typeof tiddler.title === 'string')
      .map((tiddler) => tiddler.title)
      .filter((title) => title.startsWith(PLUGIN_PREFIX))
      .map((title) => title.slice(PLUGIN_PREFIX.length));
  } catch {
    return [];
  }
}

/** The build config the wiki will be built from, preferring the one CI generated. */
export function defaultConfigPath(root = REPO_ROOT) {
  const generated = join(root, 'wiki', 'tiddlywiki.info');
  return existsSync(generated) ? generated : join(root, 'prod-tiddlywiki.info');
}

/**
 * Plugin roots carried by JSON tiddler files rather than by a plugin folder.
 *
 * This is where an `external.yml` entry of `type: json-plugin` lands (`scripts/mirror.js`),
 * and it is the one asymmetry between the build config and what the engine ships.
 */
function rootsFromJsonTiddlers(dir) {
  const roots = [];
  if (!existsSync(dir)) return roots;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.json')) {
        try {
          const tiddler = JSON.parse(readFileSync(full, 'utf8'));
          const title = typeof tiddler.title === 'string' ? tiddler.title : '';
          if (tiddler['plugin-type'] === 'plugin' && title.startsWith(PLUGIN_PREFIX)) {
            roots.push(title.slice(PLUGIN_PREFIX.length));
          }
        } catch {
          // Not a tiddler JSON this can read; it is not this list's to report.
        }
      }
    }
  };
  walk(dir);
  return roots;
}

/**
 * Every plugin root a save must exclude, sorted, with build-only tooling removed.
 *
 * A config that cannot be read answers with an empty list and a warning rather than an
 * exception: this runs inside `scripts/build-launcher.mjs`, and a checkout still has to be
 * able to build the launcher (the bundle then keeps its committed fallback list, which the
 * engine-store parity test in `legacy-saver.test.ts` polices).
 *
 * `root` and `configPath` exist for the unit test, which builds a fixture rather than reading
 * this repository.
 */
export function collectDefaultPlugins(options = {}) {
  const root = options.root ?? REPO_ROOT;
  const configPath = options.configPath ?? defaultConfigPath(root);

  let configured = [];
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    if (Array.isArray(config.plugins)) configured = config.plugins.filter((p) => typeof p === 'string');
  } catch {
    console.warn(
      `Could not read a build config at ${configPath}; the launcher build keeps its committed fallback list.`
    );
    return [];
  }

  const found = [
    ...configured,
    ...rootsFromJsonTiddlers(join(root, 'wiki', 'tiddlers')),
    ...rootsFromEngineArtifact(join(root, 'src', 'lithic.html'))
  ];
  return [...new Set(found)].filter((name) => !BUILD_ONLY.has(name)).sort();
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const plugins = collectDefaultPlugins();
  if (plugins.length === 0) {
    console.warn(
      `No plugins found in ${defaultConfigPath()}; the launcher build keeps its committed fallback list.`
    );
  }
  console.log(JSON.stringify(plugins));
}
