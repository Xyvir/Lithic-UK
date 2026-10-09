/**
 * The gallery as a pull request body.
 *
 * The release opens a pull request instead of pushing to main, so the deck has to
 * survive the trip to GitHub: the review happens on the pull request, and the
 * pictures have to be in it rather than on a runner nobody looks at. Nothing in
 * this file draws anything — it reads what `ui-gallery.mjs` wrote (`sheets.json`
 * and `modal-coverage.md`) and composes the markdown GitHub will render.
 *
 * The sheets are referenced by absolute URL rather than attached, because the
 * deck's own directory is gitignored on purpose: 18 MB of PNGs is not a thing to
 * put in the history of the branch being reviewed. So the pipeline force-pushes
 * them to a branch of their own and points `--base` at it, which keeps `main`
 * clean and still puts the sheet inline, at full size, in the description.
 *
 * A run whose deck never drew anything is a case this has to state rather than
 * fall over on: the artifacts in the pull request are unaffected by the deck, so
 * a missing `sheets.json` is news about the gallery and not about the build, and
 * the body says so instead of the pull request never opening.
 *
 *   node scripts/gallery-pr-body.mjs \
 *     --sheets ui-gallery/sheets.json \
 *     --coverage ui-gallery/modal-coverage.md \
 *     --base https://raw.githubusercontent.com/OWNER/REPO/deck/STAMP \
 *     --out ui-gallery/pr-body.md
 */

import { readFile, writeFile } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';

function arg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
}

/**
 * The artifact as it is worth naming in a description. `ui-gallery.mjs` resolves it
 * absolutely, which is right for a run on one machine and wrong for a reader on GitHub:
 * `/home/runner/work/...` names a directory in a container that no longer exists, and a
 * Windows checkout names one that never existed. Relative to the repository it is the one
 * form that says which file was photographed wherever the body is read.
 */
function artifactLabel(artifact) {
  if (!artifact) return 'unknown';
  const rel = isAbsolute(artifact) ? relative(process.cwd(), artifact) : artifact;
  return rel.startsWith('..') ? artifact : rel.split('\\').join('/');
}

/** A file we can live without, as `null` rather than an exception. */
async function optional(path) {
  if (!path) return null;
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

const sheetsPath = arg('sheets', 'ui-gallery/sheets.json');
const coveragePath = arg('coverage', 'ui-gallery/modal-coverage.md');
const base = (arg('base', '') ?? '').replace(/\/+$/, '');
const out = arg('out', 'ui-gallery/pr-body.md');
const runUrl = arg('run-url', '');
const stamp = arg('stamp', '');

const deck = JSON.parse((await optional(sheetsPath)) ?? 'null');
const lines = ['## Launcher UI gallery', ''];

if (deck === null || deck.sheets.length === 0) {
  lines.push(
    'The deck drew no sheets, so there are no pictures on this pull request.',
    '',
    'That is a fact about the gallery, not about the build: the artifacts in this pull',
    'request are the ones it was opened to publish, and they are unaffected.',
    ...(runUrl ? ['', `Look at ${runUrl} for what the deck failed on.`, ''] : [''])
  );
} else {
  const panes = deck.sheets.reduce((total, sheet) => total + sheet.panes.length, 0);
  lines.push(
    `${panes} panes across ${deck.sheets.length} sheets, shot from the launcher this pull request proposes.`,
    '',
    `Artifact: \`${artifactLabel(deck.artifact)}\``,
    '',
    '| # | sheet | panes |',
    '| --- | --- | --- |'
  );
  deck.sheets.forEach((sheet, index) => {
    const link = base ? `[${sheet.title}](${base}/${sheet.file})` : sheet.title;
    lines.push(`| ${index + 1} | ${link} | ${sheet.panes.length} |`);
  });
  lines.push('');
  if (base) {
    deck.sheets.forEach((sheet, index) => {
      lines.push(`### ${index + 1}. ${sheet.title}`, '', `![${sheet.title}](${base}/${sheet.file})`, '');
    });
  } else {
    lines.push(
      'The sheets were not published to a branch for this run, so this body cannot show them.',
      ''
    );
  }
  const coverage = await optional(coveragePath);
  if (coverage) {
    lines.push('<details>', '<summary>Dialog and window coverage</summary>', '', coverage.trim(), '', '</details>', '');
  }
}

lines.push(
  '---',
  '',
  'Merging this pull request tags and publishes the release, and starts the desktop and',
  'server builds. Closing it publishes nothing.'
);
if (stamp) lines.push('', `Build stamp: \`${stamp}\``);

await writeFile(out, `${lines.join('\n')}\n`, 'utf8');
console.log(`Body: ${out} (${deck === null ? 'no deck' : `${deck.sheets.length} sheets`})`);
