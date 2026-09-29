import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

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
// Where the assembled artifact lands. It defaults to the published path, and the
// override exists for tooling that needs a *scratch* build: the HTML at
// `src/launcher.html` is published (deploy/autoupdate.sh fetches it at runtime,
// deploy/Dockerfile copies it) and is CI-only (see agents.md), so anything that
// wants to look at unreleased UI should build somewhere else entirely rather than
// leave a hand-built copy sitting at the path that ships.
//
// `--locale=es` is the other half of a scratch build: it pins the language the artifact
// speaks, which is the only way to hold one everywhere, since a query string is lost to a
// bookmark, an installed app and an offline cache. It is the same pin the build itself
// reads (`VITE_LAUNCHER_LOCALE`), set for the child rather than left to the environment.
// A locale that is meant to be committed into `src/launcher.html` belongs in
// `launcher-ui/.env` instead, which CI and the artifact freshness gate both read: a flag
// only a person remembers to pass would put the gate and the artifact out of step for ever.
const argv = process.argv.slice(2);
const localeFlag = argv.find((arg) => arg.startsWith('--locale='));
const locale = (localeFlag ? localeFlag.slice('--locale='.length) : process.env.VITE_LAUNCHER_LOCALE)?.trim();
const destination = resolve(
  argv.find((arg) => !arg.startsWith('--')) ?? process.env.LAUNCHER_OUT ?? resolve(outputDir, 'launcher.html')
);

await new Promise((resolveBuild, rejectBuild) => {
  const child = spawn(process.execPath, [viteBin, 'build', '--config', 'vite.config.ts'], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    env: { ...process.env, ...(locale ? { VITE_LAUNCHER_LOCALE: locale } : {}) }
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

await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, html);
await Promise.all([rm(generatedHtml, { force: true }), rm(generatedJs, { force: true }), rm(generatedCss, { force: true })]);
console.log(`Wrote ${destination}${locale ? ` (locale ${locale})` : ''}`);
