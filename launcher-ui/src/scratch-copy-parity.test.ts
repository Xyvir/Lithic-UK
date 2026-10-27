import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { parseScratchText, scratchTiddlers, serializeScratchWiki, SCRATCH_SERIALIZE_RUNTIME, type ScratchNode } from './scratch-wiki.ts';

// Copy Story River puts a document on the clipboard to paste into a chat, a
// message or an agent, and the scratch saver writes that same document back to
// the file it came from. One rule covers both: the stream tree the document is
// showing IS the layout. A node is one tab under its parent, a gap holds the
// blank lines that were between nodes, and the file's own record of where a node
// used to sit is gone, because a stored copy of the layout went stale the moment
// the streams UI re-indented anything and the next save then undid that edit.
//
// One rule covers both, floor included: at least one blank line between two
// nodes, because a node added in the streams UI carries no gap of its own and on
// screen it is its own block with air around it. The save floors it in
// scratch-wiki.ts, the copy floors it in stream-indent, and both replay the
// file's own larger gaps, so the copy of an unedited document is byte for byte
// what a save writes. That equality is what this file asserts.
//
// The button's filter chain is mirrored in JS here rather than executed, because
// a filter expression only runs inside a wiki. `the copy button builds the
// clipboard from the flat-text format` keeps the mirror honest by naming the
// operators it copies, so editing one without the other fails.
const BUTTON = new URL('../../wiki/local-plugins/lithic-core/$__Lithic_ui_Buttons_copy-story-river.tid', import.meta.url);
const OPERATOR = new URL('../../wiki/local-plugins/lithic-core/$__lithic_filters_stream-indent.js.tid', import.meta.url);

type Fields = Record<string, string>;
type GetTiddler = (title: string) => Fields | undefined;
type StreamIndent = (
  source: (iterate: (tiddler: { fields: Fields } | undefined, title: string) => void) => void,
  operator: { operand?: string },
  options: { wiki: { getTiddler: (title: string) => { fields: Fields } | undefined } }
) => string[];

/** A .tid's body: everything after the header's blank line. */
function readBody(url: URL): string {
  const text = fs.readFileSync(url, 'utf8').replace(/\r\n/g, '\n');
  return text.slice(text.indexOf('\n\n') + 2);
}

/** The plugin's operator, loaded from the tiddler that ships it. */
function loadStreamIndent(): StreamIndent {
  const exportsObject: Record<string, unknown> = {};
  new Function('exports', readBody(OPERATOR))(exportsObject);
  const operator = exportsObject['stream-indent'];
  assert.equal(typeof operator, 'function', 'the plugin still exports stream-indent');
  return operator as StreamIndent;
}

/**
 * The engine's own copy of the saver: the ES5 runtime injected into every
 * mounted scratch document. It is loaded from the string that ships rather than
 * re-written here, because the two implementations of this rule drifting apart
 * is what a mounted document saves by.
 */
function loadRuntimeSaver(): (rootTitle: string, getTiddler: GetTiddler) => string {
  const scope: Record<string, unknown> = {};
  // The runtime picks `window` when it exists, so a stand-in object keeps the
  // assignment off the real global.
  new Function('window', SCRATCH_SERIALIZE_RUNTIME)(scope);
  const serialize = scope.__LITHIC_SCRATCH_SERIALIZE__;
  assert.equal(typeof serialize, 'function', 'the runtime still publishes its serialize function');
  return serialize as (rootTitle: string, getTiddler: GetTiddler) => string;
}

/** Title list syntax, the subset `get-stream-nodes` walks. */
function parseList(value: string): string[] {
  const entries: string[] = [];
  const regex = /\[\[([^\]]+)\]\]|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) entries.push(match[1] ?? match[2]);
  return entries;
}

function byTitle(tiddlers: Fields[]): Map<string, Fields> {
  return new Map(tiddlers.map((tiddler) => [tiddler.title, tiddler]));
}

/** `[<root>get-stream-nodes[]]`: the node, then each `stream-list` entry depth first. */
function streamNodes(rootTitle: string, lookup: Map<string, Fields>): string[] {
  const visited: string[] = [];
  const walk = (title: string) => {
    const tiddler = lookup.get(title);
    if (!tiddler) return;
    visited.push(title);
    if (tiddler['stream-list'] && tiddler['stream-type']) {
      for (const child of parseList(tiddler['stream-list'])) walk(child);
    }
  };
  walk(rootTitle);
  return visited;
}

/**
 * What the button puts on the clipboard, for a document whose root is the only
 * tiddler in the story river. Mirrors the button's filter expression: one block
 * per story tiddler, empty blocks dropped, blocks joined with a newline and the
 * copy closed the way a saved file is closed.
 *
 * `perNode` mirrors the ONE thing about that expression a list-at-once mirror
 * cannot: the button reaches the operator through `:map`, which evaluates its
 * subfilter once per node, so every call sees a single-item source. Handing the
 * operator the whole list instead is how the shipped copy lost all of a file's
 * blank lines while these tests stayed green, so both paths are used here.
 */
function copyStoryRiver(
  storyTitles: string[],
  tiddlers: Fields[],
  operator: StreamIndent,
  options: { perNode?: boolean } = {}
): string {
  const lookup = byTitle(tiddlers);
  const getTiddler = (title: string) => {
    const tiddler = lookup.get(title);
    return tiddler ? { fields: tiddler } : undefined;
  };
  const blocks = storyTitles
    .map((title) => {
      const sources = streamNodes(title, lookup).filter((node) => (lookup.get(node)?.text ?? '').trim() !== '');
      const items = options.perNode
        ? sources.map(
            (node) =>
              operator(
                (iterate) => iterate(lookup.get(node) ? { fields: lookup.get(node) as Fields } : undefined, node),
                { operand: title },
                { wiki: { getTiddler } }
              )[0] ?? ''
          )
        : operator(
            (iterate) => sources.forEach((node) => iterate(lookup.get(node) ? { fields: lookup.get(node) as Fields } : undefined, node)),
            { operand: title },
            { wiki: { getTiddler } }
          );
      return items.map((item) => encodeURIComponent(item)).join('%0A');
    })
    .filter((block) => block !== '');
  if (blocks.length === 0) return '';
  return decodeURIComponent(`${blocks.join('%0A')}%0A`);
}

/** What the launcher's scratch saver writes for the same document. */
function savedBytes(rootTitle: string, tiddlers: Fields[]): string {
  return serializeScratchWiki(rootTitle, byTitle(tiddlers).get.bind(byTitle(tiddlers)) as GetTiddler);
}

function documentOf(source: string): Fields[] {
  const { root, nodes } = scratchTiddlers('doc.md', parseScratchText(source));
  return [root, ...nodes];
}


const FIXTURES = {
  outline: '# Title\n\nIntro paragraph\nwrapped line\n\n- one\n\t- nested\n\ttrailing\n',
  fourSpace: 'Alpha\n\n\nBeta\n    Gamma\n        Delta\n\nEpsilon\n',
  crlf: 'One\r\n\r\nTwo\r\n',
  percent: 'See https://example.com/a%20b and 100%25 of it\n',
  empty: ''
};

test('the copy button builds the clipboard from the flat-text format', () => {
  const body = readBody(BUTTON);
  assert.ok(
    body.includes(':map[stream-indent<..currentTiddler>encodeuricomponent[]] +[join[%0A]]'),
    'nodes are escaped before they are joined, so a percent sequence in a note is not decoded as one'
  );
  assert.ok(
    body.includes(':filter[!is[blank]] +[join[%0A]addsuffix[%0A]decodeuricomponent[]]'),
    'blank blocks are dropped and the copy ends the way a saved file ends'
  );
});

test('the copy of an unedited document is the file the scratch saver writes', () => {
  const operator = loadStreamIndent();
  for (const [name, source] of Object.entries(FIXTURES)) {
    const tiddlers = documentOf(source);
    assert.equal(copyStoryRiver(['doc.md'], tiddlers, operator), savedBytes('doc.md', tiddlers), `${name}: clipboard differs from the saver`);
  }
});

// The button reaches the operator through `:map`, which evaluates its subfilter
// once per node, so every call sees a single-item source. The mirror above hands
// it the whole list at once, and that difference was the whole of the bug
// reported on 2026-10-27: a 5,851 character markdown note copied as 5,830
// characters with all 22 of its blank lines gone, because a counter inside the
// operator could only ever read zero. So both paths are asserted to agree, and
// the blank lines are asserted outright, because a change that loses them from
// both paths would otherwise pass by being consistently wrong.
test('the copy is the same whether the operator sees one node or all of them', () => {
  const operator = loadStreamIndent();
  for (const [name, source] of Object.entries(FIXTURES)) {
    const tiddlers = documentOf(source);
    assert.equal(
      copyStoryRiver(['doc.md'], tiddlers, operator, { perNode: true }),
      copyStoryRiver(['doc.md'], tiddlers, operator),
      `${name}: the copy depends on how many nodes one operator call sees`
    );
  }
  assert.equal(
    copyStoryRiver(['doc.md'], documentOf(FIXTURES.outline), operator, { perNode: true }),
    '# Title\n\nIntro paragraph\nwrapped line\n\n- one\n\n\t- nested\n\n\ttrailing\n',
    'the blank lines between blocks are on the clipboard, not only in the file'
  );
});

test('a copied document reopens as the tree it was copied from', () => {
  const operator = loadStreamIndent();
  // Gaps are compared out, and that is the floor at work rather than a weaker
  // claim: a blank line in the copy separates two blocks, it does not reparent
  // one, so a pair the file ran together comes back as the same two nodes with a
  // blank line between them.
  const shape = (source: string): unknown => {
    const strip = (node: ScratchNode): unknown => ({
      text: node.text,
      indent: node.indent,
      children: node.children.map(strip)
    });
    return parseScratchText(source).roots.map(strip);
  };
  for (const [name, source] of Object.entries(FIXTURES)) {
    const copy = copyStoryRiver(['doc.md'], documentOf(source), operator);
    assert.deepEqual(shape(copy), shape(source), `${name}: the outline did not survive the copy`);
  }
});

// The edit that used to be undone: a node re-indented in the streams UI, where
// the action rewrites `parent` and the two `stream-list` fields and nothing
// else. The copy and the save now both read that, so the edit holds.
test('a node re-parented in the UI is copied and saved where it now sits', () => {
  const operator = loadStreamIndent();
  const tiddlers = documentOf('Parent\n\tChild\n\nStray\n');
  const root = tiddlers[0];
  const child = tiddlers.find((tiddler) => tiddler.text === 'Child');
  const stray = tiddlers.find((tiddler) => tiddler.text === 'Stray');
  assert.ok(child && stray, 'the fixture parsed into the nodes this test moves');

  root['stream-list'] = (root['stream-list'] ?? '').replace(' [[doc.md 3]]', '');
  child['stream-list'] = '[[doc.md 3]]';
  stray.parent = child.title;

  // Both sides floor the separation, so they share one literal here.
  const expected = 'Parent\n\n\tChild\n\n\t\tStray\n';
  assert.equal(copyStoryRiver(['doc.md'], tiddlers, operator), expected);
  assert.equal(savedBytes('doc.md', tiddlers), expected);

  // A file whose indentation skips a level is the same question at import time,
  // and both sides read the tree: one level under the parent, one tab.
  const skipped = documentOf('Alpha\n\t\tBeta\n');
  assert.equal(copyStoryRiver(['doc.md'], skipped, operator), 'Alpha\n\n\tBeta\n');
  assert.equal(savedBytes('doc.md', skipped), 'Alpha\n\n\tBeta\n');
});

test('a node created in the streams UI copies the way the saver writes it', () => {
  const operator = loadStreamIndent();
  const tiddlers = documentOf('Alpha\n\tBeta\n');
  const root = tiddlers[0];
  // A node added in the UI carries no stored indent, which is what makes its
  // position one level past its parent rather than where it was typed.
  tiddlers.push(
    {
      title: 'doc.md 99',
      parent: 'doc.md',
      type: 'text/markdown',
      'stream-type': 'default',
      text: 'added at the top level',
      'stream-list': '[[doc.md 100]]'
    },
    { title: 'doc.md 100', parent: 'doc.md 99', type: 'text/markdown', 'stream-type': 'default', text: 'added under it' }
  );
  root['stream-list'] = `${root['stream-list']} [[doc.md 99]]`;

  const copied = copyStoryRiver(['doc.md'], tiddlers, operator);
  assert.equal(copied, savedBytes('doc.md', tiddlers));
  assert.ok(copied.includes('\tadded under it'), 'the nested node is one tab in, not two spaces');
  assert.ok(copied.includes('\n\nadded at the top level'), 'a node with no gap of its own is still separated');
});

// A Lith has no file behind it, so no node carries one of the scratch fields: the
// tree is the whole of the layout. This is the shape the copy has to work in.
test('a document with no file behind it copies with its own nesting', () => {
  const operator = loadStreamIndent();
  const tiddlers: Fields[] = [
    { title: 'Doc', text: '', type: 'text/markdown', 'stream-type': 'default', 'stream-list': '[[Doc 1]] [[Doc 2]]' },
    { title: 'Doc 1', parent: 'Doc', type: 'text/markdown', 'stream-type': 'default', text: '# Heading' },
    { title: 'Doc 2', parent: 'Doc', type: 'text/markdown', 'stream-type': 'default', text: 'Body', 'stream-list': '[[Doc 3]]' },
    { title: 'Doc 3', parent: 'Doc 2', type: 'text/markdown', 'stream-type': 'default', text: 'Nested' }
  ];
  assert.equal(copyStoryRiver(['Doc'], tiddlers, operator), '# Heading\n\nBody\n\n\tNested\n');
});

// The rule exists in two places by necessity: the launcher's TypeScript and the
// ES5 string the engine is handed. Nothing else holds them together, and a
// mounted document saves by whichever one it was given.
test('the save the engine runs is the save the launcher tests', () => {
  const runtime = loadRuntimeSaver();
  const cases: Array<{ name: string; tiddlers: Fields[] }> = Object.entries(FIXTURES).map(([name, source]) => ({
    name,
    tiddlers: documentOf(source)
  }));
  // Plus the re-parented tree, which is the case the two must not disagree on.
  const moved = documentOf('Parent\n\tChild\n\nStray\n');
  const child = moved.find((tiddler) => tiddler.text === 'Child')!;
  moved[0]['stream-list'] = (moved[0]['stream-list'] ?? '').replace(' [[doc.md 3]]', '');
  child['stream-list'] = '[[doc.md 3]]';
  moved.find((tiddler) => tiddler.text === 'Stray')!.parent = child.title;
  cases.push({ name: 're-parented', tiddlers: moved });

  for (const { name, tiddlers } of cases) {
    const lookup = byTitle(tiddlers);
    assert.equal(
      runtime('doc.md', lookup.get.bind(lookup)),
      serializeScratchWiki('doc.md', lookup.get.bind(lookup)),
      `${name}: the engine's saver and the launcher's disagree`
    );
  }
});
