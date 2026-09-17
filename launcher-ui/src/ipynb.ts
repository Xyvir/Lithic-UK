/**
 * Jupyter notebook (.ipynb) support for the scratch editor.
 *
 * Mount:  notebook cells -> scratch node tree (code cells wrapped in
 *         ```python fences so the ephemeral coderunner sees runnable blocks;
 *         cell outputs become marked child nodes)
 * Save:   $tw.wiki -> serializeIpynbWiki -> valid notebook JSON -> original path
 *
 * Representation inside the editor:
 *   - top-level stream nodes are cells (code = fenced, markdown = verbatim,
 *     raw = verbatim + `lithic-ipynb-raw` marker)
 *   - outputs of a code cell are its stream children, each carrying the
 *     `lithic-ipynb-output` marker (error outputs are fenced tracebacks)
 *   - unmarked children of a cell node re-export as plain markdown cells
 *   - the document root carries `lithic-ipynb-meta` (JSON: original notebook
 *     metadata + nbformat versions) so saves preserve kernelspec/language_info
 *
 * Notebook staleness caveats (deliberate): execution counts reset to null and
 * image outputs are dropped on import — the editor is a text surface.
 */

import { scratchTiddlers, type ScratchNode, type ScratchParseResult } from './scratch-wiki.ts';

const FENCE = '```';
const DEFAULT_LANGUAGE = 'python';

export type IpynbOutput = { kind: 'stream' | 'error' | 'data'; text: string };
export type IpynbCell = {
  type: 'code' | 'markdown' | 'raw';
  source: string;
  outputs: IpynbOutput[];
};
export type IpynbNotebook = {
  cells: IpynbCell[];
  metadata: Record<string, unknown>;
  nbformat: number;
  nbformatMinor: number;
};

/** nbformat `source` is a string or an array of lines (trailing newlines kept). */
function sourceToText(source: unknown): string {
  if (Array.isArray(source)) return source.map((line) => String(line)).join('');
  return typeof source === 'string' ? source : '';
}

function dataText(data: Record<string, unknown> | undefined, key = 'text/plain'): string | null {
  const value = data?.[key];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((line) => String(line)).join('');
  return null;
}

/** Parse notebook JSON into cells; throws on anything that is not a notebook. */
export function parseIpynb(source: string): IpynbNotebook {
  const raw = JSON.parse(source) as {
    cells?: unknown;
    metadata?: Record<string, unknown>;
    nbformat?: number;
    nbformat_minor?: number;
  };
  if (!raw || !Array.isArray(raw.cells)) throw new Error('Not a Jupyter notebook (missing cells array)');
  const cells: IpynbCell[] = raw.cells.map((entry) => {
    const cell = (entry ?? {}) as {
      cell_type?: string;
      source?: unknown;
      outputs?: Array<Record<string, unknown>>;
    };
    const type = cell.cell_type === 'code' || cell.cell_type === 'markdown' ? cell.cell_type : 'raw';
    const outputs: IpynbOutput[] = [];
    if (type === 'code') {
      for (const out of cell.outputs ?? []) {
        const outputType = String(out.output_type ?? '');
        if (outputType === 'stream') {
          const text = sourceToText(out.text);
          if (text !== '') outputs.push({ kind: 'stream', text });
        } else if (outputType === 'error') {
          const traceback = Array.isArray(out.traceback) ? out.traceback.map((l) => String(l)).join('\n') : String(out.evalue ?? '');
          if (traceback !== '') outputs.push({ kind: 'error', text: traceback });
        } else if (outputType === 'execute_result' || outputType === 'display_data') {
          const text = dataText(out.data as Record<string, unknown> | undefined);
          if (text) outputs.push({ kind: 'data', text });
        }
      }
    }
    return { type, source: sourceToText(cell.source), outputs };
  });
  return {
    cells,
    metadata: raw.metadata ?? {},
    nbformat: typeof raw.nbformat === 'number' ? raw.nbformat : 4,
    nbformatMinor: typeof raw.nbformat_minor === 'number' ? raw.nbformat_minor : 5
  };
}

/** Kernel language for a notebook (drives the code fence). */
export function notebookLanguage(nb: Pick<IpynbNotebook, 'metadata'>): string {
  const languageInfo = nb.metadata?.language_info as { name?: unknown } | undefined;
  const name = typeof languageInfo?.name === 'string' && languageInfo.name.trim() !== '' ? languageInfo.name.trim() : '';
  return name || DEFAULT_LANGUAGE;
}

/** Wrap a code cell's source in a fence the ephemeral coderunner can run. */
export function fenceCodeSource(source: string, language: string): string {
  const body = source.endsWith('\n') ? source.slice(0, -1) : source;
  return `${FENCE}${language}\n${body}\n${FENCE}`;
}

/** True when `text` is exactly a fence-wrapped block for `language`. */
export function isKernelFence(text: string, language: string): boolean {
  const open = `${FENCE}${language}\n`;
  return text.startsWith(open) && text.endsWith(`\n${FENCE}`);
}

/** Unwrap a kernel-fenced code block back to its source. */
export function unfenceCodeSource(text: string, language: string): string {
  return text.slice(`${FENCE}${language}\n`.length, text.length - `\n${FENCE}`.length);
}

/**
 * Convert parsed cells into the scratch node tree: one top-level node per
 * cell, outputs as marked children of their code cell.
 */
export function nodesFromNotebook(nb: IpynbNotebook): ScratchParseResult {
  const language = notebookLanguage(nb);
  const roots: ScratchNode[] = [];
  nb.cells.forEach((cell, index) => {
    const node: ScratchNode = {
      text: cell.type === 'code' ? fenceCodeSource(cell.source, language) : cell.source,
      indent: 0,
      gapBefore: index === 0 ? 0 : 1,
      children: []
    };
    if (cell.type === 'raw') (node as ScratchNode & { rawCell?: boolean }).rawCell = true;
    if (cell.type === 'code') {
      for (const out of cell.outputs) {
        if (out.text.trim() === '') continue;
        // Every output child (stream, error, data) carries outputKind so the
        // marker pass below tags it; untagged children export as markdown.
        node.children.push({
          text: out.kind === 'error' ? `${FENCE}\n${out.text}\n${FENCE}` : out.text,
          indent: 1,
          gapBefore: 0,
          children: [],
          outputKind: out.kind
        } as ScratchNode & { outputKind?: string });
      }
    }
    roots.push(node);
  });
  return { roots, trailingBlankLines: 0, endsWithNewline: true };
}

/**
 * Build the scratch wiki payload for a notebook: streams tiddlers plus the
 * root markers (`lithic-ipynb`, `lithic-ipynb-meta`) and per-node markers
 * (`lithic-ipynb-output` for outputs, `lithic-ipynb-raw` for raw cells).
 */
export function ipynbTiddlers(source: string, base: string): Array<Record<string, string>> {
  const nb = parseIpynb(source);
  const parse = nodesFromNotebook(nb);
  const { root, nodes } = scratchTiddlers(base, parse);
  root['lithic-ipynb'] = 'yes';
  root['lithic-ipynb-meta'] = JSON.stringify({
    metadata: nb.metadata,
    nbformat: nb.nbformat,
    nbformat_minor: nb.nbformatMinor
  });

  // Replicate scratchTiddlers' DFS numbering to map tree nodes to titles.
  const markers = new Map<string, string>();
  let counter = 0;
  const walk = (node: ScratchNode, marker?: string) => {
    const title = `${base} ${++counter}`;
    if (marker) markers.set(title, marker);
    for (const child of node.children) {
      const childKind = (child as ScratchNode & { outputKind?: string }).outputKind;
      walk(child, marker === undefined ? childKind : undefined);
    }
  };
  for (const root0 of parse.roots) {
    walk(root0, (root0 as ScratchNode & { rawCell?: boolean }).rawCell ? 'raw' : undefined);
  }
  for (const tiddler of nodes) {
    const marker = markers.get(tiddler.title);
    if (marker === 'stream' || marker === 'error' || marker === 'data') tiddler['lithic-ipynb-output'] = 'yes';
    if (marker === 'raw') tiddler['lithic-ipynb-raw'] = 'yes';
  }
  return [root, ...nodes];
}

/* --- Wiki -> notebook serialization (module + ES5 runtime mirror) --- */

/** Parse a TW list field ([[Title With Spaces]] / bare tokens). */
function parseList(value: string | undefined): string[] {
  if (!value) return [];
  const entries: string[] = [];
  const regex = /\[\[([^\]]+)\]\]|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(value)) !== null) entries.push(match[1] ?? match[2]);
  return entries;
}

export type IpynbWikiCell = IpynbCell & { executionCount: number | null };

/** Collect cells (in document order) from the mounted scratch wiki fields. */
export function cellsFromIpynbWiki(
  rootTitle: string,
  getTiddler: (title: string) => Record<string, string> | undefined
): IpynbWikiCell[] | null {
  const root = getTiddler(rootTitle);
  if (!root) return null;
  let meta: { metadata?: Record<string, unknown>; nbformat?: number; nbformat_minor?: number } = {};
  try { meta = JSON.parse(root['lithic-ipynb-meta'] ?? '{}') as typeof meta; } catch { /* defaults */ }
  const language = notebookLanguage({ metadata: (meta.metadata ?? {}) as IpynbNotebook['metadata'] });

  const cells: IpynbWikiCell[] = [];
  const emitMarkdownTree = (title: string, text: string) => {
    cells.push({ type: 'markdown', source: text, outputs: [], executionCount: null });
    for (const child of parseList(getTiddler(title)?.['stream-list'])) {
      const t = getTiddler(child);
      if (t) emitMarkdownTree(child, t.text ?? '');
    }
  };

  for (const entry of parseList(root['stream-list'])) {
    const tiddler = getTiddler(entry);
    if (!tiddler) continue;
    const text = tiddler.text ?? '';
    if (isKernelFence(text, language)) {
      const cell: IpynbWikiCell = {
        type: 'code',
        source: unfenceCodeSource(text, language),
        outputs: [],
        executionCount: null
      };
      for (const child of parseList(tiddler['stream-list'])) {
        const t = getTiddler(child);
        if (!t) continue;
        const childText = t.text ?? '';
        if (t['lithic-ipynb-output'] === 'yes') {
          if (childText.startsWith(`${FENCE}\n`) && childText.endsWith(`\n${FENCE}`)) {
            cell.outputs.push({ kind: 'error', text: childText.slice(4, childText.length - 4) });
          } else {
            cell.outputs.push({ kind: 'stream', text: childText });
          }
        } else {
          emitMarkdownTree(child, childText);
        }
      }
      cells.push(cell);
    } else if (tiddler['lithic-ipynb-raw'] === 'yes') {
      cells.push({ type: 'raw', source: text, outputs: [], executionCount: null });
    } else {
      emitMarkdownTree(entry, text);
    }
  }
  return cells;
}

/** nbformat source array: every line but the last carries a trailing \n. */
function textToSourceArray(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  return lines.map((line, index) => (index < lines.length - 1 ? `${line}\n` : line));
}

function cellToJson(cell: IpynbWikiCell): Record<string, unknown> {
  const source = textToSourceArray(cell.source);
  if (cell.type === 'code') {
    return {
      cell_type: 'code',
      execution_count: cell.executionCount,
      metadata: {},
      outputs: cell.outputs.map((out) => {
        if (out.kind === 'error') {
          return { output_type: 'error', ename: 'Error', evalue: 'Traceback', traceback: textToSourceArray(out.text) };
        }
        return { name: 'stdout', output_type: 'stream', text: textToSourceArray(out.text) };
      }),
      source
    };
  }
  if (cell.type === 'raw') return { cell_type: 'raw', metadata: {}, source };
  return { cell_type: 'markdown', metadata: {}, source };
}

/** Serialize cells + stored metadata to valid notebook JSON (1-space indent). */
export function serializeIpynbText(cells: IpynbWikiCell[], meta: Record<string, unknown>): string {
  const metadata = (meta.metadata ?? {}) as Record<string, unknown>;
  const nbformat = typeof meta.nbformat === 'number' ? meta.nbformat : 4;
  const nbformatMinor = typeof meta.nbformat_minor === 'number' ? meta.nbformat_minor : 5;
  return JSON.stringify({ cells: cells.map(cellToJson), metadata, nbformat, nbformat_minor: nbformatMinor }, null, 1);
}

/**
 * Serialize a mounted notebook scratch wiki back to .ipynb JSON text.
 * Returns null when the root tiddler is missing (the saver leaves the file
 * untouched on null, mirroring the other scratch serializers).
 */
export function serializeIpynbWiki(
  rootTitle: string,
  getTiddler: (title: string) => Record<string, string> | undefined
): string | null {
  const root = getTiddler(rootTitle);
  if (!root) return null;
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(root['lithic-ipynb-meta'] ?? '{}') as Record<string, unknown>; } catch { /* defaults */ }
  const cells = cellsFromIpynbWiki(rootTitle, getTiddler) ?? [];
  return serializeIpynbText(cells, meta);
}

/* ---
 * IPYNB_SERIALIZE_RUNTIME is an ES5-string mirror of serializeIpynbWiki for
 * the engine bootstrap (the mounted wiki serializes its nodes from its
 * inline saver script, where no module graph exists). ipynb parity tests
 * assert behavioral parity with the module functions.
 * --- */
export const IPYNB_SERIALIZE_RUNTIME = `(function (root) {
  'use strict';
  var FENCE = '\\u0060\\u0060\\u0060';
  function parseList(value) {
    if (!value) return [];
    var entries = [];
    var regex = /\\[\\[([^\\]]+)\\]\\]|(\\S+)/g;
    var match;
    while ((match = regex.exec(value)) !== null) entries.push(match[1] !== undefined ? match[1] : match[2]);
    return entries;
  }
  function tryParseMeta(raw) {
    try { return JSON.parse(raw || '{}') || {}; } catch (e) { return {}; }
  }
  function notebookLanguage(metadata) {
    var info = metadata && metadata.language_info;
    if (info && typeof info.name === 'string' && info.name.trim() !== '') return info.name.trim();
    return 'python';
  }
  function isKernelFence(text, language) {
    var open = FENCE + language + '\\n';
    return text.indexOf(open) === 0 && text.lastIndexOf('\\n' + FENCE) === text.length - ('\\n' + FENCE).length && text.length > open.length;
  }
  function unfence(text, language) {
    return text.slice((FENCE + language + '\\n').length, text.length - ('\\n' + FENCE).length);
  }
  function isTraceFence(text) {
    return text.indexOf(FENCE + '\\n') === 0 && text.lastIndexOf('\\n' + FENCE) === text.length - ('\\n' + FENCE).length && text.length > (FENCE + '\\n').length;
  }
  function unfenceTrace(text) {
    return text.slice((FENCE + '\\n').length, text.length - ('\\n' + FENCE).length);
  }
  function sourceArray(text) {
    if (text === '') return [];
    var lines = text.split('\\n');
    var out = [];
    for (var i = 0; i < lines.length; i++) out.push(i < lines.length - 1 ? lines[i] + '\\n' : lines[i]);
    return out;
  }
  /**
   * Serialize the notebook scratch wiki rooted at rootTitle back to .ipynb
   * JSON text. getTiddler(title) -> fields object.
   */
  function serialize(rootTitle, getTiddler) {
    var rootNode = getTiddler(rootTitle);
    if (!rootNode) return null;
    var meta = tryParseMeta(rootNode['lithic-ipynb-meta']);
    var metadata = meta.metadata || {};
    var language = notebookLanguage(metadata);
    var cells = [];
    function markdownTree(title, text) {
      cells.push({ cell_type: 'markdown', metadata: {}, source: sourceArray(text) });
      var children = parseList((getTiddler(title) || {})['stream-list']);
      for (var i = 0; i < children.length; i++) {
        var t = getTiddler(children[i]);
        if (t) markdownTree(children[i], t.text === undefined || t.text === null ? '' : String(t.text));
      }
    }
    var topEntries = parseList(rootNode['stream-list']);
    for (var e = 0; e < topEntries.length; e++) {
      var tiddler = getTiddler(topEntries[e]);
      if (!tiddler) continue;
      var text = tiddler.text === undefined || tiddler.text === null ? '' : String(tiddler.text);
      if (isKernelFence(text, language)) {
        var outputs = [];
        var children = parseList(tiddler['stream-list']);
        for (var c = 0; c < children.length; c++) {
          var t = getTiddler(children[c]);
          if (!t) continue;
          var childText = t.text === undefined || t.text === null ? '' : String(t.text);
          if (t['lithic-ipynb-output'] === 'yes') {
            if (isTraceFence(childText)) outputs.push({ output_type: 'error', ename: 'Error', evalue: 'Traceback', traceback: sourceArray(unfenceTrace(childText)) });
            else outputs.push({ name: 'stdout', output_type: 'stream', text: sourceArray(childText) });
          } else {
            markdownTree(children[c], childText);
          }
        }
        cells.push({ cell_type: 'code', execution_count: null, metadata: {}, outputs: outputs, source: sourceArray(unfence(text, language)) });
      } else if (tiddler['lithic-ipynb-raw'] === 'yes') {
        cells.push({ cell_type: 'raw', metadata: {}, source: sourceArray(text) });
      } else {
        markdownTree(topEntries[e], text);
      }
    }
    return JSON.stringify({ cells: cells, metadata: metadata, nbformat: typeof meta.nbformat === 'number' ? meta.nbformat : 4, nbformat_minor: typeof meta.nbformat_minor === 'number' ? meta.nbformat_minor : 5 }, null, 1);
  }
  root.__LITHIC_IPYNB_SERIALIZE__ = serialize;
})(typeof window !== 'undefined' ? window : globalThis);
`;
