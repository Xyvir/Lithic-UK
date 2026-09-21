import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

// The in-wiki .lith exporter is wikitext, so it cannot be unit-tested by
// importing it — but the three mistakes that shipped bugs are all visible in
// its source text, and each one is easy to reintroduce while "simplifying" the
// markup. They are pinned here instead:
//
//   1. Transcluding $:/core/templates/tid-tiddler prefixes every block with a
//      blank line (that template starts with a newline), and an export that
//      begins with a blank line was being read as a file with no title — which
//      the engine will not boot around, so the mount white-screened.
//   2. A bare `-[prefix[x]]` exclusion run is re-evaluated against non-shadow
//      tiddlers only, so every engine shadow survived it and a baseline tiddler
//      landed in a user's export.
//   3. The export default was the word "tiddlers" — TiddlyWiki jargon, and not
//      the name of anything in Lithic.
const EXPORTER = new URL('../../wiki/local-plugins/lithic-core/$__lithic_exporter_lith.tid', import.meta.url);
const source = fs.readFileSync(EXPORTER, 'utf8').replace(/\r\n/g, '\n');
const bodyStart = source.indexOf('\n\n');
const fields = Object.fromEntries(
  source
    .slice(0, bodyStart)
    .split('\n')
    .filter((line) => line.includes(':'))
    .map((line) => [line.slice(0, line.indexOf(':')).trim(), line.slice(line.indexOf(':') + 1).trim()])
);
const body = source.slice(bodyStart + 2);

test('the exporter renders blocks itself instead of transcluding the core template', () => {
  assert.ok(!body.includes('$:/core/templates/tid-tiddler'), 'core tid-tiddler template is what prefixed exports with a blank line');
  assert.match(body, /<\$fields exclude="text bag"/, 'fields are rendered by the exporter');
  assert.match(body, /<\$view field="text" format="text"\/>/, 'the body is rendered by the exporter');
});

test('the first block cannot open with a blank line', () => {
  assert.ok(!body.startsWith('\n'), 'the exporter body itself must not begin with a newline');
  assert.ok(!/counter="counter">\s*\n/.test(body), 'nothing whitespace-only between the list and the first block');
  assert.match(body, /counter="counter"><\$fields/, 'the first block starts immediately after the list opens');
});

test('baseline exclusions are source-qualified so shadows are subtracted too', () => {
  const sourced = [...body.matchAll(/-\[all\[tiddlers\+shadows\]prefix\[([^\]]+)\]\]/g)].map((m) => m[1]);
  for (const prefix of ['~', '$:/plugins/lithic/ephemeral/', '$:/boot/', '$:/core', '$:/themes', '$:/temp', '$:/state', '$:/HistoryList']) {
    assert.ok(sourced.includes(prefix), `exclusion for ${prefix} must name a source, else shadows survive it`);
  }
  assert.ok(!/-\s*\[prefix\[/.test(body), 'a bare -[prefix[..]] run is evaluated against tiddlers only and misses every shadow');
});

test('the exported file is named after the query, never "tiddlers"', () => {
  assert.ok(fields.filename, 'the exporter declares a filename');
  assert.match(fields.filename, /prefix\[\$:\/config\/TiddlyTools\/Filters\/\]/, 'a saved query supplies the name');
  assert.match(fields.filename, /field:filter<exportFilter>/, 'matched against the filter being exported');
  assert.match(fields.filename, /~\[\[export\]\]/, 'and falls back to "export"');
  // The old default was the literal filename `tiddlers`; `all[tiddlers+shadows]`
  // is a filter operator and says nothing about the name the user sees.
  assert.ok(!/\b(tiddlers|untitled)\b(?![+\]])/i.test(fields.filename), 'no TiddlyWiki jargon as a literal name');
});
