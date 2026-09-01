import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import puppeteer from 'puppeteer';

const artifact = resolve('src/pre-launcher.html');
assert.ok(existsSync(artifact), 'Build src/pre-launcher.html before running this test');

const browser = await puppeteer.launch({
  headless: process.env.HEADED === '1' ? false : 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  defaultViewport: { width: 900, height: 700 }
});

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });

  await page.goto(`file://${artifact}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main.container');
  // The recent section is conditional, so seed one deterministic local entry
  // before asserting its search and icon controls.
  await page.evaluate(() => {
    localStorage.setItem('lithic-recent-liths', JSON.stringify([{ name: 'fixture.lith', text: '' }]));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[aria-label="Search recent Liths"]');
  await new Promise(resolve => setTimeout(resolve, 250));

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
    mountBookmark: document.querySelector('.mount-card .bookmark-button')?.getBoundingClientRect().toJSON(),
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
  assert.deepEqual(result.footer.sort(), ['Github', 'Install']);
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
  assert.equal(result.recentList?.paddingRight, '0px', 'Recent rows use the full search width');
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
  assert.deepEqual(errors, []);
  console.log(`Puppeteer launcher smoke passed (${process.env.HEADED === '1' ? 'headed' : 'headless'})`);
} finally {
  await browser.close();
}
