import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';

// The three candidate-PIN verdicts, shared with the gallery's stand-in for Rust so
// the wording has one home. `secretCheck` is spelled out in both mocks rather than
// imported, because a mock is serialised before it runs and closes over nothing.
import { SECRET_SENTENCES } from './vault-copy.mjs';

// A stand-in instance — the launcher artifact plus the CGI routes a deployment
// answers — so the self-host backup flow below can be driven instead of only
// unit-tested. See that module for what it does and does not imitate.
import { startSelfHostStub } from './self-host-stub.mjs';

// The built single-file launcher. Overridable so this can be pointed at a scratch
// build (`node scripts/build-launcher.mjs <path>`) without overwriting the committed
// artifact, which CI regenerates and which is never hand-built.
const artifact = resolve(process.env.LAUNCHER_ARTIFACT ?? 'src/launcher.html');
assert.ok(existsSync(artifact), `Build the launcher before running this test (${artifact})`);
// The artifact's own bytes, because one scenario has to serve a *different* launcher from
// the same URL — the redeploy that a cached copy cannot notice by itself.
const artifactHtml = await readFile(artifact, 'utf8');

// One bookmark fixture entry deliberately has no cached icon, so the launcher
// tries to fetch one from a host that does not exist (see the bookmark section).
const missingIconHost = 'no-icon.example.com';

/**
 * How every `waitForFunction` in this file polls.
 *
 * Puppeteer's default is `raf`, and an animation frame is only delivered to the page the
 * browser is painting: this suite opens a page (sometimes a whole browser context) per
 * section, so "not the painted one" is the ordinary case here, and a wait on a background
 * page then sits until it times out although the state it was waiting for arrived long
 * ago. A timer poll asks the same question and does not depend on anything being drawn.
 */
const POLL = { polling: 250 };

const browser = await puppeteer.launch({
  headless: process.env.HEADED === '1' ? false : 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  defaultViewport: { width: 900, height: 700 }
});

try {
  const page = await browser.newPage();
  const errors = [];
  // Loading via file:// makes the PWA manifest/favicon lookups fail at the
  // network layer (the legacy launcher behaves the same way on disk). Filter
  // that resource noise while still failing on real JavaScript errors.
  const isFileResourceNoise = (text) =>
    text.includes('Failed to load resource: net::ERR_FAILED') ||
    text.includes('Failed to load resource: net::ERR_FILE_NOT_FOUND') ||
    (text.includes('Access to manifest at') && text.includes('CORS policy'));
  // That fixture host cannot resolve, so the icon fetch it triggers reports a
  // DNS failure. Scoped to that host's own requests: every other failed fetch
  // still fails the run.
  const isFixtureIconNoise = (message) =>
    (message.location()?.url ?? '').startsWith(`https://${missingIconHost}/`);
  page.on('pageerror', error => { if (!isFileResourceNoise(error.message)) errors.push(error.message); });
  page.on('console', message => {
    if (message.type() !== 'error' || isFileResourceNoise(message.text()) || isFixtureIconNoise(message)) return;
    errors.push(message.text());
  });

  await page.goto(`file://${artifact}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main.container');
  // The recent section is conditional, so seed one deterministic local entry
  // before asserting its search and icon controls. The history affordance only
  // renders for a wiki with recorded versions, so the fixture gets one: the
  // version store keys its per-wiki record off `search_cache_meta_<name>`.
  await page.evaluate(async () => {
    localStorage.setItem('lithic-recent-liths', JSON.stringify([{ name: 'fixture.lith', text: '' }]));
    const request = indexedDB.open('keyval-store', 1);
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
    const db = request.result;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('keyval', 'readwrite');
      tx.objectStore('keyval').put(
        { headId: 'v1', versions: [{ id: 'v1', ts: Date.now(), sizeBytes: 120, isBase: true }] },
        'search_cache_meta_fixture.lith'
      );
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[aria-label="Search recent Liths"]');
  await new Promise(resolve => setTimeout(resolve, 250));

  // Enough entries to overflow the list, so the scrollbar the panel's padding
  // makes room for is actually part of the layout being asserted below.
  const seedScrollingRecents = async () => {
    await page.evaluate(() => {
      const rows = [{ name: 'fixture.lith', text: '' }];
      for (let index = 0; index < 19; index += 1) rows.push({ name: `overflow-${index}.lith`, text: '' });
      localStorage.setItem('lithic-recent-liths', JSON.stringify(rows));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[aria-label="Search recent Liths"]');
    await new Promise(resolve => setTimeout(resolve, 250));
  };

  // Which vertical edges the panel's children share, where the list's scrollbar
  // lands relative to them, and what that scrollbar is made of: a 4px rounded
  // thumb with the platform's arrow buttons switched off. The scrollbar belongs
  // in the panel's right padding, never between the rows and the search box —
  // and the whole panel is measured against the action card above it, because
  // "the rows line up with the buttons" is the thing a person actually sees.
  // Re-measured after the search filter drops the scrollbar, to prove the
  // reserved gutter keeps the rows from shifting sideways.
  const measurePanelEdges = () => page.evaluate(() => {
    const section = document.querySelector('.recent-section');
    const list = document.querySelector('.recent-list');
    const search = document.querySelector('input.recent-search');
    const row = document.querySelector('.recent-row');
    const reset = document.querySelector('.reset-cache');
    const card = document.querySelector('.action-card');
    if (!section || !list || !search || !row || !card) return null;
    const box = element => element.getBoundingClientRect();
    const style = getComputedStyle(section);
    const cardStyle = getComputedStyle(card);
    // The card's content box: exactly where its buttons start and end.
    const cardInnerLeft = box(card).left + parseFloat(cardStyle.borderLeftWidth) + parseFloat(cardStyle.paddingLeft);
    const cardInnerRight = box(card).right - parseFloat(cardStyle.borderRightWidth) - parseFloat(cardStyle.paddingRight);
    return {
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      gutter: list.offsetWidth - list.clientWidth,
      scrolls: list.scrollHeight > list.clientHeight,
      barWidth: getComputedStyle(list, '::-webkit-scrollbar').width,
      barArrows: getComputedStyle(list, '::-webkit-scrollbar-button').display,
      barThumbRadius: getComputedStyle(list, '::-webkit-scrollbar-thumb').borderRadius,
      rowVsSearchRight: box(row).right - box(search).right,
      rowVsSearchLeft: box(row).left - box(search).left,
      resetVsSearchRight: reset ? box(reset).right - box(search).right : null,
      searchVsCardLeft: box(search).left - cardInnerLeft,
      rowVsCardLeft: box(row).left - cardInnerLeft,
      searchVsCardRight: box(search).right - cardInnerRight,
      rowVsCardRight: box(row).right - cardInnerRight,
      resetVsCardRight: reset ? box(reset).right - cardInnerRight : null,
      // Padding box, i.e. where the panel's border sits on the inside.
      panelInnerRight: box(section).right - parseFloat(style.borderRightWidth),
      scrollbarOuterRight: box(list).right,
    };
  });

  const result = await page.evaluate(() => ({
    title: document.querySelector('h1')?.textContent?.trim(),
    newBlank: [...document.querySelectorAll('button')].some(button => button.textContent?.includes('New Blank Lith')),
    mount: [...document.querySelectorAll('button')].some(button => button.textContent?.includes('Mount a Lith')),
    search: document.querySelector('input[aria-label="Search recent Liths"]') !== null || document.querySelector('input[placeholder*="Search recent liths"]') !== null || document.querySelector('input.recent-search') !== null,
    inputCount: document.querySelectorAll('input').length,
    footer: [...document.querySelectorAll('a, button')].map(element => element.textContent?.trim()).filter(text => text === 'Github' || text === 'Install'),
    font: getComputedStyle(document.body).fontFamily,
    main: document.querySelector('main.container')?.getBoundingClientRect().toJSON(),
    footerBounds: document.querySelector('footer')?.getBoundingClientRect().toJSON(),
    searchIcon: document.querySelector('.recent-search-icon') !== null,
    historyIcon: document.querySelector('.history-download-icon') !== null,
    historyViewBox: document.querySelector('.history-download-icon')?.getAttribute('viewBox'),
    historyPaths: [...document.querySelectorAll('.history-download-icon path')].map(path => path.getAttribute('class')),
    historyShape: document.querySelector('.history-icon-shape')?.getAttribute('d'),
    historyRect: document.querySelector('.history-download-icon')?.getBoundingClientRect().toJSON(),
    searchPaddingLeft: getComputedStyle(document.querySelector('.recent-search')).paddingLeft,
    searchPaddingRight: getComputedStyle(document.querySelector('.recent-search')).paddingRight,
    searchHeight: document.querySelector('.recent-search')?.getBoundingClientRect().height,
    searchRect: document.querySelector('.recent-search')?.getBoundingClientRect().toJSON(),
    recentList: document.querySelector('.recent-list') ? {
      marginTop: getComputedStyle(document.querySelector('.recent-list')).marginTop,
      paddingRight: getComputedStyle(document.querySelector('.recent-list')).paddingRight
    } : null,
    mountBookmark: document.querySelector('.action-pair .bookmark-button')?.getBoundingClientRect().toJSON(),
    recentRows: [...document.querySelectorAll('.recent-row')].map(row => ({
      gap: getComputedStyle(row).gap,
      border: getComputedStyle(row).borderWidth,
      height: row.getBoundingClientRect().height,
      icons: row.querySelectorAll('.recent-icon-button').length
    }))
  }));

  assert.equal(result.title, 'Lithic - Launcher');
  assert.equal(result.newBlank, true);
  assert.equal(result.mount, true);
  assert.equal(result.search || result.inputCount === 0, true);
  // The install control only renders once the browser has offered an install
  // prompt (webapp) or the desktop install is not current, so headless Chromium
  // — which never fires `beforeinstallprompt` — legitimately has just the link.
  assert.deepEqual(result.footer.filter(text => text !== 'Install'), ['Github']);
  assert.match(result.font, /Vollkorn/i);
  assert.ok(result.main && result.main.width <= 600, 'Launcher remains within the legacy max width');
  assert.ok(result.footerBounds && result.footerBounds.left >= 0 && result.footerBounds.right <= 900, 'Footer controls remain within the viewport');
  assert.equal(result.searchIcon, true, 'Recent search includes an inline magnifying-glass icon');
  assert.equal(result.historyIcon, true, 'Recent rows include the history/download icon');
  assert.equal(result.historyViewBox, '56 108 33 36', 'History/download icon uses the supplied design proportions');
  assert.deepEqual(result.historyPaths, ['history-icon-shape']);
  assert.match(result.historyShape ?? '', /73\.595508/ , 'History/download icon uses the supplied vector path');
  assert.equal(result.searchPaddingLeft, '42px', 'Search text clears the magnifying-glass icon');
  assert.equal(result.searchPaddingRight, '42px', 'Search text leaves room for the clear control');
  assert.equal(result.searchHeight, 52, 'Recent search uses the shared control height');
  assert.equal(result.recentList?.marginTop, '10px', 'Recent rows have a visible separation from search');
  assert.equal(result.recentList?.paddingRight, '4px', 'Recent rows keep a gap from the list scrollbar');

  // Aligned edges, with the list scrolling. Exact: the scrollbar is the custom
  // 4px one, not the platform's 10-11px scrollbar, so the 8px pull in
  // .recent-list covers its width plus its gap exactly.
  await seedScrollingRecents();
  const edges = await measurePanelEdges();
  assert.ok(edges, 'Recent panel exposes its search box, rows and button');
  assert.equal(edges?.scrolls, true, 'Seeded recents make the list scroll, so the scrollbar is part of this layout');
  assert.equal(edges?.paddingLeft, edges?.paddingRight, 'Panel padding is symmetric, so the column stays centred');
  // 4px is the custom scrollbar's own width; the platform's thin scrollbar is
  // 10-11px, so anything above 4 means the ::-webkit-scrollbar rules went dead.
  assert.ok((edges?.gutter ?? 99) <= 4, 'Recent list reserves the custom 4px scrollbar, not the platform scrollbar');
  assert.equal(edges?.barWidth, '4px', 'Scrollbar styling is applied — setting scrollbar-width would make the engine ignore it');
  assert.equal(edges?.barArrows, 'none', 'Scrollbar has no arrow buttons at its ends');
  assert.match(edges?.barThumbRadius ?? '', /999px|3px/, 'Scrollbar thumb is rounded');
  // Half a pixel of slack: the reserved scrollbar width is rounded to whole
  // pixels when the display scale is fractional. A regression to the platform
  // scrollbar is a whole pixel or more of drift, so this still catches it.
  assert.ok(Math.abs(edges?.rowVsSearchLeft ?? 99) <= 0.5, 'Recent rows start where the search box starts');
  assert.ok(Math.abs(edges?.rowVsSearchRight ?? 99) <= 0.5, 'Recent rows end where the search box ends');
  assert.ok(Math.abs(edges?.resetVsSearchRight ?? 99) <= 0.5, 'Rebuild control ends where the search box ends');
  // The panel's contents share the action card's edges, not just each other's:
  // a scrollbar's worth of extra inset here is exactly the misalignment the
  // panel's padding exists to avoid.
  assert.ok(Math.abs(edges?.searchVsCardLeft ?? 99) <= 0.5, 'Search box starts where the action card’s buttons start');
  assert.ok(Math.abs(edges?.rowVsCardLeft ?? 99) <= 0.5, 'Recent rows start where the action card’s buttons start');
  assert.ok(Math.abs(edges?.searchVsCardRight ?? 99) <= 0.5, 'Search box ends where the action card’s buttons end');
  assert.ok(Math.abs(edges?.rowVsCardRight ?? 99) <= 0.5, 'Recent rows end where the action card’s buttons end');
  assert.ok(Math.abs(edges?.resetVsCardRight ?? 99) <= 0.5, 'Rebuild control ends where the action card’s buttons end');
  assert.ok((edges?.scrollbarOuterRight ?? 0) <= (edges?.panelInnerRight ?? 0), 'Recent list scrollbar sits inside the panel padding, not over the rows');
  assert.ok((edges?.panelInnerRight ?? 0) - (edges?.scrollbarOuterRight ?? 0) >= 3, 'Scrollbar keeps clearance from the panel border');
  assert.ok((result.recentRows[0]?.height ?? 0) === 52, 'Recent row uses the shared control height');
  assert.ok((result.historyRect?.width ?? 99) <= 20, 'History/download icon is visually smaller than its control');
  assert.ok(result.mountBookmark && result.mountBookmark.height === 60, 'Bookmark control matches the main action height');
  assert.ok(result.recentRows.every(row => row.gap === '0px' && row.height === 52 && row.icons >= 1), 'Recent rows use shared height and gapless inline icon controls');

  await page.type('input[aria-label="Search recent Liths"]', 'fixture');
  await page.keyboard.press('Escape');
  const cancelledSearch = await page.evaluate(() => {
    const input = document.querySelector('input[aria-label="Search recent Liths"]');
    return { value: input?.value, focused: document.activeElement === input };
  });
  assert.equal(cancelledSearch.value, 'fixture', 'Escape preserves the active recent search');
  assert.equal(cancelledSearch.focused, false, 'Escape deselects the search field');

  // Filtered down to one row there is no scrollbar left: the reserved gutter has
  // to hold the rows on exactly the edges they had while the list was scrolling.
  const filteredEdges = await measurePanelEdges();
  assert.ok(filteredEdges && !filteredEdges.scrolls, 'Filtering the list down removes the scrollbar');
  assert.equal(filteredEdges?.gutter, edges?.gutter, 'The scrollbar gutter stays reserved after the filter');
  assert.equal(filteredEdges?.rowVsSearchLeft, edges?.rowVsSearchLeft, 'Rows keep their left edge when the scrollbar goes away');
  assert.equal(filteredEdges?.rowVsSearchRight, edges?.rowVsSearchRight, 'Rows keep their right edge when the scrollbar goes away');
  assert.equal(filteredEdges?.resetVsSearchRight, edges?.resetVsSearchRight, 'Rebuild control keeps its right edge when the scrollbar goes away');

  await page.setViewport({ width: 600, height: 700 });
  const narrow = await page.evaluate(() => ({
    paddingBottom: parseFloat(getComputedStyle(document.querySelector('main.container')).paddingBottom),
    footerTop: document.querySelector('footer')?.getBoundingClientRect().top ?? 0,
    mainBottom: document.querySelector('main.container')?.getBoundingClientRect().bottom ?? 0
  }));
  assert.ok(narrow.paddingBottom >= 70, 'Narrow layout reserves space for the blocking footer');
  assert.ok(narrow.footerTop >= 0 && narrow.footerTop <= narrow.mainBottom, 'Narrow footer remains in the viewport');

  await page.setViewport({ width: 1000, height: 700 });
  const wide = await page.evaluate(() => ({
    paddingBottom: parseFloat(getComputedStyle(document.querySelector('main.container')).paddingBottom),
    footerLeft: document.querySelector('footer')?.getBoundingClientRect().left ?? 0,
    mainLeft: document.querySelector('main.container')?.getBoundingClientRect().left ?? 0
  }));
  assert.ok(wide.paddingBottom < 70, 'Wide layout does not reserve the blocking footer band');
  assert.ok(wide.footerLeft < wide.mainLeft || wide.footerLeft > wide.mainLeft + 600, 'Wide footer is placed outside the launcher column');

  // The bookmark tile on narrow launchers. It used to be dropped below 440px; it is now
  // the only route into the dialog that holds the saved-logins manager, so dropping it
  // would strand the vault with no way to change its secret or forget it. Kept, it has
  // to stay inside the card — at 320px the row wraps rather than overflowing.
  const readActionRow = async (width) => {
    await page.setViewport({ width, height: 700 });
    return page.evaluate(() => {
      const card = document.querySelector('.action-pair');
      const tile = card?.querySelector('.bookmark-button');
      const first = card?.querySelector('.action-button');
      if (!card || !tile || !first) return null;
      const tileBox = tile.getBoundingClientRect();
      return {
        overflow: card.scrollWidth - card.clientWidth,
        tileWidth: Math.round(tileBox.width),
        sameLine: Math.round(tileBox.top) === Math.round(first.getBoundingClientRect().top),
        insideCard: tileBox.right <= card.getBoundingClientRect().right + 0.5
      };
    });
  };
  const phoneRow = await readActionRow(390);
  assert.equal(phoneRow?.sameLine, true, 'The bookmark tile still sits beside the action buttons at phone width');
  assert.equal(phoneRow?.insideCard, true, '...inside the card, which is where the narrow rule used to drop it');
  assert.equal(phoneRow?.overflow, 0, '...without the row overflowing');
  const tinyRow = await readActionRow(320);
  assert.equal(tinyRow?.insideCard, true, 'At 320px the tile stays inside the card rather than hanging past its edge');
  assert.equal(tinyRow?.sameLine, false, '...by taking a line of its own, since the text buttons do not shrink below their labels');
  assert.equal(tinyRow?.overflow, 0, '...and the row still does not overflow');

  // Webapp mode: the mark is the project link, so the footer's copy of it is
  // the one that goes on mobile — the mark always fits. This file:// document
  // resolves to webapp (no Tauri global, no instance marker).
  const readMarkAt = async (width) => {
    await page.setViewport({ width, height: 700 });
    return page.evaluate(() => {
      const mark = document.querySelector('.brand-icon-wrap');
      const link = document.querySelector('.github-link');
      return {
        markTag: mark?.tagName ?? null,
        markHref: mark?.getAttribute('href') ?? null,
        markLabel: mark?.getAttribute('aria-label') ?? null,
        footerDisplay: link ? getComputedStyle(link).display : 'absent',
        footerHref: link?.getAttribute('href') ?? null
      };
    });
  };
  const mobileMark = await readMarkAt(600);
  const desktopMark = await readMarkAt(1000);
  assert.equal(mobileMark.markTag, 'A', 'Mobile: the Lithic mark is the project link');
  assert.equal(mobileMark.markHref, 'https://github.com/Lithic-UK/Lithic', 'Mobile: the mark points at the project');
  assert.equal(mobileMark.markLabel, 'Lithic on GitHub', 'Mobile: the mark is labelled for screen readers');
  assert.equal(mobileMark.footerDisplay, 'none', 'Mobile hides the footer Github button');
  assert.equal(desktopMark.markTag, 'A', 'Desktop: the mark is the project link too');
  assert.equal(desktopMark.footerDisplay, 'flex', 'Desktop keeps the footer Github button');
  assert.equal(desktopMark.footerHref, mobileMark.markHref, 'The footer link points where the mark does');

  // The other half of that rule: self-host is the one mode where the mark really
  // is a control — the instance's own icon picker — so it must not have turned
  // into a link. Forced with the mode query the legacy launcher already accepts;
  // this page cannot reach a server over file://, so its failed fetches are
  // expected and are deliberately not collected as errors.
  // Its own browser context, not another page in the main one: the two share a `file://`
  // origin, and storage seeded for these assertions would otherwise still be sitting in the
  // recents and bookmark lists the rest of this test measures further down.
  const selfHostContext = await browser.createBrowserContext();
  const selfHostPage = await selfHostContext.newPage();
  await selfHostPage.setViewport({ width: 1000, height: 700 });
  // Seeded on this page's own origin before the mode is asked for, so the assertions below
  // have something that *could* have been drawn: a recent row, a cache-only row and a
  // bookmark, all of which belong to the device rather than to the server. Self-host shows
  // none of them, and the only way to see that it does not is to give it all three. The
  // bookmark carries its icon, so nothing here reaches the network: an unfetched favicon
  // would be a fetch this test then has to explain.
  await selfHostPage.goto(`file://${artifact}`, { waitUntil: 'domcontentloaded' });
  await selfHostPage.waitForSelector('main.container');
  await selfHostPage.evaluate(async () => {
    localStorage.setItem('lithic-recent-liths', JSON.stringify([{ name: 'device-only.lith', text: '' }]));
    localStorage.setItem('bookmarkedInstances', JSON.stringify([{
      url: 'https://personal.lithic.uk',
      label: 'personal.lithic.uk',
      icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFUlEQVR42mP8z8Dwn4GBgYGJgYGBHgAeCgIBAAAAAElFTkSuQmCC',
      iconFetchedAt: Date.now()
    }]));
    const request = indexedDB.open('keyval-store', 1);
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
    const db = request.result;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('keyval', 'readwrite');
      tx.objectStore('keyval').put({ text: JSON.stringify([{ title: 'Cached', text: 'cache only' }]) }, 'search_cache_cache-only.lith');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await selfHostPage.goto(`file://${artifact}?mode=self-host`, { waitUntil: 'domcontentloaded' });
  await selfHostPage.waitForSelector('main.container');
  // The mark is read once its bytes have arrived, so what is asserted below is the image
  // that actually rendered rather than a src on its way somewhere.
  await selfHostPage.waitForFunction(() => {
    const image = document.querySelector('.brand-icon-wrap img.brand-icon');
    return Boolean(image && image.complete && image.naturalWidth > 0);
  }, POLL);
  const selfHost = await selfHostPage.evaluate(() => {
    const mark = document.querySelector('.brand-icon-wrap');
    const refresh = document.querySelector('.remote-refresh');
    return {
      tag: mark?.tagName ?? null,
      label: mark?.getAttribute('aria-label') ?? null,
      href: mark?.getAttribute('href') ?? null,
      disabled: mark?.hasAttribute('disabled') ?? null,
      markSrc: mark?.querySelector('img.brand-icon')?.getAttribute('src') ?? null,
      markWidth: mark?.querySelector('img.brand-icon')?.naturalWidth ?? null,
      mountLabel: document.querySelector('.action-pair .mount-button')?.textContent?.trim() ?? null,
      refresh: refresh !== null,
      headingButtons: [...document.querySelectorAll('.heading button')].map(button => button.className),
      // The GitHub backup button, and what it says about an instance that cannot
      // answer: `error` with the `!` badge, and a tooltip that names the failure
      // rather than guessing at the backup's state.
      syncLabel: document.querySelector('.heading .sync-button')?.getAttribute('aria-label') ?? null,
      syncTitle: document.querySelector('.heading .sync-button')?.getAttribute('title') ?? null,
      syncGlyph: document.querySelector('.heading .sync-button .sync-glyph')?.textContent?.trim() ?? null,
      // The device's own rows, none of which this mode draws — seeded above, so each of
      // these counts would be non-zero without the gate that keeps them off this list.
      bookmarkRows: document.querySelectorAll('.bookmark-row').length,
      localRows: document.querySelectorAll('.recent-row:not(.remote-row)').length,
      cachedRows: document.querySelectorAll('.cached-result').length,
      // The server's rows, and the two decorations that used to separate them from the
      // device's: a group heading and a marker per row. With no other rows there is
      // nothing to separate them from.
      groupLabels: document.querySelectorAll('.recent-group-label').length,
      remoteDots: document.querySelectorAll('.remote-dot').length,
      // The rebuild control, which this mode keeps: the list is the server's, but the
      // caches it repairs are this device's, and reading the store again is also what
      // indexes it here. Reset is the half that does not belong to a list this device
      // does not own.
      resetCache: document.querySelector('.reset-cache') !== null,
      rebuildLabel: [...document.querySelectorAll('button')].map(button => button.textContent?.trim()).find(text => text?.includes('Rebuild')) ?? null,
      empty: document.querySelector('.empty')?.textContent?.trim() ?? null,
      error: document.querySelector('.status-line.error')?.textContent?.trim() ?? null
    };
  });
  assert.equal(selfHost.tag, 'BUTTON', 'Self-host: the mark stays the icon picker button');
  assert.equal(selfHost.label, 'Set this instance’s icon', 'Self-host: the picker button is still labelled');
  assert.equal(selfHost.href, null, 'Self-host: the mark does not link away from the picker');
  assert.equal(selfHost.disabled, false, 'Self-host: the picker is a live control, not the old dead button');
  // This page is a file with no instance behind it, so there is no mark to read: the
  // shipped mark is the answer, and its 150px is how this tells the two apart.
  assert.notEqual(
    selfHost.markSrc,
    '/mstile-150x150.png',
    `Self-host: a page with no instance behind it asks no address for a mark, and falls back to the one it carries: ${JSON.stringify(selfHost.markSrc?.slice(0, 40))}`
  );
  assert.equal(selfHost.markWidth, 150, 'Self-host: which is the 150px mark this build ships, drawn and whole');
  assert.equal(selfHost.mountLabel, 'Upload a Lith', 'Self-host: the file action says which way the file goes');
  assert.notEqual(selfHost.mountLabel, 'Mount a Lith', 'Self-host: it does not offer a device mount');
  assert.equal(selfHost.refresh, false, 'Self-host: nothing in the heading re-lists the server');
  assert.deepEqual(
    selfHost.headingButtons,
    ['brand-icon-wrap pickable', 'sync-button error'],
    'Self-host: the heading holds the icon picker and the backup button, and nothing else'
  );
  assert.equal(selfHost.syncLabel, 'GitHub Sync', 'Self-host: the backup button is labelled for screen readers');
  assert.match(
    selfHost.syncTitle ?? '',
    /did not answer/,
    'Self-host: an instance that cannot be asked is reported, not guessed at'
  );
  assert.equal(selfHost.syncGlyph, '!', 'Self-host: the failure carries a non-colour badge too');
  assert.equal(selfHost.bookmarkRows, 0, 'Self-host: bookmarks for other instances are not on this list');
  assert.equal(selfHost.localRows, 0, 'Self-host: this device\'s own Liths are not on this list');
  assert.equal(selfHost.cachedRows, 0, 'Self-host: neither are this device\'s cached copies');
  assert.equal(selfHost.groupLabels, 0, 'Self-host: no group heading, because there is no second group');
  assert.equal(selfHost.remoteDots, 0, 'Self-host: the server\'s rows carry no marker');
  assert.equal(selfHost.resetCache, true, 'Self-host: the rebuild control stays, since the caches it rebuilds are this device\'s');
  assert.equal(selfHost.rebuildLabel, 'Rebuild Recents', 'Self-host: and it is offered as the rebuild rather than as a reset');
  assert.equal(selfHost.empty, null, 'Self-host: a failed list says the failure, not that the server is empty');
  assert.match(selfHost.error ?? '', /^Could not list this server’s Liths/, 'Self-host: the failure is the one line about the list');

  // The backup dialog, opened from that button. What is asserted here is that the
  // *dialog* speaks about a server rather than a folder, and that the two things
  // which are only meaningful on the desktop — the folder being backed up, and
  // the order to save a Lith first — are not on it at all.
  await selfHostPage.click('.heading .sync-button');
  await selfHostPage.waitForSelector('.git-sync-modal');
  const selfHostSyncDialog = await selfHostPage.evaluate(() => {
    const modal = document.querySelector('.git-sync-modal');
    return {
      title: modal?.querySelector('h2')?.textContent?.trim() ?? null,
      lines: [...modal.querySelectorAll('p')].map((line) => line.textContent.trim()),
      actions: [...modal.querySelectorAll('.modal-action')].map((action) => action.textContent.trim()),
      folder: modal?.querySelector('.sync-folder') !== null,
      advanced: modal?.querySelector('.git-sync-advanced summary')?.textContent?.trim() ?? null,
      cancel: modal?.querySelector('.sync-cancel') !== null
    };
  });
  assert.equal(selfHostSyncDialog.title, 'GitHub Sync', 'Self-host: the backup dialog is titled like the desktop one');
  assert.ok(
    selfHostSyncDialog.lines.includes('Back up this server to GitHub. Its saves push automatically.'),
    `Self-host: the dialog offers the server's backup, in its own words: ${JSON.stringify(selfHostSyncDialog.lines)}`
  );
  assert.ok(
    selfHostSyncDialog.lines.includes('This instance did not answer about GitHub backups.'),
    `Self-host: an unreachable instance is named in the dialog: ${JSON.stringify(selfHostSyncDialog.lines)}`
  );
  assert.ok(
    !selfHostSyncDialog.lines.some((line) => /folder/i.test(line)),
    `Self-host: no line asks about a folder on this device: ${JSON.stringify(selfHostSyncDialog.lines)}`
  );
  assert.equal(selfHostSyncDialog.folder, false, 'Self-host: the folder line is desktop-only');
  assert.deepEqual(
    selfHostSyncDialog.actions,
    ['Connect to GitHub', 'Connect & Push'],
    'Self-host: connect, plus the token fallback for an instance whose OAuth is blocked'
  );
  assert.equal(
    selfHostSyncDialog.advanced,
    'Advanced: connect with a personal access token',
    'Self-host: the fallback is the same one the desktop dialog offers'
  );
  assert.equal(selfHostSyncDialog.cancel, false, 'Self-host: nothing to stop, so no stop control is offered');
  await selfHostContext.close();

  // --- the same launcher on an instance that answers --------------------------
  // The page above is one half of this mode: a server that cannot be asked, which
  // is what a plain WebDAV deployment or a reverse proxy that forwards only
  // `/sync/` looks like. This is the other half, and the only way the backup
  // dialog's live states can be reached at all. `scripts/self-host-stub.mjs`
  // serves this artifact and the `/api/github/*` routes the container's generated
  // Caddy config hands to `github-sync.sh`, so device code → poll → repo list →
  // setup → disconnect is a conversation this test holds, rather than six unit
  // tests on the parsing of one.
  //
  // Its own browser context again, and its own storage with it: the flow moves the
  // page into the picker and back out, and none of that belongs in the recents and
  // bookmarks the rest of this test measures.
  const stub = await startSelfHostStub({ artifact });
  const liveContext = await browser.createBrowserContext();
  const livePage = await liveContext.newPage();
  await livePage.setViewport({ width: 1000, height: 700 });
  // Unlike the offline page, this one has an answer for every request it makes, so
  // its console is collected and asserted clean at the end of the flow.
  const liveErrors = [];
  const liveNoise = (text) =>
    text.includes('Failed to load resource') || text.includes('ERR_FILE_NOT_FOUND') || text.includes('ERR_FAILED');
  livePage.on('pageerror', (error) => { if (!liveNoise(error.message)) liveErrors.push(error.message); });
  livePage.on('console', (message) => {
    if (message.type() === 'error' && !liveNoise(message.text())) liveErrors.push(message.text());
  });
  // Scoped to a selector, not to the document: the confirm dialog that guards the
  // disconnect carries a `Disconnect` action of its own, and clicking the first
  // match in the document would re-open the confirmation it is asking about.
  const clickAction = (page, selector, label) => page.evaluate((css, text) => {
    const button = [...document.querySelectorAll(css)].find((node) => node.textContent.trim() === text);
    if (!button) throw new Error(`no ${css} saying ${text}`);
    button.click();
  }, selector, label);
  const waitForAction = (page, selector, label) => page.waitForFunction((css, text) =>
    [...document.querySelectorAll(css)].some((node) => node.textContent.trim() === text), POLL, selector, label);
  const readSyncDialog = (page) => page.evaluate(() => {
    const modal = document.querySelector('.git-sync-modal');
    if (!modal) return null;
    return {
      lines: [...modal.querySelectorAll('p')].map((line) => line.textContent.trim()),
      actions: [...modal.querySelectorAll('.modal-action')].map((action) => action.textContent.trim()),
      userCode: modal.querySelector('.user-code-display')?.textContent?.trim() ?? null,
      note: modal.querySelector('.git-sync-note')?.textContent?.trim() ?? null,
      repoCards: [...modal.querySelectorAll('.repo-card')].map((card) => card.textContent.trim()),
      selected: [...modal.querySelectorAll('.repo-card.selected')].map((card) => card.textContent.trim()),
      groupLabels: [...modal.querySelectorAll('.repo-group-label')].map((label) => label.textContent.trim()),
      otherRepos: [...modal.querySelectorAll('.repo-list .repo-card')].map((card) => card.textContent.trim())
    };
  });

  await livePage.goto(`${stub.origin}/launcher.html?mode=self-host`, { waitUntil: 'domcontentloaded' });
  await livePage.waitForSelector('main.container');

  // The mark in the heading, before this flow touches anything: it is the instance's own
  // file, read from the address the legacy launcher's header read, so what it draws is
  // whatever this instance currently serves — not the mark the build ships. The fixture is
  // 2x2 on purpose, so the size the image actually rendered is proof of *which* bytes
  // arrived: 2 is the instance's own, 150 is this build's. A deployment whose icon set was
  // never published answers 404, which is the one case the address cannot answer for, and
  // that is driven too — the shipped mark is what is left there.
  const readHeadingMark = async () => {
    await livePage.waitForFunction(() => {
      const image = document.querySelector('.brand-icon-wrap img.brand-icon');
      return Boolean(image && image.complete && image.naturalWidth > 0);
    }, POLL);
    return livePage.evaluate(() => {
      const image = document.querySelector('.brand-icon-wrap img.brand-icon');
      return { src: image?.getAttribute('src') ?? null, width: image?.naturalWidth ?? null };
    });
  };
  const servedMark = await readHeadingMark();
  assert.equal(
    servedMark.src,
    '/mstile-150x150.png',
    'Live self-host: the heading reads the mark the instance publishes, at the file the icon set writes'
  );
  assert.equal(
    servedMark.width,
    2,
    `Live self-host: and draws the bytes the instance served rather than this build's mark: ${JSON.stringify(servedMark)}`
  );
  stub.state.instanceMark = false;
  await livePage.reload({ waitUntil: 'domcontentloaded' });
  await livePage.waitForSelector('main.container');
  const fallbackMark = await readHeadingMark();
  assert.notEqual(
    fallbackMark.src,
    '/mstile-150x150.png',
    `Live self-host: an instance that published no icon set is not left pointing at the address that failed: ${JSON.stringify(fallbackMark)}`
  );
  assert.equal(
    fallbackMark.width,
    150,
    `Live self-host: it draws the shipped mark instead, which is the same answer a page with no instance behind it gives: ${JSON.stringify(fallbackMark)}`
  );
  stub.state.instanceMark = true;
  await livePage.reload({ waitUntil: 'domcontentloaded' });
  await livePage.waitForSelector('main.container');
  // The status read lands before anything is drawn about it, so "idle" here is the
  // instance's own answer and not the button's opening guess.
  await livePage.waitForSelector('.heading .sync-button.idle');
  const idleTitle = await livePage.$eval('.heading .sync-button', (button) => button.getAttribute('title'));
  assert.equal(idleTitle, 'GitHub Sync', 'Live self-host: an instance with no backup shows the plain button, not a failure');

  await livePage.click('.heading .sync-button');
  await livePage.waitForSelector('.git-sync-modal');
  const offer = await readSyncDialog(livePage);
  assert.ok(
    offer.lines.includes('Back up this server to GitHub. Its saves push automatically.'),
    `Live self-host: the dialog offers the server's backup: ${JSON.stringify(offer.lines)}`
  );
  assert.ok(
    !offer.lines.some((line) => line.includes('did not answer')),
    `Live self-host: an instance that answered is not reported as unreachable: ${JSON.stringify(offer.lines)}`
  );

  // Step one of the device flow. The code is the server's, not Rust's: on an
  // instance the *server* runs the OAuth, because the token it receives is the one
  // it will push with.
  await clickAction(livePage, '.git-sync-modal .modal-action', 'Connect to GitHub');
  await livePage.waitForSelector('.git-sync-modal .user-code-display');
  const waiting = await readSyncDialog(livePage);
  assert.equal(waiting.userCode, 'WXYZ-9876', 'Live self-host: the code the instance issued is grouped the way GitHub shows it');
  assert.equal(waiting.note, 'Waiting for authorization…', 'Live self-host: and the dialog says what it is doing with the code');
  assert.ok(
    waiting.lines.includes('1. Open github.com/login/device'),
    `Live self-host: the instructions name the page to open: ${JSON.stringify(waiting.lines)}`
  );
  assert.ok(stub.state.asked.includes('GET /api/github/device-code'), 'Live self-host: the code came from the instance, not from Rust');

  // Nobody has authorized yet, so the poll comes back `authorization_pending`.
  // That is the state that must not move the dialog: "waiting" is a state, not a
  // failure, and a poll loop that gave up on the first answer would end here.
  await new Promise((resolve) => setTimeout(resolve, 1_400));
  const stillWaiting = await readSyncDialog(livePage);
  assert.equal(stillWaiting.userCode, 'WXYZ-9876', 'Live self-host: an unanswered poll leaves the code on screen');
  assert.equal(stillWaiting.actions.length, 1, 'Live self-host: and offers exactly the one way out, which is to stop waiting');
  assert.equal(stillWaiting.actions[0], 'Stop waiting', 'Live self-host: named for what it does, since the dialog stays open');

  stub.authorize();
  await livePage.waitForSelector('.git-sync-modal .repo-card.create', { timeout: 15000 });
  const picker = await readSyncDialog(livePage);
  assert.deepEqual(
    picker.groupLabels,
    ['Found existing Lithic sync repos', 'Advanced: your other repositories'],
    'Live self-host: the picker separates the repositories Lithic made from the rest'
  );
  assert.deepEqual(
    picker.selected,
    ['keeper/lithic-sync-4k2p'],
    'Live self-host: an existing sync repo is offered first, so the default is not another new one'
  );
  assert.deepEqual(
    picker.repoCards.slice(1),
    ['keeper/lithic-sync-4k2p', 'keeper/lithic-archive', 'keeper/notes', 'keeper/website'],
    'Live self-host: every repository the instance can see is offered, managed ones first'
  );
  assert.deepEqual(
    picker.otherRepos,
    ['keeper/notes', 'keeper/website'],
    'Live self-host: the fallback list holds only the repositories Lithic did not make'
  );
  assert.match(
    picker.repoCards[0] ?? '',
    /^\+ Create lithic-sync-[a-z0-9]{4} and sync$/,
    'Live self-host: and a fresh repository can be made instead'
  );

  await livePage.click('.git-sync-modal .repo-card.create');
  const chosen = await readSyncDialog(livePage);
  assert.equal(chosen.selected.length, 1, 'Live self-host: exactly one repository is ever selected');
  assert.match(
    chosen.selected[0] ?? '',
    /^\+ Create lithic-sync-[a-z0-9]{4} and sync$/,
    'Live self-host: and picking the new one moves the selection onto it'
  );
  // A Lith the setup pulls down, added mid-flow on purpose: what is worth proving
  // is not that a server row can be drawn — the offline page drew one — but that
  // connecting re-lists the store, so the row arrives only because the setup ran.
  // Its size is part of the fixture: the row draws what the store reports about the file,
  // so the server has to report something for there to be anything to prove. 200 KB.
  stub.addLith('arrived.lith', new Date(), 204800);
  await clickAction(livePage, '.git-sync-modal .modal-action', 'Start Sync');
  await waitForAction(livePage, '.git-sync-modal .modal-action', 'Disconnect');
  const connected = await readSyncDialog(livePage);
  assert.equal(stub.state.connected, true, 'Live self-host: the instance is now backing itself up');
  assert.match(stub.state.repo, /^keeper\/lithic-sync-[a-z0-9]{4}$/, 'Live self-host: to the repository the flow created, owner and all');
  assert.equal(
    connected.userCode,
    stub.state.repo,
    'Live self-host: the dialog shows the repository the instance reports, not the name that was typed'
  );
  assert.match(
    connected.note ?? '',
    /^Last synced \d+[smh] ago\.$/,
    `Live self-host: the instance's own clock is quoted back: ${connected.note}`
  );
  assert.ok(
    connected.lines.includes(`Created ${stub.state.repo}. Backing up github.com/${stub.state.repo}.`),
    `Live self-host: and the setup's own summary is kept: ${JSON.stringify(connected.lines)}`
  );
  assert.deepEqual(
    connected.actions,
    ['Disconnect'],
    'Live self-host: a connected instance offers only the one thing left to want, which is stopping'
  );
  assert.ok(stub.state.asked.includes('POST /api/github/create-repo'), 'Live self-host: creating the repository is a route of its own');
  assert.ok(stub.state.asked.includes('POST /api/github/setup'), 'Live self-host: and the setup is the one that lands it');

  await livePage.click('.git-sync-modal .modal-close');
  await livePage.waitForSelector('.git-sync-modal', { hidden: true });
  await livePage.waitForFunction(
    () => [...document.querySelectorAll('.recent-row.remote-row .recent-name')].some((row) => row.textContent.includes('arrived.lith')),
    POLL
  );
  const afterConnect = await livePage.evaluate(() => ({
    button: document.querySelector('.heading .sync-button')?.className ?? null,
    title: document.querySelector('.heading .sync-button')?.getAttribute('title') ?? null,
    rows: [...document.querySelectorAll('.recent-row.remote-row .recent-name')].map((row) => row.textContent.trim()),
    size: document.querySelector('.recent-row.remote-row .recent-name .cached-size')?.textContent?.trim() ?? null
  }));
  assert.equal(afterConnect.button, 'sync-button connected', 'Live self-host: the heading button turns green once the instance reports a backup');
  assert.match(
    afterConnect.title ?? '',
    /^GitHub Sync: github\.com\/keeper\/lithic-sync-[a-z0-9]{4}, last synced \d+[smh] ago$/,
    `Live self-host: and names the repository the instance is on: ${afterConnect.title}`
  );
  assert.ok(
    afterConnect.rows.some((row) => row.startsWith('arrived.lith')),
    `Live self-host: connecting re-listed the store, so the Lith the setup pulled down is on screen: ${JSON.stringify(afterConnect.rows)}`
  );

  // What a row says about the file beside its name, which is its size on the server rather
  // than the date the store last touched it. The stamp is the one fact a store cannot
  // help telling you and the one a reader already knows — every file in a store this size
  // was written this week — while the size is what a name cannot say.
  assert.equal(
    afterConnect.size,
    '200 KB',
    `Live self-host: the row shows what the server says the file weighs: ${JSON.stringify(afterConnect.size)}`
  );
  assert.ok(
    !afterConnect.rows.some((row) => /\d\/\d\/\d{4}/.test(row)),
    `Live self-host: and no row carries a date instead: ${JSON.stringify(afterConnect.rows)}`
  );

  // --- Re-reading the server, and indexing it here ----------------------------
  // The rebuild control stays on an instance, which is the mode whose list is derived
  // rather than authored. Rebuilding here is two things at once: the store is read again,
  // and each Lith in it is indexed into this device's caches — which is what search reads
  // for a Lith this browser never opened, and what it otherwise never learns. The reset
  // half is not offered: the list is not this device's to clear.
  const rebuildControl = await livePage.evaluate(() => {
    const button = document.querySelector('.reset-cache');
    return { label: button?.textContent?.trim() ?? null, title: button?.getAttribute('title') ?? null };
  });
  assert.equal(rebuildControl.label, 'Rebuild Recents', 'Live self-host: the rebuild control is offered on a server');
  assert.equal(
    rebuildControl.title,
    'Read this server again and index its Liths here',
    `Live self-host: and says what it does in this mode rather than talking about files on disk: ${JSON.stringify(rebuildControl)}`
  );
  const propfinds = () => stub.state.asked.filter((entry) => entry === 'PROPFIND /sync/').length;
  const propfindsBefore = propfinds();
  await livePage.click('.reset-cache');
  await livePage.waitForFunction(
    () => [...document.querySelectorAll('.status-line')].some((line) => line.textContent.includes('Re-indexed')),
    POLL
  );
  assert.equal(propfinds(), propfindsBefore + 1, 'Live self-host: rebuilding asks the server for its list again');
  assert.ok(
    stub.state.asked.includes('GET /api/lithic/file?file=arrived.lith'),
    `Live self-host: and reads each Lith it is about to index: ${JSON.stringify(stub.state.asked.slice(-8))}`
  );
  const rebuildLine = await livePage.evaluate(() =>
    [...document.querySelectorAll('.status-line')].map((line) => line.textContent.trim()).find((text) => text.includes('Re-indexed')) ?? null
  );
  assert.match(
    rebuildLine ?? '',
    /^Re-indexed 1 lith/,
    `Live self-host: and the count is the index it just wrote on this device: ${rebuildLine}`
  );

  // --- Deleting a Lith from the server ----------------------------------------
  // The legacy store put a × on every row of its remote list, and this mode's list is
  // still that store: the two decorations the rework dropped from it — the group heading
  // and the per-row dot — were there to tell the server's rows apart from the device's,
  // and a control that acts on a row is not. What is new is the answer it takes. The
  // legacy asked with `window.confirm`, which the desktop app renders as an OS message
  // box belonging to no part of the launcher it interrupts, so the question is the app's
  // own dialog now. Nothing is asked of the server until that question is answered.
  const remoteRows = () => livePage.evaluate(() =>
    [...document.querySelectorAll('.recent-row.remote-row')].map((row) => ({
      name: row.querySelector('.recent-name')?.firstChild?.textContent?.trim() ?? null,
      remove: row.querySelector('.remove-remote')?.getAttribute('aria-label') ?? null,
      title: row.querySelector('.remove-remote')?.getAttribute('title') ?? null
    }))
  );
  const storeDeletes = () => stub.state.asked.filter((entry) => entry.startsWith('DELETE '));
  assert.deepEqual(
    await remoteRows(),
    [
      {
        name: 'arrived.lith',
        remove: 'Delete arrived.lith from this server',
        title: 'Delete from remote storage'
      }
    ],
    'Live self-host: every row of the store carries the × that deletes it from the server'
  );

  // Declining, first: the × asks, and an answer of no reaches the server with nothing.
  await livePage.click('.recent-row.remote-row .remove-remote');
  await livePage.waitForSelector('.confirm-modal');
  const deleteAsk = await livePage.evaluate(() => ({
    title: document.querySelector('.confirm-modal h2')?.textContent?.trim() ?? null,
    body: document.querySelector('.confirm-modal p')?.textContent?.trim() ?? null,
    actions: [...document.querySelectorAll('.confirm-modal .modal-action')].map((action) => action.textContent.trim()),
    danger: document.querySelector('.confirm-modal .modal-action')?.classList.contains('danger') ?? false,
    crosses: document.querySelectorAll('.confirm-modal .modal-close').length
  }));
  assert.equal(deleteAsk.title, 'Delete this Lith?', 'Live self-host: the row’s × asks before it deletes');
  assert.equal(
    deleteAsk.body,
    'arrived.lith is deleted from the server, not just this device.',
    'Live self-host: and says which Lith, and which copy of it goes'
  );
  assert.deepEqual(deleteAsk.actions, ['Delete', 'Cancel'], 'Live self-host: with the answer it is asking for beside the way out');
  assert.equal(deleteAsk.danger, true, 'Live self-host: in the one colour this app keeps for an act that cannot be undone');
  assert.equal(deleteAsk.crosses, 0, 'Live self-host: and no × of its own, the way out being the Cancel that declines it');
  await clickAction(livePage, '.confirm-modal .modal-action', 'Cancel');
  await livePage.waitForSelector('.confirm-modal', { hidden: true });
  assert.deepEqual(storeDeletes(), [], 'Live self-host: declining the question deletes nothing');
  assert.deepEqual(
    (await remoteRows()).map((row) => row.name),
    ['arrived.lith'],
    'Live self-host: and the row it was asked about is still in the store'
  );

  // Then the answer that means it. The row leaves because the list is read again rather
  // than edited here — the server is the one that decides the file is gone — so this also
  // stands as the re-list the legacy delete did by hand.
  await livePage.click('.recent-row.remote-row .remove-remote');
  await livePage.waitForSelector('.confirm-modal');
  await clickAction(livePage, '.confirm-modal .modal-action', 'Delete');
  await livePage.waitForFunction(() => document.querySelectorAll('.recent-row.remote-row').length === 0, POLL);
  assert.deepEqual(
    stub.state.liths.map((lith) => lith.name),
    [],
    'Live self-host: the delete reached the instance’s store'
  );
  assert.ok(
    storeDeletes().includes('DELETE /sync/arrived.lith'),
    `Live self-host: through the store route, under the name the row showed: ${JSON.stringify(storeDeletes())}`
  );
  assert.ok(
    storeDeletes().includes('DELETE /sync/arrived.lith.lock'),
    `Live self-host: and the presence lock goes with it, exactly as the legacy delete tidied up: ${JSON.stringify(storeDeletes())}`
  );

  // And back out again. The confirmation is a second dialog, so the disconnect is
  // two clicks: the one that asks, and the one that means it. The status read the dialog
  // makes on the way in is held open on purpose, so its answer — composed while the
  // instance was still backing itself up — arrives *after* the disconnect has landed. That
  // ordering is the one that matters here: the answer is about a world the disconnect has
  // just left, and believing it would put the dialog back on the repository the user has
  // just stopped, with the repository filled in from that dead world. An instance whose
  // reply simply arrives late is what makes this deterministic instead of a race the run
  // sometimes wins.
  const STATUS_HOLD_MS = 1500;
  stub.state.statusDelayMs = STATUS_HOLD_MS;
  await livePage.click('.heading .sync-button');
  await waitForAction(livePage, '.git-sync-modal .modal-action', 'Disconnect');
  await clickAction(livePage, '.git-sync-modal .modal-action', 'Disconnect');
  await livePage.waitForSelector('.confirm-modal');
  const confirm = await livePage.evaluate(() => ({
    title: document.querySelector('.confirm-modal h2')?.textContent?.trim() ?? null,
    body: document.querySelector('.confirm-modal p')?.textContent?.trim() ?? null,
    actions: [...document.querySelectorAll('.confirm-modal .modal-action')].map((action) => action.textContent.trim())
  }));
  assert.equal(confirm.title, 'Disconnect GitHub Sync?', 'Live self-host: stopping the backup asks first');
  assert.equal(
    confirm.body,
    'Saves on this server stop syncing to GitHub.',
    'Live self-host: and says what stops, which is the server it is talking to rather than this device'
  );
  assert.deepEqual(confirm.actions, ['Disconnect', 'Cancel'], 'Live self-host: with the answer it is asking for beside the way out');
  await clickAction(livePage, '.confirm-modal .modal-action', 'Disconnect');
  // Waited on through the dialog rather than the heading button: the dialog is the
  // thing being asserted, and the button settles from the same disconnect one
  // status read later.
  await waitForAction(livePage, '.git-sync-modal .modal-action', 'Connect to GitHub');
  const afterDisconnect = await readSyncDialog(livePage);
  // Nothing has been clicked since the disconnect, so the held-back answer has landed on a
  // dialog that is sitting on the start of the flow — which is the state the stale answer
  // must leave alone. Waited out rather than polled: the answer lands on its own schedule,
  // and what is being asserted is the state after it has.
  await new Promise((resolve) => setTimeout(resolve, STATUS_HOLD_MS));
  assert.deepEqual(
    stub.state.statusHolds,
    [STATUS_HOLD_MS],
    `Live self-host: the read the disconnect had to outlive is the one that was held open: ${JSON.stringify(stub.state.statusHolds)}`
  );
  const afterStaleAnswer = await readSyncDialog(livePage);
  assert.deepEqual(
    afterStaleAnswer.actions,
    ['Connect to GitHub', 'Connect & Push'],
    `Live self-host: an answer composed before the disconnect does not put the dialog back on the repository it stopped: ${JSON.stringify(afterStaleAnswer)}`
  );
  assert.equal(stub.state.connected, false, 'Live self-host: disconnect reached the instance');
  assert.ok(
    stub.state.asked.includes('GET /api/github/disconnect'),
    'Live self-host: through the route that deletes the token its watcher pushes with'
  );
  assert.deepEqual(
    afterDisconnect.actions,
    ['Connect to GitHub', 'Connect & Push'],
    'Live self-host: and the dialog is back at the start, ready to be pointed somewhere else'
  );
  assert.equal(
    afterDisconnect.lines.some((line) => line.includes('did not answer')),
    false,
    `Live self-host: an instance that answered the disconnect is not reported as unreachable: ${JSON.stringify(afterDisconnect.lines)}`
  );
  await livePage.waitForSelector('.heading .sync-button.idle');

  // The route that took the place of the connected view's own "Change Repository":
  // stop, then connect again. Driven here rather than assumed, because removing a
  // button is only safe if what it did is still reachable — and the second setup is
  // aimed at a different repository, so what this proves is a re-point and not a
  // repeat of the first connect.
  await clickAction(livePage, '.git-sync-modal .modal-action', 'Connect to GitHub');
  await livePage.waitForSelector('.git-sync-modal .user-code-display');
  stub.authorize();
  await livePage.waitForSelector('.git-sync-modal .repo-card.create', { timeout: 15000 });
  await clickAction(livePage, '.git-sync-modal .repo-card', 'keeper/lithic-sync-4k2p');
  const secondPick = await readSyncDialog(livePage);
  assert.deepEqual(
    secondPick.selected,
    ['keeper/lithic-sync-4k2p'],
    'Live self-host: an instance that was stopped can be pointed at another repository'
  );
  await clickAction(livePage, '.git-sync-modal .modal-action', 'Start Sync');
  await waitForAction(livePage, '.git-sync-modal .modal-action', 'Disconnect');
  assert.equal(
    stub.state.repo,
    'keeper/lithic-sync-4k2p',
    'Live self-host: and the instance is on it, which is the re-point the removed button used to make'
  );
  assert.equal(
    stub.state.asked.filter((entry) => entry === 'POST /api/github/setup').length,
    2,
    'Live self-host: through the same setup route the first connect used, so the two routes were one route'
  );
  await livePage.click('.git-sync-modal .modal-close');
  await livePage.waitForSelector('.git-sync-modal', { hidden: true });
  const repointedTitle = await livePage.$eval('.heading .sync-button', (button) => button.getAttribute('title'));
  assert.match(
    repointedTitle ?? '',
    /^GitHub Sync: github\.com\/keeper\/lithic-sync-4k2p, last synced \d+[smh] ago$/,
    `Live self-host: and the heading names it, so the move is visible outside the dialog: ${repointedTitle}`
  );

  assert.deepEqual(
    liveErrors,
    [],
    `Live self-host: the whole flow ran without a console error: ${liveErrors.join(' | ')}`
  );
  await liveContext.close();
  await stub.close();

  // --- The instance's icon belongs to the instance -----------------------------
  // A picker that only wrote to the browser it was used in is per-client by construction:
  // whoever set the emoji sees it, everybody else gets the shipped mark, and a redeploy or
  // a restored backup takes it away from them as well. So the choice itself is kept in the
  // store, beside the renders it describes and inside the tree git backs up, and every
  // client reads it before drawing its own heading. What is asserted here is that contract
  // from the outside, on a browser that has never seen this instance: it inherits the icon,
  // saving is what writes it, restoring the default is what takes it away, and the icon
  // files are never mistaken for Liths.
  const iconSource = await readFile(resolve('launcher-ui/src/instance-icon.ts'), 'utf8');
  const iconSetting = /export const ICON_SETTING = '([^']+)'/.exec(iconSource)?.[1];
  assert.equal(
    iconSetting,
    'favicon.conf',
    `The choice is stored under the name the deployment's backup carries it in (source says ${iconSetting})`
  );
  const iconStub = await startSelfHostStub({ artifact });
  const iconContext = await browser.createBrowserContext();
  const iconPage = await iconContext.newPage();
  const iconErrors = [];
  iconPage.on('pageerror', (error) => iconErrors.push(error.message));
  await iconPage.setViewport({ width: 1000, height: 700 });
  // Set on the instance, never in this context: this is the browser whose mark used to be
  // wrong, and this context's own storage starts empty on purpose.
  iconStub.addFile(iconSetting, '🌿');
  const settingReads = () => iconStub.state.asked.filter((entry) => entry === `GET /sync/${iconSetting}`).length;
  await iconPage.goto(`${iconStub.origin}/launcher.html?mode=self-host`, { waitUntil: 'domcontentloaded' });
  await iconPage.waitForSelector('.brand-emoji');
  const inherited = await iconPage.evaluate(() => ({
    mark: document.querySelector('.brand-icon-wrap')?.className ?? null,
    glyph: document.querySelector('.brand-emoji')?.textContent?.trim() ?? null,
    // The document ships a `rel="shortcut icon"` link and the module reuses it (`applyFavicon`
    // looks for `icon` first, then that), so the tab is read the way the module finds it.
    favicon: (document.querySelector("link[rel='icon']") ?? document.querySelector("link[rel='shortcut icon']"))?.href?.slice(0, 22) ?? null,
    mirror: localStorage.getItem('lithic-icon-emoji')
  }));
  assert.equal(settingReads() > 0, true, 'A launcher on an instance asks the instance for its icon');
  assert.equal(inherited.glyph, '🌿', `A browser that never picked an icon shows the instance's own: ${JSON.stringify(inherited)}`);
  assert.match(inherited.mark ?? '', /brand-emoji-wrap/, 'and the mark reads as set rather than as the shipped tile');
  assert.match(inherited.favicon ?? '', /^data:image\/png;base64,/, 'with the tab following the instance rather than the bundled favicon');
  assert.equal(inherited.mirror, '🌿', 'and the choice mirrored locally, so an instance that cannot be asked later still shows it');

  // The picker agrees, which is what makes the icon a setting the owner can change rather
  // than a value the page happened to render.
  await iconPage.click('.brand-icon-wrap.pickable');
  await iconPage.waitForSelector('.emoji-modal');
  const pickerOpen = await iconPage.evaluate(() => ({
    selected: [...document.querySelectorAll('.emoji-btn.selected')].map((node) => node.textContent.trim()),
    preview: document.querySelector('.emoji-preview')?.textContent?.trim() ?? null,
    line: document.querySelector('.emoji-modal p')?.textContent?.trim() ?? null
  }));
  assert.deepEqual(pickerOpen.selected, ['🌿'], 'The picker opens on the instance’s icon, not on an empty choice');
  assert.equal(pickerOpen.preview, '🌿', 'and previews it');
  assert.equal(
    pickerOpen.line,
    'This icon belongs to the instance. Everyone who opens this address sees it.',
    'and says whose icon it is, which is what makes the choice a setting rather than a theme'
  );

  await iconPage.evaluate(() => {
    const button = [...document.querySelectorAll('.emoji-btn')].find((node) => node.textContent.trim() === '🎨');
    if (!button) throw new Error('no 🎨 in the grid');
    button.click();
  });
  await clickAction(iconPage, '.emoji-modal .modal-action', 'Save Icon');
  await iconPage.waitForFunction(
    () => document.querySelector('.emoji-modal .status-line')?.textContent?.includes('Saved') ?? false,
    POLL
  );
  const saved = await iconPage.evaluate(() => ({
    status: document.querySelector('.emoji-modal .status-line')?.textContent?.trim() ?? null,
    glyph: document.querySelector('.brand-emoji')?.textContent?.trim() ?? null
  }));
  assert.equal(saved.status, '✓ Saved. This instance now uses 🎨.', 'Saving says what the instance is now known by');
  assert.equal(saved.glyph, '🎨', 'and the mark follows it');
  assert.equal(
    iconStub.state.files.get(iconSetting)?.bytes.toString('utf8'),
    '🎨',
    'The emoji itself is in the store, which is the whole of what another client reads'
  );
  // Where in the run the choice lands: after the renders, immediately before the doorbell.
  // Earlier and the setting could describe icons that never arrived; later and the instance
  // would be told to apply a set whose choice is missing.
  const storeWrites = iconStub.state.asked.filter((entry) => entry.startsWith('PUT /sync/'));
  const settingAt = storeWrites.indexOf(`PUT /sync/${iconSetting}`);
  const doorbellAt = storeWrites.indexOf('PUT /sync/custom.ico');
  assert.equal(
    settingAt,
    doorbellAt - 1,
    `The choice is written after the renders and immediately before the doorbell: ${JSON.stringify(storeWrites)}`
  );
  assert.equal(
    storeWrites.filter((entry) => entry === `PUT /sync/${iconSetting}`).length,
    1,
    'and written exactly once, which is what makes its position mean anything'
  );
  // Every render is in the store too, and none of them is a Lith: the list is the store's
  // answer filtered to the files a launcher can open, and the icons live in the same root.
  assert.equal(iconStub.state.files.size, 9, `The store holds the renders and the choice: ${JSON.stringify([...iconStub.state.files.keys()])}`);
  const storeRows = () => iconPage.evaluate(() =>
    [...document.querySelectorAll('.recent-row.remote-row .recent-name')].map((row) => row.firstChild?.textContent?.trim() ?? '')
  );
  assert.deepEqual(await storeRows(), [], 'and the icon files are not listed as Liths');

  // Restoring the shipped icon takes the choice with it, or the next client would inherit
  // an emoji nobody is using any more.
  await clickAction(iconPage, '.emoji-modal .modal-action', 'Restore Default');
  await iconPage.waitForFunction(() => document.querySelector('.brand-emoji') === null, POLL);
  assert.equal(iconStub.state.files.has(iconSetting), false, 'Restoring the default forgets the instance’s choice');
  assert.ok(
    iconStub.state.asked.includes(`DELETE /sync/${iconSetting}`),
    `by deleting it from the store: ${JSON.stringify(iconStub.state.asked.slice(-12))}`
  );
  assert.ok(
    iconStub.state.asked.lastIndexOf('DELETE /sync/custom.ico') > iconStub.state.asked.indexOf(`DELETE /sync/${iconSetting}`),
    'with the doorbell last, that write being the signal the deployment acts on'
  );
  assert.equal(
    await iconPage.evaluate(() => localStorage.getItem('lithic-icon-emoji')),
    null,
    'and the browser that made the choice stops mirroring it'
  );

  // A third browser, on an instance whose choice has just been removed: it is told there is
  // nothing to inherit, and the shipped mark is what it draws — the other half of "the
  // instance decides", which a mirror-only design cannot express at all.
  const cleanContext = await browser.createBrowserContext();
  const cleanPage = await cleanContext.newPage();
  await cleanPage.setViewport({ width: 1000, height: 700 });
  const readsBefore = settingReads();
  await cleanPage.goto(`${iconStub.origin}/launcher.html?mode=self-host`, { waitUntil: 'domcontentloaded' });
  await cleanPage.waitForSelector('.brand-icon-wrap');
  const answered = async () => {
    const started = Date.now();
    while (settingReads() <= readsBefore && Date.now() - started < 5000) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return settingReads() > readsBefore;
  };
  assert.equal(await answered(), true, 'A fresh browser asks the instance about the icon too');
  assert.equal(await cleanPage.$('.brand-emoji'), null, 'and an instance with no choice shows the shipped mark');
  assert.equal(await cleanPage.evaluate(() => localStorage.getItem('lithic-icon-emoji')), null, 'with nothing inherited into this browser either');
  assert.deepEqual(iconErrors, [], `The whole icon flow ran without a console error: ${iconErrors.join(' | ')}`);
  await cleanContext.close();
  await iconContext.close();
  await iconStub.close();

  // --- The copy an instance leaves in this app's profile ------------------------
  // Removing and re-adding a bookmark does not reach an instance's cached launcher: that
  // copy lives under the instance's own origin, and a page may only touch its own origin's
  // storage. The app can, because every webview in it shares one profile, so the × sends
  // `forget_instance_copy` and Rust drops that one origin's copy through the browser's own
  // protocol (`src-tauri/src/instance_copy.rs`). What is asserted here is that the calls it
  // makes do that job, twice over: once against the worker a deployment really ships, and
  // once against a webview HTTP cache holding a page a proxy is caching.
  //
  // The storage list is read out of the Rust source rather than written out again: the two
  // halves have to agree, and a change there that would take an instance's cached wikis
  // with its page has to fail *this* test, which leaves one behind on purpose.
  const rustCopySource = await readFile(resolve('src-tauri/src/instance_copy.rs'), 'utf8');
  const clearedStores = /const CLEARED_STORES: &str = "([^"]+)"/.exec(rustCopySource)?.[1];
  assert.equal(
    clearedStores,
    'service_workers,cache_storage',
    `The app drops the downloaded page and nothing else (instance_copy.rs says ${clearedStores})`
  );
  // A copy of the launcher that says it is the old one. The attribute is this harness's,
  // not the artifact's: what has to be told apart is two documents served from one URL,
  // which is exactly what a stale copy is.
  const staleCopy = artifactHtml.replace('<html lang="en">', '<html lang="en" data-build="stale">');
  assert.ok(staleCopy !== artifactHtml, 'The stale copy is marked, so which one arrived is readable');

  const cachingStub = await startSelfHostStub({ artifact, serviceWorker: 'real', document: staleCopy });
  const copyContext = await browser.createBrowserContext();
  const copyPage = await copyContext.newPage();
  const copyErrors = [];
  copyPage.on('pageerror', error => copyErrors.push(error.message));
  await copyPage.goto(`${cachingStub.origin}/`, { waitUntil: 'domcontentloaded' });
  const workerState = await copyPage.evaluate(async () => {
    await navigator.serviceWorker.register('/offline-service-worker.js');
    const registration = await navigator.serviceWorker.ready;
    return { active: Boolean(registration.active), script: registration.active?.scriptURL ?? '' };
  });
  assert.ok(
    workerState.active && workerState.script.endsWith('/offline-service-worker.js'),
    `The instance's own worker is installed: ${JSON.stringify(workerState)}`
  );
  const precached = await copyPage.evaluate(async () => {
    const marked = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const body = await (await cache.match(request)).text();
        if (body.includes('data-build="stale"')) marked.push(request.url);
      }
    }
    return marked;
  });
  assert.ok(
    precached.includes(`${cachingStub.origin}/`),
    `The worker cached the copy the instance was serving, which is what goes stale: ${JSON.stringify(precached)}`
  );
  // The instance's cached wiki, in its *own* storage: what the launcher's cross-instance
  // search reads, and what dropping a page has to leave exactly where it is.
  await copyPage.evaluate(async () => {
    const request = indexedDB.open('keyval-store', 1);
    await new Promise((ok, fail) => {
      request.onsuccess = ok;
      request.onerror = () => fail(request.error);
    });
    const db = request.result;
    await new Promise((ok, fail) => {
      const tx = db.transaction('keyval', 'readwrite');
      tx.objectStore('keyval').put({ text: '[]' }, 'search_cache_notes.lith');
      tx.oncomplete = ok;
      tx.onerror = () => fail(tx.error);
    });
    db.close();
  });
  // The instance redeploys: the same URL, a launcher that no longer says it is the old one.
  cachingStub.setLauncherDocument(artifactHtml);
  // ...and the bookmark still opens the old one. Nothing but a cache could have answered
  // with a document the instance is not serving any more, which is the report this exists for.
  await copyPage.goto(`${cachingStub.origin}/`, { waitUntil: 'domcontentloaded' });
  const staleOnRedeploy = await copyPage.evaluate(() => ({
    build: document.documentElement.dataset.build ?? null,
    controlled: Boolean(navigator.serviceWorker.controller)
  }));
  assert.equal(staleOnRedeploy.build, 'stale', 'An instance that redeployed still opens the copy the worker cached');
  assert.equal(staleOnRedeploy.controlled, true, '...because the worker is answering, not the network');
  // The two calls Rust makes, in the order it makes them (see `instance_copy::forget`).
  const copyClient = await copyPage.createCDPSession();
  await copyClient.send('Storage.clearDataForOrigin', { origin: cachingStub.origin, storageTypes: clearedStores });
  await copyClient.send('Network.clearBrowserCache');
  await copyClient.detach();
  await copyPage.goto(`${cachingStub.origin}/`, { waitUntil: 'domcontentloaded' });
  const afterClear = await copyPage.evaluate(async () => {
    const wiki = await new Promise((resolve) => {
      const request = indexedDB.open('keyval-store', 1);
      request.onsuccess = () => {
        const get = request.result.transaction('keyval', 'readonly').objectStore('keyval').get('search_cache_notes.lith');
        get.onsuccess = () => resolve(get.result ? 'kept' : 'gone');
        get.onerror = () => resolve('gone');
      };
      request.onerror = () => resolve('gone');
    });
    const staleLeft = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const body = await (await cache.match(request)).text();
        if (body.includes('data-build="stale"')) staleLeft.push(request.url);
      }
    }
    return { build: document.documentElement.dataset.build ?? null, wiki, staleLeft };
  });
  assert.equal(afterClear.build, null, 'The next open is the launcher the instance is actually serving');
  assert.deepEqual(
    afterClear.staleLeft,
    [],
    `No cache at that origin still holds the old copy: ${JSON.stringify(afterClear.staleLeft)}`
  );
  assert.equal(afterClear.wiki, 'kept', 'An instance’s cached wikis are not part of a downloaded page, so they are untouched');
  // Not one visit: the fresh launcher registers the worker again, and what that worker
  // caches is the copy being served now — so a later open is the current launcher too.
  await copyPage.evaluate(() => navigator.serviceWorker.ready);
  await copyPage.goto(`${cachingStub.origin}/`, { waitUntil: 'domcontentloaded' });
  assert.equal(
    await copyPage.evaluate(() => document.documentElement.dataset.build ?? null),
    null,
    'A later open comes from a worker that cached the current copy, not the old one'
  );
  assert.deepEqual(copyErrors, [], `The cache flow ran without an uncaught error: ${copyErrors.join(' | ')}`);
  await copyContext.close();
  await cachingStub.close();

  // --- The same staleness in the webview's own cache ---------------------------
  // A deployment behind a proxy that caches the page: the copy that goes stale is in the
  // webview's HTTP cache rather than in a worker's store, and the protocol has no
  // per-origin clear for it. That is why the app drops the cache as a whole as well —
  // bytes and no storage — and this is what shows that second call earns its place.
  const proxyStub = await startSelfHostStub({ artifact, document: staleCopy, documentMaxAge: 600 });
  const proxyContext = await browser.createBrowserContext();
  const proxyPage = await proxyContext.newPage();
  await proxyPage.goto(`${proxyStub.origin}/`, { waitUntil: 'domcontentloaded' });
  assert.equal(
    await proxyPage.evaluate(() => document.documentElement.dataset.build ?? null),
    'stale',
    'A page a proxy is caching arrives as the old copy on the first open'
  );
  proxyStub.setLauncherDocument(artifactHtml);
  await proxyPage.goto(`${proxyStub.origin}/`, { waitUntil: 'domcontentloaded' });
  assert.equal(
    await proxyPage.evaluate(() => document.documentElement.dataset.build ?? null),
    'stale',
    '...and the cached one comes back without the instance being asked again'
  );
  const proxyClient = await proxyPage.createCDPSession();
  await proxyClient.send('Network.clearBrowserCache');
  await proxyClient.detach();
  await proxyPage.goto(`${proxyStub.origin}/`, { waitUntil: 'domcontentloaded' });
  assert.equal(
    await proxyPage.evaluate(() => document.documentElement.dataset.build ?? null),
    null,
    'Dropping the webview’s cache is what makes the next open fetch the launcher the instance serves'
  );
  await proxyContext.close();
  await proxyStub.close();

  // Seed a cache-only wiki. The query below is intentionally absent from the
  // filename so this exercises cached content search without file permissions.
  await page.evaluate(async () => {
    const request = indexedDB.open('keyval-store', 1);
    await new Promise((resolve, reject) => {
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
    const db = request.result;
    await new Promise((resolve, reject) => {
      const tx = db.transaction('keyval', 'readwrite');
      // With the stamps a real cache carries. They are why `te` used to match this
      // entry at all: creaTE d, modified's cousin, and `text/vnd.tiddlywiki`.
      //
      // The name and the body are chosen so the three cases stay separable: between
      // them they hold `archive` and `distinctive` but not `te` — which is the trap
      // that caught this fixture twice, first in `content` and then in `Note`.
      tx.objectStore('keyval').put({ text: JSON.stringify([{
        title: 'Archive Box',
        created: '20260816020116648',
        modified: '20260816020116648',
        type: 'text/vnd.tiddlywiki',
        text: 'distinctive local findings'
      }]) }, 'search_cache_archive.lith');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[aria-label="Search recent Liths"]');
  await page.type('input[aria-label="Search recent Liths"]', 'distinctive');
  await new Promise(resolve => setTimeout(resolve, 250));
  // One query at a time, typed the way a user changes their mind: through the
  // inline clear, so the box is driven rather than emptied from outside.
  // Scoped to this fixture's own row: the page holds other seeded caches, and a
  // document-wide `querySelector('.cache-preview')` reads whichever row happens to
  // come first — which is how this probe first "found" a panel for a query this
  // fixture must not match at all.
  const describeMatch = () => page.evaluate(() => {
    const row = [...document.querySelectorAll('.recent-row')].find(entry => entry.textContent?.includes('archive.lith')) ?? null;
    const preview = row?.querySelector('.cache-preview') ?? null;
    const titleMark = row?.querySelector('mark.cache-preview-title-mark') ?? null;
    const bodyMark = row?.querySelector('mark:not(.cache-preview-title-mark)') ?? null;
    return {
      row,
      preview,
      previewStyle: preview && getComputedStyle(preview).display,
      previewText: preview?.textContent,
      titleMarkText: titleMark?.textContent ?? null,
      titleMarkColor: titleMark && getComputedStyle(titleMark).color,
      bodyMarkText: bodyMark?.textContent ?? null,
      bodyMarkColor: bodyMark && getComputedStyle(bodyMark).color,
      size: row?.querySelector('.cached-size')?.textContent
    };
  });
  const setQuery = async (query) => {
    await page.click('.recent-search-clear');
    await page.type('input[aria-label="Search recent Liths"]', query);
    await new Promise(resolve => setTimeout(resolve, 250));
    return describeMatch();
  };

  const cachedSearch = await describeMatch();
  assert.ok(cachedSearch.row, 'Cached content-only match remains visible');
  assert.match(cachedSearch.previewText ?? '', /distinctive/);
  assert.match(cachedSearch.size ?? '', /MB$/, 'Cached result displays its local cache size');
  assert.equal(cachedSearch.previewStyle, 'block', 'Desktop cached context uses a pop-out preview');
  assert.equal(await page.$('.recent-search-clear') !== null, true, 'Search exposes an inline clear button while active');
  // A body hit marks the body, in the amber the panel has always used, and does not
  // mark a title that does not contain the query.
  assert.equal(cachedSearch.bodyMarkText, 'distinctive', 'The body hit carries the mark');
  assert.equal(cachedSearch.bodyMarkColor, 'rgb(255, 152, 0)', 'Body marks stay amber');
  assert.equal(cachedSearch.titleMarkText, null, 'A title without the query is not marked');

  // The note's own name is content, so it matches and it is marked — in the install
  // button's blue, which is the one colour this app already uses for "the thing".
  const titleMatch = await setQuery('Archive');
  assert.ok(titleMatch.preview, 'A title-only match still opens a preview');
  assert.equal(titleMatch.titleMarkText, 'Archive', 'The matched title is marked, case preserved');
  assert.equal(titleMatch.titleMarkColor, 'rgb(138, 180, 248)', 'The title mark is the install button blue');
  assert.equal(titleMatch.bodyMarkText, null, 'A title-only match marks no body text');

  // The stamps are not search surface: `te` lives in creaTE d, in modified's cousin
  // and in `text/vnd.tiddlywiki`, and none of them may bring a row or a panel back.
  const stampOnly = await setQuery('te');
  assert.equal(stampOnly.preview, null, 'A stamp-only match opens no preview');
  assert.equal(stampOnly.row, null, 'A stamp-only match shows no cached row');
  assert.equal(stampOnly.bodyMarkText, null, 'A stamp-only match marks nothing');

  const restored = await setQuery('distinctive');
  assert.match(restored.previewText ?? '', /distinctive/, 'The body query still matches after the others');

  await page.setViewport({ width: 600, height: 700 });
  const mobileSearch = await page.evaluate(() => ({
    row: [...document.querySelectorAll('.recent-row')].find(row => row.textContent?.includes('archive.lith')),
    previewStyle: document.querySelector('.cache-preview') && getComputedStyle(document.querySelector('.cache-preview')).display
  }));
  assert.ok(mobileSearch.row, 'Mobile cached content-only match remains visible');
  assert.equal(mobileSearch.previewStyle, 'none', 'Mobile layout hides the context pop-out');

  // --- The install offer's dismiss affordance ---
  // It only renders in the desktop app, or in a browser that has offered an
  // install prompt — never in this page — so drive the markup the bundle emits.
  // The word is a hint that appears under the cursor; the ✕ is the control and
  // must neither paint anything at rest nor move when the word arrives.
  assert.ok(
    artifactHtml.includes('install-dismiss-label') && artifactHtml.includes('>dismiss</span>'),
    'Built launcher ships the dismiss affordance with its hover-revealed word'
  );
  await page.evaluate(() => {
    document.querySelector('footer').insertAdjacentHTML(
      'beforeend',
      '<span class="install-offer"><button class="install-button" type="button">Install App</button>' +
        '<button class="install-dismiss" title="Hide the install offer" aria-label="Dismiss install offer">' +
        '<span class="install-dismiss-label">dismiss</span>\u2715</button></span>'
    );
  });
  await new Promise(resolve => setTimeout(resolve, 250));
  const measureDismiss = () => page.evaluate(() => {
    const button = document.querySelector('.install-dismiss');
    const label = button.querySelector('.install-dismiss-label');
    const range = document.createRange();
    const glyph = button.lastChild;
    range.setStart(glyph, glyph.textContent.length - 1);
    range.setEnd(glyph, glyph.textContent.length);
    const glyphBox = range.getBoundingClientRect();
    const labelBox = label.getBoundingClientRect();
    const round = value => +value.toFixed(2);
    return {
      labelOpacity: getComputedStyle(label).opacity,
      labelLeft: round(labelBox.left),
      labelRight: round(labelBox.right),
      glyphLeft: round(glyphBox.left),
      glyphCenterY: round((glyphBox.top + glyphBox.bottom) / 2),
      wordCenterY: round((labelBox.top + labelBox.bottom) / 2),
      gapToGlyph: round(glyphBox.left - labelBox.right),
      buttonLeft: round(button.getBoundingClientRect().left),
      buttonWidth: round(button.getBoundingClientRect().width),
      installLeft: round(document.querySelector('.install-button').getBoundingClientRect().left)
    };
  });
  const dismissAtRest = await measureDismiss();
  assert.equal(dismissAtRest.labelOpacity, '0', 'The dismiss word stays hidden until the cursor is on the control');
  await page.hover('.install-dismiss');
  await new Promise(resolve => setTimeout(resolve, 300));
  const dismissHovered = await measureDismiss();
  assert.equal(dismissHovered.labelOpacity, '1', 'The dismiss word appears on hover');
  assert.equal(dismissHovered.glyphLeft, dismissAtRest.glyphLeft, 'The ✕ does not move when the word appears');
  assert.equal(dismissHovered.glyphCenterY, dismissAtRest.glyphCenterY, 'The ✕ does not shift vertically when the word appears');
  assert.equal(dismissHovered.buttonWidth, dismissAtRest.buttonWidth, 'Revealing the word does not resize the control');
  assert.equal(dismissHovered.installLeft, dismissAtRest.installLeft, 'Revealing the word does not move the install button beside it');
  assert.ok(Math.abs(dismissHovered.gapToGlyph - 4) <= 0.5, 'The word sits a set gap clear of the ✕');
  assert.ok(Math.abs(dismissHovered.wordCenterY - dismissHovered.glyphCenterY) <= 0.5, 'The word is centred on the same line as the ✕');
  // The hidden word is still part of the hover target: the reveal picks up the
  // cursor wherever it already is, rather than only on the ✕ itself.
  const hoverTargetWidth = dismissHovered.buttonWidth - dismissHovered.gapToGlyph + (dismissHovered.glyphLeft - dismissHovered.labelLeft);
  assert.ok(hoverTargetWidth >= 40, 'The dismiss control keeps a wide enough hover target with the word hidden');

  // --- A bookmark row is one control, not two ---
  // The cached instance icon belongs to the link. Left beside the button instead
  // of inside it, the highlight stops before the icon, so the row reads as an
  // icon that does nothing next to a label that opens the instance — and a click
  // on the icon opens nothing at all. Measured on the built artifact, which is
  // what ships.
  const fixtureIcon =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAFUlEQVR42mP8z8Dwn4GBgYGJgYGBHgAeCgIBAAAAAElFTkSuQmCC';
  await page.evaluate((entries) => {
    localStorage.setItem('bookmarkedInstances', JSON.stringify(entries));
  }, [
    { url: 'https://personal.lithic.uk', label: 'personal.lithic.uk', icon: fixtureIcon, iconFetchedAt: Date.now() },
    { url: `https://${missingIconHost}`, label: missingIconHost }
  ]);
  await page.goto(`file://${artifact}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.bookmark-row .bookmark-name');
  await new Promise(resolve => setTimeout(resolve, 250));
  const bookmarkRows = await page.evaluate(() => [...document.querySelectorAll('.bookmark-row')].map(row => {
    const link = row.querySelector('.bookmark-name');
    const icon = row.querySelector('.bookmark-icon');
    const label = row.querySelector('.bookmark-label');
    const box = element => element.getBoundingClientRect();
    const linkBox = box(link);
    const iconBox = box(icon);
    return {
      iconInsideLink: link.contains(icon),
      coversIcon: linkBox.left < iconBox.left && iconBox.right < linkBox.right,
      iconLeft: +(iconBox.left - linkBox.left).toFixed(2),
      iconSize: [iconBox.width, iconBox.height],
      labelLeft: +(box(label).left - linkBox.left).toFixed(2),
      placeholder: icon.classList.contains('bookmark-icon-empty'),
      centre: { x: iconBox.left + iconBox.width / 2, y: iconBox.top + iconBox.height / 2 }
    };
  }));
  assert.equal(bookmarkRows.length, 2, 'Both bookmark fixtures render a row');
  for (const row of bookmarkRows) {
    assert.ok(row.iconInsideLink, 'The icon is part of the link, not a control beside it');
    assert.ok(row.coversIcon, 'The link’s box — and so its hover highlight — covers the icon');
    assert.ok(Math.abs(row.iconSize[0] - 24) <= 0.5 && Math.abs(row.iconSize[1] - 24) <= 0.5, 'The icon keeps its 24px box');
    assert.ok(row.labelLeft > row.iconLeft, 'The label follows the icon inside the link');
  }
  assert.equal(bookmarkRows[1].placeholder, true, 'A bookmark with no cached icon renders its placeholder inside the link too');
  // The label and the icon share the row's centre line — and that line is where
  // every other row's text sits, because <button> centres its own content — so a
  // bookmark row does not read as a different kind of row.
  const centreLines = await page.evaluate(() => {
    const fromRowTop = (row, node) => {
      const box = node.getBoundingClientRect();
      return +((box.top + box.bottom) / 2 - row.getBoundingClientRect().top).toFixed(2);
    };
    const textLine = (row, node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      return +((box.top + box.bottom) / 2 - row.getBoundingClientRect().top).toFixed(2);
    };
    const bookmark = document.querySelector('.bookmark-row');
    const file = document.querySelector('.recent-row:not(.bookmark-row)');
    return {
      bookmarkLabel: textLine(bookmark, bookmark.querySelector('.bookmark-label')),
      bookmarkIcon: fromRowTop(bookmark, bookmark.querySelector('.bookmark-icon')),
      fileLabel: textLine(file, file.querySelector('.recent-name').firstChild),
      rowHeight: bookmark.getBoundingClientRect().height
    };
  });
  assert.equal(centreLines.bookmarkLabel, centreLines.fileLabel, 'The bookmark label sits on the same line as every other row’s text');
  assert.equal(centreLines.bookmarkIcon, centreLines.fileLabel, 'The icon is centred on that same line');
  // A real cursor on the icon: the link is the hovered control, so the highlight
  // is painted across it and a click there opens the instance.
  await page.mouse.move(bookmarkRows[0].centre.x - 80, bookmarkRows[0].centre.y);
  await page.mouse.move(bookmarkRows[0].centre.x, bookmarkRows[0].centre.y, { steps: 6 });
  await new Promise(resolve => setTimeout(resolve, 150));
  const iconHover = await page.evaluate(({ x, y }) => {
    const link = document.querySelector('.bookmark-row .bookmark-name');
    const at = document.elementFromPoint(x, y);
    return {
      linkHovered: link.matches(':hover'),
      linkBackground: getComputedStyle(link).backgroundColor,
      iconBackground: getComputedStyle(link.querySelector('.bookmark-icon')).backgroundColor,
      clickTargetOpensInstance: Boolean(at && at.closest('.bookmark-name'))
    };
  }, bookmarkRows[0].centre);
  assert.equal(iconHover.linkHovered, true, 'Hovering the icon hovers the link it belongs to');
  assert.notEqual(iconHover.linkBackground, 'rgba(0, 0, 0, 0)', 'The link paints one highlight across itself, icon included');
  assert.equal(iconHover.iconBackground, 'rgba(0, 0, 0, 0)', 'The icon paints no background of its own: it is not a second control');
  assert.equal(iconHover.clickTargetOpensInstance, true, 'Clicking the icon opens the instance');

  // --- The way back out of a handed-over instance ---
  // A page the launcher handed this window to is reached at an instance origin
  // with a marker naming the launcher; that is the only state with somewhere to
  // return to, and in the desktop app there is no browser chrome to do it with.
  // Where it is drawn is the point of it: in the page's margin, which means the mark and
  // the title have to land in exactly the same place whether it is there or not. So the
  // window is set to the desktop width the app's own window opens near — an 800px window
  // leaves 100px of margin either side of the column, a phone-width one leaves none — and
  // the same two boxes are measured on the page without a way back and the page with one.
  const backViewport = page.viewport();
  await page.setViewport({ width: 1000, height: 700 });
  const headingBoxes = (target) => target.evaluate(() => {
    const box = (selector) => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    };
    const back = document.querySelector('.back-to-launcher');
    return {
      mark: box('.brand-icon-wrap'),
      title: box('.heading-copy h1'),
      back: back ? box('.back-to-launcher') : null,
      backInActions: Boolean(document.querySelector('.heading-actions')?.contains(back))
    };
  });
  const bare = await headingBoxes(page);
  assert.equal(bare.back, null, 'A launcher that was not handed over shows no way back');
  const launcherAddress = 'https://tauri.localhost/';
  await page.goto(`file://${artifact}?lithic-from=${encodeURIComponent(launcherAddress)}`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForSelector('.back-to-launcher');
  const backMarkup = await page.evaluate(() => {
    const back = document.querySelector('.back-to-launcher');
    return {
      label: back.getAttribute('aria-label'),
      target: back.getAttribute('data-target'),
      hasArrow: Boolean(back.querySelector('svg path'))
    };
  });
  assert.equal(backMarkup.label, 'Back to the main launcher');
  assert.ok(backMarkup.hasArrow, 'The way back renders an icon, not bare text');
  assert.equal(backMarkup.target, launcherAddress, 'The marker names the launcher to return to');
  const handed = await headingBoxes(page);
  assert.deepEqual(
    handed.mark,
    bare.mark,
    `The way back takes nothing from the mark: it is in the margin, not the heading's row ${JSON.stringify([bare.mark, handed.mark])}`
  );
  assert.deepEqual(
    handed.title,
    bare.title,
    `and the title is where it was without one ${JSON.stringify([bare.title, handed.title])}`
  );
  assert.equal(handed.backInActions, false, 'It is no longer one of the heading’s trailing controls');
  assert.ok(
    handed.back.left + handed.back.width <= handed.mark.left,
    `It sits clear of the mark, left of it: ${JSON.stringify(handed)}`
  );
  assert.ok(
    Math.abs(handed.back.top + handed.back.height / 2 - (handed.mark.top + handed.mark.height / 2)) <= 1,
    `and on the mark’s own centre line: ${JSON.stringify(handed)}`
  );
  // And at a phone's width, where there is no margin to hold a 38px circle: it joins the
  // heading's row instead of hanging off the edge of the window, which is the one case
  // where it is allowed to move the mark.
  await page.setViewport({ width: 600, height: 700 });
  const noMargin = await headingBoxes(page);
  assert.ok(noMargin.back.left >= 0, `A window with no margin still shows the way back in full: ${JSON.stringify(noMargin)}`);
  assert.ok(
    noMargin.mark.left >= noMargin.back.left + noMargin.back.width,
    `where it stands ahead of the mark rather than over it: ${JSON.stringify(noMargin)}`
  );
  await page.setViewport(backViewport ?? { width: 600, height: 700 });
  // Clicking must navigate to the launcher the marker named — not `history.back()`,
  // which would leave the app entirely for a page opened from a bookmark.
  const navigations = [];
  const recordNavigation = request => {
    if (request.isNavigationRequest()) navigations.push(request.url());
  };
  page.on('request', recordNavigation);
  await page.click('.back-to-launcher');
  await new Promise(resolve => setTimeout(resolve, 400));
  page.off('request', recordNavigation);
  assert.ok(
    navigations.some(url => url.startsWith(launcherAddress)),
    `Clicking the way back navigates to the launcher (saw ${JSON.stringify(navigations)})`
  );

  // --- Saved instance logins (the credential vault) ----------------------------
  // Rendered only in the desktop app, so this page is given the app's own global
  // and `?mode=tauri` (the launcher's documented override) with a mock standing
  // in for Rust. What is being pinned here is the contract between the two
  // halves: command names, argument keys, and which state the dialog shows. The
  // vault's own behaviour — KDF, AEAD, origin matching — is covered by the Rust
  // unit tests, and the two meet at exactly these names.
  const vaultPage = await browser.newPage();
  /**
   * Type a PIN the way the dialog is meant to be used: into the first box, by
   * keyboard, with the sixth character being the submit. Each box is left alone
   * afterwards — driving them one at a time would test six inputs rather than the
   * entry method, and the focus movement is the half of it worth pinning.
   */
  const typePin = async (page, container, pin) => {
    const boxes = await page.$$(`${container} .pin-box`);
    assert.equal(boxes.length, 6, `${container} is entered as six boxes`);
    await boxes[0].click();
    await page.keyboard.type(pin);
  };
  /**
   * Bring the launcher back after it has handed the window to an instance.
   *
   * A handoff to a host that does not resolve leaves the tab on an error page, and
   * that document has no `localStorage` to read — which surfaces as an unrelated
   * SecurityError somewhere below rather than as the assertion it really is. So this
   * waits for the launcher's own document to be up, and navigates again if the tab
   * was still on its way somewhere else.
   */
  const reopenLauncher = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vaultPage.goto(`file://${artifact}?mode=tauri`, { waitUntil: 'domcontentloaded' });
      try {
        await vaultPage.waitForSelector('.bookmark-row .vault-row-button', { timeout: 5000 });
        if (await vaultPage.evaluate(() => typeof window.__lithicVault === 'object')) return;
      } catch {
        // Still somewhere else: the next attempt navigates again.
      }
    }
    throw new Error('the launcher never came back up');
  };
  /**
   * Wait for one row's key to reach the colour the vault's index says it should be.
   *
   * A key click is routed by that colour, and the colour arrives with the coverage
   * question the launcher asks on mount — so clicking before it has been answered would
   * open the save dialog where the manager was meant, or the reverse.
   */
  /**
   * A dialog with a × in its corner needs no second way out.
   *
   * Its action row is for the decisions it exists to make — save, open, forget — and a
   * button whose whole label is "Cancel" runs the same function as the × beside it, so it
   * is refused here rather than trusted to stay deleted, and that holds whatever the label
   * would have been: `Close` and `Done` are the same function under a friendlier word. A
   * dialog with nothing to decide therefore has no action row at all. What is *not* this: a
   * yes/no confirmation keeps its Cancel (the rebuild confirmation, the destructive confirm
   * — the two answers are both decisions, and neither of them is dismissing anything), and
   * the GitHub device flow's button says "Stop waiting" because it abandons an authorization
   * instead of closing anything.
   *
   * Named rather than counted, so a failure says which dialog grew one back.
   */
  const assertNoExtraDismiss = async (scope, where) => {
    const shape = await vaultPage.evaluate(selector => {
      const modal = document.querySelector(selector);
      if (!modal) return null;
      return {
        hasClose: Boolean(modal.querySelector('.modal-close')),
        actions: [...modal.querySelectorAll('.modal-action')].map(node => node.textContent.trim())
      };
    }, scope);
    assert.ok(shape, `${where} is on screen`);
    assert.equal(shape.hasClose, true, `${where} keeps its × in the corner`);
    assert.deepEqual(
      shape.actions.filter(label => /^(cancel|close|done)$/i.test(label)),
      [],
      `${where} leaves dismissing to the ×: ${JSON.stringify(shape.actions)}`
    );
  };

  const waitForKeyCoverage = async (label, covered) => {
    await vaultPage.waitForFunction(
      (text, expected) => {
        const row = [...document.querySelectorAll('.bookmark-row')].find(node => node.textContent.includes(text));
        const key = row?.querySelector('.vault-row-button');
        return key?.classList.contains('covered') === expected;
      },
      { timeout: 5000 },
      label,
      covered
    );
  };
  /**
   * Wait for the launcher to have asked Rust something, from this side of the browser.
   *
   * A command that is followed by a handoff cannot be waited for in the page: the document
   * that asked is gone by the time it is worth checking, and the one that replaced it has no
   * record of the call. `vaultCalls` is the record that survives that.
   */
  const waitForCall = async matches => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (vaultCalls.some(matches)) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('the launcher never asked for what this was waiting on');
  };
  await vaultPage.setViewport({ width: 900, height: 700 });
  vaultPage.on('pageerror', error => errors.push(`vault: ${error.message}`));
  // A record of what the launcher asked Rust, held on this side of the browser.
  // Opening an instance navigates away from the page that asked, so the page's own
  // log is gone by the time that call is worth checking.
  const vaultCalls = [];
  await vaultPage.exposeFunction('__lithicRecord', entry => vaultCalls.push(entry));
  await vaultPage.evaluateOnNewDocument((secretSentences) => {
    // The fixture is a *file* rather than a per-document constant: what a save writes has
    // to still be there after the launcher hands the window to an instance and comes back,
    // and every opening decision in the launcher is taken from that state. So it lives in
    // localStorage, which is the only store that survives the round trip being tested.
    const FIXTURE_KEY = '__lithicVaultFixture';
    const stored = (() => {
      try {
        return JSON.parse(localStorage.getItem(FIXTURE_KEY) ?? 'null');
      } catch {
        return null;
      }
    })();
    const vault = {
      state: stored?.state ?? {
        exists: true,
        granted: false,
        count: 1,
        path: 'C:\\Users\\fixture\\AppData\\Local\\Lithic\\credentials.vault'
      },
      // One saved login, for the first bookmark fixture: the rows and the manager key
      // have something to be green about without the test having to set it up first.
      entries: stored?.entries ?? [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
      // What `forget_instance_copy` answers. The one line the × adds when a copy could
      // not be dropped hangs off this, and the case that has to stay silent — a platform
      // with no hook — is only reachable if a test can set the answer.
      copyDrop: stored?.copyDrop ?? { supported: true, cleared: true },
      calls: []
    };
    // A grant is never part of the file: it is dropped on every launcher mount anyway, and
    // persisting one would make a reload look like a session that survived.
    const persist = () => {
      try {
        localStorage.setItem(
          FIXTURE_KEY,
          JSON.stringify({ state: { ...vault.state, granted: false }, entries: vault.entries })
        );
      } catch {
        // A document with no storage is not a case this test walks.
      }
    };
    // The PIN the boxes are expected to produce — folded to upper case, which is what
    // the launcher sends. Nothing here opens for any other one: there is no persistent
    // unlock, so every command that needs the PIN takes it and checks it itself.
    const PIN = 'L1TH1C';
    window.__lithicVault = vault;
    // The folder a GitHub backup acts on. `automatic` stands in for the folder Rust works
    // out for itself (the open Lith, else the newest recent row, else a library folder with
    // a repository in it) and `picked` for the one the user chose in the OS picker, which
    // Rust keeps in the recents sidecar beside the exe. Per document, because the choice is
    // recorded by the command that takes it and read back by the next one.
    // `none` models the machine where Rust has nothing to propose either — a portable
    // bundle with no install folder and no Lith beside the program. It has to be read here
    // rather than set by the test, because the launcher asks for the folder as it mounts,
    // before any test code could run. Guarded, because this script also runs on documents
    // with no storage at all: the error page a handoff to an unresolvable host leaves.
    let nothingToPropose = false;
    try {
      nothingToPropose = localStorage.getItem('__lithicSyncFolderNone') === '1';
    } catch {
      // No storage here: the fixture's own folder stands.
    }
    const syncFolder = {
      automatic: nothingToPropose ? null : 'C:/Users/fixture/Documents/Lithic',
      picked: null,
      picks: 0,
      clears: 0,
      openedAt: null
    };
    window.__lithicSyncFolder = syncFolder;
    const answer = (command, args) => {
      vault.calls.push({ command, args });
      if (typeof window.__lithicRecord === 'function') window.__lithicRecord({ command, args });
      switch (command) {
        case 'credentials_status':
          // The count comes from the file's origin index in Rust, so it is known
          // while locked; the mock answers from its entries either way.
          return { ...vault.state, count: vault.entries.length };
        case 'credential_coverage': {
          // Which of the addresses asked about the vault holds a login for. Never
          // needs a secret, which is what colours a row before anything is unlocked.
          const asked = args.origins.map(origin => {
            try {
              return new URL(origin).origin;
            } catch {
              return origin;
            }
          });
          return asked.filter(origin => vault.entries.some(entry => entry.origin === origin));
        }
        case 'list_credentials':
          // Opening is not a state: the PIN opens the vault for the length of this call
          // and nothing more, so a wrong one is refused here rather than by an unlock
          // that happened earlier.
          if (args.secret !== PIN) throw new Error('That PIN does not open the vault.');
          return vault.entries;
        // Rust's own rule, near enough to keep the contract honest: six letters or
        // digits, and the band that shape falls in. The sentence is the injected one,
        // so the wording cannot drift from the gallery's stand-in.
        case 'check_credentials_secret': {
          const pin = String(args.secret ?? '').toUpperCase();
          if (!/^[0-9A-Z]{6}$/.test(pin)) {
            return { ok: false, problem: 'A PIN is 6 letters or digits.', warning: null, band: null };
          }
          const band = /^[0-9]{6}$/.test(pin) ? 'weak' : /^[A-Z]{6}$/.test(pin) ? 'average' : 'strong';
          return { ok: true, problem: null, band, warning: secretSentences[band] };
        }
        case 'probe_instance':
          // Only one fixture answers without asking for a password: the verdict is what
          // decides whether the offer is made at all, so both answers have to be
          // reachable from here.
          return args.url.includes('open.example')
            ? { state: 'lithic', status: 200 }
            : { state: 'protected', status: 401 };
        case 'forget_instance_copy':
          // The × on a bookmark. The copy belongs to the *instance's* origin and the app
          // is the only side that can reach it, which is why this is a command at all.
          return vault.copyDrop;
        case 'unlock_for_instance': {
          if (args.secret !== PIN) throw new Error('That PIN does not open the vault.');
          if (!vault.entries.some(entry => entry.origin === args.origin)) {
            throw new Error(`No login is saved for ${args.origin}.`);
          }
          vault.state.granted = true;
          return { origin: args.origin, user: 'keeper' };
        }
        case 'save_login_for_instance': {
          // One command, which is the point of the dialog: the login is stored and the
          // grant it leaves behind is what signs the instance in. With no vault on disk
          // this is also what creates one, under the PIN typed in the same dialog — the
          // same first-use bargain `remember_credentials` makes on the Rust side.
          if (vault.state.exists && args.secret !== PIN) throw new Error('That PIN does not open the vault.');
          vault.state.exists = true;
          vault.entries = vault.entries
            .filter(entry => entry.origin !== args.origin)
            .concat([{ origin: args.origin, user: args.user }]);
          vault.state.granted = true;
          persist();
          return { origin: args.origin, user: args.user };
        }
        case 'lend_instance_credentials': {
          // "Open without saving": the grant an unlock leaves behind, built from what
          // was typed. No secret is asked for and nothing is written, which is exactly
          // what the test below checks by looking at the entries afterwards.
          vault.state.granted = true;
          vault.lent = { origin: args.origin, user: args.user };
          return { origin: args.origin, user: args.user };
        }
        case 'remember_credentials': {
          // With a vault on disk the PIN has to be its own; with none, whatever is typed
          // here becomes the vault's — which is how first use creates one, in one dialog.
          if (vault.state.exists && args.secret !== PIN) throw new Error('That PIN does not open the vault.');
          // Saving the first login is what makes a vault, so the file exists from here on.
          vault.state.exists = true;
          // Rust normalises to an origin (scheme, host, port) before storing, and
          // the dialog forgets entries by what it lists — so the mock has to
          // normalise too, or it would be testing a contract Rust does not honour.
          let origin = args.origin;
          try {
            origin = new URL(args.origin).origin;
          } catch {
            // Rust rejects this; answering with the raw string is close enough
            // for a mock whose job is the argument names and the state machine.
          }
          vault.entries = vault.entries.filter(entry => entry.origin !== origin).concat([{ origin, user: args.user }]);
          persist();
          return vault.entries;
        }
        case 'forget_credentials':
          // Authenticated because it is a change to a stored entry, not because of what it
          // would reveal: the file's index already answers "is one saved for this?" free.
          if (args.secret !== PIN) throw new Error('That PIN does not open the vault.');
          vault.entries = vault.entries.filter(entry => entry.origin !== args.origin);
          persist();
          return vault.entries;
        case 'check_login_for_instance':
          // A login that is not saved yet: the instance is what answers for it, and this
          // is the command the dialogs use in place of a repeat-password box.
          return { outcome: 'accepted', detail: 'The instance asks for a password, and accepts this login.' };
        case 'check_credential':
          // One login the instance still accepts, and one it has since refused: the
          // two verdicts the row has to be able to tell apart.
          return args.origin === 'https://personal.lithic.uk'
            ? { outcome: 'accepted', status: 200, detail: 'The instance asks for a password, and accepts this login.' }
            : { outcome: 'refused', status: 401, detail: 'The instance refused this login (401).' };
        case 'instance_cache_search':
          // What the app's own reader answers (see `instance_search.rs`): one instance
          // with a cached wiki and one with nothing, asked for by the addresses the
          // launcher bookmarked and only while a search is running.
          return args.origins.map(origin => ({
            origin,
            truncated: false,
            caches: origin === 'https://personal.lithic.uk'
              ? [{ name: 'notes.lith', text: JSON.stringify([{ title: 'Archive Box', text: 'distinctive local findings' }]) }]
              : []
          }));
        case 'destroy_credentials':
          vault.entries = [];
          vault.state.exists = false;
          persist();
          return { ...vault.state, exists: false, count: 0 };
        case 'lock_credentials':
          // Nothing is open to close: this only drops the grant an instance load left
          // behind, which is why the launcher calls it on every mount.
          vault.state.granted = false;
          return { ...vault.state, count: vault.entries.length };
        case 'git_sync_folder':
          // Which folder the backup acts on, and whether it is the user's own pick — the
          // flag is what draws the way back to the automatic one.
          return { folder: syncFolder.picked ?? syncFolder.automatic, overridden: syncFolder.picked !== null };
        case 'pick_sync_folder':
          // The OS folder picker, imitated. Rust writes what was chosen into the recents
          // sidecar and answers with the path it wrote, which is what the next read of
          // `git_sync_folder` reports — so the dialog is re-read rather than assumed. What
          // the command is handed is the folder the dialog is naming, which is where the
          // picker opens.
          syncFolder.picks += 1;
          syncFolder.openedAt = args.current ?? null;
          syncFolder.picked = 'D:/Lithic';
          return syncFolder.picked;
        case 'clear_sync_folder_override':
          syncFolder.clears += 1;
          syncFolder.picked = null;
          return null;
        default:
          // Everything else the launcher asks for in this mode: no answer, which
          // every caller already treats as "absent".
          return null;
      }
    };
    window.__TAURI__ = {
      // A command that refuses has to reject the way Rust's does: a synchronous throw
      // out of `invoke` would not be the same contract.
      core: {
        invoke: (command, args) => {
          try {
            return Promise.resolve(answer(command, args));
          } catch (error) {
            return Promise.reject(error);
          }
        }
      },
      event: { listen: () => Promise.resolve(() => {}) }
    };
  }, SECRET_SENTENCES);
  await vaultPage.goto(`file://${artifact}?mode=tauri`, { waitUntil: 'domcontentloaded' });
  // Two bookmarks, one of which the vault already holds a login for.
  //
  // The example address is the sheet's own (`www.foobar.com`, see scripts/ui-gallery.mjs)
  // rather than a reserved name, because this dialog prints it and an assertion below reads
  // that text back. The label stays the short form: that is the row's display name, and it
  // is what the app derives from the URL anyway. It is never mounted — the one address a run
  // does open is `personal.lithic.uk`, the project's own, and that is deliberate — so the
  // *parsing* fixtures keep their reserved hosts, where `example.test:8080` is testing a port.
  await vaultPage.evaluate(entries => {
    localStorage.setItem('bookmarkedInstances', JSON.stringify(entries));
  }, [
    { url: 'https://personal.lithic.uk', label: 'personal.lithic.uk' },
    { url: 'https://www.foobar.com', label: 'foobar.com' }
  ]);
  await vaultPage.goto(`file://${artifact}?mode=tauri`, { waitUntil: 'domcontentloaded' });
  await vaultPage.waitForSelector('.bookmark-row .vault-row-button');
  await new Promise(resolve => setTimeout(resolve, 250));

  // The vault no longer has a control in the heading: what it owns is an instance's
  // address, so its controls live with the instances.
  assert.equal(await vaultPage.$('.vault-button'), null, 'The vault has no app-level button in the heading');

  // The vault's own manager is a button inside the bookmark dialog, which owns the
  // same thing it does — an instance's address. It used to be a tile in the
  // launcher's action row, spending permanent main-screen space on a control you
  // only reach for while setting an instance up.
  await vaultPage.click('.action-pair .bookmark-button');
  await vaultPage.waitForSelector('.vault-manager-button');
  const managerControl = await vaultPage.evaluate(() => {
    const node = document.querySelector('.vault-manager-button');
    return {
      exists: Boolean(node),
      inBookmarkDialog: Boolean(node?.closest('.launcher-modal')?.querySelector('#bookmark-title')),
      inActionCard: Boolean(node?.closest('.action-pair')),
      hasLogins: node?.classList.contains('has-logins') ?? null,
      title: node?.getAttribute('title') ?? ''
    };
  });
  assert.ok(managerControl.exists, 'The manager key renders in the desktop app');
  assert.ok(managerControl.inBookmarkDialog, 'It sits in the bookmark dialog, which owns the same address');
  assert.equal(managerControl.inActionCard, false, '...and no longer takes a tile in the launcher’s own action row');
  assert.equal(managerControl.hasLogins, true, 'A vault holding a login says so in colour');
  assert.ok(managerControl.title.includes('1 saved'), `And says how many without being opened: ${managerControl.title}`);
  // Its shape in that row: a key glyph and a label, on the same line as the two buttons
  // the dialog already had, coloured rather than hidden — and the colour is read as the
  // computed value, because a plain `.modal-action.secondary` would paint it #ddd and
  // quietly win on a later rule.
  const managerLooks = await vaultPage.evaluate(() => {
    const node = document.querySelector('.vault-manager-button');
    const row = node.closest('.modal-actions');
    const buttons = [...row.querySelectorAll('button')];
    const box = node.getBoundingClientRect();
    return {
      label: node.textContent.trim(),
      labels: buttons.map(button => button.textContent.trim()),
      widths: buttons.map(button => Math.round(button.getBoundingClientRect().width)),
      // The glyph and the label are one group, centred in the half of the row the button
      // takes: the half is wider than the two of them, so where that spare space goes is
      // the whole of whether the button reads as finished.
      groupCentre: Math.round(
        (node.querySelector('svg').getBoundingClientRect().left +
          node.querySelector('span').getBoundingClientRect().right) / 2 -
          (box.left + box.right) / 2
      ),
      hasGlyph: Boolean(node.querySelector('svg')),
      colour: getComputedStyle(node).color,
      onOneLine: buttons.every(button => Math.round(button.getBoundingClientRect().top) === Math.round(box.top)),
      rowOverflow: row.scrollWidth - row.clientWidth
    };
  });
  assert.deepEqual(
    managerLooks.labels,
    ['Save Bookmark', 'Manage Credentials'],
    'The dialog names both of its actions: the save, and the vault it saves into'
  );
  // Equal halves of the row, measured: the manager key is the shorter label, and at
  // `flex: 1 1 auto` it was priced from its own width, which is what made the second
  // option read as the lesser one. Equal here means equal *to the pixel*, since a
  // shared basis makes the labels' widths irrelevant while both of them fit.
  assert.equal(
    managerLooks.widths[0],
    managerLooks.widths[1],
    `Both actions take the same width: ${JSON.stringify(managerLooks.widths)}px`
  );
  assert.ok(managerLooks.hasGlyph, '...and keeps the key it is recognised by');
  assert.ok(
    Math.abs(managerLooks.groupCentre) <= 1,
    `The key glyph and the label are centred in their half of the row, ${managerLooks.groupCentre}px off centre`
  );
  assert.equal(managerLooks.colour, 'rgb(123, 168, 111)', 'Green is the same green a bookmark row’s key uses for a saved login');
  assert.equal(managerLooks.onOneLine, true, 'It shares the dialog’s action row rather than wrapping under it');
  assert.equal(managerLooks.rowOverflow, 0, '...without the row overflowing the dialog');
  // The same row at the two phone widths the launcher has to hold. Equal halves are a
  // property of a dialog wide enough to give each action half; on a phone the key's own
  // minimum width — padding, glyph, gap and a two-word label — is most of the row, so what
  // is asserted there is the thing that actually matters: nothing clipped, nothing past the
  // dialog's own edge, and the two still side by side wherever they fit on one line.
  const managerRowAt = async (width) => {
    await vaultPage.setViewport({ width, height: 700 });
    await new Promise(resolve => setTimeout(resolve, 60));
    const measured = await vaultPage.evaluate(() => {
      const modal = document.querySelector('.bookmark-modal').getBoundingClientRect();
      const buttons = [...document.querySelectorAll('.bookmark-modal .modal-actions button')];
      const boxes = buttons.map(button => button.getBoundingClientRect());
      return {
        widths: boxes.map(box => Math.round(box.width)),
        rows: new Set(boxes.map(box => Math.round(box.top))).size,
        clipped: buttons.filter(button => button.scrollWidth - button.clientWidth > 0).length,
        past: Math.max(0, Math.round(Math.max(...boxes.map(box => box.right)) - (modal.right - 22)))
      };
    });
    return { ...measured, width };
  };
  const rowAtPhone = await managerRowAt(390);
  const rowAtNarrow = await managerRowAt(320);
  await vaultPage.setViewport({ width: 900, height: 700 });
  // 390px: both fit on the one line the dialog's own margin leaves, so the row is asserted
  // to still be one row rather than two — a phone should not turn the choice into a stack
  // while there is room to state it as a choice.
  assert.deepEqual(
    { clipped: rowAtPhone.clipped, past: rowAtPhone.past, rows: rowAtPhone.rows },
    { clipped: 0, past: 0, rows: 1 },
    `At ${rowAtPhone.width}px the two actions share one line, unclipped and inside the dialog: ${JSON.stringify(rowAtPhone)}`
  );
  // 320px: the labels no longer fit together, so the row wraps to a button per line — where
  // each action is alone on its line and therefore takes the same width as the other again.
  assert.deepEqual(
    { clipped: rowAtNarrow.clipped, past: rowAtNarrow.past, equal: rowAtNarrow.widths[0] === rowAtNarrow.widths[1] },
    { clipped: 0, past: 0, equal: true },
    `At ${rowAtNarrow.width}px the two actions stack at one width, unclipped and inside the dialog: ${JSON.stringify(rowAtNarrow)}`
  );
  // An address typed in the bookmark dialog is deliberately *not* carried into the
  // manager, because the manager has nowhere to put it: it lists and forgets, and a
  // login is written only for an instance the user was already pointing at. So there
  // is no add form here, and no field anywhere in the dialog that would take an origin.
  await vaultPage.type('input[aria-label="Self-hosted instance URL"]', 'foobar.com');
  await vaultPage.click('.vault-manager-button');
  await vaultPage.waitForSelector('.vault-modal');
  const handedOver = await vaultPage.evaluate(() => ({
    bookmarkDialogClosed: document.querySelector('#bookmark-title') === null,
    dialogs: document.querySelectorAll('.modal-overlay').length,
    forms: document.querySelectorAll('.vault-modal .vault-field').length,
    subheads: [...document.querySelectorAll('.vault-modal .vault-subhead')].map(node => node.textContent.trim()),
    buttons: [...document.querySelectorAll('.vault-modal .modal-action')].map(node => node.textContent.trim())
  }));
  assert.equal(handedOver.bookmarkDialogClosed, true, 'The bookmark dialog closes behind the vault it opened');
  assert.equal(handedOver.dialogs, 1, '...so the two are never stacked on each other');
  assert.equal(handedOver.forms, 0, 'The manager holds no fields at all, so no address can be typed into it');
  assert.deepEqual(handedOver.subheads, [], '...and no add-a-login section to hold them');
  assert.equal(
    await vaultPage.evaluate(() => [...document.querySelectorAll('.vault-modal .modal-action')].some(node => /save/i.test(node.textContent))),
    false,
    'Not one action offers to save anything, in either of its shapes'
  );
  assert.deepEqual(
    handedOver.buttons,
    ['Open', 'Forget Everything'],
    'The PIN shape carries the PIN and the reset: the way out is the × in the corner'
  );
  await assertNoExtraDismiss('.vault-modal', 'The PIN shape');
  // The sixth character is the submit, so there is no button to press.
  await typePin(vaultPage, '.vault-unlock-pin', 'L1TH1C');
  await new Promise(resolve => setTimeout(resolve, 400));
  const firstUnlock = await vaultPage.evaluate(() => ({
    rows: document.querySelectorAll('.vault-list li').length,
    empty: Boolean(document.querySelector('.vault-empty')),
    pinBoxes: document.querySelectorAll('.vault-unlock-pin .pin-box').length,
    error: document.querySelector('.vault-modal .status-line.error')?.textContent.trim() ?? '',
    listed: [...document.querySelectorAll('.vault-list li')].map(row => row.textContent.replace(/\s+/g, ' ').trim()),
    typed: [...document.querySelectorAll('.vault-unlock-pin .pin-box')].map(box => box.value).join(''),
    calls: window.__lithicVault.calls.map(call => call.command).slice(-4)
  }));
  assert.equal(
    firstUnlock.rows,
    1,
    `The completed PIN submits itself: the vault is listed with no button pressed (${JSON.stringify(firstUnlock)})`
  );
  // A fresh page for what comes next, which walks the per-instance keys from the locked
  // vault this left behind. The coverage answer is what colours them, so the rows are read
  // after one of them has gone green rather than after they merely exist.
  await vaultPage.goto(`file://${artifact}?mode=tauri`, { waitUntil: 'domcontentloaded' });
  await vaultPage.waitForSelector('.bookmark-row .vault-row-button');
  await waitForKeyCoverage('personal.lithic.uk', true);

  // One key per bookmark, coloured from the vault file's index: green for an address a
  // login is saved for, grey for one that has none — decided before anything unlocks.
  const rowKeys = await vaultPage.evaluate(() =>
    [...document.querySelectorAll('.bookmark-row')].map(row => {
      const key = row.querySelector('.vault-row-button');
      return {
        covered: key?.classList.contains('covered') ?? null,
        title: key?.getAttribute('title') ?? '',
        colour: key ? getComputedStyle(key).color : '',
        beforeRemove: key?.nextElementSibling?.classList.contains('remove-recent') ?? false
      };
    })
  );
  assert.equal(rowKeys.length, 2, 'Every bookmark row gets a key');
  assert.equal(rowKeys[0].covered, true, 'The bookmark with a saved login shows the key green');
  assert.equal(rowKeys[1].covered, false, 'One without shows it grey, meaning it can be set up');
  assert.equal(rowKeys[0].colour, 'rgb(123, 168, 111)', 'Green is the same green the manager key uses');
  assert.equal(rowKeys[1].colour, 'rgb(138, 138, 138)', 'Grey is the same grey');
  assert.ok(rowKeys[1].beforeRemove, 'The key sits with the row’s other controls, not over the link');
  assert.ok(rowKeys[1].title.includes('Save a login'), `Grey says what a click will do: ${rowKeys[1].title}`);

  // The grey key is the way a login is written, and the only way: it opens the one dialog
  // that can save one, already aimed at that row's own address — which is why there is no
  // field anywhere in the app to type an address into, and no way to save a login for an
  // instance the user was not already pointing at.
  await vaultPage.evaluate(() => document.querySelectorAll('.bookmark-row .vault-row-button')[1].click());
  await vaultPage.waitForSelector('#credential-offer-title');
  const aimedAtRow = await vaultPage.evaluate(() => ({
    heading: document.querySelector('#credential-offer-title').textContent.trim(),
    sub: document.querySelector('#credential-offer-title').nextElementSibling.textContent.replace(/\s+/g, ' ').trim(),
    originFields: document.querySelectorAll('input#vault-new-origin, [list="vault-origin-hints"], datalist').length,
    pinLabel: document.querySelector('.credential-offer-pin .pin-label')?.textContent.trim() ?? '',
    toggleInLabel: document.querySelectorAll('.credential-offer-pin .pin-head .vault-reveal').length,
    toggleNextToLabel: document.querySelector('.credential-offer-pin .pin-head .pin-label')?.nextElementSibling?.classList.contains('vault-reveal') ?? false,
    // Every toggle on screen has to be riding in a label row: one on its own line is the
    // thing the contact sheet sent back.
    looseToggles: [...document.querySelectorAll('.vault-modal .vault-reveal')].filter(
      node => !node.closest('.pin-head')
    ).length,
    managerInstead: document.querySelector('#vault-title') !== null,
    buttons: [...document.querySelectorAll('.vault-modal .modal-action')]
      .map(node => ({ label: node.textContent.trim(), disabled: node.disabled })),
    dialogs: document.querySelectorAll('.modal-overlay').length
  }));
  assert.equal(aimedAtRow.managerInstead, false, 'The key opens the save dialog rather than the manager');
  assert.equal(aimedAtRow.heading, 'Add a saved credential?');
  assert.ok(aimedAtRow.sub.includes('foobar.com'), `And names the address that key belongs to: ${aimedAtRow.sub}`);
  assert.equal(aimedAtRow.originFields, 0, 'There is no address field, no hint list, and nothing to choose from');
  assert.equal(aimedAtRow.pinLabel, 'PIN', 'A vault on disk already has its PIN, so nothing is being chosen here');
  assert.equal(aimedAtRow.toggleInLabel, 1, 'Its Show toggle rides in the PIN label row rather than on a row of its own');
  assert.equal(aimedAtRow.toggleNextToLabel, true, '...as the row\u2019s own last child, which is what puts it on the boxes\u2019 right edge');
  assert.equal(aimedAtRow.looseToggles, 0, '...and no toggle anywhere in this dialog has a row to itself');
  assert.deepEqual(
    aimedAtRow.buttons.map(button => button.label),
    ['Save Credential', 'Open without saving'],
    'Saving and borrowing sit beside each other, with no third button that is just the ×'
  );
  await assertNoExtraDismiss('.vault-modal', 'The save-a-login dialog');
  assert.deepEqual(
    aimedAtRow.buttons.filter(button => button.label === 'Don’t ask again'),
    [],
    'There is no "do not ask again": the answer it stood for is borrowing the login below'
  );
  assert.equal(aimedAtRow.dialogs, 1, 'All of it fits one dialog');

  // Saving it from here: the PIN is typed once for the one command that stores it, and
  // nothing is left open behind it. With a vault on disk the PIN is not a choice, so it
  // does not submit anything when the sixth character lands.
  await typePin(vaultPage, '.credential-offer-pin', 'L1TH1C');
  await vaultPage.type('.credential-offer-user', 'keeper');
  // One password box, not two: the instance is asked whether the login works, and two
  // matching typos would satisfy a repeat box that cannot tell either of them is wrong.
  await vaultPage.type('.credential-offer-password', 's3cret');
  await new Promise(resolve => setTimeout(resolve, 900));
  await vaultPage.$eval('.credential-offer-save', node => node.click());
  await new Promise(resolve => setTimeout(resolve, 400));
  const rowSave = vaultCalls.filter(call => call.command === 'save_login_for_instance').at(-1);
  assert.deepEqual(
    rowSave?.args,
    { origin: 'https://www.foobar.com', secret: 'L1TH1C', user: 'keeper', password: 's3cret' },
    'Saving from a row passes the origin it was aimed at, with PIN, user and password as Rust declares them'
  );
  assert.equal(
    vaultCalls.some(call => call.command === 'unlock_credentials'),
    false,
    '...and there is no separate unlock for it to have gone through first, because none exists'
  );

  // The list, read from the manager: the same PIN, typed again, because it was never a
  // session. Both logins are there, and both keys are now green.
  await reopenLauncher();
  await waitForKeyCoverage('foobar.com', true);
  await vaultPage.evaluate(() => document.querySelectorAll('.bookmark-row .vault-row-button')[1].click());
  await vaultPage.waitForSelector('.vault-modal');
  assert.equal(
    await vaultPage.$eval('.vault-count', node => node.textContent.trim()),
    '2 logins saved.',
    'The count is known while locked, because it comes from the file’s origin index'
  );
  assert.equal(
    await vaultPage.evaluate(() => Boolean(document.querySelector('.vault-modal .vault-field'))),
    false,
    'A vault that has not been opened offers no way to add a login'
  );
  await typePin(vaultPage, '.vault-unlock-pin', 'L1TH1C');
  await new Promise(resolve => setTimeout(resolve, 400));
  const afterUnlock = await vaultPage.evaluate(() => ({
    calls: window.__lithicVault.calls,
    listed: [...document.querySelectorAll('.vault-list li')].map(row => row.textContent.replace(/\s+/g, ' ').trim()),
    // Nothing above the rows: the heading names the list and the rows are the list, so a
    // sentence there could only restate one of them. Read structurally, as the heading's
    // own next sibling, so a line cannot creep back in under a different class name.
    copyLines: document.querySelectorAll('.vault-modal .vault-sub, .vault-modal .vault-note').length,
    headingNext: document.getElementById('vault-title')?.nextElementSibling?.tagName.toLowerCase() ?? '',
    openDialogs: [...document.querySelectorAll('.vault-modal, .launcher-modal')].length,
    bookmarkDialogClosed: document.querySelector('#bookmark-title') === null,
    greenRows: [...document.querySelectorAll('.bookmark-row .vault-row-button')].map(key => key.classList.contains('covered')),
    coveredCall: window.__lithicVault.calls.filter(call => call.command === 'credential_coverage').at(-1)
  }));
  const listCall = afterUnlock.calls.find(call => call.command === 'list_credentials');
  assert.deepEqual(listCall?.args, { secret: 'L1TH1C' }, 'Reading the list passes the PIN under the name Rust expects, folded to upper case');
  assert.equal(afterUnlock.listed.length, 2, 'The completed PIN opens the vault, listing what is in it');
  assert.equal(afterUnlock.copyLines, 0, 'The list carries no copy line above the rows');
  assert.equal(afterUnlock.headingNext, 'ul', '...the heading is followed straight by the rows');
  assert.ok(
    afterUnlock.listed.some(row => row.includes('https://personal.lithic.uk')),
    'The saved login is listed by its address'
  );
  assert.equal(afterUnlock.bookmarkDialogClosed, true, 'The bookmark dialog closes behind the vault it opened, rather than stacking on it');
  assert.equal(afterUnlock.openDialogs, 1, 'One dialog is on screen, and it is the vault’s');
  assert.deepEqual(afterUnlock.greenRows, [true, true], 'And every row the vault now covers turns green');
  assert.ok(
    afterUnlock.coveredCall.args.origins.includes('https://www.foobar.com'),
    'The rows were recoloured by asking the vault about their addresses'
  );
  await assertNoExtraDismiss('.vault-modal', 'The manager with logins in it');
  assert.equal(
    vaultCalls.some(call => call.command === 'credential_coverage' && call.args.origins.includes('https://www.foobar.com')),
    true,
    'And the save asked about the addresses as part of writing, so the row it came from is green'
  );

  // Checking a login against its instance. Only offered here, in the list, because the
  // password has to be readable to send it — which is true only while the vault is open.
  await vaultPage.waitForFunction(() => document.querySelectorAll('.vault-list .vault-test').length === 2);
  const check = async needle => {
    await vaultPage.evaluate(text => {
      const row = [...document.querySelectorAll('.vault-list li')].find(node => node.textContent.includes(text));
      row.querySelector('.vault-test').click();
    }, needle);
  };
  // Waited for with a pause rather than a condition: the mock answers at once, and a
  // missing or wrong verdict should fail as the assertion below — which names it —
  // rather than as a timeout that only says nothing appeared.
  await check('personal.lithic.uk');
  await new Promise(resolve => setTimeout(resolve, 200));
  await check('foobar.com');
  await new Promise(resolve => setTimeout(resolve, 200));
  const checked = await vaultPage.evaluate(() => ({
    calls: window.__lithicVault.calls.filter(call => call.command === 'check_credential'),
    verdicts: [...document.querySelectorAll('.vault-check')]
      .map(node => `${node.className.replace('vault-check ', '')}:${node.textContent.trim()}`)
      .sort(),
    // Read defensively: if no verdict rendered at all, the assertions below are what
    // should say so, not a null dereference in here.
    reason: document.querySelector('.vault-check.refused')?.getAttribute('title') ?? '',
    labels: [...document.querySelectorAll('.vault-list .vault-test')].map(node => node.getAttribute('aria-label'))
  }));
  assert.deepEqual(
    checked.calls.at(-1)?.args,
    { origin: 'https://www.foobar.com', secret: 'L1TH1C' },
    'Checking passes the origin and the PIN under the names Rust expects'
  );
  assert.deepEqual(checked.verdicts, ['accepted:Signs in', 'refused:Refused'], 'Each login shows what its instance said about it');
  assert.ok(checked.reason.includes('401'), `And the reason is kept behind the verdict: ${checked.reason}`);
  assert.ok(
    checked.labels.every(label => label.startsWith('Check the login for https://')),
    `The control says which login it will check: ${checked.labels.join(' / ')}`
  );

  // Forgetting one, from the list: the command takes the normalised origin, and the
  // row that address belongs to goes back to grey.
  await vaultPage.evaluate(() => {
    const row = [...document.querySelectorAll('.vault-list li')].find(node => node.textContent.includes('foobar.com'));
    row.querySelector('.vault-forget').click();
  });
  await vaultPage.waitForFunction(() => document.querySelectorAll('.vault-list li').length === 1);
  const afterForget = await vaultPage.evaluate(() => ({
    calls: window.__lithicVault.calls.filter(call => call.command === 'forget_credentials'),
    greenRows: [...document.querySelectorAll('.bookmark-row .vault-row-button')].map(key => key.classList.contains('covered'))
  }));
  assert.deepEqual(
    afterForget.calls.at(-1)?.args,
    { origin: 'https://www.foobar.com', secret: 'L1TH1C' },
    'Forgetting passes the normalised origin and the PIN, because it is a change'
  );
  assert.deepEqual(afterForget.greenRows, [true, false], 'The forgotten address stops showing a saved login');

  // There is no rotation and no "change the PIN" control. An unwanted or forgotten PIN
  // is replaced by forgetting everything and setting the vault up again, which is the
  // one path that also costs the logins — so the rotation flow's controls are gone
  // rather than kept beside a control that makes them redundant.
  assert.equal(await vaultPage.$('.vault-advanced'), null, 'The manager has no advanced/rotation section');
  assert.equal(
    await vaultPage.evaluate(() =>
      [...document.querySelectorAll('.vault-modal .modal-action')].some(node => /change|rotate/i.test(node.textContent))
    ),
    false,
    '...and no control anywhere in it that offers to change the PIN'
  );

  // Closing the manager asks Rust to lock nothing, because nothing was left open: every
  // action above carried the PIN in the same command that used it. This is the whole
  // point of the design — there is no lock control because there is no vault held open
  // to lock.
  const locksBefore = await vaultPage.evaluate(() =>
    window.__lithicVault.calls.filter(call => call.command === 'lock_credentials').length
  );
  await vaultPage.click('.vault-modal .modal-close');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-modal') === null);
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(
    await vaultPage.evaluate(() => window.__lithicVault.calls.filter(call => call.command === 'lock_credentials').length),
    locksBefore,
    'Closing the manager locks nothing, because it left nothing open'
  );
  assert.equal(await vaultPage.$('.instance-unlock-pin .pin-box'), null, 'and no prompt is left behind by any of it');

  // And the PIN did not survive the dialog. Reopening asks for it again rather than
  // showing a list a previous visit had opened — which is what "no session" looks like
  // from the outside.
  await vaultPage.evaluate(() => document.querySelectorAll('.bookmark-row .vault-row-button')[1].click());
  await vaultPage.waitForSelector('.vault-modal');
  assert.equal(
    await vaultPage.evaluate(() => document.querySelectorAll('.vault-modal .pin-box').length),
    6,
    'Reopening the manager asks for the PIN again'
  );
  assert.equal(
    await vaultPage.evaluate(() => Boolean(document.querySelector('.vault-list'))),
    false,
    '...with nothing listed behind it, because the last visit left nothing open'
  );
  await vaultPage.click('.vault-modal .modal-close');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-modal') === null);

  // --- Offering to save a login, where there is a prompt to answer --------------
  // An instance with nothing saved used to open straight through. It now asks first —
  // but only where asking can lead anywhere: an instance that challenges a visitor who
  // has no password, which is what `probe_instance` is asked before anything appears.
  const offerRequests = [];
  const recordOffer = request => {
    if (request.isNavigationRequest()) offerRequests.push(request.url());
  };
  /** Click a bookmark by its label, and give the dialog (or the navigation) a moment. */
  const openBookmark = async label => {
    await vaultPage.evaluate(text => {
      const row = [...document.querySelectorAll('.bookmark-row')].find(node => node.textContent.includes(text));
      row.querySelector('.bookmark-name').click();
    }, label);
    await new Promise(resolve => setTimeout(resolve, 300));
  };
  /**
   * Add a bookmark fixture and come back to the launcher, so a case with no login of its
   * own can be opened without borrowing one the earlier assertions rely on.
   */
  const addBookmark = async address => {
    // Back on the launcher first: the call before this one may have handed the tab to an
    // instance, and a document somewhere else has no storage to add a fixture to.
    await reopenLauncher();
    await vaultPage.evaluate(url => {
      const entries = JSON.parse(localStorage.getItem('bookmarkedInstances') ?? '[]');
      if (!entries.some(entry => entry.url === url)) {
        entries.push({ url, label: url.replace(/^https?:\/\//, '') });
        localStorage.setItem('bookmarkedInstances', JSON.stringify(entries));
      }
    }, address);
    await vaultPage.goto(`file://${artifact}?mode=tauri`, { waitUntil: 'domcontentloaded' });
    await vaultPage.waitForSelector('.bookmark-row .vault-row-button');
  };
  // An address nothing is saved for: both of the fixtures above have a login by now.
  await addBookmark('https://unsaved.example');
  vaultPage.on('request', recordOffer);
  await openBookmark('unsaved.example');
  const offered = await vaultPage.evaluate(() => ({
    heading: document.querySelector('#credential-offer-title')?.textContent.trim() ?? '',
    sub: document.querySelector('#credential-offer-title')?.nextElementSibling?.textContent.trim() ?? '',
    pinBoxes: document.querySelectorAll('.credential-offer-pin .pin-box').length,
    confirmBoxes: document.querySelectorAll('.credential-offer-pin-confirm .pin-box').length,
    buttons: [...document.querySelectorAll('.modal-actions button')].map(node => node.textContent.trim()),
    saveDisabled: document.querySelector('.credential-offer-save')?.disabled ?? null,
    dialogs: document.querySelectorAll('.modal-overlay').length,
    probes: window.__lithicVault.calls.filter(call => call.command === 'probe_instance').at(-1)?.args
  }));
  assert.equal(offered.heading, 'Add a saved credential?', 'An instance with nothing saved is offered one');
  // One line on both paths into this dialog. The offer used to say *why* it had opened
  // ("…asks for a password"), which was the heading with an address in it, and the line
  // used to add the scope the credential is kept under. Both are gone: what is left is
  // the one fact the dialog cannot do without, which the offer and the sheet share.
  assert.equal(
    offered.sub,
    'For unsaved.example.',
    'The offer names the instance the credential is for, and says nothing else'
  );
  assert.equal(offered.pinBoxes, 6, 'The PIN is asked for in six boxes');
  assert.equal(offered.confirmBoxes, 0, 'A vault on disk already has a PIN, so there is nothing to confirm');
  assert.deepEqual(
    offered.buttons,
    ['Save Credential', 'Open without saving'],
    'Both ways of answering sit beside each other, and neither is a second way out'
  );
  assert.equal(offered.saveDisabled, true, 'And an empty credential cannot be saved');
  assert.equal(offered.dialogs, 1, 'All of it fits one dialog');
  assert.deepEqual(
    offered.probes,
    { url: 'https://unsaved.example' },
    'Whether to ask at all was decided by the probe, before anything was shown'
  );
  assert.equal(offerRequests.length, 0, 'Nothing has been requested from the instance yet');

  // The boxes fold what is typed, here in the one place where six characters do not
  // submit anything: with a vault already on disk there is nothing to choose, so the
  // PIN can be looked at after it has been typed.
  await typePin(vaultPage, '.credential-offer-pin', 'l1th1c');
  assert.equal(
    await vaultPage.$$eval('.credential-offer-pin .pin-box', nodes => nodes.map(node => node.value).join('')),
    'L1TH1C',
    'A lower-case PIN is folded as it is typed, which is what makes the entry case-insensitive'
  );

  // The credential itself. There is no repeat box: the instance is asked, and the
  // sentence it answers with is what the dialog shows — two matching typos would pass a
  // repeat box, and the instance is the only thing that can tell a wrong password from
  // a right one.
  await vaultPage.type('.credential-offer-user', 'keeper');
  assert.equal(
    await vaultPage.$eval('.credential-offer-save', node => node.disabled),
    true,
    'A credential with no password cannot be saved, and nothing was asked yet either'
  );
  await vaultPage.type('.credential-offer-password', 's3cret');
  // Longer than the box's own settle, so the answer about this password is on screen.
  await new Promise(resolve => setTimeout(resolve, 900));
  const offerCheck = await vaultPage.evaluate(() => ({
    asked: window.__lithicVault.calls.filter(call => call.command === 'check_login_for_instance').at(-1)?.args ?? null,
    line: document.querySelector('.vault-check-line')?.textContent.trim() ?? ''
  }));
  assert.deepEqual(
    offerCheck.asked,
    { origin: 'https://unsaved.example', user: 'keeper', password: 's3cret' },
    'The typed login is put to the instance before it is saved, under the names Rust expects'
  );
  assert.ok(offerCheck.line.length > 0, `...and the dialog shows what it said: ${offerCheck.line}`);
  assert.equal(
    await vaultPage.$eval('.credential-offer-save', node => node.disabled),
    false,
    'A login the instance accepts can be saved'
  );
  await vaultPage.$eval('.credential-offer-save', node => node.click());
  await new Promise(resolve => setTimeout(resolve, 400));
  vaultPage.off('request', recordOffer);
  const savedOffer = vaultCalls.filter(call => call.command === 'save_login_for_instance').at(-1);
  assert.deepEqual(
    savedOffer?.args,
    { origin: 'https://unsaved.example', secret: 'L1TH1C', user: 'keeper', password: 's3cret' },
    'Saving offers origin, PIN, user and password exactly as Rust declares them'
  );
  assert.ok(
    offerRequests.some(url => url.startsWith('https://unsaved.example')),
    `And the instance opens straight afterwards, without the platform's own prompt (saw ${JSON.stringify(offerRequests)})`
  );
  assert.ok(
    offerRequests.some(url => url.includes('lithic-from=')),
    '...carrying the marker that names this launcher, as any other open does'
  );

  // --- Open without saving, which is what replaced the platform's own prompt -------
  // The workflow for not using the credential manager, and the answer "do not ask again"
  // used to stand for: the login is borrowed for one load rather than written down, so
  // there is nothing stored and nothing to remember. It needs no PIN, because nothing is
  // sent to the vault — the values came from the boxes, and the grant they leave behind
  // is the same one an unlock leaves, which is what answers the instance's own 401.
  await addBookmark('https://borrow.example');
  await openBookmark('borrow.example');
  await vaultPage.waitForSelector('#credential-offer-title');
  await vaultPage.type('.credential-offer-user', 'keeper');
  await vaultPage.type('.credential-offer-password', 's3cret');
  await new Promise(resolve => setTimeout(resolve, 900));
  const borrowing = await vaultPage.evaluate(() => ({
    pinBoxes: [...document.querySelectorAll('.credential-offer-pin .pin-box')].map(box => box.value).join(''),
    label: document.querySelector('.credential-offer-without-saving').textContent.trim(),
    borrowDisabled: document.querySelector('.credential-offer-without-saving').disabled,
    saveDisabled: document.querySelector('.credential-offer-save').disabled,
    skip: document.querySelector('.credential-offer-skip')
  }));
  assert.equal(borrowing.label, 'Open without saving', 'The way through without the manager is named for what it does');
  assert.equal(borrowing.pinBoxes, '', 'No PIN has been typed');
  assert.equal(borrowing.borrowDisabled, false, '...and borrowing needs none: an empty PIN does not hold it back');
  assert.equal(borrowing.saveDisabled, true, '...while saving still does, because writing a login needs the PIN');
  assert.equal(borrowing.skip, null, 'There is no "do not ask again", because borrowing is what it used to mean');
  const lentRequests = [];
  const recordLent = request => {
    if (request.isNavigationRequest()) lentRequests.push(request.url());
  };
  vaultPage.on('request', recordLent);
  await vaultPage.$eval('.credential-offer-without-saving', node => node.click());
  await new Promise(resolve => setTimeout(resolve, 400));
  vaultPage.off('request', recordLent);
  const lent = vaultCalls.filter(call => call.command === 'lend_instance_credentials').at(-1);
  assert.deepEqual(
    lent?.args,
    { origin: 'https://borrow.example', user: 'keeper', password: 's3cret' },
    'Borrowing passes the origin and the typed login, under the names Rust expects'
  );
  assert.equal(
    await vaultPage.evaluate(() => window.__lithicVault.entries.some(entry => entry.origin === 'https://borrow.example')),
    false,
    '...and nothing was written: borrowing is not saving by another name'
  );
  assert.equal(
    vaultCalls.some(call => call.command === 'remember_credentials'),
    false,
    'No command that stores a login was used anywhere in this block'
  );
  assert.ok(
    lentRequests.some(url => url.startsWith('https://borrow.example')),
    `Then the instance opens (saw ${JSON.stringify(lentRequests)})`
  );
  assert.ok(
    lentRequests.some(url => url.includes('lithic-from=')),
    '...carrying the marker that names this launcher, as any other open does'
  );
  // The row says so afterwards: a borrowed login is not a saved one, so the key is still
  // grey and still offers to save one.
  await reopenLauncher();
  const borrowedKey = await vaultPage.evaluate(() => {
    const row = [...document.querySelectorAll('.bookmark-row')].find(node => node.textContent.includes('borrow.example'));
    const key = row.querySelector('.vault-row-button');
    return { covered: key.classList.contains('covered'), title: key.getAttribute('title') };
  });
  assert.equal(borrowedKey.covered, false, 'Borrowing leaves the row grey: it is not a login on file');
  assert.ok(borrowedKey.title.includes('Save a login'), `So the key still offers to save one: ${borrowedKey.title}`);

  // The other verdict from the probe: an instance that answers without a password is
  // never asked about, because a saved login would have nothing to answer.
  await reopenLauncher();
  await vaultPage.evaluate(() => {
    const entries = JSON.parse(localStorage.getItem('bookmarkedInstances') ?? '[]');
    if (!entries.some(entry => entry.url === 'https://open.example')) {
      entries.push({ url: 'https://open.example', label: 'open.example' });
      localStorage.setItem('bookmarkedInstances', JSON.stringify(entries));
    }
  });
  await reopenLauncher();
  const openRequests = [];
  const recordOpen = request => {
    if (request.isNavigationRequest()) openRequests.push(request.url());
  };
  vaultPage.on('request', recordOpen);
  await openBookmark('open.example');
  await new Promise(resolve => setTimeout(resolve, 400));
  vaultPage.off('request', recordOpen);
  assert.equal(
    await vaultPage.evaluate(() => document.querySelector('#credential-offer-title') === null),
    true,
    'An instance that asks for no password is never offered a login for one'
  );
  assert.ok(
    openRequests.some(url => url.startsWith('https://open.example')),
    `It opens straight away (saw ${JSON.stringify(openRequests)})`
  );
  // The fixture list drops the instance that asks for nothing, so a bookmark added for
  // one verdict cannot quietly change what the next assertions count. Read from the
  // launcher's own document, since the handoff has left this tab somewhere else.
  await reopenLauncher();
  await vaultPage.evaluate(() => {
    const entries = JSON.parse(localStorage.getItem('bookmarkedInstances') ?? '[]');
    localStorage.setItem('bookmarkedInstances', JSON.stringify(entries.filter(entry => entry.url !== 'https://open.example')));
  });

  // --- Unlocking is per instance, not per session -------------------------------
  // Opening an instance the vault has a login for asks for the secret first, and the
  // credential that buys is one instance load: Rust holds it only until the load is
  // done, and this launcher locks again on the way back.
  const navigationRequests = [];
  const recordInstanceNavigation = request => {
    if (request.isNavigationRequest()) navigationRequests.push(request.url());
  };
  await reopenLauncher();
  navigationRequests.length = 0;
  vaultPage.on('request', recordInstanceNavigation);
  await vaultPage.evaluate(() => {
    const row = [...document.querySelectorAll('.bookmark-row')].find(node => node.textContent.includes('personal.lithic.uk'));
    row.querySelector('.bookmark-name').click();
  });
  await vaultPage.waitForSelector('.instance-unlock-pin .pin-box');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(
    navigationRequests.length,
    0,
    'Asking for the PIN happens before anything is requested from the instance'
  );
  assert.equal(
    await vaultPage.$eval('.instance-unlock-pin', node =>
      node.closest('.launcher-modal').querySelector('h2').textContent.trim()
    ),
    'Open personal.lithic.uk',
    'The prompt names the instance it is for, without the scheme every one of them shares'
  );
  assert.equal(
    await vaultPage.evaluate(() =>
      [...document.querySelectorAll('.vault-modal .modal-action')].some(button =>
        button.textContent.includes('Open Without the Login')
      )
    ),
    false,
    'There is no way past the PIN: this dialog only exists for an instance a login is saved for'
  );
  await assertNoExtraDismiss('.vault-modal', 'The per-instance prompt');
  // The whole-vault reset belongs to the manager and to nothing else: this dialog is
  // about one instance, and forgetting every login is not about any instance at all.
  assert.equal(
    await vaultPage.evaluate(() => document.querySelectorAll('.vault-danger').length),
    0,
    'The per-instance prompt carries no "Forget Everything": the reset lives in the manager'
  );
  assert.equal(
    await vaultPage.$eval('.instance-unlock-pin .pin-head .pin-label + .vault-reveal', node => Boolean(node)),
    true,
    'Its Show toggle rides in the PIN label row, rather than on a row of its own'
  );
  assert.equal(
    await vaultPage.evaluate(() =>
      [...document.querySelectorAll('.vault-modal .vault-reveal')].filter(
        node => !node.closest('.pin-head')
      ).length
    ),
    0,
    '...and no toggle in this dialog sits on a row of its own'
  );
  // Flush with the boxes, measured rather than read off the class. "The right edge of the
  // box entry" is the last box's own edge, not the dialog's: six boxes stop well short of a
  // desktop dialog, which is the whole reason the row is shrink-wrapped to them, and the
  // toggle used to sit an em after the word "PIN" — over the middle of the boxes it reveals.
  const toggleRow = await vaultPage.evaluate(() => {
    const row = document.querySelector('.instance-unlock-pin .pin-head');
    const label = row.querySelector('.pin-label').getBoundingClientRect();
    const toggle = row.querySelector('.vault-reveal').getBoundingClientRect();
    const boxes = [...document.querySelectorAll('.instance-unlock-pin .pin-box')];
    const last = boxes[boxes.length - 1].getBoundingClientRect();
    return {
      gap: Math.round(toggle.left - label.right),
      boxEdge: Math.round(toggle.right - last.right)
    };
  });
  assert.ok(
    Math.abs(toggleRow.boxEdge) <= 1,
    `Show ends ${toggleRow.boxEdge}px from the last box's right edge: flush with the entry it reveals`
  );
  assert.ok(
    toggleRow.gap >= 6,
    `...and ${toggleRow.gap}px clear of the label, so the two never collide on a narrow dialog`
  );
  // Centred as a group, measured rather than assumed: six boxes and their word stop short
  // of the dialog's own width, so something has to decide where the spare space goes, and
  // the leftover used to sit entirely to the right of the last box.
  const centred = await vaultPage.evaluate(() => {
    const modal = document.querySelector('.vault-modal').getBoundingClientRect();
    const entry = document.querySelector('.instance-unlock-pin .pin-entry').getBoundingClientRect();
    const pad = 22; // the modal's own padding
    return {
      left: Math.round(entry.left - (modal.left + pad)),
      right: Math.round(modal.right - pad - entry.right)
    };
  });
  assert.ok(
    Math.abs(centred.left - centred.right) <= 1,
    `The PIN group sits centred in the dialog: ${centred.left}px of dead space on the left, ${centred.right}px on the right`
  );

  // Six boxes have to stay six boxes on one line: the dialog is `min(100%, 560px)` with
  // padding, so on a phone they have to shrink rather than wrap, and the row must not
  // hang past the modal's own edge. Measured at both widths, because the narrow one is
  // where it would fail and the wide one is where it is read.
  const measurePin = () =>
    vaultPage.evaluate(() => {
      const boxes = [...document.querySelectorAll('.instance-unlock-pin .pin-box')];
      const modal = document.querySelector('.vault-modal').getBoundingClientRect();
      const width = (node) => Math.round(node.getBoundingClientRect().width);
      return {
        count: boxes.length,
        rows: new Set(boxes.map(node => Math.round(node.getBoundingClientRect().top))).size,
        widths: [...new Set(boxes.map(width))],
        // At most nothing: the last box may stop short of the modal's inner edge, but
        // it must not pass it.
        past: Math.max(0, Math.round(boxes.at(-1).getBoundingClientRect().right - (modal.right - 22))),
        // The toggle tracks the boxes at this width too: both are clamped by `.pin-entry`,
        // so a phone cannot open a gap the desktop dialog does not have.
        toggleEdge: Math.round(
          document.querySelector('.instance-unlock-pin .pin-head .vault-reveal')
            .getBoundingClientRect().right - boxes.at(-1).getBoundingClientRect().right
        )
      };
    });
  const pinAtWide = await measurePin();
  assert.deepEqual(
    { count: pinAtWide.count, rows: pinAtWide.rows, past: pinAtWide.past, toggleEdge: pinAtWide.toggleEdge },
    { count: 6, rows: 1, past: 0, toggleEdge: 0 },
    `Six boxes on one line, inside the modal: ${JSON.stringify(pinAtWide)}`
  );
  await vaultPage.setViewport({ width: 320, height: 700 });
  const pinAtNarrow = await measurePin();
  await vaultPage.setViewport({ width: 900, height: 700 });
  assert.deepEqual(
    { count: pinAtNarrow.count, rows: pinAtNarrow.rows, past: pinAtNarrow.past, toggleEdge: pinAtNarrow.toggleEdge },
    { count: 6, rows: 1, past: 0, toggleEdge: 0 },
    `...and still on the narrowest phone rather than wrapping: ${JSON.stringify(pinAtNarrow)}`
  );
  assert.ok(
    pinAtNarrow.widths[0] < pinAtWide.widths[0],
    `The boxes shrink to fit rather than overflowing: ${pinAtNarrow.widths[0]}px at 320 against ${pinAtWide.widths[0]}px at 900`
  );

  // A wrong PIN is refused where it was typed, does not open the instance, and leaves
  // the boxes empty — the next attempt is typed again rather than edited.
  await typePin(vaultPage, '.instance-unlock-pin', 'ZZZZZZ');
  // A pause rather than a condition: the mock answers at once, and whether anything
  // was asked at all is the assertion below — a wait would fail as a timeout that
  // names nothing instead of as the promise that broke.
  await new Promise(resolve => setTimeout(resolve, 400));
  const refused = await vaultPage.evaluate(() => ({
    detail: document.querySelector('.vault-modal .status-line.error')?.textContent.trim() ?? '',
    boxes: [...document.querySelectorAll('.instance-unlock-pin .pin-box')].map(box => box.value).join('')
  }));
  assert.ok(
    vaultCalls.some(call => call.command === 'unlock_for_instance' && call.args.secret === 'ZZZZZZ'),
    'The sixth character is the submit: nothing else was pressed, and Rust was asked'
  );
  assert.ok(refused.detail.includes('does not open the vault'), `A wrong PIN says so: ${refused.detail}`);
  assert.equal(refused.boxes, '', 'and the boxes are empty, ready for the next attempt');
  assert.equal(navigationRequests.length, 0, 'And it does not open the instance anyway');

  // The right one signs in to that origin and opens it, with the marker that gives the
  // instance a way back to this launcher. Nothing else is pressed: the sixth character
  // is the whole of the confirmation.
  await typePin(vaultPage, '.instance-unlock-pin', 'L1TH1C');
  await new Promise(resolve => setTimeout(resolve, 500));
  vaultPage.off('request', recordInstanceNavigation);
  const opened = vaultCalls.filter(call => call.command === 'unlock_for_instance').at(-1);
  assert.deepEqual(
    opened?.args,
    { origin: 'https://personal.lithic.uk', secret: 'L1TH1C' },
    'Unlocking for an instance passes the origin and the PIN under the names Rust expects'
  );
  assert.ok(
    vaultCalls.some(call => call.command === 'unlock_for_instance' && call.args.origin === 'https://personal.lithic.uk'),
    'and it was asked once, for the instance that was opened'
  );
  assert.ok(
    navigationRequests.some(url => url.startsWith('https://personal.lithic.uk')),
    `Then the instance is opened (saw ${JSON.stringify(navigationRequests)})`
  );
  assert.ok(
    navigationRequests.some(url => url.includes('lithic-from=')),
    '...carrying the marker that names this launcher, so the instance has a way back'
  );

  // --- What another instance cached, found from this launcher's own search ---------
  //
  // The one thing the launcher's page can never read for itself: an instance is a
  // different origin, and its cached wiki lives behind that origin. The app reads it
  // (`instance_search.rs`) and hands back one hit per instance — this is orientation, not
  // destination, so the instance's own search is where the rest of the matches are.
  await reopenLauncher();
  navigationRequests.length = 0;
  // The section above detached its own recorder on the way out, so this one attaches
  // its own and takes it off again at the end of the click below.
  vaultPage.on('request', recordInstanceNavigation);
  const instanceSearchBox = 'input[aria-label="Search recent Liths"]';
  // A wide window for the geometry below, because the panel is hidden outright on a
  // narrow one — the same behaviour a local match panel has, and not what this section
  // is asking about. The window goes back to what it was before anything is clicked.
  const previousViewport = vaultPage.viewport() ?? { width: 800, height: 600 };
  await vaultPage.setViewport({ width: 1200, height: 900 });
  const describeInstanceHit = () => vaultPage.evaluate(() => {
    const row = [...document.querySelectorAll('.bookmark-row')].find(node => node.textContent.includes('personal.lithic.uk')) ?? null;
    const preview = row?.querySelector('.cache-preview') ?? null;
    const titleMark = row?.querySelector('mark.cache-preview-title-mark') ?? null;
    const bodyMark = row?.querySelector('mark:not(.cache-preview-title-mark)') ?? null;
    const rowRect = row?.getBoundingClientRect() ?? null;
    const previewRect = preview?.getBoundingClientRect() ?? null;
    return {
      rows: [...document.querySelectorAll('.bookmark-row')].map(node => node.textContent.trim()),
      panel: Boolean(preview),
      previewText: preview?.textContent ?? null,
      previewStyle: preview ? getComputedStyle(preview).display : null,
      titleMarkText: titleMark?.textContent ?? null,
      titleMarkColor: titleMark ? getComputedStyle(titleMark).color : null,
      bodyMarkText: bodyMark?.textContent ?? null,
      bodyMarkColor: bodyMark ? getComputedStyle(bodyMark).color : null,
      // Beside the row, not under it: the panel's left edge is past the row's right edge
      // and its centre is the row's centre — the same placement a local match gets.
      gap: rowRect && previewRect ? Math.round(previewRect.left - rowRect.right) : null,
      centreOff: rowRect && previewRect ? Math.round((previewRect.top + previewRect.height / 2) - (rowRect.top + rowRect.height / 2)) : null
    };
  });

  // The name of the cached note matches, which is content — and the row is drawn for it
  // even though nothing about the address `foobar.com` contains the query.
  await vaultPage.type(instanceSearchBox, 'Archive');
  await new Promise(resolve => setTimeout(resolve, 300));
  const titled = await describeInstanceHit();
  assert.ok(titled.panel, `An instance's own match draws its panel (rows: ${JSON.stringify(titled.rows)})`);
  assert.equal(titled.titleMarkText, 'Archive', 'The matched note name is marked, case preserved');
  assert.equal(titled.titleMarkColor, 'rgb(138, 180, 248)', 'The instance panel marks the name in the install button blue');
  assert.equal(titled.bodyMarkText, null, '...and marks no body text, which did not match');

  await vaultPage.click('.recent-search-clear');
  await vaultPage.type(instanceSearchBox, 'distinctive');
  await new Promise(resolve => setTimeout(resolve, 300));
  const instanceHit = await describeInstanceHit();
  assert.ok(instanceHit.panel, 'A body match in another instance draws its panel too');
  assert.match(instanceHit.previewText ?? '', /Archive Box/, '...naming the note it was found in');
  assert.equal(instanceHit.bodyMarkText, 'distinctive', '...with the hit marked in the body');
  assert.equal(instanceHit.bodyMarkColor, 'rgb(255, 152, 0)', 'Body marks stay amber, here as everywhere');
  assert.equal(instanceHit.previewStyle, 'block', 'The instance panel is drawn on a desktop window');
  assert.ok((instanceHit.gap ?? -1) >= 0, `The panel sits beside the row, not under it (gap ${instanceHit.gap}px)`);
  assert.ok(
    Math.abs(instanceHit.centreOff ?? 99) <= 1,
    `...centred on the row it belongs to (off by ${instanceHit.centreOff}px)`
  );
  // One hit per instance and no more: the panel carries the single best match, and the
  // instance it is beside is the one whose cache answered.
  assert.equal(
    instanceHit.rows.filter(row => row.includes('foobar.com')).length,
    0,
    'An instance with nothing cached is not dragged in by the query'
  );

  await vaultPage.setViewport(previousViewport);

  // Clicking it hands the window over already searching, which is the whole reason the
  // panel is a control rather than a second label: the instance's own launcher comes up
  // looking for these words instead of with an empty box.
  await vaultPage.evaluate(() => {
    const row = [...document.querySelectorAll('.bookmark-row')].find(node => node.textContent.includes('personal.lithic.uk'));
    row.querySelector('.cache-preview').click();
  });
  await vaultPage.waitForSelector('.instance-unlock-pin .pin-box');
  assert.equal(
    navigationRequests.length,
    0,
    'The panel goes through the unlock rather than around it'
  );
  await typePin(vaultPage, '.instance-unlock-pin', 'L1TH1C');
  await new Promise(resolve => setTimeout(resolve, 400));
  const instanceOpened = navigationRequests.find(url => url.startsWith('https://personal.lithic.uk')) ?? null;
  assert.ok(instanceOpened, `Then the instance opens (saw ${JSON.stringify(navigationRequests)})`);
  assert.match(instanceOpened, /[?&]q=distinctive/, '...carrying the search, through the dialog, so it arrives searching');
  assert.match(instanceOpened, /lithic-from=/, '...and the marker that gives the instance a way back');
  vaultPage.off('request', recordInstanceNavigation);

  // --- Starting over, and the one control knowing the secret cannot undo ---------
  await vaultPage.goto(`file://${artifact}?mode=tauri`, { waitUntil: 'domcontentloaded' });
  await vaultPage.waitForSelector('.action-pair .bookmark-button');
  await vaultPage.click('.action-pair .bookmark-button');
  await vaultPage.waitForSelector('.vault-manager-button');
  await vaultPage.click('.vault-manager-button');
  await vaultPage.waitForSelector('.vault-modal');
  assert.equal(
    await vaultPage.$eval('.vault-modal .vault-count', node => node.textContent.trim()),
    '2 logins saved.',
    'The manager says what is stored without opening it'
  );
  // It asks first, and the asking happens before anything is destroyed.
  assert.equal(
    await vaultPage.$eval('.vault-modal .vault-danger', node => node.textContent.trim()),
    'Forget Everything'
  );
  await vaultPage.click('.vault-modal .vault-danger');
  // Both dialogs are on screen at once, so the question is found among them rather
  // than assumed to be the first.
  await vaultPage.waitForFunction(() =>
    [...document.querySelectorAll('.launcher-modal h2')].some(node => node.textContent.includes('Forget every saved login'))
  );
  assert.equal(
    await vaultPage.evaluate(() => window.__lithicVault.calls.some(call => call.command === 'destroy_credentials')),
    false,
    'Confirming is what deletes the vault, not the click that opened the question'
  );
  // The question's own button is the red one: the act it performs is the only one here that
  // cannot be undone, and the outlined primary is the colour of the confirmations that can.
  const question = await vaultPage.evaluate(() => {
    const button = [...document.querySelectorAll('.confirm-modal .modal-action')]
      .find(node => node.textContent.trim() === 'Forget Everything');
    const style = getComputedStyle(button);
    return { colour: style.color, border: style.borderTopColor, fill: style.backgroundColor };
  });
  assert.equal(question.colour, 'rgb(224, 138, 122)', 'Forgetting everything is styled as the danger it is');
  assert.equal(question.border, 'rgb(224, 138, 122)', '...border and all rather than only in its word');
  assert.equal(question.fill, 'rgba(224, 138, 122, 0.12)', '...on the same red wash the primary wears in blue');
  // Scoped to the question itself: the dialog underneath carries a button with the
  // same wording now, and an unscoped search would answer "no" by pressing it again.
  await vaultPage.evaluate(() => {
    const button = [...document.querySelectorAll('.confirm-modal .modal-action')].find(node => node.textContent.trim() === 'Forget Everything');
    button.click();
  });
  await vaultPage.waitForFunction(() => window.__lithicVault.calls.some(call => call.command === 'destroy_credentials'));
  const destroyed = await vaultPage.evaluate(() => ({
    calls: window.__lithicVault.calls.filter(call => call.command === 'destroy_credentials').length,
    greenRows: [...document.querySelectorAll('.bookmark-row .vault-row-button')].filter(key => key.classList.contains('covered')).length,
    count: document.querySelector('.vault-count')
  }));
  assert.equal(destroyed.calls, 1, 'Forgetting everything is one command');
  assert.equal(destroyed.greenRows, 0, 'And no bookmark claims a saved login afterwards');
  assert.equal(destroyed.count, null, 'The count goes with it');

  // Nothing on disk now, so the same dialog is the one that creates a vault: the
  // secret twice, since nothing can recover it.
  // Grey again, which is only readable from where the manager now lives — and that is
  // the point of the count: it is known without unlocking, and it says the vault holds
  // nothing any more rather than leaving the last answer standing.
  await vaultPage.evaluate(() => { window.__lithicVault.state.exists = false; });
  await vaultPage.click('.vault-modal .modal-close');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-modal') === null);
  await vaultPage.click('.action-pair .bookmark-button');
  await vaultPage.waitForSelector('.vault-manager-button');
  assert.deepEqual(
    await vaultPage.evaluate(() => ({
      hasLogins: document.querySelector('.vault-manager-button').classList.contains('has-logins'),
      colour: getComputedStyle(document.querySelector('.vault-manager-button')).color
    })),
    { hasLogins: false, colour: 'rgb(165, 165, 165)' },
    'Forgetting everything returns the manager key to the grey it starts at, not the default button white'
  );
  await vaultPage.click('.vault-manager-button');
  // No vault at all now, so the manager has nothing to open and nothing to write. It says
  // what the dialog is for in one line — where a login comes from is on the key that writes
  // one, which is the only control that can name an address — and that absence is what
  // makes every stored credential instance-specific.
  const noVault = await vaultPage.evaluate(() => ({
    sub: document.querySelector('.vault-modal .vault-sub')?.textContent.trim() ?? '',
    copyLines: document.querySelectorAll('.vault-modal .vault-sub, .vault-modal .vault-note').length,
    pinBoxes: document.querySelectorAll('.vault-modal .pin-box').length,
    fields: document.querySelectorAll('.vault-modal .vault-field').length,
    buttons: [...document.querySelectorAll('.vault-modal .modal-action')].map(node => node.textContent.trim())
  }));
  assert.equal(
    noVault.sub,
    'Self-host instance credentials are listed here once saved.',
    'An empty vault says what it is for'
  );
  assert.equal(noVault.copyLines, 1, 'In one line: the paragraph about where a login comes from is gone');
  assert.equal(noVault.pinBoxes, 0, 'There is no PIN to type, because there is no vault to open');
  assert.equal(noVault.fields, 0, 'And not one field, so there is no address to type either');
  assert.deepEqual(
    noVault.buttons,
    [],
    'An empty vault offers nothing to decide, so it has no action row: the × is the way out'
  );
  await assertNoExtraDismiss('.vault-modal', 'The manager before a vault exists');
  await vaultPage.click('.vault-modal .modal-close');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-modal') === null);

  // First use, from a row whose key is grey: the same dialog, now asking for the PIN it
  // will have — twice, since nothing can recover it. The login it is created for is that
  // row's own address, and there is no field anywhere that could make it another one.
  const savesBefore = vaultCalls.filter(call => call.command === 'save_login_for_instance').length;
  await vaultPage.evaluate(() => document.querySelectorAll('.bookmark-row .vault-row-button')[0].click());
  await vaultPage.waitForSelector('#credential-offer-title');
  const createShape = await vaultPage.evaluate(() => ({
    heading: document.querySelector('#credential-offer-title').textContent.trim(),
    sub: document.querySelector('#credential-offer-title').nextElementSibling.textContent.replace(/\s+/g, ' ').trim(),
    pinLabel: document.querySelector('.credential-offer-pin .pin-label').textContent.trim(),
    confirmLabel: document.querySelector('.credential-offer-pin-confirm .pin-label')?.textContent.trim() ?? '',
    // A PIN that is repeated confirms itself, so it is offered no Show toggle at all.
    pinToggles: document.querySelectorAll(
      '.credential-offer-pin .pin-head .vault-reveal, .credential-offer-pin-confirm .pin-head .vault-reveal'
    ).length,
    // The password is the field nothing repeats back, so it keeps one — in its label row,
    // at the far end of its label row, whose width is the input's, which is where every
    // toggle in this dialog now sits.
    passwordToggle: document.querySelectorAll('.vault-field .pin-head .vault-reveal').length,
    passwordToggleNextToLabel: document.querySelector('.pin-label[for="credential-offer-password"]')?.nextElementSibling?.classList.contains('vault-reveal') ?? false,
    // Flush with the input below it, the way the PIN's toggle is flush with its boxes: a
    // full-width field's right edge is its row's right edge.
    passwordToggleEdge: (() => {
      const toggle = document.querySelector('.vault-field .pin-head .vault-reveal');
      const input = document.getElementById('credential-offer-password');
      if (!toggle || !input) return null;
      return Math.round(toggle.getBoundingClientRect().right - input.getBoundingClientRect().right);
    })(),
    looseToggles: [...document.querySelectorAll('.vault-modal .vault-reveal')].filter(
      node => !node.closest('.pin-head')
    ).length,
    fields: document.querySelectorAll('.vault-modal .vault-field').length,
    originFields: document.querySelectorAll('#vault-new-origin, [list="vault-origin-hints"], datalist').length,
    primary: document.querySelector('.credential-offer-save').textContent.trim(),
    disabled: document.querySelector('.credential-offer-save').disabled
  }));
  assert.equal(createShape.heading, 'Add a saved credential?');
  assert.ok(createShape.sub.includes('personal.lithic.uk'), `Aimed at that row's own address: ${createShape.sub}`);
  assert.equal(createShape.pinLabel, 'Choose a PIN', 'With no vault, the PIN is chosen here — the first use bargain');
  assert.equal(createShape.confirmLabel, 'Repeat the PIN');
  assert.equal(createShape.pinToggles, 0, 'The two boxes confirm each other, so neither carries a Show toggle');
  assert.equal(createShape.passwordToggle, 1, '...while the password, typed once, keeps its own in its label row');
  assert.equal(createShape.passwordToggleNextToLabel, true, '...on the row above the input it belongs to');
  assert.ok(
    Math.abs(createShape.passwordToggleEdge ?? 99) <= 1,
    `...ending ${createShape.passwordToggleEdge}px from the input's own right edge`
  );
  assert.equal(createShape.looseToggles, 0, '...and not one toggle has a row to itself');
  assert.equal(createShape.fields, 2, 'The form is the login itself and nothing else');
  assert.equal(createShape.originFields, 0, 'No address field and no hint list: the row already said which instance this is');
  assert.equal(createShape.primary, 'Save Credential');
  assert.equal(createShape.disabled, true, 'And an empty credential cannot be saved');

  /**
   * Empty the offer dialog's PIN from the last box back, the way the boxes are meant to
   * be driven — `clear()` is the component's own and not reachable from here.
   */
  const clearOfferPin = async () => {
    await vaultPage.evaluate(() => document.querySelectorAll('.credential-offer-pin .pin-box')[5].focus());
    for (let index = 0; index < 6; index += 1) await vaultPage.keyboard.press('Backspace');
    await new Promise(resolve => setTimeout(resolve, 400));
  };

  /** Ask for the band of another alphabet by typing a different one. */
  const retypeOfferPin = async (pin) => {
    await clearOfferPin();
    await vaultPage.keyboard.type(pin);
    await new Promise(resolve => setTimeout(resolve, 400));
  };

  /**
   * The band word the dialog shows, where it sits, and what is behind it.
   *
   * `beside` and `inside` are the two halves of the layout this dialog settled on: a word
   * about the PIN sits in the empty end of the boxes' own row, on the boxes' line, rather
   * than on a line of its own under them.
   */
  const offerBand = () =>
    vaultPage.evaluate(() => {
      const word = document.querySelector('.vault-band');
      const boxes = [...document.querySelectorAll('.credential-offer-pin .pin-box')];
      if (!word || boxes.length === 0) {
        return { word: '', classes: '', title: '', colour: '', beside: null, inside: null, copyLines: null };
      }
      const rect = word.getBoundingClientRect();
      const first = boxes[0].getBoundingClientRect();
      const last = boxes[boxes.length - 1].getBoundingClientRect();
      const modal = document.querySelector('.vault-modal').getBoundingClientRect();
      return {
        word: word.textContent.trim(),
        classes: word.className,
        title: word.getAttribute('title') ?? '',
        colour: getComputedStyle(word).color,
        beside: Math.round(rect.left) >= Math.round(last.right),
        inside: rect.top >= first.top && rect.bottom <= first.bottom,
        // The group's own space, from the modal's inner edges: the boxes and the word
        // together, because the word is part of the line the boxes are on.
        deadLeft: Math.round(first.left - (modal.left + 22)),
        deadRight: Math.round(modal.right - 22 - rect.right),
        copyLines: document.querySelectorAll('.vault-modal .vault-sub, .vault-modal .vault-note').length
      };
    });

  // Six digits is the weakest band. What the dialog says about a chosen PIN is one word —
  // the band Rust returned — and the arithmetic behind it is that word's own tooltip
  // rather than a paragraph standing in the dialog.
  await typePin(vaultPage, '.credential-offer-pin', '123456');
  await new Promise(resolve => setTimeout(resolve, 400));
  const weakPin = await offerBand();
  assert.equal(weakPin.word, 'Weak', 'A digits-only PIN is banded in one word');
  assert.ok(weakPin.title.startsWith('Weak:'), `...whose tooltip carries Rust's arithmetic: ${weakPin.title}`);
  assert.ok(weakPin.title.includes('1,000,000'), `...including the count behind the band: ${weakPin.title}`);
  assert.equal(weakPin.classes, 'vault-band weak', 'And the band is the class the word is coloured by');
  assert.equal(weakPin.colour, 'rgb(224, 138, 122)', 'Weak is the red the rest of the dialog uses for a refusal');
  assert.equal(weakPin.beside, true, 'The word sits in the empty end of the boxes’ own row');
  assert.ok(
    Math.abs(weakPin.deadLeft - weakPin.deadRight) <= 1,
    `...and the boxes and the word are centred as one group: ${weakPin.deadLeft}px of dead space on the left, ${weakPin.deadRight}px on the right`
  );
  assert.equal(weakPin.inside, true, '...on the line the boxes are on, rather than on one of its own');
  assert.equal(weakPin.copyLines, 1, '...and no paragraph of the dialog explains the PIN it describes');
  // The other two alphabets, which is the whole reason a word is banded at all rather than
  // shown only when something is wrong: every complete PIN gets a word, a colour, and the
  // arithmetic that alphabet costs behind it.
  await retypeOfferPin('LITHIC');
  const averagePin = await offerBand();
  assert.equal(averagePin.word, 'Average', 'A letters-only PIN is banded average');
  assert.ok(averagePin.title.includes('308,915,776'), `...with its own arithmetic behind it: ${averagePin.title}`);
  assert.equal(averagePin.classes, 'vault-band average', 'And its own class, so its own colour');
  assert.equal(averagePin.colour, 'rgb(224, 179, 65)', 'Average is the amber the dialog already uses for a warning');
  await retypeOfferPin('L1TH1C');
  const strongPin = await offerBand();
  assert.equal(strongPin.word, 'Strong', 'Both alphabets is the strongest band');
  assert.equal(strongPin.classes, 'vault-band strong');
  assert.equal(strongPin.colour, 'rgb(123, 168, 111)', 'Strong is the same green a saved login is marked with');
  assert.ok(!strongPin.title.includes('makes that number useless'), '...and the strongest band has no nudge to make');
  // The word is about a PIN that is in the boxes: emptied, it goes with them.
  await clearOfferPin();
  assert.equal(
    await vaultPage.evaluate(() => document.querySelectorAll('.vault-band').length),
    0,
    'Half-typed PINs are banded nothing: the word describes a complete candidate'
  );
  await retypeOfferPin('123456');
  assert.equal(
    await vaultPage.$eval('.credential-offer-save', node => node.disabled),
    true,
    'A PIN typed once, with the confirmation still empty, cannot create a vault'
  );
  await vaultPage.type('.credential-offer-user', 'keeper');
  await vaultPage.type('.credential-offer-password', 's3cret');
  await typePin(vaultPage, '.credential-offer-pin-confirm', '123455');
  // Longer than the box's settle, so the verdict about this login has arrived and cannot
  // be what is holding the button below.
  await new Promise(resolve => setTimeout(resolve, 900));
  assert.equal(
    await vaultPage.$eval('.credential-offer-save', node => node.disabled),
    true,
    'A mistyped confirmation does not create a vault under a PIN nobody knows'
  );
  assert.equal(
    vaultCalls.filter(call => call.command === 'save_login_for_instance').length,
    savesBefore,
    '...and nothing was written: with no vault, the first save is what creates the file'
  );
  // Corrected in place: the last box is cleared and retyped, which is all a mistake in a
  // six-box PIN costs.
  await vaultPage.evaluate(() => document.querySelectorAll('.credential-offer-pin-confirm .pin-box')[5].focus());
  await vaultPage.keyboard.press('Backspace');
  await vaultPage.keyboard.type('6');
  await new Promise(resolve => setTimeout(resolve, 400));
  const corrected = await vaultPage.evaluate(() => ({
    pin: [...document.querySelectorAll('.credential-offer-pin .pin-box')].map(box => box.value).join(''),
    confirm: [...document.querySelectorAll('.credential-offer-pin-confirm .pin-box')].map(box => box.value).join(''),
    user: document.querySelector('.credential-offer-user').value,
    password: document.querySelector('.credential-offer-password').value,
    check: document.querySelector('.vault-check-line')?.textContent.trim() ?? '',
    disabled: document.querySelector('.credential-offer-save').disabled
  }));
  assert.equal(
    corrected.disabled,
    false,
    `The corrected confirmation is what the button was waiting for (${JSON.stringify(corrected)})`
  );
  await vaultPage.$eval('.credential-offer-save', node => node.click());
  await waitForCall(call => call.command === 'save_login_for_instance' && call.args.secret === '123456');
  const created = vaultCalls.filter(call => call.command === 'save_login_for_instance').at(-1);
  assert.deepEqual(
    created?.args,
    { origin: 'https://personal.lithic.uk', secret: '123456', user: 'keeper', password: 's3cret' },
    'Saving the first login is what creates the vault, under the PIN chosen in the same dialog'
  );
  assert.equal(
    vaultCalls.some(call => call.command === 'remember_credentials'),
    false,
    'The command the manager used to save with is now unused: the dialog is the only writer'
  );
  // Read from the launcher afterwards, with no dialog open: the count and the colour both
  // come from the file's origin index, which is what makes them readable while locked.
  await reopenLauncher();
  const createdState = await vaultPage.evaluate(() => ({
    exists: window.__lithicVault.state.exists,
    origins: window.__lithicVault.entries.map(entry => entry.origin)
  }));
  assert.equal(createdState.exists, true, '...and the file exists from that moment');
  assert.deepEqual(
    createdState.origins,
    ['https://personal.lithic.uk'],
    '...holding the one login the dialog was aimed at, and nothing it was not'
  );
  await vaultPage.click('.action-pair .bookmark-button');
  await vaultPage.waitForSelector('.vault-manager-button');
  const managerAfterCreate = await vaultPage.evaluate(() => ({
    hasLogins: document.querySelector('.vault-manager-button').classList.contains('has-logins'),
    title: document.querySelector('.vault-manager-button').getAttribute('title'),
    covered: [...document.querySelectorAll('.bookmark-row .vault-row-button')].filter(key => key.classList.contains('covered')).length
  }));
  assert.equal(managerAfterCreate.hasLogins, true, 'One login saved is a vault with a login in it, and the key says so in colour');
  assert.ok(managerAfterCreate.title.includes('1 saved'), `And counts it without being opened: ${managerAfterCreate.title}`);
  assert.equal(managerAfterCreate.covered, 1, 'Exactly one row claims a saved login, because only one does');
  // And the manager, which is the only dialog that shows the file, still names it.
  await vaultPage.click('.vault-manager-button');
  await vaultPage.waitForSelector('.vault-modal');
  assert.equal(
    await vaultPage.evaluate(() => Boolean(document.querySelector('.vault-path')?.textContent.includes('credentials.vault'))),
    true,
    'The manager names the file the logins live in'
  );
  // Version history, read off the screen: the store hands the modal its versions newest
  // first, and the list draws what joins them. Both are asserted here because the order is
  // the whole of what that panel means, and because a chevron is not something a unit test
  // can see — the store's own newest-first test can only prove the array it returned.
  await vaultPage.click('.vault-modal .modal-close');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-modal') === null);
  const chainAt = Date.UTC(2026, 8, 20, 14, 32, 8);
  await vaultPage.evaluate(async (at) => {
    const request = indexedDB.open('keyval-store', 1);
    await new Promise((ok, fail) => {
      request.onerror = () => fail(request.error);
      request.onsuccess = () => ok();
    });
    const db = request.result;
    await new Promise((ok, fail) => {
      const tx = db.transaction('keyval', 'readwrite');
      const store = tx.objectStore('keyval');
      store.put([{ handle: null, tauriPath: null, name: 'chain.lith' }], 'recentFiles');
      store.put({ text: '[]' }, 'search_cache_chain.lith');
      // Oldest first, which is the order the chain is recorded in: the modal is what
      // turns it round, so an ascending store is the case worth asserting.
      store.put(
        {
          headId: 'v3',
          versions: [
            { id: 'v1', ts: at - 86_400_000, sizeBytes: 41_820, isBase: true },
            { id: 'v2', ts: at - 3_600_000, sizeBytes: 42_360 },
            { id: 'v3', ts: at, sizeBytes: 43_010 }
          ]
        },
        'search_cache_meta_chain.lith'
      );
      tx.oncomplete = ok;
      tx.onerror = () => fail(tx.error);
    });
    db.close();
  }, chainAt);
  await reopenLauncher();
  await vaultPage.waitForSelector('.recent-row .cache-history-button');
  await vaultPage.click('.recent-row .cache-history-button');
  await vaultPage.waitForSelector('.history-entry');
  const chain = await vaultPage.evaluate(() => {
    const list = document.querySelector('.history-list');
    const box = list.getBoundingClientRect();
    const rows = [...list.querySelectorAll('.history-entry')].map(node => ({
      badge: node.querySelector('.history-badge').textContent.trim(),
      at: Date.parse(node.querySelector('.history-time').textContent.trim().replace(' UTC', 'Z').replace(' ', 'T'))
    }));
    return {
      rows,
      // Where each connector's chevron falls, as an offset from the list's own centre.
      links: [...list.querySelectorAll('.history-link')].map(node => {
        const chevron = node.querySelector('svg').getBoundingClientRect();
        return Math.round(chevron.left + chevron.width / 2 - (box.left + box.width / 2));
      })
    };
  });
  assert.deepEqual(
    chain.rows.map(row => row.badge),
    ['step', 'step', 'full'],
    'The chain reads newest first: the two steps down to the full save they were written from'
  );
  assert.ok(
    chain.rows[0].at > chain.rows[1].at && chain.rows[1].at > chain.rows[2].at,
    `...and the timestamps descend with them: ${JSON.stringify(chain.rows.map(row => row.at))}`
  );
  assert.equal(chain.links.length, chain.rows.length - 1, 'Every gap between two versions is drawn, and no more');
  assert.ok(
    chain.links.every(offset => Math.abs(offset) <= 1),
    `...each one centred on the list rather than on the row it hangs from: ${JSON.stringify(chain.links)}`
  );
  // --- The folder a backup acts on, and the picker that changes it ---------------
  // The dialog named a folder nobody chose: it was inferred from the open Lith, else the
  // newest recent row, else a library folder Lithic already had a repository in, and moving
  // a backup meant disconnecting first. What is pinned here is the contract with Rust — the
  // read that says whether the folder in force is the user's own pick, the picker command,
  // and the way back. That the file itself is spelled portably is Rust's own test
  // (`the_picked_folder_rides_in_the_recents_sidecar`); this is the half that names it.
  await reopenLauncher();
  await vaultPage.waitForSelector('.heading .sync-button');
  await vaultPage.click('.heading .sync-button');
  await vaultPage.waitForSelector('.git-sync-modal .sync-folder');

  const folderLine = await vaultPage.evaluate(() => {
    const row = document.querySelector('.git-sync-modal .sync-folder');
    return {
      tag: row.tagName,
      disabled: row.disabled,
      label: row.querySelector('.sync-folder-label')?.textContent.trim() ?? '',
      path: row.querySelector('.sync-folder-path')?.textContent.trim() ?? '',
      tooltip: row.querySelector('.sync-folder-path')?.getAttribute('title') ?? '',
      hint: row.querySelector('.sync-folder-change')?.textContent.trim() ?? '',
      title: row.getAttribute('title') ?? '',
      reset: document.querySelector('.git-sync-modal .sync-folder-reset')?.textContent.trim() ?? null
    };
  });
  assert.equal(folderLine.tag, 'BUTTON', 'The folder line is a control, not a label');
  assert.equal(folderLine.disabled, false, '...enabled while nothing is running');
  assert.equal(folderLine.label, 'Folder', '...labelled the way it always was');
  assert.equal(folderLine.path, 'C:/Users/fixture/Documents/Lithic', '...naming the folder the backup acts on');
  assert.equal(folderLine.tooltip, folderLine.path, 'The line ellipsizes, so the full path stays readable on it');
  assert.equal(folderLine.hint, 'Change', '...and the row says what clicking it does');
  assert.equal(
    folderLine.title,
    'Change the folder GitHub Sync backs up',
    '...in the tooltip, for a pointer anywhere on the row'
  );
  assert.equal(folderLine.reset, null, 'Nothing to undo: a folder Lithic worked out is not a choice anyone made');

  // Clicking it opens the OS picker, through Rust, which is also what records the answer.
  await vaultPage.click('.git-sync-modal .sync-folder');
  await vaultPage.waitForFunction(() =>
    document.querySelector('.git-sync-modal .sync-folder-path')?.textContent.trim() === 'D:/Lithic'
  );
  const picked = await vaultPage.evaluate(() => ({
    picks: window.__lithicSyncFolder.picks,
    openedAt: window.__lithicSyncFolder.openedAt,
    reads: window.__lithicVault.calls.filter(call => call.command === 'git_sync_folder').length,
    path: document.querySelector('.git-sync-modal .sync-folder-path')?.textContent.trim() ?? '',
    reset: document.querySelector('.git-sync-modal .sync-folder-reset')?.textContent.trim() ?? null
  }));
  assert.equal(picked.picks, 1, 'Clicking the folder line asks the OS once, and through Rust');
  assert.equal(
    picked.openedAt,
    'C:/Users/fixture/Documents/Lithic',
    '...handing it the folder the dialog is naming, so the picker opens where the dialog points'
  );
  assert.equal(picked.path, 'D:/Lithic', '...and the dialog names the folder the pick recorded');
  assert.ok(picked.reads >= 2, `The folder is re-read rather than assumed (reads: ${picked.reads})`);
  assert.equal(picked.reset, 'Use the automatic folder', 'A folder the user chose can be given back');

  // The way back, which exists only while there is a choice to undo.
  await vaultPage.click('.git-sync-modal .sync-folder-reset button');
  await vaultPage.waitForFunction(() => window.__lithicSyncFolder.clears === 1);
  await vaultPage.waitForFunction(() =>
    document.querySelector('.git-sync-modal .sync-folder-path')?.textContent.trim() === 'C:/Users/fixture/Documents/Lithic'
  );
  const restoredFolder = await vaultPage.evaluate(() => ({
    clears: window.__lithicSyncFolder.clears,
    reset: document.querySelector('.git-sync-modal .sync-folder-reset') ?? null,
    path: document.querySelector('.git-sync-modal .sync-folder-path')?.textContent.trim() ?? ''
  }));
  assert.equal(restoredFolder.clears, 1, 'Putting the automatic folder back is one command');
  assert.equal(restoredFolder.path, 'C:/Users/fixture/Documents/Lithic', '...and the dialog is back on it');
  assert.equal(restoredFolder.reset, null, '...with the line that offered the way back gone with the choice');
  // The rule this dialog already followed, checked again because a control was added to it.
  await assertNoExtraDismiss('.git-sync-modal', 'The sync dialog with a folder override');
  await vaultPage.click('.git-sync-modal .modal-close');
  await vaultPage.waitForFunction(() => document.querySelector('.git-sync-modal') === null);

  // --- A fresh download, where Lithic has nothing of its own to go on -----------
  // No open Lith, no recents on this machine and nothing to propose: Rust answers with no
  // folder at all, which is the state a new install starts in. The folder line used to be
  // absent here and the dialog's whole body was one sentence telling the user to save a Lith
  // first, with no way to answer it. The empty line is that way out.
  //
  // Reloaded first, because that is what makes this a fresh install rather than a stale
  // dialog: the app asks Rust as it mounts, and opening the dialog again would have kept
  // the answer the last open worked out.
  await vaultPage.evaluate(() => localStorage.setItem('__lithicSyncFolderNone', '1'));
  await reopenLauncher();
  await vaultPage.click('.heading .sync-button');
  await vaultPage.waitForSelector('.git-sync-modal .sync-folder');
  const noFolderYet = await vaultPage.evaluate(() => {
    const row = document.querySelector('.git-sync-modal .sync-folder');
    return {
      tag: row.tagName,
      empty: row.classList.contains('empty'),
      disabled: row.disabled,
      label: row.querySelector('.sync-folder-label')?.textContent.trim() ?? '',
      path: row.querySelector('.sync-folder-path')?.textContent.trim() ?? '',
      tooltip: row.querySelector('.sync-folder-path')?.getAttribute('title') ?? null,
      hint: row.querySelector('.sync-folder-change')?.textContent.trim() ?? '',
      style: getComputedStyle(row.querySelector('.sync-folder-path')).fontStyle,
      title: row.getAttribute('title') ?? '',
      aria: row.getAttribute('aria-label') ?? '',
      advice: document.querySelector('.git-sync-modal .status-line.error')?.textContent.trim() ?? '',
      connect: document.querySelector('.git-sync-modal .modal-actions .modal-action')?.textContent.trim() ?? null
    };
  });
  assert.equal(noFolderYet.tag, 'BUTTON', 'The line is a control even with no folder to name');
  assert.equal(noFolderYet.empty, true, '...and says so where a path would be');
  assert.equal(noFolderYet.disabled, false, '...so the way out of a fresh install is reachable');
  assert.equal(noFolderYet.label, 'Folder', '...under the label it always had');
  assert.equal(noFolderYet.path, 'No folder yet', 'Nothing is named, because nothing could be worked out');
  assert.equal(noFolderYet.tooltip, null, 'There is no path to carry as a tooltip, so the placeholder has none');
  assert.equal(noFolderYet.style, 'italic', '...and it is drawn as a placeholder rather than as a folder named that');
  assert.equal(noFolderYet.hint, 'Choose', 'The hint says what clicking it does when there is nothing to change');
  assert.equal(noFolderYet.title, 'Choose the folder GitHub Sync backs up', '...in the tooltip, for a pointer anywhere on the row');
  assert.equal(
    noFolderYet.aria,
    'Choose the folder GitHub Sync backs up',
    '...and to a screen reader, which has no path to read out either'
  );
  assert.equal(
    noFolderYet.advice,
    'Save a Lith to disk first, since sync backs up its folder.',
    'Nothing is synced yet, and the dialog still says so'
  );
  assert.equal(noFolderYet.connect, null, '...with no Connect offered over an empty folder');

  // The row is the way out: one click, and the dialog has a folder to act on.
  await vaultPage.click('.git-sync-modal .sync-folder');
  await vaultPage.waitForFunction(() =>
    document.querySelector('.git-sync-modal .sync-folder-path')?.textContent.trim() === 'D:/Lithic'
  );
  const chosenFromNothing = await vaultPage.evaluate(() => ({
    picks: window.__lithicSyncFolder.picks,
    openedAt: window.__lithicSyncFolder.openedAt,
    path: document.querySelector('.git-sync-modal .sync-folder-path')?.textContent.trim() ?? '',
    empty: document.querySelector('.git-sync-modal .sync-folder')?.classList.contains('empty') ?? null,
    hint: document.querySelector('.git-sync-modal .sync-folder-change')?.textContent.trim() ?? '',
    reset: document.querySelector('.git-sync-modal .sync-folder-reset')?.textContent.trim() ?? null,
    advice: document.querySelector('.git-sync-modal .status-line.error')?.textContent.trim() ?? '',
    connect: document.querySelector('.git-sync-modal .modal-actions .modal-action')?.textContent.trim() ?? null
  }));
  assert.equal(chosenFromNothing.picks, 1, 'A fresh install picks its folder through the same one command');
  assert.equal(chosenFromNothing.openedAt, null, '...with nothing to open at, so the picker decides where to start');
  assert.equal(chosenFromNothing.path, 'D:/Lithic', '...and the dialog names the folder the pick recorded');
  assert.equal(chosenFromNothing.empty, false, '...drawn as a folder rather than as a placeholder');
  assert.equal(chosenFromNothing.hint, 'Change', '...and the hint goes back to naming what a second click does');
  assert.equal(chosenFromNothing.reset, 'Use the automatic folder', 'A folder chosen from nothing can be given back too');
  assert.equal(
    chosenFromNothing.advice,
    '',
    'The advice goes with the state it described: there is a folder to back up now'
  );
  assert.equal(
    chosenFromNothing.connect,
    'Connect to GitHub',
    '...and the pick was worth making: the dialog now offers to use it'
  );
  await assertNoExtraDismiss('.git-sync-modal', 'The sync dialog with an empty folder line');
  await vaultPage.click('.git-sync-modal .modal-close');
  await vaultPage.waitForFunction(() => document.querySelector('.git-sync-modal') === null);
  // Reloaded again, which is also what puts the fixture's folder and its unrecorded pick
  // back: nothing below this point sees a fresh install or the folder just chosen.
  await vaultPage.evaluate(() => localStorage.removeItem('__lithicSyncFolderNone'));
  await reopenLauncher();

  // --- The × on a bookmark, and the half of it this page cannot do ---------------
  // Removing a bookmark is the launcher's own storage and needs nothing from the app.
  // What needs the app is the *copy*: an instance's launcher page, its scripts and its
  // icons live under that instance's origin, and a page may only touch its own origin's
  // storage — which is why a stale instance used to survive removing and re-adding the
  // bookmark. So the × asks Rust to drop that one origin's copy, and this is the seam the
  // two halves meet at: the command, its one argument, and the one thing it must never do.
  /**
   * Set what the next launcher page finds: two bookmarked instances, one saved login (so
   * the row that stays has something to be green about), and what the app answers about
   * dropping a copy. The mock is rebuilt from storage on every navigation, so storage is
   * where all of it has to live for the page about to be loaded.
   */
  const installFixtures = async (copyDrop) => {
    await vaultPage.evaluate((drop) => {
      const key = '__lithicVaultFixture';
      const stored = JSON.parse(localStorage.getItem(key) ?? 'null') ?? {};
      localStorage.setItem(key, JSON.stringify({
        ...stored,
        state: { ...(stored.state ?? {}), exists: true, granted: false, count: 1 },
        entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
        copyDrop: drop
      }));
      // The second entry carries a path, which is what an entry written by an older
      // launcher looks like. It is why the app derives the origin before naming it: an
      // address is not an origin, and only an origin can be cleared.
      localStorage.setItem('bookmarkedInstances', JSON.stringify([
        { url: 'https://personal.lithic.uk', label: 'personal.lithic.uk' },
        { url: 'https://www.foobar.com/wiki', label: 'foobar.com' }
      ]));
    }, copyDrop);
    await reopenLauncher();
    await vaultPage.waitForSelector('.bookmark-row .remove-recent');
  };
  const statusLine = async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
    return vaultPage.$eval('.status-label', node => node.textContent.trim()).catch(() => null);
  };
  await installFixtures({ supported: true, cleared: true });
  await waitForKeyCoverage('personal.lithic.uk', true);
  assert.equal(
    await vaultPage.$$eval('.bookmark-row', rows => rows.length),
    2,
    'Two bookmarked instances, so the row that goes and the row that stays are two rows'
  );
  /**
   * Remove the row for one instance, and read what the launcher asked for.
   *
   * Only the calls the × itself makes: the section above has emptied and refilled the
   * vault, and what it asked for then is not this assertion's business.
   */
  const removeRow = async (label) => {
    await vaultPage.evaluate(() => { window.__lithicCopiesAt = window.__lithicVault.calls.length; });
    await vaultPage.evaluate((text) => {
      const row = [...document.querySelectorAll('.bookmark-row')].find(node => node.textContent.includes(text));
      row.querySelector('.remove-recent').click();
    }, label);
    await vaultPage.waitForFunction((text) =>
      ![...document.querySelectorAll('.bookmark-row')].some(node => node.textContent.includes(text)), {}, label);
    return vaultPage.evaluate(() => ({
      added: window.__lithicVault.calls.slice(window.__lithicCopiesAt),
      entries: window.__lithicVault.entries,
      rows: [...document.querySelectorAll('.bookmark-row')].map(row => row.textContent.trim()),
      greenRows: [...document.querySelectorAll('.bookmark-row .vault-row-button')]
        .filter(key => key.classList.contains('covered')).length
    }));
  };
  const afterRemove = await removeRow('foobar.com');
  assert.deepEqual(
    afterRemove.added.map(call => call.command)
      .filter(command => !['credential_coverage', 'credentials_status', 'lock_credentials'].includes(command)),
    ['forget_instance_copy'],
    `Removing a bookmark asks the app for the copy and tells the vault nothing: ${JSON.stringify(afterRemove.added)}`
  );
  assert.deepEqual(
    afterRemove.added.find(call => call.command === 'forget_instance_copy').args,
    { origin: 'https://www.foobar.com' },
    'The origin is what is cleared, not the address from the row: a path is not part of one'
  );
  assert.equal(afterRemove.rows.length, 1, 'The row the × was on is the one that went');
  assert.deepEqual(
    afterRemove.entries,
    [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
    'The saved logins are exactly where they were: forgetting one stays the vault’s own named action'
  );
  assert.equal(afterRemove.greenRows, 1, '...which is why the instance that still has a login still says so');

  // A copy the app could not drop is said out loud, by name: the row went, and the one
  // thing the × promised beyond that is the thing that did not happen.
  await installFixtures({ supported: true, cleared: false });
  await removeRow('foobar.com');
  await vaultPage.waitForFunction(() => document.querySelector('.status-label') !== null);
  assert.equal(
    await vaultPage.$eval('.status-label', node => node.textContent.trim()),
    'Could not clear the cached copy of foobar.com',
    'A copy that is still there is reported, naming the row it was thrown away from'
  );
  // And silence where this half was never on offer: a platform with no hook would
  // otherwise be told about a failure it never attempted.
  await installFixtures({ supported: false, cleared: false });
  await removeRow('foobar.com');
  assert.equal(
    await statusLine(),
    null,
    'A platform without the hook says nothing about a half it never offered'
  );

  await vaultPage.close();

  assert.deepEqual(errors, []);
  console.log(`Puppeteer launcher smoke passed (${process.env.HEADED === '1' ? 'headed' : 'headless'})`);
} finally {
  await browser.close();
}
