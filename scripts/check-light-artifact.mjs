#!/usr/bin/env node
/**
 * Guard for the committed light distribution (src/lithic-light.html).
 *
 * The light artifact is built from lithic-light-tw.info — the same core and the
 * same plugin sources as the full artifact, minus the heavy optional layer — and
 * it is the file that gets flashed onto a small host. Both of those facts rot
 * silently if nothing checks them, which is exactly what happened to the manually
 * built copy it replaces: it sat in the repo on core 5.3.8 while the full artifact
 * moved to 5.4.1, carrying two plugins that had since been renamed.
 *
 * So this reads the two committed artifacts (no build, no browser) and asserts:
 *
 *   1. every plugin and theme in light is also in full, at the same version
 *   2. the core versions agree
 *   3. light ships xyvir/lithic-save but not the uglify toolchain it purges
 *   4. light carries no editor state ($:/temp, $:/state/popup)
 *   5. light is still small enough to be worth flashing
 *
 * Exit 0 = consistent; nonzero (with a reason) = rebuild light before pushing.
 * Usage: node scripts/check-light-artifact.mjs
 */
import { readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import process from 'node:process';

const LIGHT = 'src/lithic-light.html';
const FULL = 'src/lithic.html';
const STORE_TAG = '<script class="tiddlywiki-tiddler-store" type="application/json">';
/** The raw ceiling is a drift alarm; the gzipped one is the real flash budget. */
const MAX_RAW_BYTES = 4_000_000;
const MAX_GZIP_BYTES = 1_048_576;

function fail(message) {
  console.error(`\ncheck-light-artifact: ${message}\n`);
  process.exit(1);
}

function readStore(file) {
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
  try {
    const tiddlers = JSON.parse(html.slice(start + STORE_TAG.length, end).trim());
    return { bytes: statSync(file).size, tiddlers, byTitle: new Map(tiddlers.map((t) => [t.title, t])) };
  } catch (error) {
    fail(`${file}'s tiddler store does not parse: ${error.message}`);
  }
}

const light = readStore(LIGHT);
const full = readStore(FULL);

const root = (title) => title.replace(/^\$:\/(plugins|themes)\//, '');
/** Plugin and theme roots only: modules and ordinary tiddlers are not inventory. */
const roots = (store) =>
  [...store.byTitle.keys()].filter((title) => /^\$:\/(plugins|themes)\/[^/]+\/[^/]+$/.test(title)).sort();

const problems = [];

for (const title of roots(light)) {
  const twin = full.byTitle.get(title);
  if (!twin) {
    problems.push(`${root(title)} is in light but not in the full artifact (renamed, or added to the light set by mistake)`);
    continue;
  }
  const [a, b] = [light.byTitle.get(title).version, twin.version];
  if (a !== b) problems.push(`${root(title)} is v${a} in light but v${b} in full (light is stale)`);
}

if (light.byTitle.get('$:/core')?.version !== full.byTitle.get('$:/core')?.version) {
  problems.push(
    `core differs: light is ${light.byTitle.get('$:/core')?.version}, full is ${full.byTitle.get('$:/core')?.version}`
  );
}

// lithic-save is what strips the build toolchain out of the rendered file; without
// it in the light set, the uglify plugin ships to a device with no room for it.
if (!light.byTitle.has('$:/plugins/xyvir/lithic-save')) {
  problems.push('light is missing $:/plugins/xyvir/lithic-save (its save/all override purges the uglify toolchain)');
}
if (light.byTitle.has('$:/plugins/flibbles/uglify')) {
  problems.push('light ships $:/plugins/flibbles/uglify — the build toolchain leaked past the publish override');
}

const junk = [...light.byTitle.keys()].filter((title) => /^\$:\/temp\/|^\$:\/state\/popup\//.test(title));
if (junk.length > 0) problems.push(`light carries editor state: ${junk.join(', ')} (it was saved from a browser, not built)`);

const gzipped = gzipSync(readFileSync(LIGHT), { level: 9 }).length;
const sizes = `${(light.bytes / 1048576).toFixed(2)} MB raw / ${(gzipped / 1048576).toFixed(2)} MB gzipped (full: ${(
  full.bytes / 1048576
).toFixed(2)} MB)`;
if (light.bytes >= MAX_RAW_BYTES) problems.push(`light is ${light.bytes} bytes — past the ${MAX_RAW_BYTES} byte drift ceiling`);
if (gzipped >= MAX_GZIP_BYTES) problems.push(`light gzips to ${gzipped} bytes — over the ${MAX_GZIP_BYTES} byte flash budget`);

if (problems.length > 0) {
  fail(`the light artifact disagrees with the full one:\n  - ${problems.join('\n  - ')}\n\nRebuild it: npm run build:light (or workflow_dispatch build-wiki.yml with build_config=light).`);
}

console.log(
  `light artifact OK — ${roots(light).length} plugins/themes, core ${light.byTitle.get('$:/core').version}, ${sizes}`
);
