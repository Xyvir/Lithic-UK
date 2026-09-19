import { spawn } from 'node:child_process';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('launcher-ui');
const viteBin = resolve(root, 'node_modules/vite/bin/vite.js');
const outputDir = resolve('src');
const generatedHtml = resolve(outputDir, 'index.html');
const generatedJs = resolve(outputDir, 'launcher.js');
const generatedCss = resolve(outputDir, 'launcher.css');
// ONE artifact. The legacy launcher was moved to assets/legacy-launcher.html
// and this is the only launcher we emit; there is no historical-name alias and
// no preview-only engine sibling. The TiddlyWiki engine already lives beside
// it as src/lithic.html, which is the sibling the runtime resolves first.
const destination = resolve(outputDir, 'launcher.html');

await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn(process.execPath, [viteBin, 'build', '--config', 'vite.config.ts'], {
    cwd: root,
    stdio: 'inherit',
    shell: false
  });
  child.on('error', rejectBuild);
  child.on('exit', (code) => {
    if (code === 0) resolveBuild();
    else rejectBuild(new Error(`Vite exited with code ${code}`));
  });
});

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
  .replace(/<script type="module"[^>]*src="[^"]+"><\/script>/g, () => `<script type="module">${js}</script>`)
  .replace(/<script type="module"[^>]*><\/script>/g, () => `<script type="module">${js}</script>`);

await writeFile(destination, html);
await Promise.all([rm(generatedHtml, { force: true }), rm(generatedJs, { force: true }), rm(generatedCss, { force: true })]);
console.log(`Wrote ${destination}`);
