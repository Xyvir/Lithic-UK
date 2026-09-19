#!/usr/bin/env node
/**
 * Launcher artifact freshness gate.
 *
 * Since the 2026-09-18 cutover, `src/launcher.html` is GENERATED — it is the
 * Svelte launcher build (`scripts/build-launcher.mjs`) — but it is still
 * COMMITTED, because `deploy/autoupdate.sh`, `deploy/Dockerfile`,
 * `build-server.yml`, `manifest.json` and `index.html` all reference it by that
 * name. That combination makes a silent failure mode possible: edit
 * `launcher-ui/src/**`, forget to rebuild, and every deployed instance keeps
 * serving the previous launcher until someone notices by hand.
 *
 * This gate rebuilds and compares against the committed bytes, failing loudly
 * on a mismatch. The fresh build is deliberately left in the working tree so
 * the fix is a plain `git add`.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const artifact = path.join(repoRoot, 'src', 'launcher.html');

let committed;
try {
  committed = readFileSync(artifact, 'utf8');
} catch {
  console.error('FAIL — src/launcher.html is missing. Run: npm run build:launcher');
  process.exit(1);
}

const build = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-launcher.mjs')], {
  cwd: repoRoot,
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf8',
});

if (build.status !== 0) {
  const tail = `${build.stdout ?? ''}${build.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n  ');
  console.error('FAIL — the launcher build itself failed:');
  console.error('  ' + tail);
  process.exit(1);
}

if (readFileSync(artifact, 'utf8') === committed) {
  console.log('OK — committed src/launcher.html matches a fresh build.');
  process.exit(0);
}

console.error('FAIL — src/launcher.html is STALE: the committed bytes differ from a fresh build.');
console.error('  The working tree now holds the fresh build, so commit it:');
console.error('    git add src/launcher.html && git commit');
console.error('  (The server image, autoupdate.sh and the PWA manifest all ship this file by name,');
console.error('   so a stale artifact silently ships the previous launcher.)');
process.exit(1);
