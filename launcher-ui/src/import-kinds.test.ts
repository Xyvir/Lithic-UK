import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importKindOf } from './import-kinds.ts';
import { resolveScratchPlan } from './scratch-editor.ts';

/**
 * The registration table and the launcher's drop are two lists that have to agree, and the
 * only thing that made them agree was somebody reading both.
 *
 * `associations.json` is what makes a shell offer this app for a file, and it has no idea
 * whether the launcher stages what it offers. Twice now the disagreement has been silent:
 * `.pdf` and the pictures were registered and dropped on the floor, and `.md`, `.txt`, `.tid`
 * and `.ipynb` were registered and ignored in the same way. These tests are the seam, checked
 * against the real table rather than a fixture, so a new row that reaches no branch fails
 * here instead of in somebody's hands.
 */

type Association = { ext: string; label: string; mime: string; imported?: boolean };

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const table: { types: Association[] } = JSON.parse(
  readFileSync(join(repoRoot, 'src-tauri', 'src', 'platform', 'associations.json'), 'utf8')
);

/** The name a row would arrive as, which is what both classifiers are asked. */
const sampleName = (row: Association) => `example.${row.ext}`;

/**
 * The roads that never ask either classifier, because the file is not content to convert or
 * text to edit: a Lith is its own document, a `.json` is read as this device's backup or as a
 * tiddler array before anything parses it as text, and an HTML page is served as it is.
 *
 * Ordered rather than disjoint, which is why this is a list of firsts and not a partition:
 * `.json` is also a scratch kind, since Explorer opens one as text, and a drop reads it as a
 * payload first. Whichever comes first in `handleDrop` is the road it takes.
 */
const PAYLOAD_OR_PAGE = new Set(['lith', 'json', 'html']);

test('every registered type has a branch in the launcher drop', () => {
  const orphaned = table.types
    .filter((row) => !PAYLOAD_OR_PAGE.has(row.ext))
    .filter((row) => !importKindOf(sampleName(row)) && !resolveScratchPlan(sampleName(row)))
    .map((row) => row.ext);
  assert.deepEqual(
    orphaned,
    [],
    'a registered type with no branch is a file the shell offers this app and a drop ignores'
  );
});

test('a row says it is imported exactly when a converter claims it', () => {
  const disagrees = table.types
    .filter((row) => Boolean(row.imported) !== Boolean(importKindOf(sampleName(row))))
    .map((row) => `${row.ext}: imported=${row.imported === true}, converted=${Boolean(importKindOf(sampleName(row)))}`);
  assert.deepEqual(
    disagrees,
    [],
    'a type declared imported has to be one the launcher can convert, and the other way round'
  );
});

// The two staging roads, which the drop decides between in one order: a converter first, and
// the scratch parser for what is left. A type claimed by both would be converted when it should
// have been edited, and the point of this test is that nobody has to notice that by hand.
test('no type is both converted and parsed as text, except the payload a drop reads first', () => {
  const both = table.types
    .filter((row) => importKindOf(sampleName(row)) && resolveScratchPlan(sampleName(row)))
    .map((row) => row.ext);
  assert.deepEqual(both.filter((ext) => !PAYLOAD_OR_PAGE.has(ext)), []);
});

// And the table itself is worth one sanity check, because every assertion above is vacuous on
// an empty or unreadable one.
test('the table lists the app own format and each type it offers', () => {
  const extensions = table.types.map((row) => row.ext);
  assert.ok(extensions.includes('lith'), 'the app has to claim its own format');
  assert.ok(table.types.some((row) => row.imported), 'and at least one type it converts');
  assert.equal(new Set(extensions).size, extensions.length, 'no extension is listed twice');
});
