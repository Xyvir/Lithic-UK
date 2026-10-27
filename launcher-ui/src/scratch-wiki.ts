/**
 * Scratch-wiki round-trips: flat text files ↔ streams node trees.
 *
 * The primary Lithic usage is streams (node/block) mode, so opening a flat
 * file (.txt / .md / .tid) should not present it as one giant tiddler.
 * Instead the file is split into a node tree by whitespace intent:
 *   - blank lines separate nodes (the gap count is recorded, so a parse can be
 *     replayed exactly and a save knows how much air the file put between two
 *     nodes)
 *   - leading tabs (or 4-space groups) define node depth (children), stored
 *     as an ABSOLUTE indent so serialization replays the source exactly
 *   - adjacent top-level (indent 0) lines soft-wrap into one paragraph node;
 *     adjacent indented lines are separate sibling nodes (outline style)
 *
 * All node tiddlers render as markdown (`type: text/markdown`) regardless of
 * the source extension. Double-clicking a block shows the source text.
 *
 * Layout rule: the tree IS the layout. `serializeScratchWiki` (the live save
 * path, mirrored into the engine as SCRATCH_SERIALIZE_RUNTIME) writes every node
 * one tab deeper than its parent, so a node re-indented or re-parented in the
 * streams UI is saved where it now sits. The file's own absolute indent is
 * therefore neither written nor read: recording it and preferring it meant a
 * save after a re-indent replayed the old layout and silently undid the edit,
 * because streams' indent actions rewrite only `parent` and `stream-list`.
 *
 * What is kept from the file is the blank lines between nodes (`lithic-gap`),
 * which no streams gesture contradicts, and the trailing newline. Indentation is
 * written as tabs, so a source indented with 4-space groups comes back as one
 * tab per level; that was already true before the tree became authoritative.
 *
 * What is NOT kept is a pair of nodes the file ran together: ONE blank line is
 * the floor between two nodes, and it applies on both sides. The copy floors it
 * in `stream-indent`, and the two savers here floor it as well, because on
 * screen every node is its own block with air around it, a node added in the
 * streams UI carries no gap of its own to separate it, and two top-level nodes
 * written on adjacent lines would re-import as ONE paragraph (see the soft-wrap
 * rule above). A file's own larger gaps are still replayed; the floor only ever
 * adds air, never removes it.
 *
 * `parseScratchText`/`serializeScratchText` are the PARSER's pair rather than a
 * save path: they replay the parse's own indents, gaps, trailing blank lines and
 * final newline byte for byte, which is what proves the parse loses nothing, and
 * they are what the parser's round-trip tests exercise. Nothing writes a file
 * with them. The savers below write a DOCUMENT, so they floor every gap, and
 * `scratch-copy-parity.test.ts` holds the copy and the save to the same rule.
 */

export type ScratchNode = {
  /** Raw line content of the node (may embed newlines from soft-wrapped paragraphs). */
  text: string;
  /** Absolute indent level (tabs, or 4-space groups). */
  indent: number;
  /** Blank lines that preceded this node (sibling gap; 0 = adjacent line). */
  gapBefore: number;
  children: ScratchNode[];
};

export type ScratchParseResult = {
  roots: ScratchNode[];
  /** Blank lines between the last node and EOF. */
  trailingBlankLines: number;
  /** Whether the source ended with a newline character. */
  endsWithNewline: boolean;
};

/** Depth of a line: leading tabs, or groups of 4 spaces when no tabs lead. */
export function lineIndent(line: string): number {
  const match = /^(?:\t+| +)/.exec(line);
  if (!match) return 0;
  const ws = match[0];
  if (ws[0] === '\t') return ws.length;
  return Math.floor(ws.length / 4);
}

/** Content of a line with its indentation stripped. */
export function stripIndent(line: string): string {
  return line.replace(/^(?:\t+| +)/, '');
}

/**
 * Parse flat text into a node tree.
 * The stack of (indent, node) persists across blank lines, so a deeper
 * indented chunk after a gap still becomes a child of the matching ancestor.
 */
export function parseScratchText(source: string): ScratchParseResult {
  const normalized = source.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  let endsWithNewline = false;
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    // The final element after a trailing "\n" is the EOF newline itself.
    endsWithNewline = true;
    lines.pop();
  }

  const roots: ScratchNode[] = [];
  const stack: Array<{ indent: number; node: ScratchNode }> = [];
  let pendingGap = 0;
  // Whether the top-of-stack node can absorb another same-indent line as a
  // soft-wrapped continuation (false right after a blank line).
  let topOpen = false;

  for (const line of lines) {
    if (line.trim() === '') {
      pendingGap += 1;
      topOpen = false;
      continue;
    }
    const indent = lineIndent(line);
    const content = stripIndent(line);

    const top = stack[stack.length - 1];
    if (top && topOpen && indent === top.indent && indent === 0) {
      // Paragraph soft-wrap: adjacent top-level lines stay one node
      // (a blank line closes the paragraph via topOpen = false).
      top.node.text += `\n${content}`;
      continue;
    }

    const node: ScratchNode = { text: content, indent, gapBefore: pendingGap, children: [] };
    pendingGap = 0;
    while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
    if (stack.length === 0) roots.push(node);
    else stack[stack.length - 1].node.children.push(node);
    stack.push({ indent, node });
    topOpen = true;
  }

  return { roots, trailingBlankLines: pendingGap, endsWithNewline };
}

/**
 * Serialize a node tree back to flat text. Node indents are absolute, gaps
 * replay as blank lines, and `endsWithNewline` controls the EOF newline.
 *
 * This replays a PARSE, it does not write a document: it is the pair that proves
 * the parse loses nothing, so it does not floor a gap the way the savers do.
 */
export function serializeScratchText(
  roots: ScratchNode[],
  trailingBlankLines = 0,
  endsWithNewline = true
): string {
  const lines: string[] = [];
  const emit = (node: ScratchNode) => {
    for (let i = 0; i < node.gapBefore && lines.length > 0; i++) lines.push('');
    const pad = '\t'.repeat(node.indent);
    node.text.split('\n').forEach((line) => lines.push(pad + line));
    for (const child of node.children) emit(child);
  };
  roots.forEach(emit);
  for (let i = 0; i < trailingBlankLines; i++) lines.push('');
  const body = lines.join('\n');
  return endsWithNewline && body !== '' ? `${body}\n` : body;
}

/* --- .tid (TiddlyWiki tiddler file) round-trip --- */

export type TidFile = {
  /** Header fields in original order (`text` excluded). */
  fields: Array<[string, string]>;
  /** Body text (after the header, per TW's `.tid` layout). */
  text: string;
};

/**
 * Parse a `.tid` file. Single-line header values are verbatim; quoted values
 * (TW stringifies multi-line field values as JSON strings) are unescaped.
 * The body begins after the first blank line.
 */
export function parseTidFile(source: string): TidFile {
  const normalized = source.replace(/\r\n/g, '\n');
  const blank = normalized.indexOf('\n\n');
  const headerPart = blank === -1 ? normalized : normalized.slice(0, blank);
  const body = blank === -1 ? '' : normalized.slice(blank + 2);

  const fields: Array<[string, string]> = [];
  for (const line of headerPart.split('\n')) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    let value = line.slice(colon + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value) as string; } catch { /* keep raw */ }
    }
    fields.push([key, value]);
  }
  return { fields, text: body };
}

/** Quote a field value the way TiddlyWiki's `$tw.utils.stringify` does. */
function stringifyTidValue(value: string): string {
  if (/[\n"\\]/.test(value)) return JSON.stringify(value);
  return value;
}

/**
 * Serialize a tiddler back to `.tid` format. `fields` (order preserved)
 * carries every non-text field; `text` becomes the body.
 */
export function serializeTidFile(tid: TidFile): string {
  const header = tid.fields
    .filter(([key, value]) => value !== '' || key === 'title')
    .map(([key, value]) => `${key}: ${stringifyTidValue(value)}`);
  return `${header.join('\n')}\n\n${tid.text}`;
}

/* --- Wiki payload mapping --- */

export type ScratchWikiPayload = {
  /** The document (root) tiddler that carries the stream-list. */
  root: Record<string, string>;
  /** Node tiddlers in document order. */
  nodes: Array<Record<string, string>>;
};

/** Bracket a title for inclusion in a TiddlyWiki list field. */
function listEntry(title: string): string {
  return title.includes(' ') ? `[[${title}]]` : title;
}

/** Title for a node: `<base> <n>` (bracketed when placed in list fields). */
export function scratchNodeTitle(base: string, index: number): string {
  return `${base} ${index}`;
}

/**
 * Every stream tiddler carries `stream-type`. The streams plugin assigns it to
 * `default` on the nodes it creates, and Lithic's own creators do the same
 * (`$:/core/ui/Actions/new-journal`, the streams action macros). The scratch
 * mount is the one place that used to leave it off, and that is not cosmetic:
 * the streams `get-stream-nodes` operator only walks a node when it has BOTH
 * `stream-list` and `stream-type` (see
 * wiki/external/tiddlystudy/plugins/streams/.../get-stream-nodes.js). Without
 * it the walk stops at the document root, whose text is empty, so every filter
 * built on that operator (Copy Story River, the context menu's copy body text)
 * copies nothing at all from a scratch document. `stream-type` is never
 * serialized back to the file: the scratch saver writes flat text from the
 * stream-list, and a .tid mount keeps the file's own header fields.
 */
const STREAM_TYPE = { 'stream-type': 'default' };

/**
 * Build the scratch wiki tiddlers for a parsed source.
 * The root tiddler carries `stream-list` (children order); each node gets
 * `parent`, its gap (`lithic-gap`), its stream type, and renders as markdown.
 * The node's depth is NOT recorded, because the tree already holds it and a
 * second copy of it is what a re-indent could not keep in step.
 *
 * `emptyNode` gives a source with no nodes at all one empty node. Streams adds
 * a node beside an existing one, so a document that mounts with nothing in it
 * offers nothing to double-click and the file stays empty for good. The node is
 * built by the same walk as every other node, so its fields cannot drift from a
 * parsed node's, and it sits at the top level with no stored gap: an untouched
 * file still saves as the empty file it was, and the first line typed into it
 * is the file's first line.
 */
export function scratchTiddlers(
  base: string,
  parse: ScratchParseResult,
  extraRootFields: Record<string, string> = {},
  options: { emptyNode?: boolean } = {}
): ScratchWikiPayload {
  const nodes: Array<Record<string, string>> = [];
  let counter = 0;

  // Depth-first, document order: each node is pushed before its descendants
  // (the stream-list is filled in after the children have been walked).
  const walk = (node: ScratchNode, parentTitle: string): string => {
    const title = scratchNodeTitle(base, ++counter);
    const tiddler: Record<string, string> = {
      title,
      parent: parentTitle,
      'lithic-gap': String(node.gapBefore),
      type: 'text/markdown',
      ...STREAM_TYPE,
      text: node.text
    };
    nodes.push(tiddler);
    if (node.children.length > 0) {
      tiddler['stream-list'] = node.children.map((child) => listEntry(walk(child, title))).join(' ');
    }
    return title;
  };

  const rootTitles = parse.roots.map((root) => walk(root, base));
  if (options.emptyNode === true && rootTitles.length === 0) {
    rootTitles.push(walk({ text: '', indent: 0, gapBefore: 0, children: [] }, base));
  }
  const root: Record<string, string> = {
    title: base,
    text: '',
    type: 'text/markdown',
    ...STREAM_TYPE,
    ...(rootTitles.length > 0 ? { 'stream-list': rootTitles.map(listEntry).join(' ') } : {}),
    ...extraRootFields
  };
  return { root, nodes };
}

/**
 * Serialize a mounted scratch wiki (given as field maps keyed by title, the
 * shape `getTiddlersAsJson` yields per tiddler) back to the flat source text.
 * Walks `stream-list` from the root; unknown/missing tiddlers are skipped.
 * Every node is written one tab under its parent, which is where the streams UI
 * is showing it, and every node is separated from the one before it by at least
 * one blank line, with the file's own larger gaps replayed on top of that floor.
 * The document's own first line opens without one. The file ends with a newline.
 */
export function serializeScratchWiki(
  rootTitle: string,
  getTiddler: (title: string) => Record<string, string> | undefined
): string {
  const root = getTiddler(rootTitle);
  if (!root) return '';

  const lines: string[] = [];
  // Cycle guard: hand-edited stream-lists can point at ancestors.
  const visiting = new Set<string>();
  const parseList = (value: string | undefined): string[] => {
    if (!value) return [];
    const entries: string[] = [];
    const regex = /\[\[([^\]]+)\]\]|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(value)) !== null) entries.push(match[1] ?? match[2]);
    return entries;
  };

  const emit = (title: string, parentIndent: number) => {
    if (visiting.has(title)) return; // Cycle: emit once, never recurse.
    const tiddler = getTiddler(title);
    if (!tiddler) return;
    visiting.add(title);
    const gap = parseInt(tiddler['lithic-gap'] ?? '0', 10);
    // One blank line is the floor between two nodes, whatever the file recorded:
    // a node added in the streams UI carries no gap of its own, and two top-level
    // nodes on adjacent lines would re-import as one paragraph. The
    // `lines.length > 0` guard keeps the floor off the document's first line.
    const blanks = Math.max(Number.isFinite(gap) ? gap : 0, 1);
    for (let i = 0; i < blanks && lines.length > 0; i++) lines.push('');
    const indent = parentIndent + 1;
    const pad = '\t'.repeat(Math.max(0, indent));
    (tiddler.text ?? '').split('\n').forEach((line) => lines.push(pad + line));
    for (const child of parseList(tiddler['stream-list'])) emit(child, indent);
  };

  for (const rootEntry of parseList(root['stream-list'])) emit(rootEntry, -1);
  const body = lines.join('\n');
  return body !== '' ? `${body}\n` : body;
}

/* ---
 * SCRATCH_SERIALIZE_RUNTIME is an ES5-string mirror of serializeScratchWiki
 * for the engine bootstrap (the mounted wiki serializes its nodes from its
 * inline saver script, where no module graph exists). It reads the wiki via
 * callbacks so it works against both $tw.wiki and plain field maps.
 * scratch-wiki.test.ts asserts behavioral parity with the module function.
 * --- */
export const SCRATCH_SERIALIZE_RUNTIME = `(function (root) {
  'use strict';
  function parseList(value) {
    if (!value) return [];
    var entries = [];
    var regex = /\\[\\[([^\\]]+)\\]\\]|(\\S+)/g;
    var match;
    while ((match = regex.exec(value)) !== null) entries.push(match[1] !== undefined ? match[1] : match[2]);
    return entries;
  }
  /**
   * Serialize the scratch wiki rooted at rootTitle back to flat text.
   * getTiddler(title) -> fields object (title/text/stream-list/lithic-*).
   */
  function serialize(rootTitle, getTiddler) {
    var rootNode = getTiddler(rootTitle);
    if (!rootNode) return '';
    var lines = [];
    var visiting = {};
    function emit(title, parentIndent) {
      if (visiting[title]) return;
      var tiddler = getTiddler(title);
      if (!tiddler) return;
      visiting[title] = true;
      var gap = parseInt(tiddler['lithic-gap'] || '0', 10);
      if (isNaN(gap) || gap < 0) gap = 0;
      // One blank line between two nodes is the floor, as in the module above:
      // a node with no gap of its own still gets air, and the first line of the
      // document still opens without it (the lines.length guard below).
      if (gap < 1) gap = 1;
      for (var i = 0; i < gap && lines.length > 0; i++) lines.push('');
      var indent = parentIndent + 1;
      if (indent < 0) indent = 0;
      var pad = new Array(indent + 1).join('\\t');
      var text = tiddler.text === undefined || tiddler.text === null ? '' : String(tiddler.text);
      var bodyLines = text.split('\\n');
      for (var j = 0; j < bodyLines.length; j++) lines.push(pad + bodyLines[j]);
      var children = parseList(tiddler['stream-list']);
      for (var k = 0; k < children.length; k++) emit(children[k], indent);
      visiting[title] = false;
    }
    var topEntries = parseList(rootNode['stream-list']);
    for (var e = 0; e < topEntries.length; e++) emit(topEntries[e], -1);
    var body = lines.join('\\n');
    return body !== '' ? body + '\\n' : body;
  }
  root.__LITHIC_SCRATCH_SERIALIZE__ = serialize;
})(typeof window !== 'undefined' ? window : globalThis);`;
