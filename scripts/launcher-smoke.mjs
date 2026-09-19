import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const path = process.argv[2] || 'src/launcher.html';
const html = await readFile(path, 'utf8');

// The engine is the tracked src/lithic.html sibling — the launcher build no
// longer emits a copy of it, so check the file the runtime actually resolves.
const enginePath = resolve(dirname(path), 'lithic.html');
const engine = await readFile(enginePath, 'utf8');

const checks = [
  ['document doctype', /^<!doctype html>/i.test(html)],
  ['app mount point', /<div id="app"><\/div>/i.test(html)],
  ['inline module script', /<script type="module">/i.test(html)],
  ['no Vite source script', !/<script type="module"[^>]+src=/i.test(html)],
  ['no escaped script markup', !/&lt;script/i.test(html)],
  ['Svelte bundle content', /createElement|mount\(/.test(html)],
  ['sibling engine exists', engine.length > 1000],
  ['engine has TiddlyWiki store', /tiddlywiki-tiddler-store/.test(engine)]
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
