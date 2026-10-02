#!/usr/bin/env node
/**
 * The copy gate: no em dash and no en dash anywhere in the launcher's sources, or the shim's.
 *
 * The rule is the "In-App Copy: Terse, Non-Technical, No Em Dashes" section of `agents.md` — "No em dashes or en dashes. Use a
 * period, or rewrite." — and the reason it needs a gate rather than a reviewer is that the
 * offenders are never in one place: a modal's subtitle, a tooltip, a confirmation body, a
 * `title` a screen reader reads. Every one of them was added mid-sentence by an agent,
 * because a dash is what English prose wants there.
 *
 * The scan is absolute: every file under `launcher-ui/src`, `launcher-ui/index.html` and
 * `shim/src`, no exemption list, no build. The shim is in here because its copy is read in the
 * same read-aloud places: a line printed when the port is taken, and the desktop entry the
 * AppImage installs into a menu. An earlier version of this gate scanned the built artifact
 * instead, on the theory that the build strips JS and CSS comments, so any dash left in
 * `src/launcher.html` was shipped copy. That theory was wrong twice. The engine plumbing the
 * launcher inlines into a wiki is a string, so the comments inside it are shipped, and the
 * artifact was carrying eight of those; and comments are where a dash starts anyway, because
 * the sentence around one is the sentence somebody is editing. So the sweep took the dashes
 * out of the comments too, and the gate can simply read the source.
 *
 * The one thing that cannot spell the character is `offline-mode.test.ts`, which exists to
 * assert it is absent: it writes `[\u2013\u2014]`, an escape rather than the character, so
 * the scan stays absolute with no carve-out.
 *
 * Run it before pushing (`npm run check:push` does) or against other paths by naming them:
 *
 *   node scripts/check-launcher-copy.mjs
 *   node scripts/check-launcher-copy.mjs launcher-ui/src/App.svelte
 */
import { globSync, readFileSync, statSync } from 'node:fs';
import process from 'node:process';

const DASHES = [
  { name: 'em dash', glyph: '\u2014' },
  { name: 'en dash', glyph: '\u2013' }
];

const roots = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['launcher-ui/src', 'launcher-ui/index.html', 'shim/src'];

const files = [];
for (const root of roots) {
  let info;
  try {
    info = statSync(root);
  } catch {
    console.error(`FAIL — ${root} is missing.`);
    process.exit(1);
  }
  if (info.isDirectory()) {
    files.push(...globSync(`${root}/**/*`).filter((file) => statSync(file).isFile()));
  } else {
    files.push(root);
  }
}

if (files.length === 0) {
  console.error(`FAIL — nothing to scan under ${roots.join(', ')}.`);
  process.exit(1);
}

const findings = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const { name, glyph } of DASHES) {
      let at = line.indexOf(glyph);
      while (at !== -1) {
        findings.push({
          name,
          where: `${file}:${index + 1}:${at + 1}`,
          reads: `${line.slice(0, at)}\u3010${glyph}\u3011${line.slice(at + glyph.length)}`
        });
        at = line.indexOf(glyph, at + glyph.length);
      }
    }
  });
}

if (findings.length === 0) {
  console.log(`OK — ${files.length} launcher and shim files carry no em dash and no en dash.`);
  process.exit(0);
}

console.error(`FAIL — ${findings.length} dash${findings.length === 1 ? '' : 'es'} in the launcher and shim sources:`);
for (const finding of findings) {
  console.error(`  ${finding.name} at ${finding.where}`);
  console.error(`    ${finding.reads.replace(/\s+/g, ' ').trim()}`);
}
console.error(
  '\nThe house rule is a period, or a rewrite: a dash between two clauses reads as\n' +
    'editorializing, and it wraps badly in exactly the places this copy is read (a modal, a\n' +
    'tooltip). A coordinating conjunction takes a comma instead. A test that has to name the\n' +
    'character spells it as an escape, e.g. /[\\u2013\\u2014]/.'
);
process.exit(1);
