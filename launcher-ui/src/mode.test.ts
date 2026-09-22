import assert from 'node:assert/strict';
import test from 'node:test';
import {
  hostedInApp,
  launcherReturn,
  resolveMode,
  servedByApp,
  tauriApiAvailable,
  withLauncherHandoff
} from './mode.ts';

function location(url: string): Location {
  return new URL(url) as unknown as Location;
}

/** A document that does (or does not) declare itself a Lithic instance. */
function doc(declares: boolean): Pick<Document, 'querySelector'> {
  return {
    querySelector: (selector: string) => (declares && selector.includes('lithic-webdav') ? ({} as Element) : null)
  };
}

test('query parameter forces each supported mode', () => {
  assert.equal(resolveMode(location('https://lithic.uk/?mode=webapp')), 'webapp');
  assert.equal(resolveMode(location('https://lithic.uk/?mode=tauri')), 'tauri');
  assert.equal(resolveMode(location('https://lithic.uk/?mode=self-host')), 'self-host');
});

test('query parameter matching is case insensitive', () => {
  assert.equal(resolveMode(location('https://lithic.uk/?launcher-mode=SELF-HOST')), 'self-host');
});

test('invalid query values fall back to environment detection', () => {
  assert.equal(resolveMode(location('https://lithic.uk/?mode=invalid')), 'webapp');
  assert.equal(resolveMode(location('http://localhost/?mode=invalid')), 'self-host');
  assert.equal(resolveMode(location('https://example.local/?mode=invalid')), 'self-host');
});

test('sync paths resolve to self-host mode', () => {
  assert.equal(resolveMode(location('https://example.com/sync/wiki')), 'self-host');
});

test('only the app’s own document is the app', () => {
  assert.equal(resolveMode(location('https://tauri.localhost/'), doc(false), { __TAURI__: {} }), 'tauri');
  assert.equal(resolveMode(location('tauri://localhost/'), doc(false), { __TAURI__: {} }), 'tauri');
});

test('the injected global alone does not make an instance’s page the app', () => {
  // The regression this exists for: the app injects __TAURI__ into every
  // document its window loads, so a bookmarked instance used to claim `tauri`
  // and take every local-only path built on it.
  const host = { __TAURI__: {} };
  assert.equal(resolveMode(location('https://personal.example.uk/'), doc(false), host), 'webapp');
  assert.equal(resolveMode(location('https://personal.example.uk/'), doc(true), host), 'self-host');
  assert.equal(resolveMode(location('https://personal.example.uk/sync/'), doc(false), host), 'self-host');
  // In a plain browser nothing changes: no global, so self-host is a declaration.
  assert.equal(resolveMode(location('https://personal.example.uk/'), doc(false), undefined), 'webapp');
  assert.equal(resolveMode(location('https://personal.example.uk/'), doc(true), undefined), 'self-host');
});

test('an explicit declaration outranks an accidental hostname match', () => {
  // localhost is an instance by default, but a page can still say otherwise.
  assert.equal(resolveMode(location('http://localhost:8080/'), doc(false), undefined), 'self-host');
  assert.equal(resolveMode(location('http://localhost:8080/?mode=webapp'), doc(false), undefined), 'webapp');
});

test('servedByApp is about the document, not the API', () => {
  assert.equal(servedByApp(location('https://tauri.localhost/')), true);
  assert.equal(servedByApp(location('tauri://localhost/index.html')), true);
  assert.equal(servedByApp(location('https://personal.example.uk/')), false);
  assert.equal(tauriApiAvailable({ __TAURI__: {} }), true);
  assert.equal(tauriApiAvailable({}), false);
  assert.equal(tauriApiAvailable(undefined), false);
});

test('hosted in the app means the app is behind the window but not serving it', () => {
  assert.equal(hostedInApp(location('https://personal.example.uk/'), { __TAURI__: {} }), true);
  assert.equal(hostedInApp(location('https://tauri.localhost/'), { __TAURI__: {} }), false);
  assert.equal(hostedInApp(location('https://personal.example.uk/'), undefined), false);
});

test('the handoff declares the instance and carries the way back', () => {
  const marked = withLauncherHandoff('https://personal.example.uk', 'https://tauri.localhost/');
  assert.equal(marked, 'https://personal.example.uk/?lithic-from=https%3A%2F%2Ftauri.localhost%2F&mode=self-host');
  // Round trip: what the launcher writes is what the arriving page reads.
  assert.equal(resolveMode(location(marked), doc(false), { __TAURI__: {} }), 'self-host');
  assert.deepEqual(launcherReturn(location(marked), { __TAURI__: {} }), {
    kind: 'url',
    url: 'https://tauri.localhost/'
  });
});

test('the handoff keeps the address it was given and survives junk', () => {
  assert.equal(
    withLauncherHandoff('https://example.uk/wiki?x=1#top', 'tauri://localhost/'),
    'https://example.uk/wiki?x=1&lithic-from=tauri%3A%2F%2Flocalhost%2F&mode=self-host#top'
  );
  assert.equal(withLauncherHandoff('not a url', 'https://tauri.localhost/'), 'not a url');
});

/** The session store as the launcher uses it: a string map with the same surface. */
function store(): Pick<Storage, 'getItem' | 'setItem'> {
  const values = new Map<string, string>();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => void values.set(key, value) };
}

test('a way back exists only where there is somewhere to go back to', () => {
  // Opened from a launcher that named itself.
  assert.deepEqual(
    launcherReturn(location('https://example.uk/?lithic-from=https://tauri.localhost/'), undefined, store()),
    { kind: 'url', url: 'https://tauri.localhost/' }
  );
  // In the app with no marker: the window's history still holds the launcher.
  assert.deepEqual(launcherReturn(location('https://example.uk/'), { __TAURI__: {} }, store()), {
    kind: 'history'
  });
  // A plain browser on a non-instance page has no launcher to return to.
  assert.equal(launcherReturn(location('https://example.uk/'), undefined, store()), null);
  // Unreadable or foreign markers are no marker (javascript: is the one that matters).
  assert.deepEqual(
    launcherReturn(location('https://example.uk/?lithic-from=javascript:alert(1)'), { __TAURI__: {} }, store()),
    { kind: 'history' }
  );
  assert.equal(launcherReturn(location('https://example.uk/?lithic-from=%20'), undefined, store()), null);
  // Blocked storage is not a failure: the marker itself still answers.
  assert.deepEqual(
    launcherReturn(location('https://example.uk/?lithic-from=https://tauri.localhost/'), undefined, null),
    { kind: 'url', url: 'https://tauri.localhost/' }
  );
});

test('the way back outlives the instance’s own links', () => {
  const session = store();
  // The handoff lands on the instance's own page and records the address…
  launcherReturn(location('https://example.uk/?lithic-from=https://tauri.localhost/'), undefined, session);
  // …so the next page of the same instance, whose link carried no marker, can
  // still offer it.
  assert.deepEqual(launcherReturn(location('https://example.uk/wiki/index.html'), undefined, session), {
    kind: 'url',
    url: 'https://tauri.localhost/'
  });
  // A different window (fresh storage) is back to knowing nothing.
  assert.equal(launcherReturn(location('https://example.uk/wiki/index.html'), undefined, store()), null);
});

test('a remembered address is validated like a handed-over one', () => {
  const poisoned = {
    getItem: () => 'javascript:alert(1)',
    setItem: () => {}
  };
  assert.equal(launcherReturn(location('https://example.uk/'), undefined, poisoned), null);
  assert.equal(launcherReturn(location('https://example.uk/'), { __TAURI__: {} }, poisoned)?.kind, 'history');
});
