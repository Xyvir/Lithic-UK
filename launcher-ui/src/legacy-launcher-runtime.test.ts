import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEngineCandidates, bootLegacyWiki, buildEngineHtml, getTodayTitle } from './legacy-launcher-runtime.ts';

test('resolves lithic.html as a sibling for file URLs', () => {
  assert.deepEqual(resolveEngineCandidates('file:///C:/Lithic/src/pre-launcher.html'), [
    'file:///C:/Lithic/src/lithic.html',
    'file:///C:/Lithic/src/pre-launcher-engine.html',
    'file:///C:/Lithic/src/src/lithic.html',
    'file:///lithic.html',
    'file:///src/lithic.html'
  ]);
});

test('resolves lithic.html as a sibling for hosted URLs', () => {
  assert.equal(resolveEngineCandidates('https://example.test/src/pre-launcher.html')[0], 'https://example.test/src/lithic.html');
});

test('keeps the canonical online engine as the recovery source', () => {
  assert.equal(resolveEngineCandidates('https://example.test/pre-launcher.html').length, 5);
});

const ENGINE_STUB = '<html><head></head><body><script class="tiddlywiki-tiddler-store" type="application/json">[]</script></body></html>';

function readStore(html: string): Array<Record<string, string>> {
  const match = html.match(/<script class="tiddlywiki-tiddler-store" type="application\/json">(\[.*?\])<\/script>/s);
  assert.ok(match, 'engine html should contain a tiddler store');
  return JSON.parse(match[1]);
}

test('buildEngineHtml injects handoff tiddlers then pending imports', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: 'title: FileTiddler\n\nfile body' }, [{ title: 'PendingTiddler', text: 'queued' }]);
  const titles = readStore(html).map((tiddler) => tiddler.title);
  assert.ok(titles.includes('FileTiddler'));
  assert.ok(titles.includes('PendingTiddler'));
  assert.ok(titles.includes('$:/state/DisableAutoSaver'));
  // Later entries win on title conflicts, mirroring the legacy append order.
  const override = buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: 'title: Dup\n\nfile' }, [{ title: 'Dup', text: 'pending wins' }]);
  const dup = readStore(override).filter((tiddler) => tiddler.title === 'Dup');
  assert.equal(dup[dup.length - 1].text, 'pending wins');
});

test('buildEngineHtml does not duplicate the today journal from a payload', () => {
  const today = getTodayTitle();
  const html = buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: '' }, [{ title: today, tags: 'Journal', text: 'payload body' }]);
  const matches = readStore(html).filter((tiddler) => tiddler.title === today);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].text, 'payload body');
});

test('bootLegacyWiki navigates via Blob URL instead of document.write to avoid module-context white screen', async () => {
  // Minimal engine stub — just needs to be valid HTML so injectTiddlers and
  // injectSaverBootstrap can run without throwing.
  const engineStub = '<html><head></head><body><script class="tiddlywiki-tiddler-store" type="application/json">[]</script></body></html>';

  let navigatedTo: string | undefined;
  let docWriteCalled = false;

  // Patch globals required by bootLegacyWiki in a Node environment.
  const globalAny = globalThis as any;
  const savedLocation = globalAny.location;
  const savedWindow = globalAny.window;
  const savedLocalStorage = globalAny.localStorage;
  const savedSessionStorage = globalAny.sessionStorage;
  const savedFetch = globalAny.fetch;
  const savedDocument = globalAny.document;
  const savedCreateObjectURL = URL.createObjectURL;

  const locationMock = {
    href: 'file:///src/pre-launcher.html',
    replace(url: string) { navigatedTo = url; }
  };
  globalAny.location = locationMock;
  // fetchEngine() reads window.location.href — Node has no global `window`, so
  // point it at the same location mock used for location.replace().
  globalAny.window = { location: locationMock };
  globalAny.localStorage = {
    getItem: (key: string) => key === 'cachedOnlineCoreEngine' ? engineStub : null,
    setItem: () => {}
  };
  globalAny.sessionStorage = { setItem: () => {}, getItem: () => null, removeItem: () => {} };
  globalAny.fetch = async () => { throw new Error('network unavailable'); };
  globalAny.document = {
    open() { docWriteCalled = true; },
    write() { docWriteCalled = true; },
    close() {}
  };
  // Patch only the static method, leaving the URL constructor intact.
  (URL as any).createObjectURL = (blob: Blob) => `blob:test-${blob.size}`;

  try {
    await bootLegacyWiki({ name: 'test.lith', text: '' });

    assert.ok(navigatedTo?.startsWith('blob:'), `Expected Blob URL navigation, got: ${navigatedTo}`);
    assert.equal(docWriteCalled, false, 'document.write() must NOT be called from a module script context — it causes a blank white page in Chrome/Edge');
  } finally {
    // Restore all patched globals.
    if (savedLocation !== undefined) globalAny.location = savedLocation; else delete globalAny.location;
    if (savedWindow !== undefined) globalAny.window = savedWindow; else delete globalAny.window;
    if (savedLocalStorage !== undefined) globalAny.localStorage = savedLocalStorage; else delete globalAny.localStorage;
    if (savedSessionStorage !== undefined) globalAny.sessionStorage = savedSessionStorage; else delete globalAny.sessionStorage;
    if (savedFetch !== undefined) globalAny.fetch = savedFetch; else delete globalAny.fetch;
    if (savedDocument !== undefined) globalAny.document = savedDocument; else delete globalAny.document;
    (URL as any).createObjectURL = savedCreateObjectURL;
  }
});
