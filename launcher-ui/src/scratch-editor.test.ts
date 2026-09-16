import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCRATCH_EXTENSIONS,
  isScratchFileName,
  resolveScratchKind,
  resolveScratchPlan,
  parseScratchSource,
  parseHandoffTiddlers
} from './scratch-editor.ts';
import { parseScratchText, serializeScratchText } from './scratch-wiki.ts';

test('scratch file name detection', () => {
  for (const ext of SCRATCH_EXTENSIONS) {
    assert.ok(isScratchFileName(`notes.${ext}`), `${ext} should be scratch`);
  }
  assert.equal(isScratchFileName('notes.lith'), false);
  assert.equal(isScratchFileName('notes.html'), false);
  assert.equal(isScratchFileName('notes.htm'), false);
  assert.equal(isScratchFileName('noextension'), false);
});

test('scratch kind resolves per extension (case-insensitive)', () => {
  assert.equal(resolveScratchKind('A.MD'), 'text');
  assert.equal(resolveScratchKind('b.txt'), 'text');
  assert.equal(resolveScratchKind('c.markdown'), 'text');
  assert.equal(resolveScratchKind('d.tid'), 'tid');
  assert.equal(resolveScratchKind('e.json'), 'json');
  assert.equal(resolveScratchKind('f.lith'), null);
});

test('resolveScratchPlan derives a base title from the file stem', () => {
  const plan = resolveScratchPlan('Meeting Notes.md');
  assert.equal(plan?.kind, 'text');
  assert.equal(plan?.base, 'Meeting Notes');
  // Empty stem falls back to "Scratch".
  const bare = resolveScratchPlan('.md');
  assert.equal(bare?.base, 'Scratch');
  // Explicit base wins.
  assert.equal(resolveScratchPlan('x.txt', 'Custom')?.base, 'Custom');
});

test('parseScratchSource (text) produces a streams payload that round-trips', () => {
  const source = 'Root line\n\tIndented child\n\nSecond root\n';
  const plan = resolveScratchPlan('Notes.txt')!;
  const tiddlers = parseScratchSource(source, plan);

  assert.equal(tiddlers[0].title, 'Notes');
  assert.equal(tiddlers[0]['lithic-scratch'], 'yes');
  assert.equal(tiddlers[1].parent, 'Notes');
  // Nodes render as markdown and carry the scratch fields.
  const node = tiddlers.find((t) => t.text === 'Indented child');
  assert.equal(node?.type, 'text/markdown');
  assert.equal(node?.['lithic-indent'], '1');
});

test('parseScratchSource (tid) keeps header fields and body', () => {
  const source = 'title: Saved Tiddler\ntags: A B\n\nBody text\n';
  const plan = resolveScratchPlan('saved.tid')!;
  const tiddlers = parseScratchSource(source, plan);

  const root = tiddlers[0];
  assert.equal(root.title, 'saved');
  assert.equal(root['lithic-tid'], 'yes');
  assert.equal(root.tags, 'A B');
  assert.equal(root.text, 'Body text\n');
});

test('parseScratchSource (json) embeds the body verbatim', () => {
  const source = '{"a": 1}\n';
  const plan = resolveScratchPlan('data.json')!;
  const tiddlers = parseScratchSource(source, plan);
  assert.equal(tiddlers[0]['lithic-json'], 'yes');
  assert.equal(tiddlers[0].text, source);
});

test('parseHandoffTiddlers routes scratch files through scratch and liths through lith', () => {
  const md = parseHandoffTiddlers('notes.md', '# Heading\n\tchild');
  assert.equal(md.length, 3); // doc root + '# Heading' node + child node
  assert.equal(md[0]['lithic-scratch'], 'yes');

  const lith = parseHandoffTiddlers('wiki.lith', 'title: One\n\nbody');
  assert.equal(lith.length, 1);
  assert.equal(lith[0].title, 'One');

  // Empty text (blank lith) yields no tiddlers.
  assert.deepEqual(parseHandoffTiddlers('blank.lith', ''), []);
});

test('scratch text payloads re-serialize byte-identically through the wiki fields', () => {
  const source = 'Para one\nwrapped line\n\n\tIndented\n\t\tDeep\nGamma\n';
  const plan = resolveScratchPlan('Doc.txt')!;
  const tiddlers = parseScratchSource(source, plan);

  // Simulate the saver: build the field map the engine's getTiddlersAsJson
  // would produce and serialize from it.
  const byTitle = new Map(tiddlers.map((t) => [t.title, t]));
  const serialized = serializeScratchWikiForTest(plan.base, (title) => byTitle.get(title));
  assert.equal(serialized, source);
});

function serializeScratchWikiForTest(
  rootTitle: string,
  getTiddler: (title: string) => Record<string, string> | undefined
): string {
  // Mirror of the engine runtime behavior tested behaviorally in
  // scratch-wiki.test.ts; here we only assert payload fidelity.
  const root = getTiddler(rootTitle);
  assert.ok(root, 'root tiddler exists');
  const list = (root['stream-list'] ?? '').match(/\[\[([^\]]+)\]\]|(\S+)/g) ?? [];
  const lines: string[] = [];
  const emit = (title: string, parentIndent: number, visiting: Set<string>) => {
    if (visiting.has(title)) return;
    const t = getTiddler(title);
    if (!t) return;
    visiting.add(title);
    const gap = parseInt(t['lithic-gap'] ?? '0', 10) || 0;
    for (let i = 0; i < gap && lines.length > 0; i++) lines.push('');
    const stored = parseInt(t['lithic-indent'] ?? '', 10);
    const indent = Number.isFinite(stored) ? stored : parentIndent + 1;
    t.text.split('\n').forEach((line) => lines.push('\t'.repeat(Math.max(0, indent)) + line));
    for (const child of (t['stream-list'] ?? '').match(/\[\[([^\]]+)\]\]|(\S+)/g) ?? []) {
      emit(child.replace(/^\[\[|\]\]$/g, ''), indent, visiting);
    }
  };
  for (const entry of list) emit(entry.replace(/^\[\[|\]\]$/g, ''), -1, new Set());
  const body = lines.join('\n');
  return body !== '' ? `${body}\n` : body;
}

// Keep the import surface honest: parseScratchText/serializeScratchText are
// re-exported helpers of this module's contract.
assert.equal(typeof parseScratchText, 'function');
assert.equal(typeof serializeScratchText, 'function');
