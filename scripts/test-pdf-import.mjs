import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = path.join(repoRoot, 'wiki/local-plugins/lithic-import-handler');
const dropHandlerPath = path.join(pluginDir, 'pdf-drop-handler.js.tid');
const openRequestPath = path.join(pluginDir, 'pdf-open-request.js.tid');

/**
 * The module body of a `.js.tid`: everything after its plain-text header. Both files are
 * CRLF in the repo, and the VM only ever sees the JavaScript.
 */
function moduleBody(file) {
  const source = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  return source.slice(source.indexOf('\n\n') + 2);
}

/**
 * A booted-enough wiki for the importer: a store, a canvas that reports pixels, and a pdf.js
 * that renders one page of text. Shared by both tests so the drop and the open-request are
 * judged against the same engine.
 */
function createPdfContext() {
  const listeners = {};
  const tiddlers = new Map();
  const canvasRequests = [];
  const errors = [];
  const saves = [];
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
    toDataURL(type, quality) {
      canvasRequests.push([type, quality]);
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
      // A save is how the new Lith lands on disk, so the test watches for the dispatch the
      // importer makes after it has finished rendering.
      rootWidget: { dispatchEvent: (event) => saves.push(event && event.type) },
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
    atob,
    Date,
    Math,
    Promise,
    setTimeout,
  };

  return { context, listeners, tiddlers, canvasRequests, errors, saves, canvas };
}

function loadPdfImportPlugin() {
  const loaded = createPdfContext();
  vm.runInNewContext(moduleBody(dropHandlerPath), loaded.context, { filename: dropHandlerPath });
  loaded.context.exports.startup();
  return loaded;
}

/**
 * Both modules run in one context, in boot order: the drop handler's module scope publishes
 * the render path, and the open-request module is the one whose `startup` is called. The
 * payload is what the launcher leaves on the window for the importer to find.
 */
function loadPdfOpenRequest({ base64 = 'AAAAAQ==' } = {}) {
  const loaded = createPdfContext();
  loaded.context.window = {
    __LITHIC_PDF_IMPORT__: { filename: 'imported-doc.pdf', base64 },
  };
  vm.runInNewContext(moduleBody(dropHandlerPath), loaded.context, { filename: dropHandlerPath });
  vm.runInNewContext(moduleBody(openRequestPath), loaded.context, { filename: openRequestPath });
  return loaded;
}

test('PDF import embeds a compressed raster image in its whiteboard page', async () => {
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
  assert.deepEqual(canvasRequests, [['image/webp', 0.75]], 'PDF pages must use WebP so a deck does not embed PNG-sized pages');
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
  assert.equal(asset.fileName, 'page_1.webp');
  assert.match(asset.src, /^data:image\/webp;base64,/);
  assert.deepEqual(shape.size, [600, 800]);
  assert.equal(document.assets[shape.assetId].src, asset.src);
});

test('a PDF the desktop app opens becomes a new Lith beside it, saved and on screen', async () => {
  const { context, tiddlers, saves } = loadPdfOpenRequest();

  context.exports.startup();
  for (let attempt = 0; attempt < 100 && !tiddlers.has('$:/StoryList'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  assert.equal(
    context.window.__LITHIC_PDF_IMPORT__,
    null,
    'the payload is taken off the window, so it cannot be read a second time or saved into the Lith'
  );
  assert.equal(
    tiddlers.get('$:/StoryList')?.fields.list,
    'imported-doc-whiteboard',
    'the board is what opens, because it is the whole point of the double-click'
  );
  assert.deepEqual(
    saves,
    ['tm-save-wiki'],
    'the new Lith is written to disk rather than left unsaved, so the copy exists as soon as it opens'
  );
  assert.ok(tiddlers.get('imported-doc'), 'the container tiddler still exists beside the board');
  const whiteboard = tiddlers.get('imported-doc-whiteboard');
  assert.equal(whiteboard.fields.type, 'application/tldr');
  assert.equal(whiteboard.fields['whiteboard-height'], '1056px', 'the page height follows the page shape, the same rule a drop takes');
  assert.match(tiddlers.get('imported-doc-text').fields.text, /Rasterized PDF text/);
});
