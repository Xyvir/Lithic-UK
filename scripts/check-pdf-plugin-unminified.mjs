/**
 * Does the built artifact ship the PDF import plugin's JavaScript unmodified?
 *
 * Why this exists: the prod build runs the flibbles/uglify pass. The import handler
 * carries its own pdfjs-dist build, which is *already* minified by terser, and
 * re-minifying it produced blank white pages on every imported PDF page from
 * build-2026.09.16-1658 onward while the import still reported success. The fix is
 * an entry in $:/config/flibbles/uglify/blacklist (xyvir/lithic-default-configs)
 * that keeps the three tiddlers out of that pass.
 *
 * A blacklist entry is matched by exact title, so this check is the thing that
 * notices when it stops matching: a renamed tiddler, a lost config tiddler, or a
 * changed uglify setting all put the minifier back on the plugin, and the symptom
 * is visual rather than an error. The artifact's text must equal the tracked
 * source's body (line endings normalized).
 *
 * scripts/test-pdf-import-artifact.mjs is the behavioural half: it drops a real PDF
 * on the artifact and measures the ink on every rendered page.
 *
 * Usage:
 *   node scripts/check-pdf-plugin-unminified.mjs                     # checks src/lithic.html
 *   node scripts/check-pdf-plugin-unminified.mjs wiki/output/index.html
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = path.resolve(repoRoot, process.argv[2] || 'src/lithic.html');
const pluginSource = path.join(repoRoot, 'wiki/local-plugins/lithic-import-handler');
const blacklistSource = path.join(
  repoRoot,
  'wiki/local-plugins/lithic-default-configs/$__config_flibbles_uglify_blacklist.tiddlywiki.tid'
);

const PLUGIN_ROOT = '$:/plugins/xyvir/lithic-import-handler';
const toLf = (text) => text.replace(/\r\n/g, '\n');

/** Splits a .tid file into its fields and its body. */
function parseTid(text) {
  const lf = toLf(text);
  // A tiddler with no body (a plain config value, say) is fields only.
  const split = lf.indexOf('\n\n');
  const fields = Object.fromEntries(
    (split === -1 ? lf : lf.slice(0, split)).split('\n').filter(Boolean).map((line) => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    })
  );
  return { fields, body: split === -1 ? '' : lf.slice(split + 2) };
}

const sources = readdirSync(pluginSource)
  .filter((name) => name.endsWith('.tid'))
  .map((name) => parseTid(readFileSync(path.join(pluginSource, name), 'utf8')))
  .map(({ fields, body }) => ({ title: fields.title, body }));

assert.ok(existsSync(blacklistSource), `the uglify blacklist tiddler is missing: ${path.relative(repoRoot, blacklistSource)}`);
assert.ok(existsSync(artifact), `no artifact at ${artifact}`);
const blacklist = parseTid(readFileSync(blacklistSource, 'utf8')).fields.text;

assert.ok(existsSync(artifact), `no artifact at ${artifact}`);
const html = readFileSync(artifact, 'utf8');
const storeMatch = /<script class="tiddlywiki-tiddler-store" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
assert.ok(storeMatch, `${path.basename(artifact)} carries no tiddler store`);

const pluginEntry = JSON.parse(storeMatch[1]).find((tiddler) => tiddler.title === PLUGIN_ROOT);
if (!pluginEntry) {
  // Lithic Light leaves the import handler out on purpose; there is nothing to check.
  console.log(`${path.relative(repoRoot, artifact)} has no ${PLUGIN_ROOT}: nothing to check.`);
  process.exit(0);
}
const bundled = JSON.parse(pluginEntry.text).tiddlers;

const problems = [];
for (const { title, body } of sources) {
  const shipped = bundled[title];
  if (!shipped) {
    problems.push(`${title} is not in the plugin bundle at all`);
    continue;
  }
  const shippedText = toLf(shipped.text || '');
  const intact = shippedText === body;
  console.log(
    `  ${intact ? 'intact  ' : 'REWRITTEN'}  source ${String(body.length).padStart(8)}  artifact ${String(shippedText.length).padStart(8)}  ${title}`
  );
  if (!intact) problems.push(`${title} does not match its source (${body.length} chars in source, ${shippedText.length} in the artifact)`);
  if (!blacklist.includes(`[[${title}]]`)) {
    problems.push(`$:/config/flibbles/uglify/blacklist does not name ${title}`);
  }
}

if (problems.length) {
  console.error(
    `\nFAIL: the uglify pass rewrote the PDF import plugin, which is how imported PDF pages went white:\n  * ` +
      problems.join('\n  * ') +
      `\nCheck that $:/config/flibbles/uglify/blacklist names every shipped title in ${path.relative(repoRoot, pluginSource)}.\n`
  );
  process.exit(1);
}

console.log(`PASS: ${sources.length} PDF import tiddlers ship exactly as written in ${path.relative(repoRoot, artifact)}`);
