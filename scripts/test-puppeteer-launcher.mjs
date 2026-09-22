import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';

const artifact = resolve('src/launcher.html');
assert.ok(existsSync(artifact), 'Build src/launcher.html before running this test');

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
  page.on('pageerror', error => { if (!isFileResourceNoise(error.message)) errors.push(error.message); });
  page.on('console', message => {
    if (message.type() === 'error' && !isFileResourceNoise(message.text())) errors.push(message.text());
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
      tx.objectStore('keyval').put({ text: JSON.stringify([{ title: 'Archive Note', text: 'distinctive cached content' }]) }, 'search_cache_archive.lith');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[aria-label="Search recent Liths"]');
  await page.type('input[aria-label="Search recent Liths"]', 'distinctive');
  await new Promise(resolve => setTimeout(resolve, 250));
  const cachedSearch = await page.evaluate(() => ({
    row: [...document.querySelectorAll('.recent-row')].find(row => row.textContent?.includes('archive.lith')),
    preview: document.querySelector('.cache-preview'),
    previewStyle: document.querySelector('.cache-preview') && getComputedStyle(document.querySelector('.cache-preview')).display,
    previewText: document.querySelector('.cache-preview')?.textContent,
    size: document.querySelector('.cached-size')?.textContent
  }));
  assert.ok(cachedSearch.row, 'Cached content-only match remains visible');
  assert.match(cachedSearch.previewText ?? '', /distinctive/);
  assert.match(cachedSearch.size ?? '', /MB$/, 'Cached result displays its local cache size');
  assert.equal(cachedSearch.previewStyle, 'block', 'Desktop cached context uses a pop-out preview');
  assert.equal(await page.$('.recent-search-clear') !== null, true, 'Search exposes an inline clear button while active');

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
  const artifactHtml = await readFile(artifact, 'utf8');
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

  // --- The way back out of a handed-over instance ---
  // A page the launcher handed this window to is reached at an instance origin
  // with a marker naming the launcher; that is the only state with somewhere to
  // return to, and in the desktop app there is no browser chrome to do it with.
  assert.equal(
    await page.$('.back-to-launcher'),
    null,
    'A launcher that was not handed over shows no way back'
  );
  const launcherAddress = 'https://tauri.localhost/';
  await page.goto(`file://${artifact}?lithic-from=${encodeURIComponent(launcherAddress)}`, {
    waitUntil: 'domcontentloaded'
  });
  await page.waitForSelector('.back-to-launcher');
  const backMarkup = await page.evaluate(() => {
    const back = document.querySelector('.back-to-launcher');
    const label = back.getAttribute('aria-label');
    const heading = document.querySelector('.heading-actions');
    return {
      label,
      target: back.getAttribute('data-target'),
      hasArrow: Boolean(back.querySelector('svg path')),
      inHeading: heading?.contains(back) ?? false
    };
  });
  assert.equal(backMarkup.label, 'Back to the main launcher');
  assert.ok(backMarkup.hasArrow, 'The way back renders an icon, not bare text');
  assert.ok(backMarkup.inHeading, 'The way back sits in the heading beside the mode’s own control');
  assert.equal(backMarkup.target, launcherAddress, 'The marker names the launcher to return to');
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

  assert.deepEqual(errors, []);
  console.log(`Puppeteer launcher smoke passed (${process.env.HEADED === '1' ? 'headed' : 'headless'})`);
} finally {
  await browser.close();
}
