import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMOJI_LIST,
  ICON_TARGETS,
  ICON_DOORBELL,
  ICON_SETTING,
  INSTANCE_EMOJI_KEY,
  uploadInstanceIcon,
  clearInstanceIcon,
  readServerEmoji,
  writeServerEmoji,
  deleteServerEmoji,
  emojiFaviconUrl,
  INSTANCE_MARK_FILE,
  instanceMarkUrl,
  applyFavicon,
  readInstanceEmoji,
  saveInstanceEmoji,
  clearInstanceEmoji,
  type CanvasLike
} from './instance-icon.ts';

/** Records what was drawn so the geometry can be asserted. */
function fakeCanvasFactory() {
  const drawn: Array<{ size: number; emoji: string; font: string; background: string }> = [];
  const factory = (size: number): CanvasLike => ({
    width: size,
    height: size,
    getContext: () => ({
      fillStyle: '',
      font: '',
      textAlign: '',
      textBaseline: '',
      fillRect() {},
      fillText(text: string, _x: number, _y: number) {
        const last = drawn[drawn.length - 1];
        if (last) last.emoji = text;
      }
    }),
    toBlob(callback) {
      callback(new Blob([`icon-${size}`], { type: 'image/png' }));
    },
    toDataURL: () => `data:image/png;base64,size-${size}`
  });
  // Wrap so each created canvas is registered before anything is drawn on it.
  return {
    drawn,
    factory: ((size: number) => {
      drawn.push({ size, emoji: '', font: '', background: '' });
      const canvas = factory(size);
      const context = canvas.getContext('2d');
      if (context) {
        const originalFillText = context.fillText;
        const originalFillRect = context.fillRect;
        context.fillRect = () => originalFillRect.call(context, 0, 0, 0, 0);
        context.fillText = (text: string, x: number, y: number) =>
          originalFillText.call(context, text, x, y);
      }
      return canvas;
    }) as (size: number) => CanvasLike
  };
}

type Call = { url: string; method: string; body?: unknown; contentType?: string };

function recordingFetcher(failAt: number | null = null) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body,
      contentType: (init?.headers as Record<string, string> | undefined)?.['Content-Type']
    });
    if (failAt !== null && calls.length === failAt) return new Response('nope', { status: 500 });
    // 200 rather than 204: a null-body status cannot carry a body, and the
    // module accepts 200/201/204 identically.
    return new Response('', { status: 200 });
  };
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}

/** A fetcher that answers from a handler, recording what it was asked. */
function respondingFetcher(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body,
      contentType: (init?.headers as Record<string, string> | undefined)?.['Content-Type']
    });
    return handler(url, init);
  };
  return { calls, fetcher: fetcher as unknown as typeof fetch };
}

function storage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
    clear: () => data.clear(),
    key: (index: number) => [...data.keys()][index] ?? null,
    get length() { return data.size; }
  } as unknown as Storage;
}

test('the icon doorbell is written last — the watcher depends on it', () => {
  assert.equal(ICON_TARGETS[ICON_TARGETS.length - 1].path, ICON_DOORBELL);
  assert.equal(ICON_TARGETS.filter((target) => target.path === ICON_DOORBELL).length, 1);
  const paths = ICON_TARGETS.map((target) => target.path);
  assert.equal(new Set(paths).size, paths.length);
  // The legacy sizes are what the deployment's <link rel="icon"> tags expect.
  assert.deepEqual(
    ICON_TARGETS.map((target) => target.size),
    [16, 32, 32, 150, 192, 180, 512, 512]
  );
});

test('uploadInstanceIcon PUTs every pre-sized icon in order', async () => {
  const { calls, fetcher } = recordingFetcher();
  const { drawn, factory } = fakeCanvasFactory();
  const progress: number[] = [];
  const result = await uploadInstanceIcon('🎨', {
    fetcher,
    createCanvas: factory,
    onProgress: (saved) => progress.push(saved)
  });

  const sizes = ICON_TARGETS.filter((target) => target.path !== ICON_DOORBELL);
  assert.deepEqual(result, { ok: true, saved: ICON_TARGETS.length + 1, total: ICON_TARGETS.length + 1 });
  assert.equal(calls.length, ICON_TARGETS.length + 1);
  assert.deepEqual(
    calls.map((call) => call.url),
    [...sizes.map((target) => `/sync/${target.path}`), `/sync/${ICON_SETTING}`, `/sync/${ICON_DOORBELL}`]
  );
  assert.ok(calls.every((call) => call.method === 'PUT'));
  assert.ok(
    calls.filter((call) => call.url !== `/sync/${ICON_SETTING}`).every((call) => call.contentType === 'image/png')
  );
  // The doorbell still closes the run, and the choice is written immediately before it:
  // the setting is never allowed to describe renders that did not land, and the deployment
  // is never told to apply a set whose setting is missing.
  assert.equal(calls[calls.length - 1].url, '/sync/custom.ico');
  const setting = calls[calls.length - 2];
  assert.equal(setting.url, `/sync/${ICON_SETTING}`);
  assert.match(setting.contentType ?? '', /^text\/plain/);
  assert.equal(setting.body, '🎨', 'one line of plain text: the character, and nothing around it');
  // Every size is rendered from the same emoji.
  assert.deepEqual(drawn.map((entry) => entry.size), ICON_TARGETS.map((target) => target.size));
  assert.ok(drawn.every((entry) => entry.emoji === '🎨'));
  assert.deepEqual(progress, [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('a refused choice stops the run before the doorbell fires', async () => {
  // The setting is the eighth write: seven renders, then the choice, then the doorbell.
  const { calls, fetcher } = recordingFetcher(ICON_TARGETS.length);
  const { factory } = fakeCanvasFactory();
  const result = await uploadInstanceIcon('🌿', { fetcher, createCanvas: factory });

  assert.equal(result.ok, false);
  assert.equal(result.saved, ICON_TARGETS.length - 1);
  assert.match(result.error ?? '', /favicon\.conf failed/);
  assert.ok(!calls.some((call) => call.url.endsWith(ICON_DOORBELL)));
});

test('a failed write stops the run before the doorbell fires', async () => {
  const { calls, fetcher } = recordingFetcher(3);
  const { factory } = fakeCanvasFactory();
  const result = await uploadInstanceIcon('🔥', { fetcher, createCanvas: factory });

  assert.equal(result.ok, false);
  assert.equal(result.saved, 2);
  assert.match(result.error ?? '', /favicon\.ico → 500/);
  // No doorbell write, so the watcher never copies a half-updated set.
  assert.equal(calls.length, 3);
  assert.ok(!calls.some((call) => call.url.endsWith(ICON_DOORBELL)));
});

test('uploadInstanceIcon reports a DOM-less environment instead of claiming success', async () => {
  const { calls, fetcher } = recordingFetcher();
  const result = await uploadInstanceIcon('🔥', { fetcher, createCanvas: () => null });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

test('clearInstanceIcon forgets the choice, then deletes the doorbell', async () => {
  const { calls, fetcher } = recordingFetcher();
  assert.equal(await clearInstanceIcon({ fetcher }), true);
  assert.deepEqual(calls, [
    { url: `/sync/${ICON_SETTING}`, method: 'DELETE', body: undefined, contentType: undefined },
    { url: '/sync/custom.ico', method: 'DELETE', body: undefined, contentType: undefined }
  ]);

  const broken = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
  assert.equal(await clearInstanceIcon({ fetcher: broken }), false);

  // A store that never held the choice is already in the state being asked for, so the
  // reset is not reported as a failure just because there was nothing to delete.
  const absent = respondingFetcher(async (url) =>
    url === `/sync/${ICON_SETTING}` ? new Response(null, { status: 404 }) : new Response('', { status: 200 })
  );
  assert.equal(await clearInstanceIcon({ fetcher: absent.fetcher }), true);
});

test('readServerEmoji tells "no icon" apart from "cannot ask"', async () => {
  const stored = respondingFetcher(() => new Response('🌿\n', { status: 200 }));
  assert.equal(await readServerEmoji({ fetcher: stored.fetcher }), '🌿', 'the file is read as the character it holds, newline and all');
  assert.deepEqual(stored.calls, [
    { url: `/sync/${ICON_SETTING}`, method: 'GET', body: undefined, contentType: undefined }
  ]);

  const empty = respondingFetcher(() => new Response(null, { status: 404 }));
  assert.equal(await readServerEmoji({ fetcher: empty.fetcher }), '', 'a store with no choice answers "no icon"');

  const blank = respondingFetcher(() => new Response('   \n', { status: 200 }));
  assert.equal(await readServerEmoji({ fetcher: blank.fetcher }), '', 'and so does a file with nothing in it');

  const refused = respondingFetcher(() => new Response('nope', { status: 500 }));
  assert.equal(await readServerEmoji({ fetcher: refused.fetcher }), null, 'a server that refuses the read has not answered');

  const offline = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  assert.equal(await readServerEmoji({ fetcher: offline }), null, 'and neither has one that cannot be reached');
});

test('the choice round-trips through the store', async () => {
  const { calls, fetcher } = recordingFetcher();
  assert.equal(await writeServerEmoji('🎨', { fetcher }), true);
  assert.deepEqual(calls, [
    {
      url: `/sync/${ICON_SETTING}`,
      method: 'PUT',
      body: '🎨',
      contentType: 'text/plain; charset=utf-8'
    }
  ]);
  const refused = respondingFetcher(() => new Response('nope', { status: 500 }));
  assert.equal(await writeServerEmoji('🎨', { fetcher: refused.fetcher }), false);
  assert.equal(await deleteServerEmoji({ fetcher }), true);
  assert.equal(calls[calls.length - 1].method, 'DELETE');
  const offline = (async () => {
    throw new Error('offline');
  }) as unknown as typeof fetch;
  assert.equal(await deleteServerEmoji({ fetcher: offline }), false);
});

test('the emoji choice round-trips through storage', () => {
  const store = storage();
  assert.equal(readInstanceEmoji(store), '');
  saveInstanceEmoji('🌿', store);
  assert.equal(store.getItem(INSTANCE_EMOJI_KEY), '🌿');
  assert.equal(readInstanceEmoji(store), '🌿');
  clearInstanceEmoji(store);
  assert.equal(readInstanceEmoji(store), '');
});

test('emojiFaviconUrl renders a 32px data URL and survives a hostile canvas', () => {
  const { factory } = fakeCanvasFactory();
  assert.equal(emojiFaviconUrl('📚', 32, factory), 'data:image/png;base64,size-32');
  assert.equal(emojiFaviconUrl('📚', 32, () => null), null);
  const throwing = (() => {
    throw new Error('canvas unavailable');
  }) as unknown as (size: number) => CanvasLike;
  assert.equal(emojiFaviconUrl('📚', 32, throwing), null);
});

test('applyFavicon creates the icon link and can restore the shipped one', () => {
  const appended: FakeLink[] = [];
  let existing: FakeLink | null = null;
  class FakeLink {
    rel = '';
    href = '';
    type: string | undefined = undefined;
    removed: string[] = [];
    removeAttribute(name: string) {
      this.removed.push(name);
      if (name === 'type') this.type = undefined;
    }
  }
  const doc = {
    querySelector: () => existing,
    createElement: () => new FakeLink(),
    head: { appendChild: (node: FakeLink) => appended.push(node) }
  } as unknown as Document;

  applyFavicon('data:image/png;base64,aaa', doc);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].rel, 'icon');
  assert.equal(appended[0].href, 'data:image/png;base64,aaa');
  assert.equal(appended[0].type, 'image/png');

  // An existing icon link is reused rather than duplicated.
  existing = new FakeLink();
  existing.rel = 'icon';
  applyFavicon('data:image/png;base64,bbb', doc);
  assert.equal(appended.length, 1);
  assert.equal(existing.href, 'data:image/png;base64,bbb');

  applyFavicon(null, doc);
  assert.equal(existing.href, '/favicon.ico');
  assert.deepEqual(existing.removed, ['type']);
});

test('instanceMarkUrl names the instance\'s own file, and null when there is no instance', () => {
  // The address is the file the picker publishes, read from the root of the page's own
  // origin: the instance's mark, not this build's.
  assert.equal(instanceMarkUrl({ protocol: 'https:' }), INSTANCE_MARK_FILE);
  assert.equal(instanceMarkUrl({ protocol: 'http:' }), '/mstile-150x150.png');
  assert.ok(ICON_TARGETS.some((target) => `/${target.path}` === INSTANCE_MARK_FILE), 'and it is one of the renders the set writes');
  // A page with no instance behind it has no root to read that from, and the caller draws
  // the shipped mark instead — which is what the desktop app and every file:// copy get.
  assert.equal(instanceMarkUrl({ protocol: 'file:' }), null);
  assert.equal(instanceMarkUrl({ protocol: 'tauri:' }), null);
  assert.equal(instanceMarkUrl(null), null);
  assert.equal(instanceMarkUrl(undefined), null, 'and a context with no location at all asks nobody');
});

test('the emoji shortlist matches the legacy picker categories', () => {
  assert.ok(EMOJI_LIST.length > 100);
  assert.ok(EMOJI_LIST.includes('🎨'));
  assert.equal(new Set(EMOJI_LIST).size, EMOJI_LIST.length);
  assert.ok(EMOJI_LIST.every((emoji) => emoji.length > 0));
});
