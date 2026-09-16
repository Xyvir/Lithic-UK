import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseScratchText,
  serializeScratchText,
  scratchTiddlers,
  serializeScratchWiki,
  parseTidFile,
  serializeTidFile,
  lineIndent
} from './scratch-wiki.ts';

test('lineIndent: tabs and 4-space groups', () => {
  assert.equal(lineIndent('hello'), 0);
  assert.equal(lineIndent('\thello'), 1);
  assert.equal(lineIndent('\t\thello'), 2);
  assert.equal(lineIndent('    hello'), 1);
  assert.equal(lineIndent('        hello'), 2);
  assert.equal(lineIndent('   hello'), 0); // 3 spaces is not an indent
});

test('scratch round-trip: tabs, gaps, trailing newline', () => {
  const source = 'Top A\n\tChild A1\n\tChild A2\n\n\nTop B\n\t\tDeep B1\n\nTop C\n';
  const parsed = parseScratchText(source);
  assert.equal(parsed.roots.length, 3);
  assert.equal(parsed.roots[0].children.length, 2);
  assert.equal(parsed.roots[0].children[0].text, 'Child A1');
  assert.equal(parsed.roots[1].gapBefore, 2);
  // Indent 2 under an indent-0 root: a direct child (stack pops to depth 0).
  assert.equal(parsed.roots[1].children[0].text, 'Deep B1');
  assert.equal(parsed.roots[1].children[0].indent, 2);
  assert.equal(parsed.trailingBlankLines, 0);
  assert.equal(parsed.endsWithNewline, true);
  assert.equal(serializeScratchText(parsed.roots, parsed.trailingBlankLines, parsed.endsWithNewline), source);
});

test('scratch round-trip: trailing blank lines and no final newline', () => {
  const withTrailing = 'A\nB\n\n';
  const parsed = parseScratchText(withTrailing);
  assert.equal(parsed.trailingBlankLines, 1);
  assert.equal(serializeScratchText(parsed.roots, parsed.trailingBlankLines, parsed.endsWithNewline), withTrailing);

  const noNewline = 'A\n\tB';
  const parsed2 = parseScratchText(noNewline);
  assert.equal(parsed2.trailingBlankLines, 0);
  assert.equal(parsed2.endsWithNewline, false);
  assert.equal(serializeScratchText(parsed2.roots, parsed2.trailingBlankLines, parsed2.endsWithNewline), noNewline);
});

test('paragraph soft-wrap: adjacent top-level lines merge into one node', () => {
  const source = '# Title\nSome paragraph\nwith a soft wrap\n\n---\n';
  const parsed = parseScratchText(source);
  assert.equal(parsed.roots.length, 2);
  assert.equal(parsed.roots[0].text, '# Title\nSome paragraph\nwith a soft wrap');
  assert.equal(parsed.roots[1].text, '---');
  assert.equal(serializeScratchText(parsed.roots, parsed.trailingBlankLines, parsed.endsWithNewline), source);
});

test('indented adjacent lines stay separate sibling nodes (outline style)', () => {
  const source = 'Root\n\tOne\n\tTwo\n\tThree';
  const parsed = parseScratchText(source);
  assert.equal(parsed.roots.length, 1);
  assert.equal(parsed.roots[0].children.length, 3);
  assert.equal(parsed.roots[0].children[2].text, 'Three');
});

test('absolute indents are preserved through round-trip', () => {
  const source = 'Root\n\t\tDouble-indented\n\tSingle';
  const parsed = parseScratchText(source);
  const root = parsed.roots[0];
  assert.equal(root.children[0].indent, 2);
  assert.equal(root.children[1].indent, 1);
  assert.equal(serializeScratchText(parsed.roots, parsed.trailingBlankLines, parsed.endsWithNewline), source);
});

test('UI-created nodes without stored indent inherit parent depth + 1', () => {
  const source = 'Root\n\tStored child\n';
  const parsed = parseScratchText(source);
  const { root, nodes } = scratchTiddlers('Doc', parsed);
  const byTitle = new Map([root, ...nodes].map((t) => [t.title, t]));
  // Simulate a streams-UI-created child of the top-level node (Doc 1):
  // no lithic-indent field → one level past its parent.
  byTitle.set('NewNode', { title: 'NewNode', 'lithic-gap': '0', text: 'New node' });
  const doc1 = nodes.find((t) => t.text === 'Root')!;
  doc1['stream-list'] = (doc1['stream-list'] ?? '') + ' [[NewNode]]';
  const out = serializeScratchWiki('Doc', (title) => byTitle.get(title));
  assert.equal(out, 'Root\n\tStored child\n\tNew node\n');
});

test('UI-created top-level nodes (children of the document root) get indent 0', () => {
  const source = 'Root\n';
  const parsed = parseScratchText(source);
  const { root, nodes } = scratchTiddlers('Doc', parsed);
  const byTitle = new Map([root, ...nodes].map((t) => [t.title, t]));
  byTitle.set('TopNode', { title: 'TopNode', 'lithic-gap': '0', text: 'Top-level' });
  root['stream-list'] += ' [[TopNode]]';
  const out = serializeScratchWiki('Doc', (title) => byTitle.get(title));
  assert.equal(out, 'Root\nTop-level\n');
});

test('serializeScratchWiki guards against hand-edited stream-list cycles', () => {
  const { root, nodes } = scratchTiddlers('Doc', parseScratchText('Alpha\n\tbeta\n'));
  const byTitle = new Map([root, ...nodes].map((t) => [t.title, t]));
  // Point a child back at the root: pathological, but must not hang.
  byTitle.get('Doc 1')!['stream-list'] = '[[Doc]]';
  const out = serializeScratchWiki('Doc', (title) => byTitle.get(title));
  assert.ok(out.includes('Alpha'));
});

test('scratch round-trip: CRLF inputs normalize and serialize with LF', () => {
  const parsed = parseScratchText('A\r\n\tB\r\n');
  assert.equal(parsed.roots.length, 1);
  assert.equal(parsed.roots[0].children.length, 1);
  assert.equal(serializeScratchText(parsed.roots, parsed.trailingBlankLines, parsed.endsWithNewline), 'A\n\tB\n');
});

test('blank-line gap persists across siblings and deep indents', () => {
  // A blank line, then a *deeper* indent: the child attaches to the ancestor.
  const parsed = parseScratchText('Root\n\tKid\n\n\t\tGrandkid');
  const kid = parsed.roots[0].children[0];
  assert.equal(kid.children.length, 1);
  assert.equal(kid.children[0].text, 'Grandkid');
  assert.equal(kid.children[0].gapBefore, 1);
});



test('scratchTiddlers: root carries stream-list, nodes carry parent/gap/markdown', () => {
  const parsed = parseScratchText('Root Node\n\tIndented Kid');
  const { root, nodes } = scratchTiddlers('MyNotes', parsed);

  assert.equal(root.title, 'MyNotes');
  assert.equal(root['stream-list'], '[[MyNotes 1]]'); // spaced titles are bracketed
  assert.equal(root.type, 'text/markdown');

  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].title, 'MyNotes 1');
  assert.equal(nodes[0].parent, 'MyNotes');
  assert.equal(nodes[0]['lithic-indent'], '0');
  assert.equal(nodes[0]['lithic-gap'], '0');
  assert.equal(nodes[0].type, 'text/markdown');
  assert.equal(nodes[0].text, 'Root Node');
  assert.equal(nodes[0]['stream-list'], '[[MyNotes 2]]'); // titles contain a space, so bracketed
  assert.equal(nodes[1].text, 'Indented Kid');
  assert.equal(nodes[1].parent, 'MyNotes 1');
});

test('serializeScratchWiki reconstructs flat text from wiki fields', () => {
  const source = 'Alpha\n\tbeta one\n\n\tbeta two\nGamma\n';
  const parsed = parseScratchText(source);
  const { root, nodes } = scratchTiddlers('Doc', parsed);
  const byTitle = new Map([root, ...nodes].map((t) => [t.title, t]));
  const result = serializeScratchWiki('Doc', (title) => byTitle.get(title));
  assert.equal(result, source);
});

test('serializeScratchWiki survives deleted nodes (gaps collapse)', () => {
  const source = 'Alpha\n\tbeta one\n\tbeta two\nGamma\n';
  const parsed = parseScratchText(source);
  const { root, nodes } = scratchTiddlers('Doc', parsed);
  const byTitle = new Map([root, ...nodes].map((t) => [t.title, t]));
  // Delete "beta one" from the stream-list of its parent.
  const betaOne = nodes.find((t) => t.text === 'beta one')!;
  const parent = nodes.find((t) => t.title === betaOne.parent)!;
  parent['stream-list'] = parent['stream-list'].replace('[[Doc 2]]', '').trim();
  const result = serializeScratchWiki('Doc', (title) => byTitle.get(title));
  assert.equal(result, 'Alpha\n\tbeta two\nGamma\n');
});

test('tid round-trip: simple header and body', () => {
  const source = 'title: My Tiddler\ntags: A B\n\nBody text here\nsecond line';
  const parsed = parseTidFile(source);
  assert.equal(parsed.fields.find(([k]) => k === 'title')?.[1], 'My Tiddler');
  assert.equal(parsed.text, 'Body text here\nsecond line');
  assert.equal(serializeTidFile(parsed), source);
});

test('tid round-trip: quoted multi-line values unescape', () => {
  const source = 'title: T\ncaption: "line one\\nline two"\n\nbody';
  const parsed = parseTidFile(source);
  assert.equal(parsed.fields.find(([k]) => k === 'caption')?.[1], 'line one\nline two');
  const out = serializeTidFile(parsed);
  assert.equal(out, 'title: T\ncaption: "line one\\nline two"\n\nbody');
});

test('tid: body-less tiddler serializes without body separator', () => {
  const parsed = parseTidFile('title: Only Header\ntype: text/vnd.tiddlywiki');
  assert.equal(parsed.text, '');
  const out = serializeTidFile(parsed);
  // Body separator is still emitted (empty body); TW accepts this layout.
  assert.equal(out, 'title: Only Header\ntype: text/vnd.tiddlywiki\n\n');
});
