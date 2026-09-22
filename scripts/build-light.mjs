#!/usr/bin/env node
/**
 * Build the light distribution locally, the same way CI does.
 *
 *   npm run build:light
 *
 * Steps, in order: flatten the mirrored plugin sources into the build staging
 * dirs, write wiki/tiddlywiki.info from lithic-light-tw.info, render
 * wiki/output/lithic-light.html through $:/core/save/all with --uglify, brand it,
 * copy it over the committed src/lithic-light.html, and run the guard that checks
 * it against the full artifact.
 *
 * Needs the mirrored sources to be present (npm run mirror) — this script does not
 * hit the network. CI does that step itself before running the equivalent
 * commands, so the artifact this produces is the artifact CI would commit.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { gzipSync } from 'node:zlib';

const repoRoot = process.cwd();
const OUTPUT = path.join(repoRoot, 'wiki', 'output', 'lithic-light.html');
const COMMITTED = path.join(repoRoot, 'src', 'lithic-light.html');

function step(name, args) {
  process.stdout.write(`> ${name.padEnd(30, ' ')}`);
  const result = spawnSync(process.execPath, args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  const out = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  if (result.status !== 0) {
    console.log('FAILED');
    console.error(out.split('\n').slice(-12).join('\n'));
    process.exit(1);
  }
  console.log('ok');
  return out;
}

if (!existsSync(path.join(repoRoot, 'wiki', 'external'))) {
  console.error('wiki/external is missing — run `npm run mirror` first (it needs network).');
  process.exit(1);
}
if (!existsSync(path.join(repoRoot, 'node_modules', 'tiddlywiki', 'tiddlywiki.js'))) {
  console.error('node_modules/tiddlywiki is missing — run `npm ci` first.');
  process.exit(1);
}

step('flatten plugins', [path.join('scripts', 'flatten-plugins.js')]);
step('write wiki/tiddlywiki.info', [path.join('scripts', 'generate-config.js'), 'light']);

process.stdout.write(`> ${'render with --uglify'.padEnd(30, ' ')}`);
const render = spawnSync(
  process.execPath,
  [path.join('node_modules', 'tiddlywiki', 'tiddlywiki.js'), 'wiki', '--uglify', '--build', 'light'],
  {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: {
      ...process.env,
      TIDDLYWIKI_PLUGIN_PATH: `${path.join(repoRoot, 'wiki')}${path.delimiter}${path.join(repoRoot, 'wiki', 'plugins')}`,
      TIDDLYWIKI_THEME_PATH: path.join(repoRoot, 'wiki', 'themes'),
    },
  }
);
if (render.status !== 0 || !existsSync(OUTPUT)) {
  console.log('FAILED');
  console.error(`${render.stdout ?? ''}${render.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n'));
  process.exit(1);
}
console.log('ok');

// Same branding CI applies to the published artifact.
const branded = readFileSync(OUTPUT, 'utf8').replace(/content="TiddlyWiki"/g, 'content="Lithic PKMS"');
writeFileSync(OUTPUT, branded);
copyFileSync(OUTPUT, COMMITTED);
const gz = gzipSync(Buffer.from(branded), { level: 9 }).length;
console.log(
  `\nsrc/lithic-light.html: ${(statSync(COMMITTED).size / 1048576).toFixed(2)} MB raw / ${(gz / 1048576).toFixed(2)} MB gzipped`
);

step('check light artifact', [path.join('scripts', 'check-light-artifact.mjs')]);
