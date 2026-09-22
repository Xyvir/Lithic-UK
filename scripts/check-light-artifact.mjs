#!/usr/bin/env node
/**
 * Guard for the committed light distribution (src/lithic-light.html).
 *
 * The light artifact is built from lithic-light-tw.info — the same core and the
 * same plugin sources as the full artifact, minus the heavy optional layer — and
 * it is the file that gets flashed onto a small host. Both of those facts rot
 * silently if nothing checks them, which is exactly what happened to the manually
 * built copy this replaces: it sat on core 5.3.8 while the full artifact moved to
 * 5.4.1, carrying two plugins that had since been renamed.
 *
 * So this reads the two committed artifacts (no build, no browser) and asserts:
 *
 *   1. every tiddler light ships is also in the full artifact (renames, removals
 *      and strays all show up here, not just plugin-level differences)
 *   2. every plugin and theme root light has also exists in full, same version
 *   3. the core versions agree
 *   4. light ships xyvir/lithic-save but not the uglify toolchain it purges
 *   5. the mermaid-rendered Pyramid sidebar is in full and not in light
 *   6. light carries no editor state ($:/temp, $:/state/popup)
 *   7. light is still small enough to be worth flashing
 *
 * Exit 0 = consistent; nonzero (with a reason) = rebuild light before pushing.
 * Usage: node scripts/check-light-artifact.mjs
 */
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import process from 'node:process';

// The committed artifact by default; pass a path to check a candidate before it is
// committed (CI checks the fresh build with greps instead, since it has no full
// artifact to hand at that point).
const LIGHT = process.argv[2] ?? 'src/lithic-light.html';
const FULL = 'src/lithic.html';
const STORE_TAG = '<script class="tiddlywiki-tiddler-store" type="application/json">';
/** The raw ceiling is a drift alarm; the gzipped one is the real flash budget. */
const MAX_RAW_BYTES = 4_000_000;
const MAX_GZIP_BYTES = 1_048_576;

function fail(message) {
  console.error(`\ncheck-light-artifact: ${message}\n`);
  process.exit(1);
}

/**
 * A rendered Lithic artifact stores one packed JSON tiddler per plugin, so its
 * tiddlers live on two levels: the plugin roots sit in the store, and each root's
 * `text` is the plugin's own `{tiddlers: {...}}` payload. Both levels are read,
 * because "is this tiddler in the artifact" has to mean the real one.
 */
function readArtifact(file) {
  let html;
  try {
    html = readFileSync(file, 'utf8');
  } catch {
    fail(`${file} is missing — it is committed alongside src/lithic.html.`);
  }
  // The store is the last such tag in the document; earlier occurrences are the
  // saver's own template source, escaped inside the core module text.
  const start = html.lastIndexOf(STORE_TAG);
  const end = html.indexOf('</script>', start);
  if (start < 0 || end < 0) fail(`${file} has no tiddler store — is it a rendered single-file wiki?`);

  let stored;
  try {
    stored = JSON.parse(html.slice(start + STORE_TAG.length, end).trim());
  } catch (error) {
    fail(`${file}'s tiddler store does not parse: ${error.message}`);
  }

  const roots = new Map();
  const tiddlers = new Map();
  const storeTitles = new Set();
  for (const tiddler of stored) {
    storeTitles.add(tiddler.title);
    tiddlers.set(tiddler.title, tiddler);
    if (/^\$:\/(plugins|themes)\/[^/]+\/[^/]+$/.test(tiddler.title)) roots.set(tiddler.title, tiddler.version);
    if (tiddler.type !== 'application/json' || typeof tiddler.text !== 'string') continue;
    let packed;
    try {
      packed = JSON.parse(tiddler.text);
    } catch {
      continue;
    }
    for (const title of Object.keys(packed.tiddlers ?? {})) tiddlers.set(title, { title, plugin: tiddler.title });
  }

  return {
    bytes: statSync(file).size,
    gzipped: gzipSync(readFileSync(file), { level: 9 }).length,
    roots,
    tiddlers,
    storeTitles,
  };
}

const light = readArtifact(LIGHT);
const full = readArtifact(FULL);
const name = (title) => title.replace(/^\$:\/(plugins|themes)\//, '');
const problems = [];

// 1. Tiddler-level subset: catches a rename, or a plugin that gained a tiddler the
//    full artifact does not have, without needing a build on the light side.
const strays = [...light.tiddlers.keys()].filter((title) => !full.tiddlers.has(title)).sort();
if (strays.length > 0) {
  problems.push(
    `light ships ${strays.length} tiddler(s) the full artifact does not have: ${strays.slice(0, 5).join(', ')}` +
      `${strays.length > 5 ? `, +${strays.length - 5} more` : ''}`
  );
}

// 2. Plugin and theme roots, with versions — the "light went stale" signal.
for (const [title, version] of light.roots) {
  if (!full.roots.has(title)) {
    problems.push(`${name(title)} is in light but not in the full artifact (renamed, or added to the light set by mistake)`);
    continue;
  }
  if (version !== full.roots.get(title)) {
    problems.push(`${name(title)} is v${version} in light but v${full.roots.get(title)} in full (light is stale)`);
  }
}

// 3. Core parity, the specific drift the hand-built artifact had.
const core = (artifact) => artifact.tiddlers.get('$:/core')?.version;
if (core(light) !== core(full)) problems.push(`core differs: light is ${core(light)}, full is ${core(full)}`);

// 4. lithic-save is what strips the build toolchain out of the rendered file;
//    without it in the light set, the uglify plugin ships to a device with no room.
if (!light.roots.has('$:/plugins/xyvir/lithic-save')) {
  problems.push('light is missing $:/plugins/xyvir/lithic-save (its save/all override purges the uglify toolchain)');
}
if (light.roots.has('$:/plugins/flibbles/uglify')) {
  problems.push('light ships $:/plugins/flibbles/uglify — the build toolchain leaked past the publish override');
}

// 5. The Pyramid sidebar renders the active stream node through <$mermaid>, so it
//    lives in the mermaid-dependent plugin. Light has no mermaid: no view. Full
//    must still have it, or the move deleted a feature instead of relocating it.
const PYRAMID = '$:/lithic/ui/SideBar/Pyramid';
if (light.tiddlers.has(PYRAMID)) {
  problems.push('light ships the Pyramid sidebar, whose <$mermaid> widget comes from a plugin light does not include');
}
if (!full.tiddlers.has(PYRAMID)) {
  problems.push('the full artifact has no Pyramid sidebar — the mermaid-coupled view was dropped rather than relocated');
}

// 6. Saving from a browser carries editor state along; a build must not.
//
// Measured at the store level on purpose: a rendered build does keep a handful of
// swept $:/temp and $:/state/popup titles inside its packed $:/core payload, in
// both artifacts alike, so their presence there says nothing. What distinguishes
// the hand-built artifact this guard exists for is that it carried them as
// *top-level* store tiddlers — that is the shape a browser save produces.
const junk = [...light.storeTitles].filter((title) => /^\$:\/temp\/|^\$:\/state\/popup\//.test(title));
if (junk.length > 0) problems.push(`light carries editor state: ${junk.join(', ')} (it was saved from a browser, not built)`);

// 7. Budget.
const sizes = `${(light.bytes / 1048576).toFixed(2)} MB raw / ${(light.gzipped / 1048576).toFixed(2)} MB gzipped (full: ${(
  full.bytes / 1048576
).toFixed(2)} MB)`;
if (light.bytes >= MAX_RAW_BYTES) problems.push(`light is ${light.bytes} bytes — past the ${MAX_RAW_BYTES} byte drift ceiling`);
if (light.gzipped >= MAX_GZIP_BYTES) problems.push(`light gzips to ${light.gzipped} bytes — over the ${MAX_GZIP_BYTES} byte flash budget`);

if (problems.length > 0) {
  fail(
    `the light artifact disagrees with the full one:\n  - ${problems.join('\n  - ')}\n\n` +
      'Rebuild it: npm run build:light (or workflow_dispatch build-wiki.yml with build_config=light).'
  );
}

console.log(
  `light artifact OK — ${light.roots.size} plugins/themes, ${light.tiddlers.size} tiddlers, core ${core(light)}, ${sizes}`
);
