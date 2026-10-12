import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginPath = path.join(repoRoot, 'wiki/local-plugins/lithic-import-handler/pdf-drop-handler.js.tid');

function loadPdfImportPlugin() {
  const source = readFileSync(pluginPath, 'utf8').replace(/\r\n/g, '\n');
  const body = source.slice(source.indexOf('\n\n') + 2);
  const listeners = {};
  const tiddlers = new Map();
  const canvasRequests = [];
  const errors = [];
  let uuid = 0;

  class Tiddler {
    constructor(...parts) {
      this.fields = Object.assign({}, ...parts.map((part) => part?.fields ?? part));
    }
  }

  const page = {
    getViewport: () => ({ width: 600, height: 800 }),
    render: () => ({ promise: Promise.resolve() }),
    getTextContent: async () => ({ items: [{ str: 'Rasterized PDF text' }] }),
  };
  const pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: () => ({ promise: Promise.resolve({ numPages: 1, getPage: async () => page }) }),
  };
  const wiki = {
    addTiddler(tiddler) {
      tiddlers.set(tiddler.fields.title, tiddler);
    },
    deleteTiddler(title) {
      tiddlers.delete(title);
    },
    getTiddler: (title) => tiddlers.get(title),
    getTiddlerText: (title) => tiddlers.get(title)?.fields.text ?? null,
    generateNewTitle(title) {
      let candidate = title;
      let suffix = 1;
      while (tiddlers.has(candidate)) candidate = `${title} ${suffix++}`;
      return candidate;
    },
    getCreationFields: () => ({}),
    getModificationFields: () => ({}),
  };
  const canvas = {
    getContext: () => ({
      drawImage: () => {},
      getImageData: () => ({ data: [220, 25, 20, 255] }),
    }),
    toDataURL(type) {
      canvasRequests.push(type);
      return `data:${type};base64,rasterized-pdf-page`;
    },
  };
  const context = {
    exports: {},
    globalThis: {},
    require: (title) => {
      assert.equal(title, '$:/plugins/lithic/lithic-import-handler/pdf.js');
      return pdfjsLib;
    },
    $tw: {
      Tiddler,
      wiki,
      utils: {
        stringifyList: (items) => items.join(' '),
        parseStringArray: (value) => value ? value.split(/\s+/) : [],
        copyToClipboard: () => {},
      },
    },
    document: {
      addEventListener: (name, listener) => { listeners[name] = listener; },
      createEvent: () => ({
        initEvent() {},
      }),
      createElement: (name) => {
        assert.equal(name, 'canvas');
        return canvas;
      },
      querySelectorAll: () => [],
    },
    crypto: { randomUUID: () => `test-uuid-${++uuid}` },
    console: { error: (...args) => errors.push(args), log: () => {} },
    Date,
    Math,
    Promise,
    setTimeout,
  };

  vm.runInNewContext(body, context, { filename: pluginPath });
  context.exports.startup();
  return { listeners, tiddlers, canvasRequests, errors, canvas };
}

test('PDF import embeds a broadly supported raster image in its whiteboard page', async () => {
  const { listeners, tiddlers, canvasRequests, errors, canvas } = loadPdfImportPlugin();
  const file = {
    name: 'raster-regression.pdf',
    type: 'application/pdf',
    arrayBuffer: async () => new ArrayBuffer(8),
  };
  const event = {
    type: 'drop',
    dataTransfer: { files: [file] },
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  };

  listeners.drop(event);
  for (let attempt = 0; attempt < 100 && !tiddlers.has('$:/Import'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.deepEqual(errors, [], 'the importer should finish without reporting an error');
  assert.deepEqual(canvasRequests, ['image/png'], 'PDF pages must use the universally supported PNG canvas output');
  assert.deepEqual(canvas.getContext('2d').getImageData().data, [220, 25, 20, 255], 'the canvas should contain rendered page pixels');

  const container = tiddlers.get('raster-regression');
  assert.ok(container, 'the PDF import should create its parent stream');
  const childTitles = container.fields['stream-list'].split(' ');
  const textTiddler = tiddlers.get(childTitles.find((title) => title.endsWith('-text')));
  const whiteboard = tiddlers.get(childTitles.find((title) => title.endsWith('-whiteboard')));
  assert.match(textTiddler.fields.text, /Rasterized PDF text/);
  assert.ok(whiteboard, 'the import should create a whiteboard tiddler');

  const document = JSON.parse(whiteboard.fields.text).document;
  const asset = Object.values(document.assets)[0];
  const shape = Object.values(document.pages.page.shapes)[0];
  assert.equal(asset.fileName, 'page_1.png');
  assert.match(asset.src, /^data:image\/png;base64,/);
  assert.deepEqual(shape.size, [600, 800]);
  assert.equal(document.assets[shape.assetId].src, asset.src);
});
