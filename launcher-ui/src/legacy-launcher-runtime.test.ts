import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEngineCandidates, bootLegacyHtml, bootLegacyWiki, buildEngineHtml } from './legacy-launcher-runtime.ts';

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
// blank page with no error form — the whole mount was lost to one stray
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
  // Minimal engine stub — just needs to be valid HTML so injectTiddlers and
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
  // Anchor on the NEXT `var lithText` — the saver emits one earlier, inside
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
    buildEngineHtml(ENGINE_STUB, { name: 'my wiki.lith', text: '' }, [], {}, { remote: REMOTE_TARGET }),
    'self-host remote'
  );
  assertInjectedScriptsParse(
    buildEngineHtml(ENGINE_STUB, { name: 'my wiki.lith', text: '' }, [], {}, { remote: { ...REMOTE_TARGET, readOnly: true } }),
    'self-host remote read-only'
  );
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
  assert.match(html, /if \(browserOnly\) \{\n        saveToBrowserStorage\(tw, callback\);\n        return true;\n      \}/);
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

test('an ordinary mount does not get the browser-storage save path', () => {
  const html = buildEngineHtml(ENGINE_STUB, { name: 'notes.lith', text: '' });
  assert.match(html, /var browserOnly = false;/);
  assert.match(html, /return root\.showSaveFilePicker \? root\.showSaveFilePicker\(saveOptions\) : Promise\.reject/);
});
