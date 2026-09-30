/**
 * The palette's guard: every colour the launcher draws comes from `color-palette.ts`.
 *
 * Three things could go wrong quietly, and each has an assertion here. The sheet could
 * drift from the module (a value edited in one and not the other, which is the whole
 * failure the palette exists to prevent), a colour literal could be added beside the
 * custom properties instead of in them, or two tokens could end up holding the same
 * colour, which is how a single edit lands in one place and misses the other. The last
 * two assertions are the ratchet that keeps the consolidation from undoing itself: a
 * family may not hold two tones close enough to be mistaken for one another, and the
 * palette may not grow past its ceiling without a reason being written down here.
 *
 * The scan is absolute on purpose. Comments count, like the dash sweep in
 * `scripts/check-launcher-copy.mjs`, because a comment naming a colour is where the
 * next literal comes from.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  PALETTE,
  PALETTE_BLOCK_START,
  PALETTE_BLOCK_END,
  PALETTE_MIN_SEPARATION,
  PALETTE_TOKEN_CEILING,
  paletteCss,
  paletteTokens
} from './color-palette.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const sheetPath = new URL('./styles.css', import.meta.url);

/**
 * The two files whose business is colour values: the palette holds them, and the sheet
 * carries the generated copy of them, swept by the test above with its block removed.
 * Everything else is swept whole, comments included.
 */
const PALETTE_SOURCES = new Set(['color-palette.ts', 'styles.css']);

// The lookarounds in the hex pattern are the ones the wiki colour gate uses: they skip a
// CSS id (`#app`), a Svelte block (`{#each}`) and numeric entities. Held as source text
// rather than a literal so this file is not its own exception.
const COLOUR_PATTERNS = [
  new RegExp(String.raw`(?<![\w$/.:#&-])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![\w-])`, 'g'),
  new RegExp(String.raw`\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(`, 'gi')
];

function swept(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) files.push(...swept(path));
    else if (/\.(?:ts|svelte|css|html)$/.test(entry.name)) files.push(path);
  }
  return files;
}

function literals(text: string): string[] {
  const found: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    for (const pattern of COLOUR_PATTERNS) {
      pattern.lastIndex = 0;
      const match = pattern.exec(line);
      if (match) found.push(`${index + 1}: ${line.trim().slice(0, 90)}`);
    }
  });
  return found;
}

function paletteRegion() {
  const text = readFileSync(sheetPath, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === PALETTE_BLOCK_START);
  const end = lines.findIndex((line) => line.trim() === PALETTE_BLOCK_END);
  assert.ok(start !== -1, `styles.css carries no ${PALETTE_BLOCK_START}`);
  assert.ok(end > start, `styles.css carries no ${PALETTE_BLOCK_END} after the start marker`);
  return {
    block: lines.slice(start, end + 1).join('\n'),
    rest: [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n')
  };
}

test('the sheet carries the palette exactly as the module declares it', () => {
  assert.equal(
    paletteRegion().block,
    paletteCss(),
    'the palette block in styles.css is stale. Run: node scripts/write-launcher-palette.mjs'
  );
});

test('the sheet keeps its colours in the palette and nowhere else', () => {
  const found = literals(paletteRegion().rest);
  assert.deepEqual(found, [], 'a colour literal sits in styles.css outside the palette block');
});

test('every palette variable the sheet reads is one the block defines', () => {
  const defined = new Set(paletteTokens().map((token) => token.name));
  const used = new Set([...paletteRegion().rest.matchAll(/var\((--lithic-[a-z0-9-]+)/g)].map((match) => match[1]));
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, [], 'styles.css reads a palette variable the block does not define');
});

test('no other launcher source names a colour of its own', () => {
  const offenders = [];
  for (const file of swept(here)) {
    const name = file.slice(file.lastIndexOf('/') + 1);
    if (PALETTE_SOURCES.has(name)) continue;
    const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    for (const hit of literals(text)) offenders.push(`${file.slice(here.length)} line ${hit}`);
  }
  assert.deepEqual(offenders, [], 'a launcher source holds a colour outside color-palette.ts');
});

test('no two tokens hold the same colour', () => {
  const seen = new Map();
  const duplicates = [];
  for (const token of paletteTokens()) {
    if (seen.has(token.value)) duplicates.push(`${token.name} and ${seen.get(token.value)} are both ${token.value}`);
    else seen.set(token.value, token.name);
  }
  assert.deepEqual(duplicates, [], 'a colour held twice is an edit that only half lands');
});

test('no two tones in a family are close enough to be one tone', () => {
  // Spelled without the three letter function name so this file is swept by its own rule.
  const channelsOf = (value: string) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16));
  const gap = (a: number[], b: number[]) => Math.sqrt(a.reduce((sum, channel, at) => sum + (channel - b[at]) ** 2, 0));
  const pairs: string[] = [];
  for (const [family, tones] of Object.entries(PALETTE)) {
    const list = Object.entries(tones).map(([tone, value]) => ({ tone, value, at: channelsOf(value) }));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const apart = Math.round(gap(list[i].at, list[j].at));
        if (apart < PALETTE_MIN_SEPARATION) {
          pairs.push(`${family}: ${list[i].tone} ${list[i].value} and ${list[j].tone} ${list[j].value} are ${apart} apart`);
        }
      }
    }
  }
  assert.deepEqual(
    pairs,
    [],
    'two tones this close are one tone: merge into the nearer one rather than adding a value'
  );
});

test('the palette stays inside its ceiling', () => {
  const count = paletteTokens().length;
  assert.ok(
    count <= PALETTE_TOKEN_CEILING,
    `the palette holds ${count} tokens and the ceiling is ${PALETTE_TOKEN_CEILING}: ` +
      'another tone is almost always an existing one being overlooked, so raise the ceiling in color-palette.ts on purpose if it is really needed'
  );
});

test('every token is a lowercase #rrggbb colour', () => {
  for (const token of paletteTokens().filter((entry) => entry.value.startsWith('#'))) {
    assert.match(token.value, /^#[0-9a-f]{6}$/, `${token.name} is not a lowercase six digit hex colour`);
  }
});
