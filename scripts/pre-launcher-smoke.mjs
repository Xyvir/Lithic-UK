import { readFile } from 'node:fs/promises';

const path = process.argv[2] || 'src/pre-launcher.html';
const html = await readFile(path, 'utf8');

const enginePath = path.replace(/pre-launcher\.html$/, 'pre-launcher-engine.html');
const engine = await readFile(enginePath, 'utf8');

const checks = [
  ['document doctype', /^<!doctype html>/i.test(html)],
  ['app mount point', /<div id="app"><\/div>/i.test(html)],
  ['inline module script', /<script type="module">/i.test(html)],
  ['no Vite source script', !/<script type="module"[^>]+src=/i.test(html)],
  ['no escaped script markup', !/&lt;script/i.test(html)],
  ['Svelte bundle content', /createElement|mount\(/.test(html)],
  ['preview engine exists', engine.length > 1000],
  ['engine has TiddlyWiki store', /tiddlywiki-tiddler-store/.test(engine)]
];

const failed = checks.filter(([, passed]) => !passed);
for (const [name, passed] of checks) console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
if (failed.length) process.exit(1);
