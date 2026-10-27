import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SCRATCH_EXTENSIONS,
  isScratchFileName,
  isHtmlMonolithName,
  tracksUnsavedEdits,
  resolveMountName,
  resolveScratchKind,
  resolveScratchPlan,
  parseScratchSource,
  parseHandoffTiddlers
} from './scratch-editor.ts';
import { parseScratchText, serializeScratchText, serializeScratchWiki } from './scratch-wiki.ts';

test('scratch file name detection', () => {
  for (const ext of SCRATCH_EXTENSIONS) {
    assert.ok(isScratchFileName(`notes.${ext}`), `${ext} should be scratch`);
  }
  assert.equal(isScratchFileName('notes.lith'), false);
  assert.equal(isScratchFileName('notes.html'), false);
  assert.equal(isScratchFileName('notes.htm'), false);
  assert.equal(isScratchFileName('noextension'), false);
});

// Regression: the mount gated its unsaved-edit prompt on "lith only", so a
// scratch document with captured edits (which the injected engine records under
// the same file name) booted straight from the file on disk and the edits were
// lost. A monolith is the one kind that opts out, for its own reason: the page
// may keep its own recovery mechanism.
test('every local file except an HTML monolith tracks unsaved edits', () => {
  for (const name of ['notes.md', 'notes.txt', 'notes.markdown', 'notes.tid', 'data.json', 'book.ipynb', 'wiki.lith']) {
    assert.equal(tracksUnsavedEdits(name), true, `${name} must offer unsaved-edit recovery`);
  }
  assert.equal(tracksUnsavedEdits('wiki.html'), false);
  assert.equal(tracksUnsavedEdits('wiki.htm'), false);
  assert.equal(tracksUnsavedEdits('WIKI.HTML'), false);
});

test('an HTML monolith is a complete page, not a Lithic document', () => {
  assert.equal(isHtmlMonolithName('wiki.html'), true);
  assert.equal(isHtmlMonolithName('wiki.htm'), true);
  assert.equal(isHtmlMonolithName('lithic.html'), true, 'the shipped engine is a monolith too');
  assert.equal(isHtmlMonolithName('wiki.lith'), false);
  assert.equal(isHtmlMonolithName('notes.md'), false);
});

// Regression: a monolith mount was recorded under `normalizeLithName` while its
// recent row used the file's own name. Its cache and version history landed in
// keys like `stock.html` -> `stock.lith`, so the row's history button stayed dead
// (nothing was found for the row's name) and search listed a cached wiki that no
// file corresponded to. The row name and the cache name are one value.
test('a mount name is the one name its row, cache and history all use', () => {
  assert.equal(resolveMountName('notes.lith'), 'notes.lith');
  assert.equal(resolveMountName('recipes'), 'recipes.lith');
  assert.equal(resolveMountName('stock.html', { htmlMonolith: true }), 'stock.html');
  assert.equal(resolveMountName('stock.htm', { htmlMonolith: true }), 'stock.htm');
  assert.equal(resolveMountName('notes.md', { scratch: true }), 'notes.md');
  assert.equal(resolveMountName('notes.tid', { scratch: true }), 'notes.tid');
  assert.equal(resolveMountName('book.ipynb', { scratch: true }), 'book.ipynb');
  // A .json tiddler-array backup mounts as a lith and is normalized like one.
  assert.equal(resolveMountName('backup.json'), 'backup.lith');
});

test('scratch kind resolves per extension (case-insensitive)', () => {
  assert.equal(resolveScratchKind('A.MD'), 'text');
  assert.equal(resolveScratchKind('b.txt'), 'text');
  assert.equal(resolveScratchKind('c.markdown'), 'text');
  assert.equal(resolveScratchKind('d.tid'), 'tid');
  assert.equal(resolveScratchKind('e.json'), 'json');
  assert.equal(resolveScratchKind('f.lith'), null);
});

test('resolveScratchPlan derives the root title from the file name, extension kept', () => {
  const plan = resolveScratchPlan('Meeting Notes.md');
  assert.equal(plan?.kind, 'text');
  // The document title names the file it edits, extension and all.
  assert.equal(plan?.base, 'Meeting Notes.md');
  assert.equal(resolveScratchPlan('book.ipynb')?.base, 'book.ipynb');
  // A name that is only an extension has no file name to keep: fall back.
  const bare = resolveScratchPlan('.md');
  assert.equal(bare?.base, 'Scratch');
  // Explicit base wins.
  assert.equal(resolveScratchPlan('x.txt', 'Custom')?.base, 'Custom');
});

test('parseScratchSource (text) produces a streams payload that round-trips', () => {
  const source = 'Root line\n\tIndented child\n\nSecond root\n';
  const plan = resolveScratchPlan('Notes.txt')!;
  const tiddlers = parseScratchSource(source, plan);

  assert.equal(tiddlers[0].title, 'Notes.txt');
  assert.equal(tiddlers[0]['lithic-scratch'], 'yes');
  assert.equal(tiddlers[1].parent, 'Notes.txt');
  // Node titles are the document title plus an index, extension included.
  assert.equal(tiddlers[1].title, 'Notes.txt 1');
  // Nodes render as markdown and carry their gap. The indent is not recorded:
  // the node's place in the tree is where its layout comes from.
  const node = tiddlers.find((t) => t.text === 'Indented child');
  assert.equal(node?.type, 'text/markdown');
  assert.equal(node?.['lithic-gap'], '0');
  assert.equal(node?.['lithic-indent'], undefined);
});

test('an empty text document mounts with one node to type into', () => {
  const plan = resolveScratchPlan('empty.txt')!;
  const tiddlers = parseScratchSource('', plan);
  assert.equal(tiddlers.length, 2, 'the document root and one node');
  const [root, node] = tiddlers;
  assert.equal(root['stream-list'], '[[empty.txt 1]]');
  assert.equal(node.title, 'empty.txt 1');
  assert.equal(node.parent, 'empty.txt');
  assert.equal(node.text, '');
  assert.equal(node.type, 'text/markdown');
  // Without stream-type the streams operator refuses to walk the tree, so the
  // document would mount as untypeable as it is empty.
  assert.equal(node['stream-type'], 'default');

  const lookup = new Map(tiddlers.map((tiddler) => [tiddler.title, tiddler]));
  const save = () => serializeScratchWiki('empty.txt', (title) => lookup.get(title));
  // An empty node is an empty line, and a file of nothing is an empty file, so
  // opening and saving a blank document leaves it byte for byte as it was.
  assert.equal(save(), '');
  // Typing into it writes the file's first line.
  lookup.set('empty.txt 1', { ...node, text: 'first line' });
  assert.equal(save(), 'first line\n');

  // Blank lines are a blank document too, and a file written by an editor as a
  // single newline is the shape that arrives most often.
  const blank = parseScratchSource('\n\n', resolveScratchPlan('blank.txt')!);
  assert.equal(blank.length, 2);
  assert.equal(blank[0]['stream-list'], '[[blank.txt 1]]');

  // The other scratch kinds are one tiddler rather than a node tree, so they
  // are not handed a node they would then have to write somewhere.
  const tid = parseScratchSource('', resolveScratchPlan('blank.tid')!);
  assert.equal(tid.length, 1);
});

test('parseScratchSource (tid) keeps header fields and body', () => {
  const source = 'title: Saved Tiddler\ntags: A B\n\nBody text\n';
  const plan = resolveScratchPlan('saved.tid')!;
  const tiddlers = parseScratchSource(source, plan);

  const root = tiddlers[0];
  assert.equal(root.title, 'saved.tid');
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

test('scratch text payloads re-serialize through the wiki fields with every node separated', () => {
  const source = 'Para one\nwrapped line\n\n\tIndented\n\t\tDeep\nGamma\n';
  const plan = resolveScratchPlan('Doc.txt')!;
  const tiddlers = parseScratchSource(source, plan);

  // Serialize through the function the save path uses, given the field map the
  // engine's getTiddlersAsJson would produce. The blank line after `wrapped line`
  // is the file's own; the ones before `Deep` and `Gamma` are the floor, because
  // each node is its own block and nothing may run two of them together.
  const byTitle = new Map(tiddlers.map((t) => [t.title, t]));
  const serialized = serializeScratchWiki(plan.base, (title) => byTitle.get(title));
  assert.equal(serialized, 'Para one\nwrapped line\n\n\tIndented\n\n\t\tDeep\n\nGamma\n');
});

// Keep the import surface honest: parseScratchText/serializeScratchText are
// re-exported helpers of this module's contract.
assert.equal(typeof parseScratchText, 'function');
assert.equal(typeof serializeScratchText, 'function');
