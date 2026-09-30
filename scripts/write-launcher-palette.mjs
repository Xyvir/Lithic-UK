#!/usr/bin/env node
/**
 * Regenerate the palette block in `launcher-ui/src/styles.css` from `color-palette.ts`.
 *
 *   node scripts/write-launcher-palette.mjs
 *
 * The relationship is the same one `src/launcher.html` has with its sources: the file
 * carries a generated region, the generator is the source of truth, and a test fails when
 * the two drift apart (`launcher-ui/src/color-palette.test.ts`). Run this after editing the
 * palette, then commit both: the sheet without the block is a page with no colours, and the
 * block without the sheet is the same thing written twice.
 *
 * There is no check mode. The unit test is the check, it names the token that moved, and it
 * runs in `npm test` and in `npm run check:push`, so a stale block cannot reach a push.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { PALETTE_BLOCK_START, PALETTE_BLOCK_END, paletteCss } from '../launcher-ui/src/color-palette.ts';

const FILE = 'launcher-ui/src/styles.css';
const text = readFileSync(FILE, 'utf8');
const eol = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);

const block = paletteCss().split('\n');
let start = lines.findIndex((line) => line.trim() === PALETTE_BLOCK_START);
let end = lines.findIndex((line) => line.trim() === PALETTE_BLOCK_END);

// A sheet with no region yet gets one, at the top of the first `:root`: bootstrapping the
// markers by hand would be the one step in this workflow a person could get wrong, and a
// missing region has an obvious right answer where a misplaced one does not.
if (start === -1 || end < start) {
  const root = lines.findIndex((line) => line.trim() === ':root {');
  if (root === -1) {
    console.error(`FAIL — ${FILE} carries neither a palette region nor a :root block to open one on.`);
    process.exit(1);
  }
  console.log(`No palette region in ${FILE}: opening one above :root (line ${root + 1}).`);
  start = root;
  end = root - 1;
}

const next = [...lines.slice(0, start), ...block, ...lines.slice(end + 1)].join(eol);
if (next === text) {
  console.log(`OK — ${FILE} already carries the palette as color-palette.ts declares it.`);
  process.exit(0);
}

writeFileSync(FILE, next);
console.log(`Wrote ${block.length} lines of palette into ${FILE}.`);
console.log('Stylesheet changes are source changes: commit the sheet and the palette together.');
