#!/usr/bin/env node
/**
 * Writes the light export filter tiddler, generated from lithic-light-tw.info.
 *
 *   node scripts/generate-light-filter.mjs           write the tiddler
 *   node scripts/generate-light-filter.mjs --check   fail if the tracked tiddler is stale
 *
 * The light distribution is defined once, in lithic-light-tw.info. A wiki built by
 * prod carries this tiddler, which is an export filter selecting exactly the
 * tiddlers a light build would carry (every tiddler except the plugins prod has
 * and light does not). So a Lithic wiki, standalone or paired with the launcher, can export its
 * own light copy on the fly, and the flasher never has to package one.
 *
 * The filter is written from the definition rather than by hand, so the two cannot
 * drift: adding a plugin to light or removing one changes the next generated file.
 * It is a tracked file under wiki/local-plugins/lithic-tweaks, not a build output,
 * because prod loads its plugins from there.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const LIGHT_INFO = path.join(repoRoot, 'lithic-light-tw.info');
const PROD_INFO = path.join(repoRoot, 'prod-tiddlywiki.info');
const OUTPUT = path.join(repoRoot, 'wiki', 'local-plugins', 'lithic-tweaks', '$__config_TiddlyTools_Filters_Lithic Light.tid');
const TITLE = '$:/config/TiddlyTools/Filters/Lithic Light';

const CHECK = process.argv.includes('--check');

function fail(message) {
  console.error(`generate-light-filter: ${message}`);
  process.exit(1);
}

function readInfo(file) {
  if (!existsSync(file)) fail(`${path.basename(file)} is missing.`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

// Build the filter string. Plugins that prod carries and light does not are removed
// by title, so the filter selects everything else the light build would hold.
const light = readInfo(LIGHT_INFO);
const prod = readInfo(PROD_INFO);
if (!Array.isArray(light.plugins) || light.plugins.length === 0) fail('lithic-light-tw.info lists no plugins.');

const lightPlugins = new Set(light.plugins);
const droppedPlugins = (prod.plugins || []).filter((p) => !lightPlugins.has(p));
const droppedThemes = (prod.themes || []).filter((t) => !new Set(light.themes || []).has(t));

const excludes = [
  ...droppedPlugins.map((p) => `-[[$:/plugins/${p}]]`),
  ...droppedThemes.map((t) => `-[[$:/themes/${t}]]`),
];

const filter = ['[all[]]', ...excludes].join(' ');

const body = [
  `description: Lithic Light export (generated from lithic-light-tw.info)`,
  `filter: ${filter}`,
  `tags: $:/tags/Filter`,
  `title: ${TITLE}`,
  '',
].join('\r\n');

const contents = body.replace(/\r\n$/, '');

if (CHECK) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8').replace(/\r\n$/, '') : null;
  if (current !== contents) {
    fail(`${path.relative(repoRoot, OUTPUT)} is stale. Run: node scripts/generate-light-filter.mjs`);
  }
  console.log(`generate-light-filter: ok (${droppedPlugins.length} plugins and ${droppedThemes.length} themes excluded)`);
  process.exit(0);
}

writeFileSync(OUTPUT, contents);
console.log(`generate-light-filter: wrote ${path.relative(repoRoot, OUTPUT)}`);
