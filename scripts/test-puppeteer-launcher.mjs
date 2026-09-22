import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';

const artifact = resolve('src/launcher.html');
assert.ok(existsSync(artifact), 'Build src/launcher.html before running this test');

// One bookmark fixture entry deliberately has no cached icon, so the launcher
// tries to fetch one from a host that does not exist (see the bookmark section).
const missingIconHost = 'no-icon.example.com';

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

  // --- Saved instance logins (the credential vault) ----------------------------
  // Rendered only in the desktop app, so this page is given the app's own global
  // and `?mode=tauri` (the launcher's documented override) with a mock standing
  // in for Rust. What is being pinned here is the contract between the two
  // halves: command names, argument keys, and which state the dialog shows. The
  // vault's own behaviour — KDF, AEAD, origin matching — is covered by the Rust
  // unit tests, and the two meet at exactly these names.
  const vaultPage = await browser.newPage();
  await vaultPage.setViewport({ width: 900, height: 700 });
  vaultPage.on('pageerror', error => errors.push(`vault: ${error.message}`));
  await vaultPage.evaluateOnNewDocument(() => {
    const vault = {
      state: { exists: true, unlocked: false, count: 0, path: 'C:\\Users\\fixture\\AppData\\Local\\Lithic\\credentials.vault' },
      entries: [],
      calls: []
    };
    window.__lithicVault = vault;
    const answer = (command, args) => {
      vault.calls.push({ command, args });
      switch (command) {
        case 'credentials_status':
          return { ...vault.state, count: vault.state.unlocked ? vault.entries.length : 0 };
        case 'list_credentials':
          return vault.state.unlocked ? vault.entries : [];
        case 'check_credentials_secret':
          return { ok: true, problem: null, warning: args.secret.length < 8 ? 'Six digits is about a day and a half of guessing on eight cores.' : null };
        case 'unlock_credentials':
          vault.state.unlocked = true;
          return vault.entries;
        case 'remember_credentials': {
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
          return vault.entries;
        }
        case 'forget_credentials':
          vault.entries = vault.entries.filter(entry => entry.origin !== args.origin);
          return vault.entries;
        case 'lock_credentials':
          vault.state.unlocked = false;
          return { ...vault.state, count: 0 };
        default:
          // Everything else the launcher asks for in this mode: no answer, which
          // every caller already treats as "absent".
          return null;
      }
    };
    window.__TAURI__ = {
      core: { invoke: (command, args) => Promise.resolve(answer(command, args)) },
      event: { listen: () => Promise.resolve(() => {}) }
    };
  });
  await vaultPage.goto(`file://${artifact}?mode=tauri`, { waitUntil: 'domcontentloaded' });
  await vaultPage.waitForSelector('.vault-button');
  const vaultButtonTitle = await vaultPage.$eval('.vault-button', node => node.getAttribute('title'));
  assert.equal(vaultButtonTitle, 'Saved instance logins — locked', 'A locked vault says so before it is opened');
  assert.equal(
    await vaultPage.$eval('.vault-button', node => node.querySelector('svg') !== null),
    true,
    'The vault control is an icon button, like the sync one beside it'
  );

  await vaultPage.click('.vault-button');
  await vaultPage.waitForSelector('.vault-modal');
  assert.equal(
    await vaultPage.$eval('.vault-modal h2', node => node.textContent.trim()),
    'Saved Instance Logins'
  );
  // Locked with a vault on disk: the dialog asks for the secret and nothing else.
  assert.equal(await vaultPage.$('.vault-modal input[placeholder^="https://instance"]'), null, 'A locked vault offers no way to add a login');
  await vaultPage.type('.vault-modal input[type="password"]', 'hunter2');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-warning') !== null);
  const warning = await vaultPage.$eval('.vault-warning', node => node.textContent.trim());
  assert.ok(warning.includes('day and a half'), 'The weak-secret warning is Rust’s own arithmetic, shown as written');
  await vaultPage.click('.vault-modal .modal-action');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-empty') !== null);
  const afterUnlock = await vaultPage.evaluate(() => ({
    calls: window.__lithicVault.calls,
    title: document.querySelector('.vault-button').getAttribute('title'),
    labelled: document.querySelector('.vault-button').classList.contains('unlocked')
  }));
  const unlockCall = afterUnlock.calls.find(call => call.command === 'unlock_credentials');
  assert.deepEqual(unlockCall?.args, { secret: 'hunter2' }, 'Unlocking passes the secret under the name Rust expects');
  assert.equal(afterUnlock.labelled, true, 'An unlocked vault is visibly unlocked');
  assert.ok(afterUnlock.title.includes('unlocked'), 'And its control says which state it is in');

  // Adding a login: the origin is the field that trips people, so it takes any
  // address and Rust is left to normalise it.
  await vaultPage.type('.vault-modal input[placeholder^="https://instance"]', 'https://personal.example.uk/sync/wiki.html');
  const fields = await vaultPage.$$('.vault-modal input:not([type="checkbox"])');
  await fields[1].type('keeper');
  await fields[2].type('s3cret');
  await vaultPage.evaluate(() => {
    const buttons = [...document.querySelectorAll('.vault-modal .modal-action')];
    buttons.find(button => button.textContent.includes('Save Login')).click();
  });
  await vaultPage.waitForFunction(() => document.querySelector('.vault-list li') !== null);
  const saved = await vaultPage.evaluate(() => ({
    calls: window.__lithicVault.calls,
    row: document.querySelector('.vault-list li').textContent.replace(/\s+/g, ' ').trim()
  }));
  const saveCall = saved.calls.find(call => call.command === 'remember_credentials');
  assert.deepEqual(
    saveCall?.args,
    { origin: 'https://personal.example.uk/sync/wiki.html', user: 'keeper', password: 's3cret' },
    'Saving passes origin, user and password exactly as Rust declares them'
  );
  assert.ok(saved.row.includes('https://personal.example.uk'), 'The saved login is listed by its address');

  // Forgetting one entry, then locking: both are the commands Rust expects, and
  // locking must clear the list rather than leave it on screen.
  await vaultPage.click('.vault-list li .vault-forget');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-list li') === null);
  const afterForget = await vaultPage.evaluate(() => window.__lithicVault.calls.filter(call => call.command === 'forget_credentials'));
  assert.deepEqual(afterForget.at(-1)?.args, { origin: 'https://personal.example.uk' }, 'Forgetting passes the normalised origin');
  await vaultPage.evaluate(() => {
    const buttons = [...document.querySelectorAll('.vault-modal .modal-action')];
    buttons.find(button => button.textContent.trim() === 'Lock').click();
  });
  await vaultPage.waitForFunction(() => document.querySelector('.vault-modal h2') && document.querySelector('.vault-modal input[placeholder^="https://instance"]') === null);
  assert.equal(
    await vaultPage.evaluate(() => window.__lithicVault.state.unlocked),
    false,
    'Locking asks Rust to drop the session'
  );
  assert.ok(
    await vaultPage.evaluate(() => document.querySelector('.vault-button').classList.contains('unlocked') === false),
    'And the control goes back to locked'
  );

  // A vault that does not exist yet: one dialog, a confirmation field, and no
  // "unlock" wording — creating must not be mistaken for opening.
  await vaultPage.evaluate(() => { window.__lithicVault.state.exists = false; });
  await vaultPage.click('.modal-close');
  await vaultPage.click('.vault-button');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-modal input[placeholder^="https://instance"]') === null);
  const createLabels = await vaultPage.evaluate(() => {
    const fields = [...document.querySelectorAll('.vault-modal input')].map(node => node.getAttribute('type'));
    const primary = document.querySelector('.vault-modal .modal-action');
    return { fields, primary: primary.textContent.trim(), disabled: primary.disabled };
  });
  assert.equal(createLabels.fields.filter(type => type === 'password').length, 2, 'Creating a vault asks for the secret twice, since nothing can recover it');
  assert.equal(createLabels.primary, 'Create & Unlock');
  assert.equal(createLabels.disabled, true, 'An empty secret cannot create a vault');
  await vaultPage.type('.vault-modal input[type="password"]', 'correct horse');
  assert.equal(
    await vaultPage.evaluate(() => document.querySelector('.vault-modal .modal-action').disabled),
    true,
    'A secret typed once, with the confirmation still empty, cannot create a vault'
  );
  const confirmFields = await vaultPage.$$('.vault-modal input[type="password"]');
  await confirmFields[1].type('correct hors');
  assert.equal(
    await vaultPage.evaluate(() => document.querySelector('.vault-modal .modal-action').disabled),
    true,
    'A mistyped confirmation does not create a vault under a secret nobody knows'
  );
  await confirmFields[1].type('e');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-modal .modal-action').disabled === false);
  await vaultPage.click('.vault-modal .modal-action');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-button').classList.contains('unlocked'));
  const created = await vaultPage.evaluate(() => window.__lithicVault.calls.filter(call => call.command === 'unlock_credentials').at(-1));
  assert.deepEqual(created?.args, { secret: 'correct horse' }, 'The first secret becomes the vault’s, through the same command');
  assert.equal(
    await vaultPage.evaluate(() => document.querySelector('.vault-button').getAttribute('title').includes('0 saved')),
    true,
    'Registering a vault reports nothing saved yet rather than an unreadable count'
  );
  assert.equal(
    await vaultPage.evaluate(() => Boolean(document.querySelector('.vault-path')?.textContent.includes('credentials.vault'))),
    true,
    'The dialog names the file the logins live in'
  );
  await vaultPage.close();

  assert.deepEqual(errors, []);
  console.log(`Puppeteer launcher smoke passed (${process.env.HEADED === '1' ? 'headed' : 'headless'})`);
} finally {
  await browser.close();
}
