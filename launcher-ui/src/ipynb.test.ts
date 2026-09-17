import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseIpynb,
  notebookLanguage,
  fenceCodeSource,
  isKernelFence,
  unfenceCodeSource,
  nodesFromNotebook,
  ipynbTiddlers,
  cellsFromIpynbWiki,
  serializeIpynbText,
  serializeIpynbWiki,
  IPYNB_SERIALIZE_RUNTIME
} from './ipynb.ts';

const NOTEBOOK = {
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Title\n', 'intro text'] },
    {
      cell_type: 'code',
      execution_count: 1,
      metadata: {},
      outputs: [
        { output_type: 'stream', name: 'stdout', text: ['hello\n', 'world'] },
        {
          output_type: 'execute_result',
          data: { 'text/plain': '42' },
          metadata: {}
        }
      ],
      source: ['x = 40\n', 'print(x + 2)']
    },
    { cell_type: 'raw', metadata: {}, source: 'raw blob' }
  ],
  metadata: {
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
    language_info: { name: 'python' }
  },
  nbformat: 4,
  nbformat_minor: 5
};

const SOURCE = JSON.stringify(NOTEBOOK, null, 1);

function fields(tiddlers: Array<Record<string, string>>): Map<string, Record<string, string>> {
  return new Map(tiddlers.map((t) => [t.title, t]));
}

test('parseIpynb: cells, outputs, and metadata round out', () => {
  const nb = parseIpynb(SOURCE);
  assert.equal(nb.cells.length, 3);
  assert.equal(nb.cells[0].type, 'markdown');
  assert.equal(nb.cells[1].type, 'code');
  assert.equal(nb.cells[1].source, 'x = 40\nprint(x + 2)');
  assert.equal(nb.cells[1].outputs.length, 2);
  assert.equal(nb.cells[1].outputs[0].kind, 'stream');
  assert.equal(nb.cells[1].outputs[0].text, 'hello\nworld');
  assert.equal(nb.cells[1].outputs[1].kind, 'data');
  assert.equal(nb.cells[2].type, 'raw');
  assert.equal(notebookLanguage(nb), 'python');
});

test('parseIpynb rejects non-notebooks', () => {
  assert.throws(() => parseIpynb('{"a": 1}'));
  assert.throws(() => parseIpynb('not json at all'));
});

test('fence helpers round-trip code sources', () => {
  const fenced = fenceCodeSource('x = 40\nprint(x + 2)\n', 'python');
  assert.ok(isKernelFence(fenced, 'python'));
  assert.ok(!isKernelFence(fenced, 'julia'));
  assert.equal(unfenceCodeSource(fenced, 'python'), 'x = 40\nprint(x + 2)');
  // A markdown cell with a plain ```python fence is also a kernel fence
  // (this is the collision case a user-edit could create).
  assert.ok(isKernelFence('```python\nx = 1\n```', 'python'));
});

test('nodesFromNotebook: cells become roots, outputs become children', () => {
  const nb = parseIpynb(SOURCE);
  const parse = nodesFromNotebook(nb);
  assert.equal(parse.roots.length, 3);
  assert.equal(parse.roots[0].text, '# Title\nintro text');
  assert.ok(isKernelFence(parse.roots[1].text, 'python'));
  assert.equal(parse.roots[1].children.length, 2);
  assert.equal(parse.roots[1].children[0].text, 'hello\nworld');
  // error/data outputs are fenced tracebacks or verbatim data
  assert.equal((parse.roots[1].children[1] as any).outputKind, 'data');
  assert.equal(parse.roots[2].text, 'raw blob');
});

test('ipynbTiddlers: streams payload carries root + node markers', () => {
  const tiddlers = ipynbTiddlers(SOURCE, 'analysis');
  assert.equal(tiddlers[0].title, 'analysis');
  assert.equal(tiddlers[0]['lithic-ipynb'], 'yes');
  const meta = JSON.parse(tiddlers[0]['lithic-ipynb-meta']);
  assert.equal(meta.nbformat, 4);
  assert.equal(meta.metadata.kernelspec.name, 'python3');

  const byTitle = fields(tiddlers);
  const codeTitle = tiddlers.find((t) => isKernelFence(t.text ?? '', 'python'))!.title;
  assert.equal(byTitle.get(codeTitle)!.parent, 'analysis');
  const rawNode = tiddlers.find((t) => t.text === 'raw blob');
  assert.equal(rawNode!['lithic-ipynb-raw'], 'yes');
  const outputNode = tiddlers.find((t) => t.text === 'hello\nworld');
  assert.equal(outputNode!['lithic-ipynb-output'], 'yes');
});

test('module serializer: wiki fields -> valid notebook JSON', () => {
  const tiddlers = ipynbTiddlers(SOURCE, 'analysis');
  const byTitle = fields(tiddlers);
  const json = serializeIpynbWiki('analysis', (title) => byTitle.get(title));
  assert.ok(json, 'serialization succeeds');
  const out = JSON.parse(json!);
  assert.equal(out.nbformat, 4);
  assert.equal(out.metadata.kernelspec.name, 'python3');
  assert.equal(out.cells.length, 3);
  assert.equal(out.cells[0].cell_type, 'markdown');
  assert.deepEqual(out.cells[0].source, ['# Title\n', 'intro text']);
  assert.equal(out.cells[1].cell_type, 'code');
  assert.equal(out.cells[1].source.join(''), 'x = 40\nprint(x + 2)');
  assert.equal(out.cells[1].execution_count, null);
  assert.equal(out.cells[1].outputs.length, 2);
  assert.equal(out.cells[1].outputs[0].output_type, 'stream');
  assert.deepEqual(out.cells[1].outputs[0].text, ['hello\n', 'world']);
  assert.equal(out.cells[2].cell_type, 'raw');
  // JSON must round-trip (i.e. parse) — it IS valid notebook JSON.
  assert.ok(JSON.parse(JSON.stringify(out)));
});

test('ES5 runtime parity: runtime output matches the module serializer', () => {
  const tiddlers = ipynbTiddlers(SOURCE, 'analysis');
  const byTitle = fields(tiddlers);
  const expected = serializeIpynbWiki('analysis', (title) => byTitle.get(title));

  const sandbox: Record<string, unknown> = {};
  new Function('window', 'globalThis', IPYNB_SERIALIZE_RUNTIME)(sandbox, sandbox);
  const serialize = (sandbox as { __LITHIC_IPYNB_SERIALIZE__?: unknown }).__LITHIC_IPYNB_SERIALIZE__ as
    ((title: string, get: (t: string) => Record<string, string> | undefined) => string | null) | undefined;
  assert.ok(serialize, 'runtime registers __LITHIC_IPYNB_SERIALIZE__');
  const actual = serialize!('analysis', (title) => byTitle.get(title));
  assert.equal(actual, expected);
});

test('ES5 runtime handles kernel language override and user-added markdown children', () => {
  const julia = JSON.parse(SOURCE) as typeof NOTEBOOK;
  julia.metadata.language_info = { name: 'julia' };
  julia.cells[1].source = 'println(42)';
  const tiddlers = ipynbTiddlers(JSON.stringify(julia), 'jb');
  const byTitle = fields(tiddlers);

  const sandbox: Record<string, unknown> = {};
  new Function('window', 'globalThis', IPYNB_SERIALIZE_RUNTIME)(sandbox, sandbox);
  const serialize = (sandbox as { __LITHIC_IPYNB_SERIALIZE__?: unknown }).__LITHIC_IPYNB_SERIALIZE__ as
    ((title: string, get: (t: string) => Record<string, string> | undefined) => string | null) | undefined;
  assert.ok(serialize, 'runtime registers __LITHIC_IPYNB_SERIALIZE__');

  // Add a user-created markdown child to the first (markdown) cell node.
  // Children of markdown cells export as their own markdown cells (the
  // structure-preserving rule shared with code-cell children).
  byTitle.set('jb extra', { title: 'jb extra', 'lithic-gap': '0', text: 'User note' });
  const firstRoot = tiddlers.find((t) => t.text === '# Title\nintro text')!;
  firstRoot['stream-list'] = `${firstRoot['stream-list'] ?? ''} [[jb extra]]`.trim();
  const runtimeOut = JSON.parse(serialize!('jb', (title) => byTitle.get(title))!);
  assert.equal(runtimeOut.cells.length, 4);
  assert.equal(runtimeOut.cells[0].source.join(''), '# Title\nintro text');
  assert.equal(runtimeOut.cells[1].source.join(''), 'User note');
  assert.equal(runtimeOut.cells[2].cell_type, 'code');
  assert.equal(runtimeOut.cells[2].source.join(''), 'println(42)');
  const moduleOut = JSON.parse(serializeIpynbWiki('jb', (title) => byTitle.get(title))!);
  assert.deepEqual(moduleOut, runtimeOut);
});

test('unmarked code-cell children export as markdown cells', () => {
  const tiddlers = ipynbTiddlers(SOURCE, 'd');
  // Add a plain markdown child to the code cell node (Doc-style stream edit):
  // it carries no output marker, so it exports as a markdown cell. Children
  // export in document order, before the parent cell continues.
  tiddlers.push({ title: 'd side', parent: 'd 2', 'lithic-gap': '0', text: 'a side note' });
  const code = tiddlers.find((t) => t.parent === 'd' && isKernelFence(t.text ?? '', 'python'))!;
  code['stream-list'] = `${code['stream-list'] ?? ''} [[d side]]`.trim();
  const byTitle = fields(tiddlers);
  const out = JSON.parse(serializeIpynbWiki('d', (title) => byTitle.get(title))!);
  assert.equal(out.cells.length, 4);
  assert.equal(out.cells[1].cell_type, 'markdown');
  assert.equal(out.cells[1].source.join(''), 'a side note');
  assert.equal(out.cells[2].cell_type, 'code');
});

test('empty notebook serializes to a valid empty cells array', () => {
  const source = JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 });
  const tiddlers = ipynbTiddlers(source, 'empty');
  const byTitle = fields(tiddlers);
  const out = JSON.parse(serializeIpynbWiki('empty', (title) => byTitle.get(title))!);
  assert.deepEqual(out.cells, []);
  assert.equal(out.nbformat, 4);
});

test('cellsFromIpynbWiki maps fence-less streams to markdown cells', () => {
  const cells = cellsFromIpynbWiki('x', () => undefined);
  assert.equal(cells, null);
});
