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
/**
 * One page of the fake document, as the importer sees it: the `/Rotate` a page carries, and the
 * text items with the matrix that says which way each one runs. Everything defaults to one
 * upright portrait page, which is the document the existing tests are about.
 *
 * `viewports` records the rotation each render asks for, which is how the uprighting is judged:
 * the importer never turns the pixels it has already drawn, it asks pdf.js for a turned viewport.
 */
function fakePage(spec, viewports) {
  const rotate = spec.rotate || 0;
  const items = spec.items || [{ str: 'Rasterized PDF text', transform: [1, 0, 0, 1, 0, 0] }];
  return {
    rotate,
    getViewport: ({ rotation } = {}) => {
      const applied = (((rotation === undefined ? rotate : rotation) % 360) + 360) % 360;
      viewports.push(applied);
      // A quarter turn swaps the sides, which is what makes a sideways page a wide one.
      return applied % 180 === 0 ? { width: 600, height: 800 } : { width: 800, height: 600 };
    },
    render: () => ({ promise: Promise.resolve() }),
    getTextContent: async () => ({ items }),
  };
}

function createPdfContext({ pages = [{}] } = {}) {
  const listeners = {};
  const viewports = [];
  const tiddlers = new Map();
  const canvasRequests = [];
  const errors = [];
  const saves = [];
  // What the screen looked like at the moment of each save: the layout, and the board it
  // names. This records the live view rather than what the file ends up carrying: a save drops
  // `$:/layout` (view state, not document state), so a written Lith is not where a layout is
  // read back from. A file that carries one is read on mount, which is what the open path shows.
  const saveStates = [];
  let uuid = 0;

  class Tiddler {
    constructor(...parts) {
      this.fields = Object.assign({}, ...parts.map((part) => part?.fields ?? part));
    }
  }

  const documentPages = pages.map((spec) => fakePage(spec, viewports));
  const pdfjsLib = {
    GlobalWorkerOptions: {},
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: documentPages.length,
        getPage: async (number) => documentPages[number - 1],
      }),
    }),
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
    // The boards a Lith carries, which is the fallback the importer's open request asks for when
    // the container it was given holds none. Only real tiddlers count, never the whiteboard
    // plugin's blank template, so it is asked for the file's own boards rather than every board
    // this wiki can see.
    filterTiddlers: (filter) => {
      assert.match(filter, /\[all\[tiddlers\]field:type\[application\/tldr\]/);
      return [...tiddlers.values()]
        .filter((tiddler) => tiddler.fields.type === 'application/tldr')
        .map((tiddler) => tiddler.fields.title);
    },
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
      // Opening a PDF writes nothing (the save the person presses is what makes the sibling), so
      // the test watches for a dispatch that must not come, and records the view it was taken of.
      rootWidget: {
        dispatchEvent: (event) => {
          saves.push(event && event.type);
          saveStates.push({
            layout: tiddlers.get('$:/layout')?.fields.text ?? null,
            board: tiddlers.get('$:/state/Whiteboard/PageLayout/tiddler')?.fields.text ?? null,
          });
        },
      },
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

  return { context, listeners, tiddlers, canvasRequests, errors, saves, saveStates, canvas, viewports };
}

function loadPdfImportPlugin(options) {
  const loaded = createPdfContext(options);
  vm.runInNewContext(moduleBody(dropHandlerPath), loaded.context, { filename: dropHandlerPath });
  loaded.context.exports.startup();
  return loaded;
}

/**
 * Both modules run in one context, in boot order: the drop handler's module scope publishes
 * the render path, and the open-request module is the one whose `startup` is called.
 *
 * `handoff` is what the launcher leaves on the window: the PDF's bytes when it is importing one,
 * the container the import wrote when the Lith beside the PDF is what opens, and nothing at all
 * when that Lith is opened on its own. `tiddlers` is the file being opened, standing in for the
 * store the launcher would have written it from.
 */
function loadPdfOpenRequest({
  pages = [{}],
  handoff = { __LITHIC_PDF_IMPORT__: { filename: 'imported-doc.pdf', base64: 'AAAAAQ==' } },
  tiddlers = [],
} = {}) {
  const loaded = createPdfContext({ pages });
  tiddlers.forEach((fields) => loaded.tiddlers.set(fields.title, { fields }));
  loaded.context.window = handoff;
  vm.runInNewContext(moduleBody(dropHandlerPath), loaded.context, { filename: dropHandlerPath });
  vm.runInNewContext(moduleBody(openRequestPath), loaded.context, { filename: openRequestPath });
  return loaded;
}

/** The Lith a PDF's pages were imported into, as its own file holds it. */
const SIBLING_LITH = [
  { title: '$:/layout', text: '$:/core/ui/PageTemplate' },
  { title: 'thesis', 'stream-list': 'thesis-text thesis-whiteboard', 'stream-type': 'default', text: '' },
  { title: 'thesis-text', type: 'text/x-markdown', text: '## thesis' },
  { title: 'thesis-whiteboard', type: 'application/tldr', 'whiteboard-height': '1056px', text: '{"document":{}}' },
];

// The white board page layout, and the state that says which board it shows. Named here
// rather than imported from the module under test: this is the contract with the whiteboard
// plugin, so the test is the second place it is written down.
const FULLSCREEN_LAYOUT = '$:/plugins/linonetwo/tw-whiteboard/tiddlywiki-ui/PageLayout/WhiteBoard';
const BOARD_STATE = '$:/state/Whiteboard/PageLayout/tiddler';

test('PDF import embeds a compressed raster image in its whiteboard page', async () => {
  const { listeners, tiddlers, canvasRequests, errors, canvas, viewports } = loadPdfImportPlugin();
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
  assert.deepEqual(viewports, [0], 'an upright document is drawn at the angle it already has');
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
  // A drop is an edit to the wiki already on screen, so it stays on the page it was dropped
  // on. Only a file the desktop app opened in a window of its own takes the screen over.
  assert.equal(tiddlers.has('$:/layout'), false, 'a drop leaves the layout alone, so the river keeps the page');
  assert.equal(tiddlers.has(BOARD_STATE), false, 'and names no board, because no board is full screen');
});

test('a PDF the desktop app opens becomes a new Lith beside it, full screen and unwritten', async () => {
  const { context, tiddlers, saves, saveStates } = loadPdfOpenRequest();

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
    [],
    'nothing is written: reading a PDF is a view, and the sibling is created by the save a person presses'
  );
  // The board opens full screen: the same four tiddlers `$:/lithic/buttons/FullscreenWhiteboard`
  // sets, so a double-click lands where the button lands rather than on a tiddler in the river.
  assert.equal(
    tiddlers.get('$:/layout')?.fields.text,
    FULLSCREEN_LAYOUT,
    'the white board layout is what draws the page, not the story river'
  );
  assert.equal(
    tiddlers.get(BOARD_STATE)?.fields.text,
    'imported-doc-whiteboard',
    'and the layout is told which board to draw, rather than falling back to the newest one'
  );
  assert.deepEqual(
    [tiddlers.get('$:/state/sidebar')?.fields.text, tiddlers.get('$:/state/notebook-sidebar')?.fields.text],
    ['no', 'no'],
    'both sidebars are out of the way, the way the control leaves them'
  );
  assert.deepEqual(
    saveStates,
    [],
    'and no view was recorded for a save, because there was none to take one of'
  );
  assert.ok(tiddlers.get('imported-doc'), 'the container tiddler still exists beside the board');
  const whiteboard = tiddlers.get('imported-doc-whiteboard');
  assert.equal(whiteboard.fields.type, 'application/tldr');
  assert.equal(whiteboard.fields['whiteboard-height'], '1056px', 'the page height follows the page shape, the same rule a drop takes');
  assert.match(tiddlers.get('imported-doc-text').fields.text, /Rasterized PDF text/);
});

// The PDF on its second visit. The Lith beside it already exists, so the launcher mounts that file
// rather than importing over it and hands over the container the import wrote instead of any bytes.
// The gesture is still opening the PDF, so the board the pages are under is what opens, over
// whatever layout that Lith was last saved in -- the river, here.
test('a PDF whose Lith already exists opens on the board its pages are under', () => {
  const { context, tiddlers, saves } = loadPdfOpenRequest({
    handoff: { __LITHIC_OPEN_BOARD__: { container: 'thesis' } },
    tiddlers: SIBLING_LITH,
  });

  context.exports.startup();

  assert.equal(
    context.window.__LITHIC_OPEN_BOARD__,
    null,
    'the ask is taken off the window, so it cannot fire a second time'
  );
  assert.equal(
    tiddlers.get('$:/layout')?.fields.text,
    FULLSCREEN_LAYOUT,
    'the board layout overrules the layout the Lith was saved in'
  );
  assert.equal(
    tiddlers.get(BOARD_STATE)?.fields.text,
    'thesis-whiteboard',
    'and the board named is the one the pages are under, rather than whichever board is newest'
  );
  assert.equal(
    tiddlers.get('$:/StoryList')?.fields.list,
    'thesis-whiteboard',
    'leaving the board hands the river back to the board, not to the page the PDF came from'
  );
  assert.deepEqual(
    [tiddlers.get('$:/state/sidebar')?.fields.text, tiddlers.get('$:/state/notebook-sidebar')?.fields.text],
    ['no', 'no'],
    'both sidebars are out of the way, the way the control leaves them'
  );
  assert.equal(tiddlers.get('thesis-text')?.fields.text, '## thesis', 'the text child is left alone');
  assert.deepEqual(
    saves,
    [],
    'nothing is saved: the file is its own text, so a save would write it over itself for nothing'
  );
});

// A Lith with no board in it: an import interrupted before its board landed, or a save pressed
// while the converter was still working. There is nothing to open, so the file is left as it
// stands rather than being given the plugin's blank template to draw.
test('an ask for a board the Lith does not hold leaves it as it stands', () => {
  const { context, tiddlers, saves } = loadPdfOpenRequest({
    handoff: { __LITHIC_OPEN_BOARD__: { container: 'half-imported' } },
    tiddlers: [
      { title: '$:/layout', text: '$:/core/ui/PageTemplate' },
      { title: 'half-imported', text: '' },
    ],
  });

  context.exports.startup();

  assert.equal(tiddlers.get('$:/layout')?.fields.text, '$:/core/ui/PageTemplate', 'the layout is not touched');
  assert.equal(tiddlers.has(BOARD_STATE), false, 'and no board is named');
  assert.equal(tiddlers.has('$:/StoryList'), false, 'nor is the river moved');
  assert.deepEqual(saves, [], 'and the file is not written');
});

// And the half that keeps the forcing honest: the same Lith opened on its own, from the launcher or
// a recents row, is not a PDF being opened and carries no ask, so it keeps what it says.
test('a Lith opened on its own keeps the layout it was saved in', () => {
  const { context, tiddlers, saves } = loadPdfOpenRequest({ handoff: {}, tiddlers: SIBLING_LITH });

  context.exports.startup();

  assert.equal(tiddlers.get('$:/layout')?.fields.text, '$:/core/ui/PageTemplate', 'the saved layout stands');
  assert.equal(tiddlers.has(BOARD_STATE), false, 'no board is forced on it');
  assert.equal(tiddlers.has('$:/StoryList'), false, 'and the river is left as the file left it');
  assert.deepEqual(saves, [], 'a plain mount writes nothing by itself');
});

// A document printed sideways is drawn upright, and the page geometry is what proves it: pdf.js
// is asked for a turned viewport rather than the pixels being turned afterwards, so the page the
// board gets is already wide rather than a tall page with a sideways picture in it.
test('a document whose text runs sideways is drawn upright', async () => {
  const sideways = { str: 'Everything on this page is written bottom to top', transform: [0, 1, -1, 0, 0, 0] };
  const { context, errors, viewports } = loadPdfImportPlugin({
    pages: [{ items: [sideways] }, { items: [sideways] }],
  });

  const imported = await context.$tw.lithic.convertPdfToTiddlers(
    new ArrayBuffer(8),
    'sideways-doc.pdf',
    () => {}
  );

  assert.deepEqual(errors, [], 'the import finishes without reporting an error');
  assert.deepEqual(viewports, [90, 90], 'both pages are asked for a quarter turn clockwise');
  const whiteboard = imported.find((tiddler) => tiddler.title === 'sideways-doc-whiteboard');
  const document = JSON.parse(whiteboard.text).document;
  const shape = Object.values(document.pages.page.shapes)[0];
  assert.deepEqual(shape.size, [800, 600], 'the page is wide, because it was turned before it was drawn');
  assert.equal(
    whiteboard['whiteboard-height'],
    '540px',
    'and the board is laid out for a landscape page, the same rule an upright document takes'
  );
});

// The other half of that rule: a page that leans one way and a page that leans another is a
// jumbled file, and straightening it would leave pages facing different ways. Nothing is turned.
test('a document whose pages disagree about direction is left as it is', async () => {
  const upright = { str: 'x'.repeat(100), transform: [1, 0, 0, 1, 0, 0] };
  const sideways = { str: 'x'.repeat(100), transform: [0, 1, -1, 0, 0, 0] };
  const { context, viewports } = loadPdfImportPlugin({
    pages: [{ items: [upright] }, { items: [sideways] }],
  });

  await context.$tw.lithic.convertPdfToTiddlers(new ArrayBuffer(8), 'jumbled-doc.pdf', () => {});

  assert.deepEqual(viewports, [0, 0], 'a file that cannot be straightened as a whole is not touched');
});

// And the floor under the judgement: a page with too little text on it for a direction to mean
// anything (a stamp, a form field, a scan of a picture) is left alone rather than turned on the
// strength of two words.
test('a page with almost no text is not turned', async () => {
  const stamp = { str: 'DRAFT', transform: [0, 1, -1, 0, 0, 0] };
  const { context, viewports } = loadPdfImportPlugin({ pages: [{ items: [stamp] }] });

  await context.$tw.lithic.convertPdfToTiddlers(new ArrayBuffer(8), 'stamped-doc.pdf', () => {});

  assert.deepEqual(viewports, [0], 'five letters on one page are not a document direction');
});
