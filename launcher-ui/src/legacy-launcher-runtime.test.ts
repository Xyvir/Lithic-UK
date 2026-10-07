import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  resolveEngineCandidates,
  bootLegacyHtml,
  bootLegacyWiki,
  buildEngineHtml,
  readEnginePluginRoots,
  writeHandoff
} from './legacy-launcher-runtime.ts';

test('resolves lithic.html as a sibling for file URLs', () => {
  assert.deepEqual(resolveEngineCandidates('file:///C:/Lithic/src/launcher.html'), [
    'file:///C:/Lithic/src/lithic.html',
    'file:///C:/Lithic/src/src/lithic.html',
    'file:///lithic.html',
    'file:///src/lithic.html'
  ]);
});

test('resolves lithic.html as a sibling for hosted URLs', () => {
  assert.equal(resolveEngineCandidates('https://example.test/src/launcher.html')[0], 'https://example.test/src/lithic.html');
});

test('keeps the canonical online engine as the recovery source', () => {
  assert.equal(resolveEngineCandidates('https://example.test/launcher.html').length, 4);
});

const ENGINE_STUB = '<html><head></head><body><script class="tiddlywiki-tiddler-store" type="application/json">[]</script></body></html>';

function readStore(html: string): Array<Record<string, string>> {
  const match = html.match(/<script class="tiddlywiki-tiddler-store" type="application\/json">(\[.*?\])<\/script>/s);
  assert.ok(match, 'engine html should contain a tiddler store');
  return JSON.parse(match[1]);
}

// Regression: a file exported from the in-wiki exporter opened with a blank
// line, which the parser read as the field separator, so the first tiddler
// arrived with no title. Injecting an unnamed tiddler aborts the boot into a
// blank page with no error form. The whole mount was lost to one stray
// newline. A tiddler with no title is now dropped instead.
test('a title-less tiddler is dropped instead of bricking the boot', () => {
  const html = buildEngineHtml(
    ENGINE_STUB,
    { name: 'x.lith', text: 'title: Real\n\nkept' },
    [{ text: 'no title at all' }, { title: '   ', text: 'blank title' }]
  );
  const titles = readStore(html).map((tiddler) => tiddler.title);
  assert.ok(titles.includes('Real'), 'the real tiddler still mounts');
  assert.equal(readStore(html).length, titles.filter((title) => typeof title === 'string' && title.trim() !== '').length);
});

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

test('buildEngineHtml injects a $:/SiteTitle placeholder before boot', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: '' }, [{ title: '$:/SiteTitle', text: 'My Notes' }]);
  const siteTitle = readStore(html).filter((tiddler) => tiddler.title === '$:/SiteTitle');
  assert.ok(siteTitle.length >= 1, 'SiteTitle should be present in the injected store');
  assert.equal(siteTitle[siteTitle.length - 1].text, 'My Notes', 'the blank-lith filename placeholder should win');
});

test('buildEngineHtml no longer pre-hydrates the today journal', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: '' });
  const titles = readStore(html).map((tiddler) => tiddler.title);
  assert.ok(!titles.some((title) => title.includes('Journal')), 'today journal is created by the engine stub, not the launcher');
});

test('buildEngineHtml injects engine globals into the mounted document', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: '' }, [], {
    __EPHEMERAL_MODE__: 'paper-light',
    __LITHIC_LAUNCHER_MODE__: 'webapp'
  });
  assert.match(html, /window\["__EPHEMERAL_MODE__"\] = "paper-light";/);
  assert.match(html, /window\["__LITHIC_LAUNCHER_MODE__"\] = "webapp";/);
});

test('drifted boot arms a one-shot external full snapshot', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'notes.lith', text: '' }, [], {}, { driftedFromHead: true });
  assert.ok(html.includes('var driftedFromHead = true;'));
  assert.ok(html.includes('forceBase: saveWasDrifted'));
  assert.ok(html.includes('external: saveWasDrifted'));
});

test('injected saver recovers the file handle from IndexedDB as a fallback', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'notes.lith', text: '' });
  assert.match(html, /resolveStoredHandle/);
  assert.match(html, /lithic-active-file/);
});

test('injected saver suggests the handoff filename in the Save As picker', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'my notes.lith', text: '' });
  assert.match(html, /suggestedName: "my notes\.lith"/);
  // Handoff names are embedded in a script tag, so hostile names must be
  // escaped rather than breaking out of the injected bootstrap.
  const hostile = buildEngineHtml(ENGINE_STUB, { name: '</script><script>alert(1)</script>', text: '' });
  assert.ok(!hostile.includes('<\/script><script>alert(1)<\/script>'), 'script-breaking name is escaped');
});

test('bootLegacyWiki boots the engine in place so the launcher URL stays in the address bar', async () => {
  // Minimal engine stub. Just needs to be valid HTML so injectTiddlers and
  // injectSaverBootstrap can run without throwing.
  const engineStub = '<html><head></head><body><script class="tiddlywiki-tiddler-store" type="application/json">[]</script></body></html>';

  let written = '';
  let blobNavigated = false;

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
    href: 'file:///src/launcher.html',
    replace(url: string) { blobNavigated = true; }
  };
  globalAny.location = locationMock;
  // fetchEngine() reads window.location.href. Node has no global `window`, so
  // point it at the same location mock used for location.replace().
  globalAny.window = { location: locationMock };
  globalAny.localStorage = {
    getItem: (key: string) => key === 'cachedOnlineCoreEngine' ? engineStub : null,
    setItem: () => {}
  };
  globalAny.sessionStorage = { setItem: () => {}, getItem: () => null, removeItem: () => {} };
  globalAny.fetch = async () => { throw new Error('network unavailable'); };
  globalAny.document = {
    open() {},
    write(html: string) { written += html; },
    close() {}
  };
  // Patch only the static method, leaving the URL constructor intact.
  (URL as any).createObjectURL = (blob: Blob) => `blob:test-${blob.size}`;

  try {
    await bootLegacyWiki({ name: 'test.lith', text: '' });

    // The engine is written into the current document (document.open/write/
    // close), matching the legacy launcher.html boot path. That keeps the
    // real launcher URL in the address bar so refresh returns to the launcher
    // UI instead of an ephemeral blob: URL.
    assert.equal(blobNavigated, false, 'boot must not navigate to a blob: URL');
    assert.ok(written.includes('tiddlywiki-tiddler-store'), 'engine should be written into the current document');
    assert.ok(written.includes('$:/state/DisableAutoSaver'), 'handoff tiddlers should be injected before boot');
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

test('engine bootstrap arms the realtime dirty watcher for lith mode', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: '' });
  assert.ok(html.includes('__LITHIC_ACTIVE_FILE_NAME__'), 'bootstrap exposes the active file name');
  assert.ok(html.includes('__LITHIC_DIRTY_WATCHER_ARMED__'), 'bootstrap arms a single shared change listener');
  assert.ok(html.includes("addEventListener('change'"), 'bootstrap listens for wiki change events');
  assert.ok(html.includes('dirty_state_'), 'bootstrap persists dirty tiddlers to the dirty_state_ key');
  assert.ok(html.includes('pagehide'), 'bootstrap flushes buffered drafts on pagehide');
});

test('engine bootstrap keeps the dirty watcher inert for HTML monolith mode', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'x.html', text: '' }, [], {}, { isHtmlMode: true });
  assert.ok(html.includes('__LITHIC_ACTIVE_FILE_NAME__ = "";'), 'HTML monoliths leave the active file key empty');
});

// A monolith opts out of unsaved-edit recovery because the page may keep its own,
// which leaves saved history as the only way that mount is findable or
// recoverable. Dropping it too would make an edited monolith invisible to search
// and its row's history button permanently dead.
test('HTML monolith saves record the same searchable history as a lith', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'x.html', text: '' }, [], {}, { isHtmlMode: true });
  const start = html.indexOf('writable.write(_text)');
  // Anchor on the NEXT `var lithText`. The saver emits one earlier, inside
  // saveRemote, which would otherwise put the slice's end before its start.
  const end = html.indexOf('var lithText', start);
  assert.ok(start >= 0 && end > start, 'the monolith save branch is present');
  const branch = html.slice(start, end);
  assert.match(branch, /saveSearchCache\(handle\.name, jsonText\)/, 'records the cache and version chain');
  assert.doesNotMatch(branch, /dirty_state_/, 'but never writes an unsaved-edit backup');
});

test('scratch mode injects the flat-text serializers and publishes the root title', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'notes.txt', text: '' }, [], {}, { scratchMode: 'text' });
  assert.match(html, /__LITHIC_SCRATCH_SERIALIZE__/);
  assert.match(html, /__LITHIC_TID_SERIALIZE__/);
  assert.match(html, /__LITHIC_SCRATCH_ROOT__/);
  // The root title is the file name with its extension, so the story river
  // names the file being edited rather than a bare stem.
  assert.match(html, /__LITHIC_SCRATCH_ROOT__"\] = "notes.txt"/);
  // The save path branches on the injected scratch mode flag.
  assert.match(html, /var scratchMode = "text"/);
});

test('non-scratch boots keep the scratch saver out of the document', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'wiki.lith', text: '' });
  // The save function may *reference* the runtime global, but the defining
  // runtime script itself must not be injected.
  assert.ok(!html.includes('__LITHIC_SCRATCH_SERIALIZE__ = serialize'), 'no scratch runtime script for lith files');
  assert.match(html, /var scratchMode = "off"/);
});

test('scratch mounts tag the root tiddler with Dogear for the story river', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'notes.txt', text: '# Heading\n\tchild' }, [], {}, { scratchMode: 'text' });
  const store = readStore(html);
  const root = store.find((tiddler) => tiddler.title === 'notes.txt');
  assert.ok(root, 'scratch root tiddler is present');
  assert.ok((root.tags || '').split(' ').includes('Dogear'), 'root carries the Dogear tag');
  // ...and `stream-type`, without which the streams `get-stream-nodes`
  // operator refuses to walk the tree, so Copy Story River would copy nothing.
  assert.equal(root['stream-type'], 'default');
  const headingNode = store.find((tiddler) => tiddler.title === 'notes.txt 1');
  assert.equal(headingNode?.['stream-type'], 'default');

  // .tid files without their own tags also get the marker + bookkeeping.
  const tidHtml = buildEngineHtml(ENGINE_STUB, { name: 'card.tid', text: 'title: card\n\nbody' }, [], {}, { scratchMode: 'tid' });
  const tidRoot = readStore(tidHtml).find((tiddler) => tiddler.title === 'card.tid');
  assert.equal(tidRoot?.tags, 'Dogear');
  assert.equal(tidRoot?.['lithic-tid-injected'], 'tags type');

  // Authored tags are respected: no Dogear injection; the bookkeeping
  // field tracks only the injected default type.
  const taggedHtml = buildEngineHtml(ENGINE_STUB, { name: 'tagged.tid', text: 'title: tagged\ntags: Mine\n\nbody' }, [], {}, { scratchMode: 'tid' });
  const taggedRoot = readStore(taggedHtml).find((tiddler) => tiddler.title === 'tagged.tid');
  assert.equal(taggedRoot?.tags, 'Mine');
  assert.equal(taggedRoot?.['lithic-tid-injected'], 'type');
});

/**
 * Every inline script the launcher injects is generated from a template
 * literal, so a stray backslash silently produces a document that throws on
 * boot. Parsing each one here is the cheapest way to catch that class of bug.
 */
function inlineScriptBodies(html: string): string[] {
  const bodies: string[] = [];
  const pattern = /<script([^>]*)>([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const attributes = match[1];
    if (/\bsrc=/.test(attributes)) continue;
    if (/type="application\/json"/.test(attributes)) continue; // the tiddler store
    bodies.push(match[2]);
  }
  return bodies;
}

function assertInjectedScriptsParse(html: string, label: string): string[] {
  const bodies = inlineScriptBodies(html);
  assert.ok(bodies.length > 0, `${label}: expected injected scripts`);
  for (const body of bodies) {
    try {
      new Function(body);
    } catch (error) {
      assert.fail(`${label}: injected script does not parse: ${(error as Error).message}\n${body.slice(0, 400)}`);
    }
  }
  return bodies;
}

const REMOTE_TARGET = {
  fileName: 'my wiki.lith',
  baseText: 'title: Home\ntype: \n\none\ntwo\n',
  digest: 'abc123digest',
  apiAvailable: true
};

test('every injected bootstrap script parses for every launch shape', () => {
  assertInjectedScriptsParse(buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: '' }), 'plain lith');
  assertInjectedScriptsParse(buildEngineHtml(ENGINE_STUB, { name: 'x.txt', text: '' }, [], {}, { scratchMode: 'text' }), 'scratch text');
  assertInjectedScriptsParse(buildEngineHtml(ENGINE_STUB, { name: 'x.tid', text: '' }, [], {}, { scratchMode: 'tid' }), 'scratch tid');
  assertInjectedScriptsParse(buildEngineHtml(ENGINE_STUB, { name: 'x.ipynb', text: '' }, [], {}, { scratchMode: 'ipynb' }), 'scratch ipynb');
  assertInjectedScriptsParse(buildEngineHtml(ENGINE_STUB, { name: 'x.html', text: '' }, [], {}, { isHtmlMode: true }), 'html monolith');
  assertInjectedScriptsParse(buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: '' }, [], {}, { browserOnly: true }), 'browser storage only');
  assertInjectedScriptsParse(
    buildEngineHtml(ENGINE_STUB, { name: 'x.html', text: '' }, [], {}, { isHtmlMode: true, browserOnly: true }),
    'monolith in browser storage only'
  );
  assertInjectedScriptsParse(
    buildEngineHtml(ENGINE_STUB, { name: 'my wiki.lith', text: '' }, [], {}, { remote: REMOTE_TARGET }),
    'self-host remote'
  );
  assertInjectedScriptsParse(
    buildEngineHtml(ENGINE_STUB, { name: 'my wiki.lith', text: '' }, [], {}, { remote: { ...REMOTE_TARGET, readOnly: true } }),
    'self-host remote read-only'
  );
  assertInjectedScriptsParse(
    buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: '' }, [], {}, { shimToken: 'deadbeef' }),
    'shim backend'
  );
});

test('a shim mount bakes the wire and its secret into the saver, and a plain one carries neither', () => {
  // The secret is a literal because the mounted document cannot read the launcher's meta tag:
  // document.write replaced the head that carried it. This pins that the literal is the one
  // the launcher read, and that a mount with no shim leaves the branch inert.
  const shim = buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: '' }, [], {}, { shimToken: 'deadbeef' });
  const bodies = assertInjectedScriptsParse(shim, 'shim backend');
  const saver = bodies.find((body) => body.includes('__LITHIC_WRITE_FILE__'));
  assert.ok(saver, 'the saver is injected');
  assert.ok(saver.includes('var shimToken = "deadbeef";'), 'the secret is not in the saver');
  assert.ok(saver.includes('__lithicShimPath__'), 'the saver does not recognize a shim path');

  const plain = buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: '' });
  const plainSaver = inlineScriptBodies(plain).find((body) => body.includes('__LITHIC_WRITE_FILE__')) ?? '';
  assert.ok(plainSaver.includes('var shimToken = null;'), 'a plain mount should carry no secret');
  assert.ok(!plainSaver.includes('deadbeef'), 'a plain mount carried a secret it never had');
});

/**
 * The link bootstrap's own body, taken out of a built document the way a browser would run it.
 *
 * Running the emitted string rather than a copy of it is the point: the script lives in a template
 * literal, so this is what catches a stray escape before a mounted wiki is what finds it.
 */
function linkBootstrapBody(html: string): string {
  const body = inlineScriptBodies(html).find((script) => script.includes('__LITHIC_LINK_OPENER__'));
  assert.ok(body, 'the mount injects an external link bootstrap');
  return body;
}

/**
 * A window and a document just real enough to run that body and click in it: one listener slot, an
 * anchor to resolve, and each invoke recorded as the command and address the Rust side receives.
 *
 * `shape` is which tauri global the app build exposes, since the resolution chain is the one thing
 * here that a real webview and this harness cannot share.
 */
function mountLinkHarness(body: string, options: { shape?: 'v2' | 'v1' | 'bare' | 'none'; origin?: string } = {}) {
  const opened: Array<{ command: string; url: string }> = [];
  const invoke = (command: string, args: { url: string }) => {
    opened.push({ command, url: args.url });
    return Promise.resolve();
  };
  const shape = options.shape ?? 'v2';
  const tauri = shape === 'none' ? undefined : shape === 'v1' ? { tauri: { invoke } } : shape === 'bare' ? { invoke } : { core: { invoke } };
  const root: Record<string, unknown> = { location: { origin: options.origin ?? 'https://tauri.localhost' }, __TAURI__: tauri };
  const listeners: Array<(event: any) => void> = [];
  root.document = {
    addEventListener: (type: string, listener: (event: any) => void) => {
      if (type === 'click') listeners.push(listener);
    }
  };
  const run = () => new Function('window', 'document', body)(root, root.document);
  run();

  const click = (anchor: Record<string, unknown> | null, event: Record<string, unknown> = {}) => {
    let prevented = false;
    const target = anchor ? { closest: (selector: string) => (selector === 'a[href]' ? anchor : null) } : {};
    for (const listener of listeners) {
      listener({ button: 0, defaultPrevented: false, target, preventDefault: () => { prevented = true; }, ...event });
    }
    return prevented;
  };

  return { opened, click, listeners, run, root };
}

// The desktop webview has no second window, so an external link in a mounted wiki is a control that
// does nothing at all. The click has to be taken where the document is, which is inside the page the
// mount wrote, and handed to the machine instead.
test('a mounted wiki hands an external link to the machine, and only in the app', () => {
  const body = linkBootstrapBody(buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: '' }));

  const app = mountLinkHarness(body);
  assert.equal(
    app.click({ href: 'https://lithic.uk/notes', protocol: 'https:', origin: 'https://lithic.uk' }),
    true,
    'the click is claimed, so nothing waits on a window that will not open'
  );
  assert.deepEqual(app.opened, [{ command: 'open_external', url: 'https://lithic.uk/notes' }]);

  // Every global shape this bundle is loaded into has to resolve an invoke, v1 and bare included.
  for (const shape of ['v1', 'bare'] as const) {
    const other = mountLinkHarness(body, { shape });
    other.click({ href: 'http://example.test/a', protocol: 'http:', origin: 'http://example.test' });
    assert.deepEqual(other.opened, [{ command: 'open_external', url: 'http://example.test/a' }], `${shape} resolves an invoke`);
  }

  // A browser and a hosted instance have their own handling to keep, so nothing is touched there and
  // no listener is even left behind.
  const browser = mountLinkHarness(body, { shape: 'none' });
  assert.equal(browser.click({ href: 'https://lithic.uk/notes', protocol: 'https:', origin: 'https://lithic.uk' }), false);
  assert.deepEqual(browser.opened, []);
  assert.equal(browser.listeners.length, 0, 'nothing is registered where it could not be acted on');
});

test('the link bootstrap leaves every address it cannot open to the document', () => {
  const body = linkBootstrapBody(buildEngineHtml(ENGINE_STUB, { name: 'x.lith', text: '' }));
  const harness = mountLinkHarness(body);
  const offLimits = [
    { why: 'Rust opens no mailto', anchor: { href: 'mailto:someone@example.test', protocol: 'mailto:', origin: 'null' } },
    { why: 'a tiddler link is the wiki\'s own', anchor: { href: 'https://tauri.localhost/#Home', protocol: 'https:', origin: 'https://tauri.localhost' } },
    { why: 'a relative address stays in the page', anchor: { href: 'file:///C:/docs/other.html', protocol: 'file:', origin: 'null' } },
    { why: 'a local file is not a web address', anchor: { href: 'C:/docs/notes.lith', protocol: 'file:', origin: 'null' } }
  ];
  for (const { why, anchor } of offLimits) {
    assert.equal(harness.click(anchor), false, why);
  }
  assert.deepEqual(harness.opened, [], 'nothing off limits reached the machine');

  // And the clicks that are a page's own stay a page's own.
  const link = { href: 'https://lithic.uk/notes', protocol: 'https:', origin: 'https://lithic.uk' };
  assert.equal(harness.click(link, { defaultPrevented: true }), false, 'a click already handled is not claimed again');
  assert.equal(harness.click(link, { button: 1 }), false, 'a middle click belongs to the document');
  assert.equal(harness.click(null), false, 'a click on the page rather than on a link is nothing');
  assert.deepEqual(harness.opened, []);

  // A document that carries the bootstrap twice (an engine mount and a monolith injection in one
  // page) still registers one listener, so one click is one open.
  harness.run();
  assert.equal(harness.listeners.length, 1, 'the bootstrap arms once per document');
});

test('the link bootstrap precedes the boot script, and is injected once', () => {
  const engine = '<html><head></head><body><script src="/boot.js"></script></body></html>';
  const html = buildEngineHtml(engine, { name: 'x.lith', text: '' });
  const at = html.indexOf('__LITHIC_LINK_OPENER__');
  assert.ok(at >= 0 && at < html.indexOf('src="/boot.js"'), 'the bootstrap is in the document before boot');
  assert.equal(html.split('__LITHIC_LINK_OPENER__ = true;').length - 1, 1, 'and exactly once');
});

// A monolith rewrite is the same rewrite as an engine mount: the listeners registered on the old
// document go with it, so the bootstrap has to be in the page that replaces it.
test('an HTML monolith carries the link bootstrap as well', () => {
  let written = '';
  const globals = globalThis as unknown as { sessionStorage: unknown; document: unknown };
  const original = { sessionStorage: globals.sessionStorage, document: globals.document };
  globals.sessionStorage = { setItem: () => {}, getItem: () => null, removeItem: () => {} };
  globals.document = { open() {}, write(html: string) { written += html; }, close() {} };
  try {
    bootLegacyHtml('<html><head><title>page</title></head><body><a href="https://lithic.uk">l</a></body></html>', 'page.html', 'C:/docs/page.html');
  } finally {
    globals.sessionStorage = original.sessionStorage;
    globals.document = original.document;
  }
  assert.ok(written.includes('__LITHIC_LINK_OPENER__ = true;'), 'a monolith gets the same treatment as an engine');
});

test('a read-only remote mount claims no lock and installs no saver', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'my wiki.lith', text: '' }, [], {}, {
    remote: { ...REMOTE_TARGET, readOnly: true }
  });

  // No save target at all: it compiles down to the same inert `null` a local
  // file gets, so the remote saver is unreachable even by accident.
  assert.match(html, /var remote = null;/);
  assert.ok(!html.includes('__LITHIC_LINE_PATCH__ = { create: create'), 'read-only ships no diff runtime');
  assert.ok(!html.includes('window["__LITHIC_REMOTE_BASE__"] = '), 'no base text to diff against');
  assert.ok(!html.includes('window["__LITHIC_REMOTE_DIGEST__"] = '), 'no digest to send');
  // The custom saver is the only thing that writes back, so it is gated off.
  assert.match(html, /if \(!true\) \{\n      root\.\$tw\.customSaver = \{ save: save \};\n    \}/);
  // No lock-release tiddler either: this session holds nothing to release.
  assert.ok(
    !readStore(html).some((tiddler) => tiddler.title === '$:/lithic/startup/webdav-utils.js'),
    'read-only mounts do not inject the lock cleanup tiddler'
  );
  // The writable path is untouched.
  const writable = buildEngineHtml(ENGINE_STUB, { name: 'my wiki.lith', text: '' }, [], {}, { remote: REMOTE_TARGET });
  assert.match(writable, /if \(!false\) \{\n      root\.\$tw\.customSaver = \{ save: save \};\n    \}/);
});

test('self-host mounts inject the patch saver, base digest and lock release', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'my wiki.lith', text: '' }, [], {}, { remote: REMOTE_TARGET });

  // The diff engine ships with the document; the mounted wiki builds its own patch.
  assert.match(html, /__LITHIC_LINE_PATCH__ = \{ create: create/);
  // The base text and digest arrive as globals so a large wiki is not embedded twice.
  assert.match(html, /window\["__LITHIC_REMOTE_BASE__"\] = "title: Home/);
  assert.match(html, /window\["__LITHIC_REMOTE_DIGEST__"\] = "abc123digest";/);
  // Target identity: webdav base for the fallback PUT, api base for patches.
  assert.match(html, /var remote = \{"fileName":"my wiki\.lith","base":"\/sync\/","apiBase":"\/api\/lithic\/","api":true\}/);
  // The patch is the preferred path; the whole-file PUT stays the fallback.
  assert.match(html, /function saveRemote\(tw, callback\)/);
  assert.match(html, /function remotePut\(tw, lithText, jsonText, callback\)/);
  assert.match(html, /patchApi\.create\(baseText, lithText, remote\.fileName\)/);
  assert.match(html, /patchApi\.worthSending\(patch, lithText\)/);
  // A byte-identical wiki must send nothing at all.
  assert.match(html, /if \(patch === ''\) \{ callback\(null\); return; \}/);
  // The apply body frames the patch the way the CGI reads it.
  assert.match(html, /remote\.fileName \+ '\\n' \+ digest \+ '\\n' \+ patch/);
  // Remote saves still feed the local delta-based version history.
  assert.match(html, /saveSearchCache\(remote\.fileName, jsonText\)/);
  // Engine-side lock release, excluded from saves by the base filter.
  const titles = readStore(html).map((tiddler) => tiddler.title);
  assert.ok(titles.includes('$:/lithic/startup/webdav-utils.js'), 'webdav lock cleanup tiddler is injected');
});

test('non-self-host mounts keep the patch saver out of the document', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'wiki.lith', text: '' });
  assert.match(html, /var remote = null;/);
  assert.ok(!html.includes('__LITHIC_LINE_PATCH__ = { create: create'), 'no diff runtime for local files');
  // The remote saver is compiled in but gated behind the `remote` flag, so a
  // local mount always falls through to the file-handle / Tauri write path.
  assert.match(html, /if \(remote\) \{\n        saveRemote\(tw, callback\);\n        return true;\n      \}/);
  assert.ok(!readStore(html).some((tiddler) => tiddler.title === '$:/lithic/startup/webdav-utils.js'), 'no lock tiddler for local files');
});

test('instances without the patch API still mount, but save whole files', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'old.lith', text: '' }, [], {}, {
    remote: { ...REMOTE_TARGET, apiAvailable: false }
  });
  assert.match(html, /"api":false/);
  // The runtime is still injected (the branch is data-driven), and the guard
  // routes everything to the legacy whole-file PUT.
  assert.match(html, /if \(!remote\.api \|\| !patchApi \|\| !digest\) \{ remotePut\(tw, lithText, jsonText, callback\); return; \}/);
  assertInjectedScriptsParse(html, 'legacy self-host');
});

// The injected saver resolves its write target from sessionStorage, and the
// engine mount is what writes that entry. A monolith mount did not, so it
// adopted whatever handoff the previously mounted wiki had left behind and
// wrote this page over that file.
test('mounting an HTML monolith records its own file as the save target', () => {
  const store = new Map<string, string>([
    ['lithic-active-file', JSON.stringify({ name: 'previous.lith', path: 'C:/docs/previous.lith' })]
  ]);
  const globals = globalThis as unknown as { sessionStorage: unknown; document: unknown };
  const original = { sessionStorage: globals.sessionStorage, document: globals.document };
  globals.sessionStorage = {
    setItem: (key: string, value: string) => store.set(key, value),
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => store.delete(key)
  };
  globals.document = { open() {}, write() {}, close() {} };
  try {
    bootLegacyHtml('<html></html>', 'page.html', 'C:/docs/page.html');
  } finally {
    globals.sessionStorage = original.sessionStorage;
    globals.document = original.document;
  }
  assert.deepEqual(JSON.parse(store.get('lithic-active-file') ?? 'null'), {
    name: 'page.html',
    path: 'C:/docs/page.html'
  });
});

// The engine's own entry has to stay a pointer. The injected saver reads a name and a path from it
// and never the body, and it was handed the whole handoff, so the second write of the same mount
// spent a session store's few megabytes on a document too, and a 10 MB Lith died there as well.
// This is the leg that was missing when the recents mirror was fixed for the same 10 MB file.
test('the engine mount records the save target rather than the document', async () => {
  const store = new Map<string, string>();
  const engineStub = '<html><head></head><body><script class="tiddlywiki-tiddler-store" type="application/json">[]</script></body></html>';
  const globals = globalThis as any;
  const saved = {
    window: globals.window,
    localStorage: globals.localStorage,
    sessionStorage: globals.sessionStorage,
    fetch: globals.fetch,
    document: globals.document
  };
  globals.window = { location: { href: 'https://example.test/src/launcher.html' } };
  globals.localStorage = {
    getItem: (key: string) => (key === 'cachedOnlineCoreEngine' ? engineStub : null),
    setItem: () => {}
  };
  globals.sessionStorage = {
    // A session store's real behaviour in the one respect that matters here: it refuses what it
    // cannot hold.
    setItem: (key: string, value: string) => {
      if (value.length > 4 * 1024 * 1024) throw new Error('QuotaExceededError');
      store.set(key, value);
    },
    getItem: (key: string) => store.get(key) ?? null,
    removeItem: (key: string) => store.delete(key)
  };
  globals.fetch = async () => { throw new Error('network unavailable'); };
  globals.document = { open() {}, write() {}, close() {} };
  try {
    await bootLegacyWiki({
      name: 'huge.lith',
      path: 'C:/docs/huge.lith',
      text: 'x'.repeat(6 * 1024 * 1024)
    });
  } finally {
    if (saved.window !== undefined) globals.window = saved.window; else delete globals.window;
    if (saved.localStorage !== undefined) globals.localStorage = saved.localStorage; else delete globals.localStorage;
    if (saved.sessionStorage !== undefined) globals.sessionStorage = saved.sessionStorage; else delete globals.sessionStorage;
    if (saved.fetch !== undefined) globals.fetch = saved.fetch; else delete globals.fetch;
    if (saved.document !== undefined) globals.document = saved.document; else delete globals.document;
  }
  const pointer = store.get('lithic-active-file') ?? '';
  assert.deepEqual(JSON.parse(pointer || 'null'), { name: 'huge.lith', path: 'C:/docs/huge.lith' });
  assert.ok(pointer.length < 1024, `the entry is a pointer and not a document: ${pointer.length} bytes`);
});

// The launcher's own handoff key, which is what the reported failure named. It is bookkeeping (
// the engine boots from the page this launcher writes, not from this key) so a store that will
// not take it may not cost the mount. The teeth: with the write unguarded this throws, and the
// mount dies with `QuotaExceededError` under "Could not open …".
test('a handoff the session store refuses may not cost the mount', () => {
  const globals = globalThis as any;
  const saved = globals.sessionStorage;
  globals.sessionStorage = {
    setItem: () => { throw new Error('QuotaExceededError'); },
    getItem: () => null,
    removeItem: () => {}
  };
  try {
    assert.doesNotThrow(() =>
      writeHandoff({ name: 'huge.lith', path: 'C:/docs/huge.lith', text: 'x'.repeat(6 * 1024 * 1024) })
    );
  } finally {
    if (saved !== undefined) globals.sessionStorage = saved; else delete globals.sessionStorage;
  }
});

test('ipynb scratch mode injects the notebook runtime and parses notebook cells', () => {
  const notebook = JSON.stringify({
    cells: [
      { cell_type: 'markdown', metadata: {}, source: '# Notes' },
      { cell_type: 'code', execution_count: 1, metadata: {}, outputs: [], source: 'print(1)' }
    ],
    metadata: { language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5
  });
  const html = buildEngineHtml(ENGINE_STUB, { name: 'analysis.ipynb', text: notebook }, [], {}, { scratchMode: 'ipynb' });
  // The ES5 notebook serializer ships alongside the other scratch runtimes.
  assert.match(html, /__LITHIC_IPYNB_SERIALIZE__/);
  assert.match(html, /var scratchMode = "ipynb"/);
  assert.match(html, /__LITHIC_SCRATCH_ROOT__"\] = "analysis.ipynb"/);

  // Cells mount as a nodestream: markdown cell, fenced code cell, root.
  const store = readStore(html);
  const codeNode = store.find((tiddler) => (tiddler.text || '').startsWith('```python'));
  assert.ok(codeNode, 'code cell is fenced for the ephemeral coderunner');
  const root = store.find((tiddler) => tiddler.title === 'analysis.ipynb');
  assert.equal(root?.['lithic-ipynb'], 'yes');
  assert.ok(root?.['lithic-ipynb-meta'], 'root carries the notebook metadata for re-export');
});

test('browser-storage-only mounts save into IndexedDB instead of asking for a file', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'notes.lith', text: '' }, [], {}, { browserOnly: true });

  // The mode is compiled in, and the save path branches on it before it can
  // reach for a picker no platform in this mode has.
  assert.match(html, /var browserOnly = true;/);
  assert.match(html, /function saveToBrowserStorage\(tw, callback\)/);
  // A Lith still writes the tiddler JSON the search cache and the version chain are
  // built from; only a monolith has nothing that a tiddler store can hold.
  assert.match(html, /if \(browserOnly\) \{\n        var browserName = \(handle && handle\.name\) \|\| "notes\.lith";\n        if \(false \|\| prefersHtmlFor\(browserName\)\) \{\n          saveMonolithToBrowserStorage\(tw, _text, callback\);\n        \} else \{\n          saveToBrowserStorage\(tw, callback\);\n        \}\n        return true;\n      \}/);
  // The save writes the same two keys a real save writes: the flat cache the
  // recents row and search read, and the versioned history the download modal
  // materialises a hard copy from.
  assert.match(html, /function saveToBrowserStorage[\s\S]*addRecent\(target\)/);
  assert.match(html, /function saveToBrowserStorage[\s\S]*saveSearchCache\(fileName, jsonText\)/);
  // The name it keys all of that on is the mount's own, so a rename in the
  // launcher prompt carries through to the row that appears afterwards.
  assert.match(html, /function saveToBrowserStorage[\s\S]*\|\| "notes\.lith"/);
  // …and its recents row is recorded as having no file, which is what the
  // launcher marks as volatile instead of offering to re-open.
  assert.match(html, /__lithicBrowserOnly__\n\s+\? \{ handle: null, name: fileHandle\.name, tauriPath: null, browserOnly: true \}/);
});

// A monolith is a page rather than a tiddler store, so its browser-only save has two
// halves: the page text, which is what reopens it, onto its own recents row, and the
// page's tiddler store where every other mount records it, because tiddler JSON alone
// cannot rebuild a page that carries its own scripts, plugins and styles.
test('an HTML monolith in browser-only mode saves the page text into its own row', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'page.html', text: '' }, [], {}, { isHtmlMode: true, browserOnly: true });

  assert.match(html, /var browserOnly = true;/);
  // The monolith branch is chosen ahead of the tiddler-JSON saver, and before anything
  // can reach for a picker that this mode's platforms do not have.
  assert.match(html, /if \(browserOnly\) \{\n        var browserName = \(handle && handle\.name\) \|\| "page\.html";\n        if \(true \|\| prefersHtmlFor\(browserName\)\) \{\n          saveMonolithToBrowserStorage\(tw, _text, callback\);\n        \} else \{/);

  // What it writes first is the browser-only row the launcher reads back, with the page
  // text on the row itself, keyed on the mount's own name and laid over the row it replaces.
  const start = html.indexOf('function saveMonolithToBrowserStorage');
  const end = html.indexOf('var save = function(_text, _method, callback)');
  assert.ok(start >= 0 && end > start, 'the monolith saver is present');
  const saver = html.slice(start, end);
  assert.match(saver, /browserOnly: true, text: pageText/, 'the page text travels on the row');
  assert.match(saver, /\|\| "page\.html"/, 'keyed on the mount name rather than a leftover handoff');
  assert.match(saver, /!== fileName/, 'and written in place of the row it supersedes');
  // The second half is the one the file path already records for a monolith, so a
  // browser-only monolith stays findable by search and keeps its version chain.
  assert.match(saver, /saveSearchCache\(fileName, jsonText\)/, 'the tiddler store is still indexed');
  assert.doesNotMatch(saver, /dirty_state_/, 'but never writes an unsaved-edit backup');
  assertInjectedScriptsParse(html, 'monolith browser-only');
});

// A browser-only monolith has no picker anywhere in its future (Firefox and Safari ship
// none at all), so the mount has to carry the mode in with it.
test('a browser-only monolith mount compiles the browser-storage saver in', () => {
  let written = '';
  const globals = globalThis as unknown as { sessionStorage: unknown; document: unknown };
  const original = { sessionStorage: globals.sessionStorage, document: globals.document };
  globals.sessionStorage = { setItem: () => {}, getItem: () => null, removeItem: () => {} };
  globals.document = { open() {}, write(html: string) { written += html; }, close() {} };
  try {
    bootLegacyHtml('<html><head></head><body>page</body></html>', 'page.html', undefined, true);
  } finally {
    globals.sessionStorage = original.sessionStorage;
    globals.document = original.document;
  }
  assert.match(written, /var browserOnly = true;/);
  assert.match(written, /saveMonolithToBrowserStorage\(tw, _text, callback\)/);
});

// The bootstrap runs inside the mounted document, where the launcher's own `copy` module
// does not exist. A failure message read out of it throws a ReferenceError instead of
// reaching the user, so every one of them is baked in as a literal at build time.
test('injected failure copy is a literal the mounted document can read', () => {
  const scratch = buildEngineHtml(ENGINE_STUB, { name: 'notes.txt', text: '' }, [], {}, { scratchMode: 'text' });
  assert.doesNotMatch(scratch, /copy\.status\./, 'no launcher module reference survives into the mounted document');
  assert.match(scratch, /new Error\("Scratch serialization failed; file left unchanged\."\)/);
  const monolith = buildEngineHtml(ENGINE_STUB, { name: 'page.html', text: '' }, [], {}, { isHtmlMode: true, browserOnly: true });
  assert.match(monolith, /new Error\("Page serialization failed; the stored copy is unchanged\."\)/);
});

test('an ordinary mount does not get the browser-storage save path', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'notes.lith', text: '' });
  assert.match(html, /var browserOnly = false;/);
  assert.match(html, /return root\.showSaveFilePicker \? root\.showSaveFilePicker\(saveOptions\) : Promise\.reject/);
});

/** A store tiddler list, wrapped in the script tag the engine carries it in. */
function engineWithStore(tiddlers: Array<Record<string, string>>): string {
  return `<!doctype html><html><head></head><body><script class="tiddlywiki-tiddler-store" type="application/json">${JSON.stringify(tiddlers)}</script></body></html>`;
}

// The exclusions are read out of the base being mounted, which is what makes the launcher
// correct beside a base that is not Lithic: a base ships what it ships, and a hardcoded list
// either misses one (writing the base's own tiddlers into a user's file) or names one that is
// not there. Read from the same store the mount already splices into.
test('the plugin roots come out of the base own store', () => {
  const engine = engineWithStore([
    { title: '$:/plugins/acme/base-a', 'plugin-type': 'plugin' },
    { title: '$:/themes/acme/theme', 'plugin-type': 'plugin' },
    { title: '$:/plugins/acme/base-b', 'plugin-type': 'plugin' },
    { title: 'My Note', text: 'hello' },
    // A shadow a plugin bundles is escaped inside that plugin's own text field, so it is not
    // a root of its own; only the tiddler titled $:/plugins/... is.
    {
      title: '$:/plugins/acme/base-c',
      'plugin-type': 'plugin',
      text: '{"tiddlers":{"$:/plugins/acme/shadow":{}}}'
    }
  ]);
  assert.deepEqual(readEnginePluginRoots(engine), ['acme/base-a', 'acme/base-b', 'acme/base-c']);
});

test('a base with no readable store answers with no roots so the fallback stands', () => {
  assert.deepEqual(readEnginePluginRoots('<html><body>no store here</body></html>'), []);
  assert.deepEqual(
    readEnginePluginRoots(engineWithStore([]).replace('[]', 'not json')),
    [],
    'an unreadable store must not stop a mount'
  );
  assert.deepEqual(readEnginePluginRoots(engineWithStore([]).replace('[]', '{"title":"a"}')), []);
});

/**
 * Assemble and run the injected saver's filter builder against a stub wiki.
 *
 * The filter only exists at save time and is built inside the mounted document, so this
 * evaluates the shipped text rather than a port of it: the definitions are sliced off before
 * the parts that touch IndexedDB, and the one function under test is handed back out.
 */
function evaluateInjectedFilter(html: string, tiddlerTexts: Record<string, string>): () => string {
  const start = html.indexOf('(function(){\n    var root = window;');
  assert.ok(start >= 0, 'the injected saver bootstrap is present');
  const stop = html.indexOf('var idbKeyval', start);
  assert.ok(stop > start, 'the filter definitions come before the storage layer');
  const script = `${html.slice(start, stop)}    root.__TEST_FILTER__ = userTiddlerFilter;\n  })();`;

  const sandbox: Record<string, unknown> = {};
  sandbox.window = sandbox;
  sandbox.$tw = {
    wiki: {
      getTiddlerText: (title: string, fallback = '') => tiddlerTexts[title] ?? fallback
    }
  };
  vm.runInNewContext(script, sandbox);
  return sandbox.__TEST_FILTER__ as () => string;
}

test('the injected saver builds its filter from the base it is in', () => {
  const engine = engineWithStore([
    { title: '$:/plugins/acme/base-a', 'plugin-type': 'plugin' },
    { title: '$:/plugins/acme/base-b', 'plugin-type': 'plugin' }
  ]);
  const html = buildEngineHtml(engine, { name: 'notes.lith', text: '' });

  const filter = evaluateInjectedFilter(html, {
    '$:/lithic/config/PublishFilterPatch':
      '\\define publishFilter()\r\n-[prefix[$:/acme/private/]]\r\n\\end'
  })();

  assert.ok(filter.includes('-[[$:/plugins/acme/base-a]]'), 'the base plugins are excluded');
  assert.ok(filter.includes('-[[$:/plugins/acme/base-b]]'));
  assert.ok(
    !filter.includes('-[[$:/plugins/sq/streams]]'),
    'the committed fallback is not consulted when the base answers'
  );
  assert.ok(
    filter.includes('-[prefix[$:/acme/private/]]'),
    'the base own declaration reaches the filter it is saved through'
  );
});

test('a mount that declares nothing but a store still excludes that store', () => {
  const engine = engineWithStore([{ title: '$:/plugins/acme/base-a', 'plugin-type': 'plugin' }]);
  const filter = evaluateInjectedFilter(buildEngineHtml(engine, { name: 'notes.lith', text: '' }), {})();
  assert.ok(filter.includes('-[[$:/plugins/acme/base-a]]'));
  assert.ok(!filter.includes('-[prefix[$:/acme/private/]]'), 'no declaration appends nothing');
});

test('a mount into a base with no store falls back to the list the build carries', () => {
  const filter = evaluateInjectedFilter(buildEngineHtml(ENGINE_STUB, { name: 'notes.lith', text: '' }), {})();
  assert.ok(filter.includes('-[[$:/plugins/sq/streams]]'), 'the committed list is the floor');
  assert.ok(!filter.includes('-[[$:/plugins/acme/base-a]]'));
});
