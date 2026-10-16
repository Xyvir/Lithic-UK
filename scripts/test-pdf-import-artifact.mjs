/**
 * Does a real PDF drop come out as a whiteboard with ink on every page?
 *
 * The regression this exists for (build-2026.09.16-1658 onward): the prod build's
 * uglify pass re-minified the import handler's already-minified pdfjs-dist bundles,
 * so pdf.js produced blank canvases and every imported page was pure white while the
 * import itself reported success. A unit test with a mocked pdf.js cannot see that,
 * so this test drives the shipped artifact in a real browser: it drops
 * scripts/fixtures/pdf-import-smoke.pdf on it, reads the whiteboard document the
 * handler wrote, and measures the pixels of every page image it embedded. White
 * pages (or a page that failed to decode) fail the test.
 *
 * The second half drives the other way in: a PDF the desktop app opened by file
 * association, whose bytes arrive on the window before the wiki boots. That gesture
 * is not a drop and does not end in the same place, so what it is required to do is
 * asserted on the built page: the board it produced is drawn full screen, in the
 * white board layout, and the story river is not on screen at all.
 *
 * The companion check scripts/check-pdf-plugin-unminified.mjs asserts the same
 * artifact still carries the plugin's text unmodified, which is the mechanism the
 * white pages came from.
 *
 * Usage:
 *   node scripts/test-pdf-import-artifact.mjs                    # tests src/lithic.html
 *   node scripts/test-pdf-import-artifact.mjs wiki/output/index.html
 *   node scripts/test-pdf-import-artifact.mjs wiki/output/index.html --pdf deck.pdf
 *
 * --pdf runs the same drive-and-measure against somebody's own document. It skips
 * the assertions that only make sense for the bundled fixture (page count, the
 * markdown heading), still requires ink on every page, and prints the payload the
 * import costs, which is how the PNG-versus-WebP choice for page images is judged.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PAGES = 3;

const argv = process.argv.slice(2);
const pdfFlag = argv.indexOf('--pdf');
const suppliedPdf = pdfFlag === -1 ? null : argv[pdfFlag + 1];
assert.ok(pdfFlag === -1 || suppliedPdf, '--pdf needs a file path');
const pdfValueIndex = pdfFlag === -1 ? -1 : pdfFlag + 1;
const positional = argv.filter((value, index) => !value.startsWith('--') && index !== pdfValueIndex);
const artifact = path.resolve(repoRoot, positional[0] || 'src/lithic.html');
const fixturePath = suppliedPdf ? path.resolve(suppliedPdf) : path.join(repoRoot, 'scripts/fixtures/pdf-import-smoke.pdf');
const pdfName = path.basename(fixturePath);
assert.ok(existsSync(artifact), `no artifact at ${artifact}`);
assert.ok(existsSync(fixturePath), `no fixture at ${fixturePath}`);

// The plugin's tiddlers carry their own titles, which is also what the handler
// requires by name. The plugin root (xyvir) is a different title again.
const PLUGIN_ROOT = '$:/plugins/xyvir/lithic-import-handler';
const PDFJS = '$:/plugins/lithic/lithic-import-handler/pdf.js';
// The association path's own module: a PDF opened from the desktop app never reaches the drop
// handler, so an artifact without this one would still import on a drop and quietly do nothing
// on a double-click.
const OPEN_REQUEST = '$:/plugins/lithic/lithic-import-handler/pdf-open-request.js';
// Where a board is drawn full screen. The importer sets this layout, and the whiteboard
// plugin owns it, so it is named here rather than read out of the module under test.
const WHITEBOARD_LAYOUT = '$:/plugins/linonetwo/tw-whiteboard/tiddlywiki-ui/PageLayout/WhiteBoard';

const artifactHtml = readFileSync(artifact, 'utf8');
const storeMatch = /<script class="tiddlywiki-tiddler-store" type="application\/json">([\s\S]*?)<\/script>/.exec(artifactHtml);
assert.ok(storeMatch, `${path.basename(artifact)} carries no tiddler store`);
const store = JSON.parse(storeMatch[1]);
const pluginEntry = store.find((tiddler) => tiddler.title === PLUGIN_ROOT);
assert.ok(pluginEntry, `${PLUGIN_ROOT} is not in ${path.basename(artifact)}; this artifact has no PDF import`);
const inner = JSON.parse(pluginEntry.text).tiddlers;
assert.ok(inner[PDFJS], `${PDFJS} is missing from the plugin bundle`);
assert.ok(inner[OPEN_REQUEST], `${OPEN_REQUEST} is missing from the plugin bundle`);

const pdfBytes = [...readFileSync(fixturePath)];

/**
 * Runs inside the page: drop the PDF, wait for the handler's $:/Import, and measure
 * the ink on every page image the whiteboard document references.
 */
const DRIVER = async ([bytes, name]) => {
  const stats = { status: 'running', pages: 0, text: '', assets: [], progress: '' };
  const file = new File([new Uint8Array(bytes)], name, { type: 'application/pdf' });
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: { files: [file] } });
  document.dispatchEvent(event);

  const deadline = Date.now() + 120000;
  const progress = () => window.$tw?.wiki?.getTiddlerText('$:/temp/alerts/lithic-import-progress') || '';
  while (Date.now() < deadline) {
    if (window.$tw?.wiki?.getTiddler('$:/Import')) break;
    await new Promise((done) => setTimeout(done, 200));
  }
  const imported = window.$tw?.wiki?.getTiddler('$:/Import');
  if (!imported) return { ...stats, status: 'timeout', progress: progress() };

  const titles = (imported.fields.text.match(/# \[\[(.*?)\]\]/g) || []).map((line) => line.slice(4, -2));
  const parents = titles.map((title) => window.$tw.wiki.getTiddler(title)).filter(Boolean);
  const children = parents
    .flatMap((parent) => window.$tw.utils.parseStringArray(parent.fields['stream-list'] || ''))
    .map((title) => window.$tw.wiki.getTiddler(title))
    .filter(Boolean);
  const textTiddler = children.find((tiddler) => (tiddler.fields.type || '').startsWith('text/'));
  if (textTiddler) stats.text = textTiddler.fields.text.replace(/\s+/g, ' ').slice(0, 120);

  const boards = children
    .filter((tiddler) => tiddler.fields.type === 'application/tldr')
    .map((tiddler) => ({ title: tiddler.fields.title, document: JSON.parse(tiddler.fields.text).document }));
  if (!boards.length) return { ...stats, status: 'no-whiteboard' };

  const { document: board } = boards[0];
  stats.whiteboard = boards[0].title;
  const pageIds = Object.keys(board.pages);
  stats.pages = pageIds.length;

  for (const pageId of pageIds) {
    const shape = Object.values(board.pages[pageId].shapes)[0];
    const asset = shape && board.assets[shape.assetId];
    if (!asset) {
      stats.assets.push({ page: board.pages[pageId].name, missing: true });
      continue;
    }
    const pixels = await new Promise((done) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let nonWhite = 0;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum += (data[i] + data[i + 1] + data[i + 2]) / 3;
          if (data[i] < 248 || data[i + 1] < 248 || data[i + 2] < 248) nonWhite++;
        }
        const total = data.length / 4;
        done({
          width: canvas.width,
          height: canvas.height,
          mean: +(sum / total).toFixed(2),
          inkPct: +((100 * nonWhite) / total).toFixed(2)
        });
      };
      image.onerror = () => done({ decodeFailed: true });
      image.src = asset.src;
    });
    stats.assets.push({
      page: board.pages[pageId].name,
      fileName: asset.fileName,
      format: (asset.src.match(/^data:([^;,]+)/) || [])[1] || 'unknown',
      bytes: asset.src.length,
      shapeSize: shape.size,
      assetSize: asset.size,
      pixels
    });
  }
  return { ...stats, status: 'ok' };
};

/**
 * Runs inside the page: the bytes are already on the window (see `evaluateOnNewDocument`
 * below), so this waits for the importer to produce a board and move the page onto it, then
 * reports both the wiki state and what the browser was asked to draw from it. `layout` is the
 * test's expectation, passed in so the wait ends on the state being asserted rather than on a
 * timeout.
 */
const OPEN_DRIVER = async ([layout, progressTitle]) => {
  const stats = { status: 'running', progress: '' };
  const wikiOf = () => window.$tw?.wiki;
  const progress = () => wikiOf()?.getTiddlerText(progressTitle) || '';
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    const wiki = wikiOf();
    if (wiki?.getTiddlerText('$:/layout') === layout) break;
    await new Promise((done) => setTimeout(done, 200));
  }
  const wiki = wikiOf();
  stats.progress = progress();
  if (!wiki) return { ...stats, status: 'no-wiki' };
  stats.consumed = window.__LITHIC_PDF_IMPORT__ === null;
  stats.layout = wiki.getTiddlerText('$:/layout') || '';
  stats.board = wiki.getTiddlerText('$:/state/Whiteboard/PageLayout/tiddler') || '';
  stats.sidebar = wiki.getTiddlerText('$:/state/sidebar') || '';
  stats.notebookSidebar = wiki.getTiddlerText('$:/state/notebook-sidebar') || '';
  // A story list is a `list` field, not text, which is why it is read as one.
  stats.story = wiki.getTiddler('$:/StoryList')?.fields.list || '';
  // Whether the board mounted before or after the engine's own boot-delay flag landed: the
  // whiteboard is a React widget and that flag is what keeps one from rendering into a page
  // the core is still building, so this is the number to look at if the deck ever goes odd.
  stats.bootComplete = wiki.getTiddlerText('$:/state/Lithic/BootComplete') || '';
  if (stats.layout !== layout) return { ...stats, status: 'timeout' };
  // The board itself, and how many pages the document it points at carries.
  const board = wiki.getTiddler(stats.board);
  stats.boardType = board?.fields.type || '';
  stats.boardPages = board ? Object.keys(JSON.parse(board.fields.text).document.pages).length : 0;
  // The layout draws the board in its own main area, and the river is not in the document at
  // all while it is up. `.tl-canvas` is tldraw's own canvas, so it is the board being drawn
  // rather than the shell around it.
  stats.boardArea = Boolean(document.querySelector('.tw-whiteboard-layout-main-area'));
  stats.canvas = Boolean(document.querySelector('.tw-whiteboard-layout-main-area .tl-canvas'));
  stats.river = Boolean(document.querySelector('.tc-story-river'));
  return { ...stats, status: 'ok' };
};

console.log(`artifact: ${path.relative(repoRoot, artifact)}`);
console.log(`pdf:      ${path.relative(repoRoot, fixturePath)}`);
const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--allow-file-access-from-files']
});
let failure = null;
try {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await page.goto(pathToFileURL(artifact).href, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => Boolean(window.$tw?.wiki), { timeout: 60000 });
  const result = await page.evaluate(DRIVER, [pdfBytes, pdfName]);

  console.log(`import status: ${result.status}${result.progress ? ` (${result.progress})` : ''}`);
  if (result.pages) console.log(`whiteboard: ${result.whiteboard} (${result.pages} pages)`);
  for (const asset of result.assets) {
    if (asset.missing) {
      console.log(`  ${String(asset.page).padEnd(8)} no image asset`);
      continue;
    }
    const px = asset.pixels.decodeFailed
      ? 'image failed to decode'
      : `${asset.pixels.width}x${asset.pixels.height} ink ${asset.pixels.inkPct}% mean ${asset.pixels.mean}`;
    console.log(`  ${String(asset.page).padEnd(8)} ${String(asset.fileName).padEnd(12)} ${asset.format.padEnd(11)} ${String(asset.bytes).padStart(8)} bytes  ${px}`);
  }

  assert.equal(result.status, 'ok', `the import did not produce a whiteboard: ${JSON.stringify(result)}`);
  assert.ok(result.pages >= 1, 'the whiteboard carries no pages');
  if (!suppliedPdf) {
    assert.equal(result.pages, FIXTURE_PAGES, `expected ${FIXTURE_PAGES} pages from scripts/fixtures/pdf-import-smoke.pdf`);
    assert.match(result.text, /pdf-import-smoke/, 'the import should also write a markdown text tiddler');
  }

  for (const asset of result.assets) {
    assert.ok(!asset.missing, `${asset.page} has no image asset wired to its shape`);
    assert.ok(!asset.pixels.decodeFailed, `${asset.page}'s image asset does not decode`);
    assert.deepEqual(asset.shapeSize, asset.assetSize, `${asset.page}'s shape does not match its asset size`);
    assert.ok(
      asset.pixels.inkPct >= 2,
      `${asset.page} is blank: only ${asset.pixels.inkPct}% of its pixels differ from white (mean ${asset.pixels.mean})`
    );
  }
  const totalBytes = result.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  console.log(
    `\n${result.pages} pages, ${(totalBytes / 1024).toFixed(0)} KB of embedded images ` +
      `(${(totalBytes / result.pages / 1024).toFixed(0)} KB per page), ` +
      `ink ${Math.min(...result.assets.map((asset) => asset.pixels.inkPct))}% to ${Math.max(...result.assets.map((asset) => asset.pixels.inkPct))}%`
  );
  if (!suppliedPdf) {
    const wettest = Math.max(...result.assets.map((asset) => asset.pixels.inkPct));
    assert.ok(wettest > 10, `no page carries its fixture block; the most inked page is ${wettest}%`);
  }

  console.log(`PASS: every imported page carries rendered ink`);

  /*
   * The other gesture. A double-click is not a drop: the launcher reads the file's bytes,
   * hands them to the document it mounts, and the page the person is looking at is the board
   * the import produced rather than the river it landed in. `evaluateOnNewDocument` is what
   * puts the payload in place before the wiki boots, which is the only order that works: the
   * importer reads the property during startup and clears it.
   */
  const openPayload = {
    filename: 'opened-by-association.pdf',
    base64: readFileSync(fixturePath).toString('base64')
  };
  const openPage = await browser.newPage();
  openPage.on('pageerror', (error) => pageErrors.push(error.message));
  openPage.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  await openPage.evaluateOnNewDocument((payload) => {
    window.__LITHIC_PDF_IMPORT__ = payload;
  }, openPayload);
  await openPage.goto(pathToFileURL(artifact).href, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await openPage.waitForFunction(() => Boolean(window.$tw?.wiki), { timeout: 60000 });
  const opened = await openPage.evaluate(OPEN_DRIVER, [WHITEBOARD_LAYOUT, '$:/temp/alerts/lithic-import-progress']);

  console.log(`open status: ${opened.status}${opened.progress ? ` (${opened.progress})` : ''}`);
  console.log(
    `  layout ${opened.layout}\n  board  ${opened.board} (${opened.boardType}, ${opened.boardPages} pages)\n` +
      `  drawn  board area ${opened.boardArea}, tldraw canvas ${opened.canvas}, story river ${opened.river}\n` +
      `  sidebars ${JSON.stringify(opened.sidebar)} ${JSON.stringify(opened.notebookSidebar)}, story list ${JSON.stringify(opened.story)}\n` +
      `  boot flag at that moment ${JSON.stringify(opened.bootComplete)}`
  );

  assert.equal(opened.status, 'ok', `the opened PDF did not reach the full screen board: ${JSON.stringify(opened)}`);
  assert.equal(opened.consumed, true, 'the payload is taken off the window, so it cannot be read twice or saved into the Lith');
  assert.equal(opened.layout, WHITEBOARD_LAYOUT, 'the white board layout is what draws the page');
  assert.equal(opened.boardType, 'application/tldr', 'the board the layout names is a whiteboard document');
  if (!suppliedPdf) {
    assert.match(opened.board, /^opened-by-association(-whiteboard)?$/, `the board is named after the file that was opened: ${opened.board}`);
    assert.equal(opened.boardPages, FIXTURE_PAGES, `the open path imports the same pages a drop does: ${opened.boardPages}`);
  }
  assert.equal(opened.sidebar, 'no', 'the sidebar is out of the way, the way the Fullscreen Whiteboard control leaves it');
  assert.equal(opened.notebookSidebar, 'no', 'and so is the notebook sidebar');
  assert.equal(opened.boardArea, true, 'the layout that is up is the white board one');
  assert.equal(opened.canvas, true, 'a board is actually drawn in it, not an empty layout');
  assert.equal(opened.river, false, 'and the story river is not on screen behind it');
  // The story list arrives as the array the field is parsed into, so it is joined before it
  // is matched rather than handed to `assert.match`, which insists on a string.
  assert.ok(
    String(opened.story).includes(opened.board),
    `the board is what the river holds, so leaving the board lands on it: ${JSON.stringify(opened.story)}`
  );

  console.log(`PASS: a PDF opened by file association lands full screen on its own board`);
} catch (error) {
  failure = error;
  console.error(`\nFAIL: ${error.message}`);
} finally {
  await browser.close();
}
if (failure) process.exit(1);
