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
      // The drop handler's module scope asks for the archive reader a book and a Word document
      // are both unpacked with. Nothing here imports either, so the names it destructures only
      // have to exist: a test that reached one would be testing a second module.
      if (title === '$:/plugins/lithic/lithic-import-handler/epub.js') {
        const unused = () => {
          throw new Error('the archive reader is not part of this test');
        };
        return {
          convertEpubToTiddlers: unused,
          readEntries: () => null,
          readText: async () => null,
          findEntry: () => null,
          entryBytes: unused,
          parseXml: unused,
          resolveHref: unused,
        };
      }
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
    // The picture half of a drop: a decoder that reports a size, and a reader that hands back a
    // data URL. Both answer on the next tick, the way a real one does rather than inside the
    // call that asked, which is what lets the importer await them.
    Image: class {
      constructor() {
        this.width = 400;
        this.height = 300;
        this.naturalWidth = 400;
        this.naturalHeight = 300;
      }
      set src(value) {
        this._src = value;
        setTimeout(() => this.onload && this.onload(), 0);
      }
      get src() {
        return this._src;
      }
    },
    FileReader: class {
      readAsDataURL(file) {
        setTimeout(() => {
          this.result = `data:${file.type};base64,stub-picture`;
          if (this.onload) this.onload({ target: this });
        }, 0);
      }
    },
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

// --- One gesture, one document ------------------------------------------------
//
// A selection is one thing to the person making it, so it has to be one thing in the wiki: two
// PDFs dropped together used to become two Liths, and reading them in order meant opening each
// one. The page names are what the page menu is read from, and the file names are what tells two
// documents' page ones apart in the text extract.
function dropFiles(loaded, files) {
  const event = {
    type: 'drop',
    dataTransfer: { files },
    preventDefault() {},
    stopPropagation() {},
    stopImmediatePropagation() {},
  };
  loaded.listeners.drop(event);
  return new Promise((resolve) => {
    const poll = () => {
      if (loaded.tiddlers.has('$:/Import')) resolve();
      else setTimeout(poll, 0);
    };
    poll();
  });
}

function pdfFile(name) {
  return { name, type: 'application/pdf', arrayBuffer: async () => new ArrayBuffer(8) };
}

test('two PDFs dropped together become one Lith with a page each', async () => {
  // Two pages in each, so the page names have to tell the two documents' page ones apart rather
  // than only being numbered once per board.
  const loaded = loadPdfImportPlugin({ pages: [{}, {}] });

  await dropFiles(loaded, [pdfFile('first.pdf'), pdfFile('second.pdf')]);

  assert.deepEqual(loaded.errors, [], 'the import finishes without reporting an error');
  assert.ok(loaded.tiddlers.get('first'), 'the selection lands under one container, named for its first file');
  assert.equal(loaded.tiddlers.has('second'), false, 'and the second file does not get a Lith of its own');

  const container = loaded.tiddlers.get('first');
  assert.deepEqual(
    container.fields['stream-list'].split(' '),
    ['first-text', 'first-whiteboard'],
    'one text extract and one board, in that order'
  );

  const document = JSON.parse(loaded.tiddlers.get('first-whiteboard').fields.text).document;
  const pages = Object.values(document.pages);
  assert.equal(pages.length, 4, 'every page of every document is on the one board');
  assert.deepEqual(
    pages.map((page) => page.name),
    ['first 1', 'first 2', 'second 1', 'second 2'],
    'the page menu names the file each page came from, so two page ones are told apart'
  );
  assert.equal(
    loaded.tiddlers.get('first-whiteboard').fields['whiteboard-height'],
    '1056px',
    'a portrait page sets the height even when it is not the first one'
  );

  const text = loaded.tiddlers.get('first-text').fields.text;
  assert.match(text, /^## first\n\n### first\.pdf/, 'the extract opens with the container, then the file');
  assert.match(text, /### second\.pdf/, 'and each document is named before its words');
  assert.equal(text.match(/#### Page 1/g).length, 2, 'both documents number their pages from their own first');
  assert.equal(text.match(/#### Page 2/g).length, 2, 'and their own second');
});

test('pictures dropped together become one multi-page board rather than one board each', async () => {
  const loaded = loadPdfImportPlugin();
  const pictures = ['one.png', 'two.png', 'three.png'].map((name) => ({
    name,
    type: 'image/png',
    arrayBuffer: async () => new ArrayBuffer(8),
  }));

  await dropFiles(loaded, pictures);

  assert.deepEqual(loaded.errors, [], 'the import finishes without reporting an error');
  assert.ok(loaded.tiddlers.get('one'), 'the pictures land under one container');
  assert.deepEqual(
    ['two', 'three'].filter((title) => loaded.tiddlers.has(title)),
    [],
    'a picture beside others is a page of that board, not a board of its own'
  );
  assert.equal(
    loaded.tiddlers.has('one-text'),
    false,
    'pictures have no words to extract, so no empty text node is invented for them'
  );

  const document = JSON.parse(loaded.tiddlers.get('one-whiteboard').fields.text).document;
  const pages = Object.values(document.pages);
  assert.equal(pages.length, 3, 'one page per picture');
  assert.deepEqual(
    pages.map((page) => page.name),
    ['one', 'two', 'three'],
    'each page wears the name of the picture on it'
  );
  assert.deepEqual(
    Object.values(document.assets).map((asset) => asset.fileName),
    ['one.webp', 'two.webp', 'three.webp'],
    'and each asset is the re-encoded picture, in the order the gesture carried them'
  );
  assert.equal(
    loaded.tiddlers.get('one-whiteboard').fields['whiteboard-height'],
    '540px',
    'a wide picture sets the height, the same rule a single dropped picture takes'
  );
});

// --- The launcher's gesture ---------------------------------------------------
//
// A selection dropped on the launcher has no open document to land in, so it travels as a list
// and the mounted page imports it. The tests below are the handoff that list arrives on.
async function settle(tiddlers) {
  for (let attempt = 0; attempt < 200 && !tiddlers.has('$:/StoryList'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('several files dropped on the launcher become one Lith with a page each', async () => {
  const { context, tiddlers, errors } = loadPdfOpenRequest({
    handoff: {
      __LITHIC_IMPORT_FILES__: [
        { filename: 'deck.pdf', base64: 'AAAA' },
        { filename: 'photo.png', base64: 'AAAA' },
      ],
    },
  });

  context.exports.startup();
  await settle(tiddlers);

  assert.deepEqual(errors, [], 'the import finishes without reporting an error');
  assert.equal(
    context.window.__LITHIC_IMPORT_FILES__,
    null,
    'the gesture is taken off the window, so a later mount cannot import it again'
  );
  assert.ok(tiddlers.get('deck'), 'the document is named for the first file in the gesture');
  assert.equal(tiddlers.has('photo'), false, 'and the picture beside it is a page, not a Lith of its own');

  const document = JSON.parse(tiddlers.get('deck-whiteboard').fields.text).document;
  assert.deepEqual(
    Object.values(document.pages).map((page) => page.name),
    ['deck', 'photo'],
    'one board holding the PDF page and the picture, in the order they were dropped'
  );
  assert.match(tiddlers.get('deck-text').fields.text, /### deck\.pdf/, 'the words are extracted beside the board');
  assert.equal(
    tiddlers.get('$:/StoryList').fields.list,
    'deck-whiteboard',
    'and the board is what opens, the way a dropped PDF opens'
  );
});

// One file on the gesture property is answered by the one-file route, so dropping a single PDF
// and double-clicking it produce the same document rather than two layouts of one import.
test('one file on the gesture route is read the way a double-click reads it', async () => {
  const { context, tiddlers } = loadPdfOpenRequest({
    handoff: { __LITHIC_IMPORT_FILES__: [{ filename: 'solo.pdf', base64: 'AAAA' }] },
  });

  context.exports.startup();
  await settle(tiddlers);

  assert.ok(tiddlers.get('solo'), 'the container is named for the file, as a double-click names it');
  const document = JSON.parse(tiddlers.get('solo-whiteboard').fields.text).document;
  assert.deepEqual(
    Object.values(document.pages).map((page) => page.name),
    ['Page 1'],
    'the one-file page naming, not the merged one that names pages after their file'
  );
  assert.equal(tiddlers.has('solo-text'), true, 'and the words are extracted, which a single PDF always gets');
});
