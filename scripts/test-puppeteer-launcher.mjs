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
  const selfHostPage = await browser.newPage();
  await selfHostPage.setViewport({ width: 1000, height: 700 });
  await selfHostPage.goto(`file://${artifact}?mode=self-host`, { waitUntil: 'domcontentloaded' });
  await selfHostPage.waitForSelector('main.container');
  const selfHostMark = await selfHostPage.evaluate(() => {
    const mark = document.querySelector('.brand-icon-wrap');
    return {
      tag: mark?.tagName ?? null,
      label: mark?.getAttribute('aria-label') ?? null,
      href: mark?.getAttribute('href') ?? null,
      disabled: mark?.hasAttribute('disabled') ?? null
    };
  });
  await selfHostPage.close();
  assert.equal(selfHostMark.tag, 'BUTTON', 'Self-host: the mark stays the icon picker button');
  assert.equal(selfHostMark.label, 'Set this instance’s icon', 'Self-host: the picker button is still labelled');
  assert.equal(selfHostMark.href, null, 'Self-host: the mark does not link away from the picker');
  assert.equal(selfHostMark.disabled, false, 'Self-host: the picker is a live control, not the old dead button');

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
  await vaultPage.setViewport({ width: 900, height: 700 });
  vaultPage.on('pageerror', error => errors.push(`vault: ${error.message}`));
  // A record of what the launcher asked Rust, held on this side of the browser.
  // Opening an instance navigates away from the page that asked, so the page's own
  // log is gone by the time that call is worth checking.
  const vaultCalls = [];
  await vaultPage.exposeFunction('__lithicRecord', entry => vaultCalls.push(entry));
  await vaultPage.evaluateOnNewDocument(() => {
    const vault = {
      state: { exists: true, unlocked: false, granted: false, count: 1, path: 'C:\\Users\\fixture\\AppData\\Local\\Lithic\\credentials.vault' },
      // One saved login, for the first bookmark fixture: the rows and the manager key
      // have something to be green about without the test having to set it up first.
      entries: [{ origin: 'https://personal.lithic.uk', user: 'keeper' }],
      calls: []
    };
    // The PIN the boxes are expected to produce — folded to upper case, which is what
    // the launcher sends — and one that is not it.
    const PIN = 'L1TH1C';
    const WRONG_PIN = 'ZZZZZZ';
    window.__lithicVault = vault;
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
          return vault.state.unlocked ? vault.entries : [];
        // Rust's own rules, near enough to keep the contract honest: six letters or
        // digits, and the arithmetic for the one case worth warning about.
        case 'check_credentials_secret': {
          const pin = String(args.secret ?? '').toUpperCase();
          if (!/^[0-9A-Z]{6}$/.test(pin)) {
            return { ok: false, problem: 'A PIN is 6 letters or digits.', warning: null };
          }
          return {
            ok: true,
            problem: null,
            warning: /^[0-9]{6}$/.test(pin)
              ? 'Six digits is 1,000,000 combinations — about 7 days on one core, or 21 hours across eight. One letter makes that number useless.'
              : null
          };
        }
        case 'probe_instance':
          // Only one fixture answers without asking for a password: the verdict is what
          // decides whether the offer is made at all, so both answers have to be
          // reachable from here.
          return args.url.includes('open.example')
            ? { state: 'lithic', status: 200 }
            : { state: 'protected', status: 401 };
        case 'unlock_credentials':
          if (args.secret === WRONG_PIN) throw new Error('That PIN does not open the vault.');
          vault.state.unlocked = true;
          return vault.entries;
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
          // grant it leaves behind is what signs the instance in.
          if (args.secret !== PIN) throw new Error('That PIN does not open the vault.');
          vault.entries = vault.entries
            .filter(entry => entry.origin !== args.origin)
            .concat([{ origin: args.origin, user: args.user }]);
          vault.state.granted = true;
          return { origin: args.origin, user: args.user };
        }
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
        case 'check_credential':
          // One login the instance still accepts, and one it has since refused: the
          // two verdicts the row has to be able to tell apart.
          return args.origin === 'https://personal.lithic.uk'
            ? { outcome: 'accepted', status: 200, detail: 'The instance asks for a password, and accepts this login.' }
            : { outcome: 'refused', status: 401, detail: 'The instance refused this login (401).' };
        case 'change_credentials_secret':
          return { ...vault.state, count: vault.entries.length };
        case 'destroy_credentials':
          vault.entries = [];
          vault.state.unlocked = false;
          return { ...vault.state, exists: false, count: 0 };
        case 'lock_credentials':
          vault.state.unlocked = false;
          vault.state.granted = false;
          return { ...vault.state, count: vault.entries.length };
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
  });
  await vaultPage.goto(`file://${artifact}?mode=tauri`, { waitUntil: 'domcontentloaded' });
  // Two bookmarks, one of which the vault already holds a login for.
  await vaultPage.evaluate(entries => {
    localStorage.setItem('bookmarkedInstances', JSON.stringify(entries));
  }, [
    { url: 'https://personal.lithic.uk', label: 'personal.lithic.uk' },
    { url: 'https://other.example', label: 'other.example' }
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
      hasGlyph: Boolean(node.querySelector('svg')),
      colour: getComputedStyle(node).color,
      onOneLine: buttons.every(button => Math.round(button.getBoundingClientRect().top) === Math.round(box.top)),
      rowOverflow: row.scrollWidth - row.clientWidth
    };
  });
  assert.equal(managerLooks.label, 'Saved Logins', 'The manager key is labelled, so what it manages is not a guess');
  assert.ok(managerLooks.hasGlyph, '...and keeps the key it is recognised by');
  assert.equal(managerLooks.colour, 'rgb(123, 168, 111)', 'Green is the same green a bookmark row’s key uses for a saved login');
  assert.equal(managerLooks.onOneLine, true, 'It shares the dialog’s action row rather than wrapping under it');
  assert.equal(managerLooks.rowOverflow, 0, '...without the row overflowing the dialog');
  // The one-pass setup this placement buys: the address typed in the bookmark dialog
  // is the one the manager offers to save a login for, so an instance does not have to
  // be bookmarked first and given a login afterwards. It is handed over as typed —
  // Rust is what decides an origin — which is why this is not a normalised address.
  await vaultPage.type('input[aria-label="Self-hosted instance URL"]', 'other.example');
  await vaultPage.click('.vault-manager-button');
  await vaultPage.waitForSelector('.vault-modal');
  const handedOver = await vaultPage.evaluate(() => ({
    bookmarkDialogClosed: document.querySelector('#bookmark-title') === null,
    dialogs: document.querySelectorAll('.modal-overlay').length
  }));
  assert.equal(handedOver.bookmarkDialogClosed, true, 'The bookmark dialog closes behind the vault it opened');
  assert.equal(handedOver.dialogs, 1, '...so the two are never stacked on each other');
  // The add field only exists with the vault open, so the address the dialog carried over
  // is read there — which is also the reason the hand-off is worth having: an address you
  // are already looking at does not have to be typed a second time.
  // The sixth character is the submit, so there is no button to press.
  await typePin(vaultPage, '.vault-unlock-pin', 'L1TH1C');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(
    await vaultPage.evaluate(() => Boolean(document.querySelector('#vault-new-origin'))),
    true,
    'The completed PIN submits itself: the vault is open with no button pressed'
  );
  assert.equal(
    await vaultPage.$eval('#vault-new-origin', node => node.value),
    'other.example',
    'And the address typed in the bookmark dialog is the one offered to save a login for'
  );
  // A fresh page for what comes next, which walks the per-instance keys from the locked
  // vault this left behind.
  await vaultPage.goto(`file://${artifact}?mode=tauri`, { waitUntil: 'domcontentloaded' });
  await vaultPage.waitForSelector('.bookmark-row .vault-row-button');

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

  // First-time setup, from the row whose key is grey: the manager opens with that
  // address ready, because the app cannot learn a password by watching a login work.
  await vaultPage.evaluate(() => document.querySelectorAll('.bookmark-row .vault-row-button')[1].click());
  await vaultPage.waitForSelector('.vault-modal');
  assert.equal(
    await vaultPage.$eval('.vault-modal h2', node => node.textContent.trim()),
    'Saved Instance Logins'
  );
  // Locked with a vault on disk: the secret and nothing else, plus what the file
  // says about itself without being opened.
  assert.equal(await vaultPage.$('#vault-new-origin'), null, 'A locked vault offers no way to add a login');
  assert.equal(
    await vaultPage.$eval('.vault-count', node => node.textContent.trim()),
    '1 login saved.',
    'The count is known while locked, because it comes from the file’s origin index'
  );
  await typePin(vaultPage, '.vault-unlock-pin', 'L1TH1C');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(
    await vaultPage.evaluate(() => document.querySelector('.vault-list li')?.textContent.includes('personal.lithic.uk') ?? false),
    true,
    'The completed PIN opens the vault, listing what is in it'
  );
  const afterUnlock = await vaultPage.evaluate(() => ({
    calls: window.__lithicVault.calls,
    listed: document.querySelector('.vault-list li').textContent.replace(/\s+/g, ' ').trim(),
    prefilled: document.querySelector('#vault-new-origin').value,
    openDialogs: [...document.querySelectorAll('.vault-modal, .launcher-modal')].length,
    bookmarkDialogClosed: document.querySelector('#bookmark-title') === null
  }));
  const unlockCall = afterUnlock.calls.find(call => call.command === 'unlock_credentials');
  assert.deepEqual(unlockCall?.args, { secret: 'L1TH1C' }, 'Unlocking passes the PIN under the name Rust expects, folded to upper case');
  assert.ok(afterUnlock.listed.includes('https://personal.lithic.uk'), 'The saved login is listed by its address');
  assert.equal(afterUnlock.prefilled, 'https://other.example', 'The address whose key was clicked is ready to save');
  assert.equal(afterUnlock.bookmarkDialogClosed, true, 'The bookmark dialog closes behind the vault it opened, rather than stacking on it');
  assert.equal(afterUnlock.openDialogs, 1, 'One dialog is on screen, and it is the vault’s');

  // Saving that login: the origin is the field that trips people, so it takes any
  // address and Rust is left to normalise it — and the field was already filled from
  // the row whose key was clicked.
  await vaultPage.$eval('#vault-new-origin', node => { node.value = ''; });
  await vaultPage.type('#vault-new-origin', 'https://other.example/sync/wiki.html');
  await vaultPage.type('#vault-new-user', 'keeper');
  await vaultPage.type('#vault-new-password', 's3cret');
  await vaultPage.type('#vault-new-password-confirm', 's3cret');
  await vaultPage.evaluate(() => {
    const buttons = [...document.querySelectorAll('.vault-modal .modal-action')];
    buttons.find(button => button.textContent.includes('Save Login')).click();
  });
  await vaultPage.waitForFunction(() => document.querySelectorAll('.vault-list li').length === 2);
  const saved = await vaultPage.evaluate(() => ({
    calls: window.__lithicVault.calls,
    rows: [...document.querySelectorAll('.vault-list li')].map(row => row.textContent.replace(/\s+/g, ' ').trim()),
    greenRows: [...document.querySelectorAll('.bookmark-row .vault-row-button')].map(key => key.classList.contains('covered')),
    coveredCall: window.__lithicVault.calls.filter(call => call.command === 'credential_coverage').at(-1)
  }));
  const saveCall = saved.calls.find(call => call.command === 'remember_credentials');
  assert.deepEqual(
    saveCall?.args,
    { origin: 'https://other.example/sync/wiki.html', user: 'keeper', password: 's3cret' },
    'Saving passes origin, user and password exactly as Rust declares them'
  );
  assert.equal(saved.rows.length, 2, 'Both saved logins are listed');
  assert.deepEqual(saved.greenRows, [true, true], 'And every row the vault now covers turns green');
  assert.ok(
    saved.coveredCall.args.origins.includes('https://other.example'),
    'The rows were recoloured by asking the vault about their addresses'
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
  await check('other.example');
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
  assert.deepEqual(checked.calls.at(-1)?.args, { origin: 'https://other.example' }, 'Checking passes the origin under the name Rust expects');
  assert.deepEqual(checked.verdicts, ['accepted:Signs in', 'refused:Refused'], 'Each login shows what its instance said about it');
  assert.ok(checked.reason.includes('401'), `And the reason is kept behind the verdict: ${checked.reason}`);
  assert.ok(
    checked.labels.every(label => label.startsWith('Check the login for https://')),
    `The control says which login it will check: ${checked.labels.join(' / ')}`
  );

  // Forgetting one, from the list: the command takes the normalised origin, and the
  // row that address belongs to goes back to grey.
  await vaultPage.evaluate(() => {
    const row = [...document.querySelectorAll('.vault-list li')].find(node => node.textContent.includes('other.example'));
    row.querySelector('.vault-forget').click();
  });
  await vaultPage.waitForFunction(() => document.querySelectorAll('.vault-list li').length === 1);
  const afterForget = await vaultPage.evaluate(() => ({
    calls: window.__lithicVault.calls.filter(call => call.command === 'forget_credentials'),
    greenRows: [...document.querySelectorAll('.bookmark-row .vault-row-button')].map(key => key.classList.contains('covered'))
  }));
  assert.deepEqual(afterForget.calls.at(-1)?.args, { origin: 'https://other.example' }, 'Forgetting passes the normalised origin');
  assert.deepEqual(afterForget.greenRows, [true, false], 'The forgotten address stops showing a saved login');

  // Changing the secret is offered only with the vault open, which is why the old one
  // is not asked for again: the key being replaced is already in memory.
  await vaultPage.click('.vault-advanced summary');
  await typePin(vaultPage, '.vault-new-pin', 'n3wp1n');
  await typePin(vaultPage, '.vault-new-pin-confirm', 'n3wp1n');
  // Read by its wording, not its presence: saving a login already put a notice there,
  // and a stale one would pass a presence check.
  await new Promise(resolve => setTimeout(resolve, 400));
  const rotated = await vaultPage.evaluate(() => ({
    calls: window.__lithicVault.calls.filter(call => call.command === 'change_credentials_secret'),
    notice: document.querySelector('.vault-notice')?.textContent.trim() ?? '',
    boxes: [...document.querySelectorAll('.vault-new-pin .pin-box')].map(box => box.value).join('')
  }));
  assert.deepEqual(
    rotated.calls.at(-1)?.args,
    { newSecret: 'N3WP1N' },
    'The replacement PIN goes over as `newSecret`, and the old one is never sent'
  );
  assert.equal(
    rotated.calls.length,
    1,
    'The completed confirmation is the submit: changing the PIN needs no button press'
  );
  assert.equal(rotated.boxes, 'N3WP1N', 'And the boxes hold what was typed, in upper case');
  assert.ok(rotated.notice.includes('changed'), `The dialog says the secret changed: ${rotated.notice}`);

  // Leaving the dialog locks: the vault is open only while it is on screen, so nothing
  // is left unlocked behind a dialog nobody is looking at.
  await vaultPage.click('.vault-modal .modal-close');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-modal') === null);
  assert.ok(
    await vaultPage.evaluate(() => window.__lithicVault.calls.some(call => call.command === 'lock_credentials')),
    'Closing the manager locks the vault rather than leaving it open'
  );
  assert.equal(await vaultPage.$('.instance-unlock-pin .pin-box'), null, 'and no prompt is left behind by any of it');

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
  vaultPage.on('request', recordOffer);
  await openBookmark('other.example');
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
  assert.equal(offered.sub, 'other.example asks for a password.', 'The offer names the instance and why it is being made');
  assert.equal(offered.pinBoxes, 6, 'The PIN is asked for in six boxes');
  assert.equal(offered.confirmBoxes, 0, 'A vault on disk already has a PIN, so there is nothing to confirm');
  assert.deepEqual(
    offered.buttons,
    ['Save Credential', 'Cancel', 'Don’t ask again'],
    'Both ways out sit beside the one way in, and none of them is a second dialog'
  );
  assert.equal(offered.saveDisabled, true, 'And an empty credential cannot be saved');
  assert.equal(offered.dialogs, 1, 'All of it fits one dialog');
  assert.deepEqual(
    offered.probes,
    { url: 'https://other.example' },
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

  // The credential itself: a mistyped repeat is not saved, because a stored password
  // nobody can type is worse than no stored password.
  await vaultPage.type('.credential-offer-user', 'keeper');
  await vaultPage.type('.credential-offer-password', 's3cret');
  await vaultPage.type('.credential-offer-password-confirm', 's3cre');
  assert.equal(
    await vaultPage.$eval('.credential-offer-save', node => node.disabled),
    true,
    'A mistyped password repeat does not save a credential'
  );
  await vaultPage.type('.credential-offer-password-confirm', 't');
  await vaultPage.$eval('.credential-offer-save', node => node.click());
  await new Promise(resolve => setTimeout(resolve, 400));
  vaultPage.off('request', recordOffer);
  const savedOffer = vaultCalls.filter(call => call.command === 'save_login_for_instance').at(-1);
  assert.deepEqual(
    savedOffer?.args,
    { origin: 'https://other.example', secret: 'L1TH1C', user: 'keeper', password: 's3cret' },
    'Saving offers origin, PIN, user and password exactly as Rust declares them'
  );
  assert.ok(
    offerRequests.some(url => url.startsWith('https://other.example')),
    `And the instance opens straight afterwards, without the platform's own prompt (saw ${JSON.stringify(offerRequests)})`
  );
  assert.ok(
    offerRequests.some(url => url.includes('lithic-from=')),
    '...carrying the marker that names this launcher, as any other open does'
  );

  // "Don't ask again" is remembered with the bookmark, so the offer is made once and
  // the answer is somewhere the next open can read it. The checkbox is not needed:
  // the flag is only about the offer, and saving a login is the way back from it.
  await reopenLauncher();
  await openBookmark('other.example');
  await vaultPage.waitForSelector('#credential-offer-title');
  await vaultPage.click('.credential-offer-skip');
  await new Promise(resolve => setTimeout(resolve, 400));
  await reopenLauncher();
  const skipped = await vaultPage.evaluate(() => {
    const row = [...document.querySelectorAll('.bookmark-row')].find(node => node.textContent.includes('other.example'));
    const key = row.querySelector('.vault-row-button');
    return {
      stored: JSON.parse(localStorage.getItem('bookmarkedInstances') ?? '[]').find(entry => entry.url === 'https://other.example')?.manualAuth ?? null,
      manualKeys: [...document.querySelectorAll('.bookmark-row')].map(node => node.querySelector('.vault-row-button').classList.contains('manual')),
      covered: key.classList.contains('covered'),
      title: key.getAttribute('title')
    };
  });
  assert.equal(skipped.stored, true, 'The answer is kept with the bookmark it is about');
  assert.deepEqual(skipped.manualKeys, [false, true], 'The row says so rather than looking like any other unsaved one');
  assert.equal(skipped.covered, false, '...without pretending a login is saved, because none is');
  assert.ok(skipped.title.includes('chose not to'), `And its title says what was chosen: ${skipped.title}`);

  // And the offered instance is remembered as asked: the second open asks nothing.
  const skippedRequests = [];
  const recordSkipped = request => {
    if (request.isNavigationRequest()) skippedRequests.push(request.url());
  };
  vaultPage.on('request', recordSkipped);
  await openBookmark('other.example');
  await new Promise(resolve => setTimeout(resolve, 400));
  vaultPage.off('request', recordSkipped);
  assert.equal(
    await vaultPage.evaluate(() => document.querySelector('#credential-offer-title') === null),
    true,
    'The instance that was answered "do not ask again" is not asked again'
  );
  assert.ok(
    skippedRequests.some(url => url.startsWith('https://other.example')),
    `It simply opens (saw ${JSON.stringify(skippedRequests)})`
  );

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
  // The fixture list goes back to the two the rest of this block walks, so the offer's
  // third instance cannot quietly change what the next assertions count. Read from the
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
        past: Math.max(0, Math.round(boxes.at(-1).getBoundingClientRect().right - (modal.right - 22)))
      };
    });
  const pinAtWide = await measurePin();
  assert.deepEqual(
    { count: pinAtWide.count, rows: pinAtWide.rows, past: pinAtWide.past },
    { count: 6, rows: 1, past: 0 },
    `Six boxes on one line, inside the modal: ${JSON.stringify(pinAtWide)}`
  );
  await vaultPage.setViewport({ width: 320, height: 700 });
  const pinAtNarrow = await measurePin();
  await vaultPage.setViewport({ width: 900, height: 700 });
  assert.deepEqual(
    { count: pinAtNarrow.count, rows: pinAtNarrow.rows, past: pinAtNarrow.past },
    { count: 6, rows: 1, past: 0 },
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

  // --- Starting over, and the one control knowing the secret cannot undo ---------
  await vaultPage.goto(`file://${artifact}?mode=tauri`, { waitUntil: 'domcontentloaded' });
  await vaultPage.waitForSelector('.action-pair .bookmark-button');
  await vaultPage.click('.action-pair .bookmark-button');
  await vaultPage.waitForSelector('.vault-manager-button');
  await vaultPage.click('.vault-manager-button');
  await vaultPage.waitForSelector('.vault-modal');
  assert.equal(
    await vaultPage.$eval('.vault-modal .vault-count', node => node.textContent.trim()),
    '1 login saved.',
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
  await vaultPage.waitForFunction(() => document.querySelector('#vault-new-origin') === null);
  const createLabels = await vaultPage.evaluate(() => ({
    pinBoxes: document.querySelectorAll('.vault-unlock-pin .pin-box').length,
    confirmBoxes: document.querySelectorAll('.vault-unlock-pin-confirm .pin-box').length,
    primary: document.querySelector('.vault-modal .modal-action').textContent.trim(),
    disabled: document.querySelector('.vault-modal .modal-action').disabled
  }));
  assert.deepEqual(
    createLabels,
    { pinBoxes: 6, confirmBoxes: 6, primary: 'Set PIN', disabled: true },
    'Creating a vault asks for the PIN twice, since nothing can recover it'
  );
  // Six digits is the one PIN worth warning about, and the arithmetic shown is Rust's
  // own sentence rather than a second opinion assembled here.
  await typePin(vaultPage, '.vault-unlock-pin', '123456');
  await new Promise(resolve => setTimeout(resolve, 400));
  const weakPin = await vaultPage.$eval('.vault-warning', node => node.textContent.trim()).catch(() => '');
  assert.ok(weakPin.includes('1,000,000'), `A digits-only PIN is warned about, in Rust's own arithmetic: ${weakPin}`);
  assert.equal(
    await vaultPage.$eval('.vault-modal .modal-action', node => node.disabled),
    true,
    'A PIN typed once, with the confirmation still empty, cannot create a vault'
  );
  await typePin(vaultPage, '.vault-unlock-pin-confirm', '123455');
  assert.equal(
    await vaultPage.$eval('.vault-modal .modal-action', node => node.disabled),
    true,
    'A mistyped confirmation does not create a vault under a PIN nobody knows'
  );
  assert.equal(
    await vaultPage.evaluate(() => window.__lithicVault.calls.some(call => call.command === 'unlock_credentials')),
    false,
    '...and nothing was created by the confirmation, because the two do not agree'
  );
  // Corrected in place: the last box is cleared and retyped, which is all a mistake in
  // a six-box PIN costs, and the completed confirmation then creates the vault itself.
  await vaultPage.evaluate(() => document.querySelectorAll('.vault-unlock-pin-confirm .pin-box')[5].focus());
  await vaultPage.keyboard.press('Backspace');
  await vaultPage.keyboard.type('6');
  // Named rather than waited for, for the same reason as above: the point is that the
  // completed confirmation is what created the vault.
  await new Promise(resolve => setTimeout(resolve, 400));
  const created = await vaultPage.evaluate(() => window.__lithicVault.calls.filter(call => call.command === 'unlock_credentials').at(-1));
  assert.deepEqual(created?.args, { secret: '123456' }, 'The first PIN becomes the vault’s, through the same command');
  assert.equal(
    await vaultPage.evaluate(() => document.querySelector('.vault-modal .vault-notice')?.textContent.trim() ?? ''),
    'Ready. Add a login.',
    '...and the finished confirmation is what submitted it, with no button pressed'
  );
  assert.equal(
    await vaultPage.evaluate(() => Boolean(document.querySelector('.vault-path')?.textContent.includes('credentials.vault'))),
    true,
    'The dialog names the file the logins live in'
  );
  // Read from where the manager now lives: a vault that has just been registered but
  // holds nothing has to say so, rather than leaving its count unreadable.
  await vaultPage.click('.vault-modal .modal-close');
  await vaultPage.waitForFunction(() => document.querySelector('.vault-modal') === null);
  await vaultPage.click('.action-pair .bookmark-button');
  await vaultPage.waitForSelector('.vault-manager-button');
  assert.equal(
    await vaultPage.evaluate(() => document.querySelector('.vault-manager-button').getAttribute('title').includes('none saved yet')),
    true,
    'Registering a vault reports nothing saved yet rather than an unreadable count'
  );
  await vaultPage.close();

  assert.deepEqual(errors, []);
  console.log(`Puppeteer launcher smoke passed (${process.env.HEADED === '1' ? 'headed' : 'headless'})`);
} finally {
  await browser.close();
}
