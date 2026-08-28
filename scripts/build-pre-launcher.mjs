import { build } from 'vite';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('launcher-ui');
const outputDir = resolve('src');
const generatedHtml = resolve(outputDir, 'index.html');
const generatedJs = resolve(outputDir, 'pre-launcher.js');
const generatedCss = resolve(outputDir, 'pre-launcher.css');
const destination = resolve(outputDir, 'pre-launcher.html');

await build({ root, configFile: resolve(root, 'vite.config.ts') });

let html = await readFile(generatedHtml, 'utf8');
const js = await readFile(generatedJs, 'utf8');
let css = '';
try {
  css = await readFile(generatedCss, 'utf8');
} catch {
  // CSS may be absent if the entry is changed to use component styles only.
}

html = html
  .replace(/<link rel="stylesheet"[^>]*>/g, css ? `<style>${css}</style>` : '')
  .replace(/<script type="module"[^>]*><\/script>/g, `<script>${js}</script>`)
  .replace(/<script type="module"[^>]*src="[^"]+"><\/script>/g, `<script>${js}</script>`);

await writeFile(destination, html);
await Promise.all([rm(generatedHtml, { force: true }), rm(generatedJs, { force: true }), rm(generatedCss, { force: true })]);
console.log(`Wrote ${destination}`);
