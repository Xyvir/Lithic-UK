/**
 * Does a right-click draw the tiddler context menu where the pointer is?
 *
 * The regression this exists for (from build 2026.10.27): lifting both context menus into
 * the browser's top layer opened this one with `menu.style.inset = "auto"` AFTER the
 * caller had written `left`/`top`. `inset` is a shorthand for those two longhands, so the
 * coordinates were reset to `auto` and the fixed-position menu fell back to its static
 * position: painted near the top of the page while the pointer was halfway down the story.
 * The PWA and the desktop app both showed it, because both run this one artifact.
 *
 * Nothing could see it. The menu opened, it was on top, its items worked; only the
 * geometry was wrong, so every check that "the menu appears" passed. This probe measures
 * the geometry instead: it right-clicks a known point of a real artifact in a real browser
 * and asserts the menu's box starts at the pointer, and that a click with no room below
 * still leaves the menu's bottom edge at the pointer rather than off screen.
 *
 * Each case gets its own browser context. Adding a tiddler counts as an unsaved edit, and
 * this wiki asks about unsaved edits on the next boot in the same profile, so a shared
 * context would put a modal over the second case and swallow its right-click.
 *
 * Usage:
 *   node scripts/test-puppeteer-context-menu.mjs                          # src/lithic.html
 *   node scripts/test-puppeteer-context-menu.mjs wiki/output/index.html
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = path.resolve(repoRoot, process.argv[2] || 'src/lithic.html');
assert.ok(existsSync(artifact), `no artifact at ${artifact}`);
const artifactUrl = pathToFileURL(artifact).href;

// Tall enough that one click has room below it and another does not, so the menu's own
// flip is measured against the same tiddler.
const PROBE_TIDDLER = 'Context Menu Anchor Probe';
const PROBE_BODY = 'Probe body text, long enough to fill the viewport.\n\n'.repeat(40);

/** Runs inside the page: wait for the wiki, put a tiddler in the story, report where it sits. */
const SEED = async ([title, text]) => {
  const boot = Date.now() + 60000;
  while (Date.now() < boot && !window.$tw?.wiki) await new Promise((done) => setTimeout(done, 100));
  const wiki = window.$tw?.wiki;
  if (!wiki) return { status: 'no-wiki' };
  wiki.addTiddler({ title, text });
  wiki.addToStory(title);
  const frameOf = () => document.querySelector(`.tc-story-river [data-tiddler-title="${title}"]`);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !frameOf()) await new Promise((done) => setTimeout(done, 100));
  const frame = frameOf();
  if (!frame) return { status: 'no-frame' };
  const rect = frame.getBoundingClientRect();
  return {
    status: 'ok',
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight }
  };
};

/** Runs inside the page: what is under the pointer, which is what the menu is built from. */
const TARGET = ([x, y]) => {
  const element = document.elementFromPoint(x, y);
  return element?.closest?.('[data-tiddler-title]')?.getAttribute('data-tiddler-title') || null;
};

/** Runs inside the page: wait for the menu to open, then report where it landed. */
const MEASURE = async () => {
  const deadline = Date.now() + 10000;
  const menuOf = () => document.getElementById('contextMenu');
  while (Date.now() < deadline && menuOf()?.style.display !== 'block') {
    await new Promise((done) => setTimeout(done, 50));
  }
  const menu = menuOf();
  if (!menu) return { status: 'no-menu' };
  // The menu pops in (a 0.15s scale animation added so this menu moves like every other
  // drop-down in the wiki), and a transform moves the rect it reports, so the geometry
  // below is read once that settle has finished rather than sampled mid-pop. Every
  // assertion is unchanged: it still measures the menu's own box, just the settled one.
  await Promise.all(menu.getAnimations().map((animation) => animation.finished.catch(() => {})));
  const rect = menu.getBoundingClientRect();
  return {
    status: 'ok',
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
    items: menu.querySelectorAll('li').length,
    viewport: { width: window.innerWidth, height: window.innerHeight }
  };
};

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--allow-file-access-from-files']
});
let failure = null;
try {
  const pageErrors = [];

  /** Boot a fresh artifact, right-click one point of the probe tiddler, report the menu. */
  const rightClickAt = async (name, place) => {
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.setViewport({ width: 1100, height: 900 });
    await page.goto(artifactUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });

    const seeded = await page.evaluate(SEED, [PROBE_TIDDLER, PROBE_BODY]);
    assert.equal(seeded.status, 'ok', `${name}: the probe tiddler did not reach the story: ${JSON.stringify(seeded)}`);
    const point = place(seeded.rect, seeded.viewport);
    const target = await page.evaluate(TARGET, [point.x, point.y]);
    assert.equal(
      target,
      PROBE_TIDDLER,
      `${name}: ${point.x},${point.y} is over ${JSON.stringify(target)}, not the tiddler being clicked`
    );

    // A real right-click, so the plugin's coordinates are whatever the browser reports.
    await page.mouse.click(point.x, point.y, { button: 'right' });
    const menu = await page.evaluate(MEASURE);
    await context.close();

    assert.equal(menu.status, 'ok', `${name}: a right-click drew no menu: ${JSON.stringify(menu)}`);
    assert.ok(menu.items > 0, `${name}: the menu opened with no items in it: ${JSON.stringify(menu)}`);
    return { ...menu, click: point };
  };

  /* The menu is written at exactly the pointer's client coordinates, so its top-left corner
   * is the pointer's. One pixel of slack for sub-pixel rounding. */
  const anchored = await rightClickAt('anchored', (rect) => ({
    x: Math.round(rect.left + 80),
    y: Math.round(rect.top + 30)
  }));
  console.log(
    `  anchored     click (${anchored.click.x}, ${anchored.click.y})  ` +
      `menu left ${anchored.rect.left} top ${anchored.rect.top} (${anchored.rect.width}x${anchored.rect.height})`
  );
  assert.ok(
    Math.abs(anchored.rect.left - anchored.click.x) <= 1,
    `the menu opened ${Math.round(anchored.rect.left - anchored.click.x)}px right of the pointer ` +
      `(click x ${anchored.click.x}, menu left ${anchored.rect.left})`
  );
  assert.ok(
    Math.abs(anchored.rect.top - anchored.click.y) <= 1,
    `the menu opened ${Math.round(anchored.rect.top - anchored.click.y)}px below the pointer ` +
      `(click y ${anchored.click.y}, menu top ${anchored.rect.top})`
  );

  /* Near the bottom of the window the menu flips above the pointer, which puts the click on
   * its bottom edge instead of its top. Anything else is a menu hanging off the screen. The
   * point comes from the frame rather than from a remembered pixel, so a narrower sidebar or
   * a taller theme cannot move the click off the tiddler and quietly stop testing the flip. */
  const flipped = await rightClickAt('flipped', (rect, viewport) => ({
    x: Math.round(rect.left + 80),
    y: Math.min(Math.round(rect.top + rect.height - 20), viewport.height - 20)
  }));
  console.log(
    `  flipped      click (${flipped.click.x}, ${flipped.click.y})  ` +
      `menu left ${flipped.rect.left} top ${flipped.rect.top} bottom ${flipped.rect.bottom}`
  );
  assert.ok(
    flipped.click.y + flipped.rect.height > flipped.viewport.height,
    `the flip case needs no room below the pointer: click y ${flipped.click.y}, menu ${flipped.rect.height} tall in ${flipped.viewport.height}`
  );
  assert.ok(
    Math.abs(flipped.rect.bottom - flipped.click.y) <= 1,
    `a menu with no room below should flip above the pointer: click y ${flipped.click.y}, menu bottom ${flipped.rect.bottom}`
  );
  assert.ok(flipped.rect.top >= 0, `the flipped menu starts above the window: top ${flipped.rect.top}`);
  assert.ok(
    Math.abs(flipped.rect.left - flipped.click.x) <= 1,
    `flipping up should not move the menu sideways: click x ${flipped.click.x}, menu left ${flipped.rect.left}`
  );

  assert.deepEqual(pageErrors, [], 'the artifact threw while the menu was opened');
  console.log(`PASS: the context menu opens at the pointer (${path.relative(repoRoot, artifact)})`);
} catch (error) {
  failure = error;
  console.error(`\nFAIL: ${error.message}`);
} finally {
  await browser.close();
}
if (failure) process.exit(1);
