import { copy } from './copy.ts';
import { parseLithToJSON } from './lithic-format.ts';
import { resolveScratchKind, resolveScratchPlan, parseScratchSource, parseTidFile } from './scratch-editor.ts';
import { tagRootDogear } from './pending-imports.ts';
import { JSON_PATCH_RUNTIME } from './json-patch.ts';
import { DEFAULT_PLUGINS, LITHIC_BASE_FILTER } from './legacy-saver.ts';
import { SCRATCH_SERIALIZE_RUNTIME } from './scratch-wiki.ts';
import { TID_SERIALIZE_RUNTIME } from './tid-serialize-runtime.ts';
import { IPYNB_SERIALIZE_RUNTIME } from './ipynb.ts';
import { LINE_PATCH_RUNTIME } from './line-patch.ts';
import { LITHIC_API_BASE, WEBDAV_BASE, WEBDAV_UTILS_JS } from './webdav.ts';
import { SHIM_COMMAND_PATH, SHIM_TOKEN_HEADER } from './shim-command.ts';

/** Scratch save behavior for the mounted engine's injected saver. */
export type ScratchMode = 'off' | 'text' | 'tid' | 'json' | 'ipynb';

/**
 * A self-host wiki opened over the patch API. `baseText`/`digest` are the exact
 * text and `git hash-object` digest the launcher loaded, so the injected saver
 * can diff against that base and the server can refuse a stale patch.
 * `apiAvailable` is false on instances without the patch API (older deployments,
 * or a plain WebDAV target), where every save is a whole-file PUT.
 */
export type RemoteTarget = {
  fileName: string;
  baseText: string;
  digest: string;
  apiAvailable: boolean;
  /**
   * Open without claiming the lock or installing a saver. The legacy
   * "Active Session Detected → Open Read-Only" path, used when someone else's
   * lock is still live and this session must not write over their copy.
   */
  readOnly?: boolean;
};

export type LauncherHandoff = {
  name: string;
  path?: string;
  text: string;
  /** Pre-parsed tiddlers to inject (used when the payload was already parsed by the UI). */
  payloadTiddlers?: Array<Record<string, string>>;
};

const HANDOFF_KEY = 'lithic-launcher-file';
const ACTIVE_FILE_KEY = 'lithic-active-file';
const ONLINE_ENGINE_URL = 'https://lithic.uk/src/lithic.html';
const CACHED_ENGINE_KEY = 'cachedOnlineCoreEngine';

export function resolveEngineCandidates(href: string): string[] {
  const location = new URL(href);
  const base = new URL('.', location.href);
  return [
    // The engine ships beside the launcher, so this covers both the repo
    // layout (src/launcher.html + src/lithic.html) and a deployed instance
    // (/src/launcher.html + /src/lithic.html) with no extra copies.
    new URL('lithic.html', base).href,
    new URL('src/lithic.html', base).href,
    location.origin === 'null' ? 'file:///lithic.html' : new URL('/lithic.html', location.origin).href,
    location.origin === 'null' ? 'file:///src/lithic.html' : new URL('/src/lithic.html', location.origin).href
  ];
}

async function fetchEngine(): Promise<string> {
  const candidates = resolveEngineCandidates(window.location.href).map((href) => new URL(href));

  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.href);
      if (response.ok) return response.text();
    } catch {
      // Try the next deployment-relative path.
    }
  }

  // Prefer a previously downloaded engine so local launches remain stable and
  // do not unexpectedly switch to a newer online build.
  try {
    const cached = localStorage.getItem(CACHED_ENGINE_KEY);
    if (cached) return cached;
  } catch {
    // Storage may be unavailable in restricted browser contexts.
  }

  // Local file launches commonly reject all file:// fetches as a null-origin
  // CORS violation. Only use the canonical online engine as the last resort.
  try {
    const response = await fetch(ONLINE_ENGINE_URL);
    if (response.ok) {
      const text = await response.text();
      try { localStorage.setItem(CACHED_ENGINE_KEY, text); } catch { /* storage may be unavailable */ }
      return text;
    }
  } catch {
    // Report the actionable error below.
  }

  throw new Error(copy.status.engineMissing);
}

function injectTiddlers(html: string, tiddlers: Array<Record<string, string>>): string {
  const script = `<script class="tiddlywiki-tiddler-store" type="application/json">${JSON.stringify(tiddlers)}</script>`;
  const store = /(<script class="tiddlywiki-tiddler-store" type="application\/json">\[)([\s\S]*?)(\]\s*<\/script>)/i;
  if (store.test(html)) {
    return html.replace(store, (_, start, existing, end) => `${start}${existing.trim() ? `${existing},` : ''}${JSON.stringify(tiddlers).slice(1, -1)}${end}`);
  }
  // A TiddlyWiki store must be available before the boot scripts execute.
  // Insert immediately before the first boot script, falling back to body.
  const firstBootScript = html.search(/<script[^>]+(?:src=["'][^"']*boot[^"']*["']|data-tiddler-title=["']\$:\/boot\/)/i);
  if (firstBootScript >= 0) {
    const tag = html.lastIndexOf('<script', firstBootScript);
    return `${html.slice(0, tag)}${script}\n${html.slice(tag)}`;
  }
  return html.replace(/<\/body>/i, `${script}</body>`);
}

/**
 * How one mount saves: which save target the injected saver is given.
 *
 * `browserOnly` is the index-db-only fallback (browser-storage.ts): the
 * platform has no File System Access API, so nothing this mount produces can
 * ever be written to a file, and the cached copy in IndexedDB *is* the save.
 */
export type MountSaveOptions = {
  isHtmlMode?: boolean;
  driftedFromHead?: boolean;
  scratchMode?: ScratchMode;
  remote?: RemoteTarget | null;
  browserOnly?: boolean;
  /**
   * The per-launch secret of a shim that served the launcher, or null elsewhere. It is baked
   * into the injected saver as a literal, because the mounted document replaces the one that
   * carried the meta tag, and it is what lets a save write back through the shim's wire.
   */
  shimToken?: string | null;
};

function injectSaverBootstrap(
  html: string,
  suggestedFileName?: string,
  isHtmlMode = false,
  driftedFromHead = false,
  scratchMode: ScratchMode = 'off',
  remote: RemoteTarget | null = null,
  browserOnly = false,
  shimToken: string | null = null
): string {
  const pluginsJson = JSON.stringify(DEFAULT_PLUGINS);
  const jsonPatchRuntime = JSON_PATCH_RUNTIME;
  const baseFilterStr = JSON.stringify(LITHIC_BASE_FILTER);
  // The name chosen in the launcher prompt becomes the picker's suggested
  // filename. Escape "<" so a hostile name cannot break out of the script tag.
  const suggestedNameJson = JSON.stringify(suggestedFileName || 'new.lith').replace(/</g, '\\u003c');
  // The active file name keys the transient dirty-state backup in IndexedDB.
  // An HTML monolith leaves it empty and opts out: a page may carry its own
  // recovery through add-ons or plugins, and the launcher must not interpose on
  // what the page does with its own edits. Searchable history is unaffected.
  // the save path records that for monoliths too, from what actually lands.
  const activeFileNameJson = isHtmlMode ? '""' : JSON.stringify(suggestedFileName || 'new.lith').replace(/</g, '\\u003c');
  const saveTypes = isHtmlMode
    ? [{ description: copy.fileTypes.html, accept: { 'text/html': ['.html', '.htm'] } }]
    : [{ description: copy.fileTypes.monolith, accept: { 'application/x-lith': ['.lith'] } }, { description: copy.fileTypes.notebookOne, accept: { 'application/x-ipynb+json': ['.ipynb'] } }];
  const saveTypesJson = JSON.stringify(saveTypes);
  const htmlModeLiteral = isHtmlMode ? 'true' : 'false';
  const driftedFromHeadLiteral = driftedFromHead ? 'true' : 'false';
  const browserOnlyLiteral = browserOnly ? 'true' : 'false';
  // The shim's wire and its secret, baked in as literals: the saver runs inside the mounted
  // document, which cannot read the launcher's meta tag because document.write replaced it.
  const shimTokenLiteral = JSON.stringify(shimToken ?? null);
  const shimCommandPathJson = JSON.stringify(SHIM_COMMAND_PATH);
  const shimTokenHeaderJson = JSON.stringify(SHIM_TOKEN_HEADER);
  const scratchModeJson = JSON.stringify(scratchMode);
  // Self-host: the saver talks to the same-origin save API instead of a file
  // handle. Only the target identity is baked in here; the base text and digest
  // arrive as engine globals so a large wiki is not embedded twice.
  // A read-only mount carries no save target at all: it never writes, so the
  // whole remote saver compiles down to the same inert `null` a local file gets.
  const writableRemote = remote && !remote.readOnly ? remote : null;
  const remoteJson = writableRemote
    ? JSON.stringify({ fileName: writableRemote.fileName, base: WEBDAV_BASE, apiBase: LITHIC_API_BASE, api: writableRemote.apiAvailable })
    : 'null';

  // The patch runtime is injected as its own script so the mounted wiki can
  // record per-version history (window.__LITHIC_JSON_PATCH__) from the saver.
  // Scratch mode additionally injects the flat-text serializers (ES5 strings
  // mirroring scratch-wiki.ts) used by the in-place fancy-editor save path.
  const scratchRuntimes = scratchMode === 'off'
    ? ''
    : `<script>${SCRATCH_SERIALIZE_RUNTIME}</script>\n<script>${TID_SERIALIZE_RUNTIME}</script>\n${scratchMode === 'ipynb' ? `<script>${IPYNB_SERIALIZE_RUNTIME}</script>\n` : ''}`;

  // A read-only mount never saves, so it ships neither the patch runtime nor a
  // saver at all (legacy parity: no customSaver on the read-only path).
  const readOnlyLiteral = remote?.readOnly ? 'true' : 'false';
  const remoteRuntime = remote && !remote.readOnly ? `<script>${LINE_PATCH_RUNTIME}</script>\n` : '';

  const bootstrap = `${remoteRuntime}${scratchRuntimes}<script>${jsonPatchRuntime}</script>\n<script>(function(){
    var root = window;
    var defaultPlugins = ${pluginsJson};
    var pluginExclusions = defaultPlugins.map(function(p){ return '-[[$:/plugins/' + p + ']]'; }).join(' ');
    var baseFilter = ${baseFilterStr};
    var userTiddlerFilter = baseFilter + ' ' + pluginExclusions;

    var idbKeyval = (function (exports) {
      function Store(dbName, storeName) {
        this.storeName = storeName || 'keyval';
        this._dbp = new Promise(function(resolve, reject) {
          if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB not supported'));
          var openreq = indexedDB.open(dbName || 'keyval-store', 1);
          openreq.onerror = function() { reject(openreq.error); };
          openreq.onsuccess = function() { resolve(openreq.result); };
          openreq.onupgradeneeded = function() {
            openreq.result.createObjectStore(storeName || 'keyval');
          };
        });
      }
      Store.prototype._withIDBStore = function(type, callback) {
        var self = this;
        return this._dbp.then(function(db) {
          return new Promise(function(resolve, reject) {
            var transaction = db.transaction(self.storeName, type);
            transaction.oncomplete = function() { resolve(); };
            transaction.onabort = transaction.onerror = function() { reject(transaction.error); };
            callback(transaction.objectStore(self.storeName));
          });
        });
      };
      var store;
      function getDefaultStore() { if (!store) store = new Store(); return store; }
      function get(key, st) {
        var req;
        return (st || getDefaultStore())._withIDBStore('readonly', function(s) { req = s.get(key); }).then(function() { return req ? req.result : undefined; });
      }
      function set(key, value, st) {
        return (st || getDefaultStore())._withIDBStore('readwrite', function(s) { s.put(value, key); });
      }
      function del(key, st) {
        return (st || getDefaultStore())._withIDBStore('readwrite', function(s) { s.delete(key); });
      }
      exports.Store = Store; exports.get = get; exports.set = set; exports.del = del;
      return exports;
    }({}));

    function addRecent(fileHandle) {
      if (!fileHandle) return Promise.resolve();
      return idbKeyval.get('recentFiles').then(function(raw) {
        var recentFiles = (raw || []).map(function(f) { return (f && (f.handle || f.name)) ? f : { handle: f, name: f ? f.name : '', tauriPath: null }; });
        return Promise.all(recentFiles.map(function(f) {
          try {
            if (f.handle && fileHandle.isSameEntry) return fileHandle.isSameEntry(f.handle);
            return (f.handle ? f.handle.name : f.name) === fileHandle.name;
          } catch (_) { return false; }
        })).then(function(inList) {
          var existingIndex = inList.indexOf(true);
          // Tauri pseudo-handles (no getFile) must not enter the recents
          // store: record their disk path so the launcher re-opens via the
          // Rust read command, not the File System Access API. The browser-only
          // pseudo-handle is the same kind of thing for the opposite reason (
          // there is no file at all) and is flagged so the launcher lists it
          // as volatile rather than offering to re-open it.
          var newEntry = fileHandle.__lithicTauriPath__
            ? { handle: null, name: fileHandle.name, tauriPath: fileHandle.__lithicTauriPath__ }
            : fileHandle.__lithicBrowserOnly__
              ? { handle: null, name: fileHandle.name, tauriPath: null, browserOnly: true }
              : { handle: fileHandle, name: fileHandle.name, tauriPath: null };
          if (existingIndex !== -1) {
            var moved = recentFiles.splice(existingIndex, 1)[0];
            recentFiles.unshift(moved);
          } else {
            recentFiles.unshift(newEntry);
          }
          if (recentFiles.length > 20) recentFiles = recentFiles.slice(0, 20);
          return idbKeyval.set('recentFiles', recentFiles).catch(function() {
            var fallbackRecent = recentFiles.map(function(r){ return { name: r.name || (r.handle ? r.handle.name : ''), tauriPath: r.tauriPath }; });
            return idbKeyval.set('recentFiles', fallbackRecent);
          });
        });
      }).catch(function(err) {
        var fallbackEntry = [{ name: fileHandle.name, tauriPath: null }];
        return idbKeyval.set('recentFiles', fallbackEntry).catch(function(){});
      });
    }

    var HISTORY_MAX_VERSIONS = 30;
    // Defined by the JSON patch runtime script injected just before this one.
    var JP = root.__LITHIC_JSON_PATCH__;

    function hMeta(fileName) { return 'search_cache_meta_' + fileName; }
    function hBase(fileName, id) { return 'search_cache_base_' + fileName + '_' + id; }
    function hDelta(fileName, id) { return 'search_cache_delta_' + fileName + '_' + id; }

    function versionId(ts, text, parentId) {
      var hash = 5381;
      var seed = (parentId || '') + '|' + text;
      for (var i = 0; i < seed.length; i++) hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
      return ts.toString(36) + '-' + hash.toString(36);
    }

    function replayFrom(fileName, ordered, fromIndex, map, parentId, targetIndex) {
      if (fromIndex > targetIndex) return Promise.resolve({ map: map, reached: true });
      var version = ordered[fromIndex];
      return idbKeyval.get(hDelta(fileName, version.id)).then(function(delta) {
        if (!delta || delta.parentId !== parentId) return { map: null, reached: false };
        return replayFrom(fileName, ordered, fromIndex + 1, JP.applyTiddlerPatch(map, delta.ops), version.id, targetIndex);
      });
    }

    function materializeVersion(fileName, meta, targetId) {
      var ordered = meta.versions.slice().sort(function(a, b) { return a.ts - b.ts; });
      var targetIndex = -1;
      var baseIndex = -1;
      for (var i = 0; i < ordered.length; i++) if (ordered[i].id === targetId) targetIndex = i;
      if (targetIndex < 0) return Promise.resolve({ map: null, reached: false });
      for (var j = targetIndex; j >= 0; j--) { if (ordered[j].isBase) { baseIndex = j; break; } }
      if (baseIndex < 0) return Promise.resolve({ map: null, reached: false });
      return idbKeyval.get(hBase(fileName, ordered[baseIndex].id)).then(function(base) {
        var map = base ? JP.tiddlersToMap(base.text) : null;
        if (!map) return { map: null, reached: false };
        return replayFrom(fileName, ordered, baseIndex + 1, map, ordered[baseIndex].id, targetIndex);
      });
    }

    function pruneHistory(fileName, meta) {
      function step() {
        if (meta.versions.length <= HISTORY_MAX_VERSIONS) return Promise.resolve();
        var ordered = meta.versions.slice().sort(function(a, b) { return a.ts - b.ts; });
        var oldest = ordered[0];
        if (oldest.isBase && ordered.length > 1) {
          // Re-base the successor so the oldest state can be shed without
          // orphaning its deltas (nothing else in history is destroyed).
          var second = ordered[1];
          return materializeVersion(fileName, meta, second.id).then(function(result) {
            if (!result.reached || !result.map) return;
            var text = JP.mapToTiddlerArrayText(result.map);
            return idbKeyval.set(hBase(fileName, second.id), { id: second.id, text: text }).then(function() {
              return idbKeyval.del(hBase(fileName, oldest.id));
            }).then(function() {
              return idbKeyval.del(hDelta(fileName, second.id));
            }).then(function() {
              meta.versions = ordered.slice(1).map(function(v) {
                return v.id === second.id
                  ? { id: v.id, ts: v.ts, sizeBytes: text.length, isBase: true, external: v.external || false }
                  : { id: v.id, ts: v.ts, sizeBytes: v.sizeBytes, isBase: v.isBase || false, external: v.external || false };
              });
              return step();
            });
          });
        }
        if (oldest.isBase) return Promise.resolve();
        return idbKeyval.del(hDelta(fileName, oldest.id)).then(function() {
          meta.versions = meta.versions.filter(function(v) { return v.id !== oldest.id; });
          return step();
        });
      }
      return step();
    }

    function saveVersionedCache(fileName, text, now, options) {
      if (!JP) return Promise.resolve();
      var metaKey = hMeta(fileName);
      return idbKeyval.get(metaKey).then(function(meta) {
        meta = meta || { headId: '', versions: [] };
        var headPromise = meta.headId
          ? materializeVersion(fileName, meta, meta.headId)
          : Promise.resolve({ map: null, reached: false });
        return headPromise.then(function(head) {
          var nextMap = JP.tiddlersToMap(text);
          if (!nextMap) return; // Not a tiddler array; keep only the flat cache.
          var useBase = !head.reached || !head.map || (options && options.forceBase === true);
          var ops = [];
          if (!useBase) {
            ops = JP.diffTiddlerMaps(head.map, nextMap);
            useBase = JSON.stringify(ops).length > text.length / 2;
          }
          var id;
          if (useBase) {
            id = versionId(now, text, '');
            return idbKeyval.set(hBase(fileName, id), { id: id, text: text }).then(function() {
              var entry = { id: id, ts: now, sizeBytes: text.length, isBase: true };
              if (options && options.external === true) entry.external = true;
              meta.versions.push(entry);
              meta.headId = id;
              return pruneHistory(fileName, meta);
            }).then(function() {
              return idbKeyval.set(metaKey, meta);
            });
          }
          id = versionId(now, text, meta.headId);
          return idbKeyval.set(hDelta(fileName, id), { id: id, parentId: meta.headId, ts: now, ops: ops }).then(function() {
            meta.versions.push({ id: id, ts: now, sizeBytes: JP.mapToTiddlerArrayText(nextMap).length, isBase: false });
            meta.headId = id;
            return pruneHistory(fileName, meta);
          }).then(function() {
            return idbKeyval.set(metaKey, meta);
          });
        });
      });
    }

    var driftedFromHead = ${driftedFromHeadLiteral};

    function saveSearchCache(fileName, text) {
      var now = Date.now();
      var saveWasDrifted = driftedFromHead;
      var latestKey = 'search_cache_' + fileName;
      return idbKeyval.set(latestKey, {
        text: text,
        lastModified: new Date(now).toLocaleString(),
        backupTimestamp: now
      }).then(function() {
        return saveVersionedCache(fileName, text, now, {
          forceBase: saveWasDrifted,
          external: saveWasDrifted
        });
      }).then(function() {
        // Only the first successful save after a drifted mount gets the SYNC
        // marker; later saves return to the normal full/step heuristic.
        driftedFromHead = false;
        // A real save supersedes every buffered draft tiddler.
        dirtyBuffer = {};
        return idbKeyval.del('dirty_state_' + fileName);
      }).catch(function(err) {
        console.error('Failed to update search cache in IndexedDB:', err);
      });
    }

    /* ---
     * Transient (dirty) backups: stream changed tiddlers into
     * dirty_state_<fileName> in realtime so an unsaved tab that dies can
     * still be recovered from the launcher. Cost model: serialization is
     * bounded to the titles named by each change event (never a whole-wiki
     * scan), writes are debounced at 2s (one PUT per burst, tiny payload),
     * and the dirty key is deleted on every real save. Custom fields and
     * the raw draft body are captured verbatim; it is strictly a recovery
     * cache, never a save.
     * --- */
    var DIRTY_DEBOUNCE_MS = 2000;
    var dirtyBuffer = {};
    var dirtyTimer = null;

    function markDirty(changedTitles) {
      var tw = root.$tw;
      if (!tw || !tw.wiki || !tw.wiki.getTiddler) return;
      for (var i = 0; i < changedTitles.length; i++) {
        var tiddler = tw.wiki.getTiddler(changedTitles[i]);
        if (!tiddler || !tiddler.fields) continue;
        var fields = { title: tiddler.fields.title };
        for (var field in tiddler.fields) {
          if (!Object.prototype.hasOwnProperty.call(tiddler.fields, field)) continue;
          var value = tiddler.fields[field];
          if (field === 'modified') continue; // Store-internal; noise for recovery.
          fields[field] = typeof value === 'string' ? value : String(value);
        }
        dirtyBuffer[fields.title] = fields;
      }
      scheduleDirtyFlush();
    }

    function scheduleDirtyFlush() {
      if (dirtyTimer) return;
      dirtyTimer = setTimeout(flushDirty, DIRTY_DEBOUNCE_MS);
    }

    function flushDirty() {
      dirtyTimer = null;
      if (!root.__LITHIC_ACTIVE_FILE_NAME__) return;
      var titles = Object.keys(dirtyBuffer);
      if (titles.length === 0) return;
      var payload = { ts: Date.now(), tiddlers: titles.map(function(title) { return dirtyBuffer[title]; }) };
      idbKeyval.set('dirty_state_' + root.__LITHIC_ACTIVE_FILE_NAME__, payload).catch(function() { /* best effort */ });
    }

    // Draft deathbed flush: the user may close/refresh mid-debounce.
    window.addEventListener('pagehide', flushDirty);
    window.addEventListener('beforeunload', flushDirty);

    /**
     * Wire the change hook once the wiki has booted. The engine boots in
     * place via document.write, so a re-mount of a different wiki reuses
     * this window: a single shared listener (guarded by a root flag) is
     * re-pointed at the newly active file rather than stacked, and the
     * debounce buffer is reset so edits never bleed across wikis.
     */
    var armDirtyWatcher = function() {
      var tw = root.$tw;
      if (!tw || !tw.wiki || !tw.wiki.addEventListener) return false;
      if (root.__LITHIC_DIRTY_WATCHER_ARMED__) return true;
      root.__LITHIC_DIRTY_WATCHER_ARMED__ = true;
      tw.wiki.addEventListener('change', function(changes) {
        if (!changes) return;
        var titles = Object.keys(changes);
        if (titles.length === 0) return;
        // Skip engine plumbing ($:/ state, plugins). User content only.
        // NOTE: no regex literal here. This whole bootstrap is one template
        // literal, so backslash escapes get consumed at build time and would
        // emit a script that fails to parse. indexOf needs no escapes.
        var interesting = titles.filter(function(title) { return title.indexOf('$:/') !== 0; });
        if (interesting.length === 0) return;
        markDirty(interesting);
      });
      return true;
    };

    // Reset cross-boot state for this mount, then wait for $tw.wiki.
    root.__LITHIC_DIRTY_WATCHER_ARMED__ = false;
    root.__LITHIC_ACTIVE_FILE_NAME__ = ${activeFileNameJson};
    dirtyBuffer = {};
    if (dirtyTimer) { clearTimeout(dirtyTimer); dirtyTimer = null; }

    if (!armDirtyWatcher()) {
      var armAttempts = 0;
      var armPoll = setInterval(function() {
        armAttempts += 1;
        if (armDirtyWatcher() || armAttempts > 100) clearInterval(armPoll);
      }, 100);
    }

    function serializeJsonToLith(jsonArrayText) {
      try {
        var tiddlers = JSON.parse(jsonArrayText);
        tiddlers.sort(function(a, b) {
          var isBulky = function(t) {
            if (t.type && (t.type.indexOf('image/') === 0 || t.type === 'application/pdf' || t.type === 'application/tldr')) return true;
            if (t.text && t.text.length > 50000) return true;
            return false;
          };
          var aBulky = isBulky(a);
          var bBulky = isBulky(b);
          if (aBulky && !bBulky) return 1;
          if (!aBulky && bBulky) return -1;
          return (a.title || '').localeCompare(b.title || '');
        });
        return tiddlers.map(function(t) {
          var text = '';
          var fields = Object.keys(t).filter(function(k){ return k !== 'text'; }).sort();
          for (var i = 0; i < fields.length; i++) {
            var k = fields[i];
            if (t[k] !== undefined && t[k] !== null && t[k] !== '') {
              text += k + ': ' + t[k] + '\\n';
            }
          }
          if (t.text) {
            text += '\\n' + t.text;
          }
          return text;
        }).join('\\n⁂⁂⁂\\n');
      } catch (e) {
        return '';
      }
    }

    var handle = root.__LITHIC_FILE_HANDLE__ || undefined;
    var pending;

    // Tauri v1's WebView2 lacks the File System Access API, so in-place saves
    // go through the Rust commands instead: write_text_path overwrites an
    // existing file, save_lith_file shows the native dialog for new ones.
    // v2 exposes the invoke on __TAURI__.core, v1 on __TAURI__.tauri; the bare
    // __TAURI__.invoke is accepted as well, since the global's shape is the one
    // thing that differs between the app builds this bundle is loaded into.
    var tauriInvoke = (function() {
      var tauri = root.__TAURI__;
      if (!tauri) return null;
      if (tauri.invoke) return tauri.invoke;
      if (tauri.core && tauri.core.invoke) return tauri.core.invoke;
      return (tauri.tauri && tauri.tauri.invoke) || null;
    })();

    // Pseudo-writable mirroring FileSystemWritableFileStream for the Tauri
    // bridge: write() performs the Rust write, close() is a no-op, so both
    // save branches (lith and scratch) share one code shape.
    root.__LITHIC_WRITE_FILE__ = function(fileHandle) {
      var tauriPath = fileHandle && fileHandle.__lithicTauriPath__;
      var shimPath = fileHandle && fileHandle.__lithicShimPath__;
      // The shim first when it is the one that served this page, so a handle carrying both is
      // written by the wire rather than by an invoke this distribution does not have.
      if (shimToken && shimPath) {
        return {
          write: function(text) { return shimCommand('write', { path: shimPath, text: text }); },
          close: function() { return Promise.resolve(); }
        };
      }
      if (!tauriInvoke || !tauriPath) return Promise.reject(new Error('No writable target'));
      return {
        write: function(text) { return tauriInvoke('write_text_path', { path: tauriPath, text: text }); },
        close: function() { return Promise.resolve(); }
      };
    };
    function tauriHandle(name, tauriPath) {
      return { name: name, __lithicTauriPath__: tauriPath };
    }

    // The shim's wire, resolved for itself the same way the app's invoke is, and for the
    // same reason: this whole script runs in the document the mount wrote, so nothing can
    // arrive through a closure and the secret is a literal the launcher read from the page
    // it served. A shim handle names a real path, so a save lands in the file the person
    // opened rather than behind a picker on every save.
    var shimToken = ${shimTokenLiteral};
    var shimCommand = function(command, args) {
      if (!shimToken) return Promise.reject(new Error('No shim wire'));
      var headers = { 'Content-Type': 'application/json' };
      headers[${shimTokenHeaderJson}] = shimToken;
      return fetch(${shimCommandPathJson}, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ command: command, args: args || {} })
      }).then(function(response) {
        if (!response.ok) throw new Error('The shim refused the command');
        return response.json();
      }).then(function(payload) {
        if (!payload || payload.ok !== true) throw new Error((payload && payload.error) || 'The shim could not do that');
        return payload.result;
      });
    };
    function shimHandle(name, shimPath) {
      return { name: name, __lithicShimPath__: shimPath };
    }

    // The index-db-only fallback's save target. There is no file and no picker
    // to name one, so the only thing this carries is the name every other part
    // of the system keys off: the recents row, the search cache, the version
    // history and the dirty-state backup.
    var browserOnly = ${browserOnlyLiteral};
    function browserOnlyHandle(name) {
      return { name: name, __lithicBrowserOnly__: true };
    }

    // The engine boots in place via document.open/write/close, which keeps the
    // same window, so launcher globals survive. Recover the file handle from
    // the IndexedDB recent-files list (keyed by the active handoff name) as a
    // fallback before falling back to the Save As picker.
    function resolveStoredHandle() {
      if (handle) return Promise.resolve(handle);
      try {
        var handoff = JSON.parse(sessionStorage.getItem('lithic-active-file') || 'null');
        var fileName = handoff && handoff.name;
        if (!fileName) return Promise.resolve(null);
        // Tauri: the handoff carries the absolute disk path of the opened
        // file; save in place through the invoke bridge.
        if (tauriInvoke && handoff.path) {
          handle = tauriHandle(fileName, handoff.path);
          root.__LITHIC_FILE_HANDLE__ = handle;
          return Promise.resolve(handle);
        }
        // The shim: the handoff carries the absolute path the desktop's chooser named, and
        // the wire writes that path back in place.
        if (shimToken && handoff.path) {
          handle = shimHandle(fileName, handoff.path);
          root.__LITHIC_FILE_HANDLE__ = handle;
          return Promise.resolve(handle);
        }
        return idbKeyval.get('recentFiles').then(function(raw) {
          var list = (raw || []).map(function(f) { return (f && (f.handle || f.name)) ? f : { handle: f, name: f ? f.name : '', tauriPath: null }; });
          for (var i = 0; i < list.length; i++) {
            if (list[i].handle && list[i].handle.name === fileName) {
              handle = list[i].handle;
              root.__LITHIC_FILE_HANDLE__ = handle;
              return handle;
            }
          }
          return null;
        }).catch(function() { return null; });
      } catch (e) {
        return Promise.resolve(null);
      }
    }

    var scratchMode = ${scratchModeJson};
    var remote = ${remoteJson};

    // Scratch (fancy text editor) save: serialize the wiki back to the
    // original flat format (stream nodes for .md/.txt, a .tid document for
    // .tid, verbatim body for .json) and write it to the same file.
    function serializeScratchPayload() {
      var twNow = root.$tw;
      if (!twNow || !twNow.wiki || !twNow.wiki.getTiddler) return null;
      var docTitle = root.__LITHIC_SCRATCH_ROOT__;
      if (!docTitle) return null;
      var docTiddler = twNow.wiki.getTiddler(docTitle);
      if (!docTiddler || !docTiddler.fields) return null;
      var fields = {};
      for (var key in docTiddler.fields) {
        if (!Object.prototype.hasOwnProperty.call(docTiddler.fields, key)) continue;
        var value = docTiddler.fields[key];
        fields[key] = typeof value === 'string' ? value : String(value);
      }
      if (scratchMode === 'tid') {
        return root.__LITHIC_TID_SERIALIZE__ ? root.__LITHIC_TID_SERIALIZE__(fields) : null;
      }
      if (scratchMode === 'ipynb') {
        return root.__LITHIC_IPYNB_SERIALIZE__ ? root.__LITHIC_IPYNB_SERIALIZE__(docTitle, function(title) {
          var t = twNow.wiki.getTiddler(title);
          if (!t || !t.fields) return undefined;
          var out = {};
          for (var k in t.fields) {
            if (!Object.prototype.hasOwnProperty.call(t.fields, k)) continue;
            var v = t.fields[k];
            out[k] = typeof v === 'string' ? v : String(v);
          }
          return out;
        }) : null;
      }
      if (scratchMode === 'json') {
        return typeof fields.text === 'string' ? fields.text : '';
      }
      if (!root.__LITHIC_SCRATCH_SERIALIZE__) return null;
      return root.__LITHIC_SCRATCH_SERIALIZE__(docTitle, function(title) {
        var t = twNow.wiki.getTiddler(title);
        if (!t || !t.fields) return undefined;
        var out = {};
        for (var k in t.fields) {
          if (!Object.prototype.hasOwnProperty.call(t.fields, k)) continue;
          var v = t.fields[k];
          out[k] = typeof v === 'string' ? v : String(v);
        }
        return out;
      });
    }

    // --- Self-host save path -------------------------------------------------
    // Whole-file PUT, the fallback whenever a patch cannot be used (no API on
    // the instance, an oversized edit, or a server-side conflict).
    function remotePut(tw, lithText, jsonText, callback) {
      fetch(remote.base + encodeURIComponent(remote.fileName), { method: 'PUT', body: lithText }).then(function(res) {
        if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error('PUT failed: ' + res.status);
        root.__LITHIC_REMOTE_BASE__ = lithText;
        return saveSearchCache(remote.fileName, jsonText);
      }).then(function() { callback(null); }, function(err) { callback(err); });
    }

    // Preferred self-host save: send only the changed lines and let the server
    // apply them with git, so git stays the source of truth. The local search
    // cache is still updated with the same delta-based history the local modes
    // use, so version history works identically for remote wikis.
    function saveRemote(tw, callback) {
      var jsonText = (tw && tw.wiki && tw.wiki.getTiddlersAsJson) ? tw.wiki.getTiddlersAsJson(userTiddlerFilter) : '[]';
      var lithText = serializeJsonToLith(jsonText);
      var patchApi = root.__LITHIC_LINE_PATCH__;
      var baseText = root.__LITHIC_REMOTE_BASE__ || '';
      var digest = root.__LITHIC_REMOTE_DIGEST__ || '';
      if (!remote.api || !patchApi || !digest) { remotePut(tw, lithText, jsonText, callback); return; }

      var patch = patchApi.create(baseText, lithText, remote.fileName);
      // '' means the wiki is byte-identical to what was loaded: nothing to send.
      if (patch === '') { callback(null); return; }
      // null means the edit was too large to diff; the patch would be bigger
      // than the file, so upload the file.
      if (patch === null || !patchApi.worthSending(patch, lithText)) { remotePut(tw, lithText, jsonText, callback); return; }

      fetch(remote.apiBase + 'apply', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: remote.fileName + '\\n' + digest + '\\n' + patch
      }).then(function(res) {
        if (!res.ok) {
          // 409 stale / 422 unusable patch / 404 unsupported: fall back to the
          // whole-file path rather than losing the save.
          remotePut(tw, lithText, jsonText, callback);
          return null;
        }
        return res.json().catch(function() { return {}; }).then(function(payload) {
          if (payload && payload.digest) root.__LITHIC_REMOTE_DIGEST__ = payload.digest;
          root.__LITHIC_REMOTE_BASE__ = lithText;
          return saveSearchCache(remote.fileName, jsonText);
        }).then(function() { callback(null); });
      }).catch(function(err) { callback(err); });
    }

    // --- Index-db-only save path ---------------------------------------------
    // The platform gave this tab no way to write a file, so the cached copy is
    // not a backup of the save. It *is* the save. It writes exactly the keys a
    // real save writes (the flat search cache and the versioned history), which
    // is what keeps everything downstream working unchanged: the recents row,
    // the search index, unsaved-edit recovery, and the version-history modal
    // the user downloads their own hard copy from.
    function saveToBrowserStorage(tw, callback) {
      var jsonText = (tw && tw.wiki && tw.wiki.getTiddlersAsJson) ? tw.wiki.getTiddlersAsJson(userTiddlerFilter) : '[]';
      var fileName = (handle && handle.name) || ${suggestedNameJson};
      var target = browserOnlyHandle(fileName);
      handle = target;
      root.__LITHIC_FILE_HANDLE__ = target;
      return Promise.all([
        addRecent(target),
        saveSearchCache(fileName, jsonText)
      ]).then(function() { callback(null); }, function(err) {
        console.error('Lithic browser-storage save failed:', err);
        callback(err);
      });
    }

    // --- Index-db-only monolith save path ------------------------------------
    // A monolith is a page, not a tiddler store, so this save has two halves and
    // they land in two different places. The page text is what reopens the mount,
    // so it goes onto the recents row the launcher reads it from: tiddler JSON
    // cannot rebuild a page that carries its own scripts, plugins and styles. The
    // page's own tiddler store, where it has one, then goes where every other
    // mount records it, so a browser-only monolith stays searchable and its row
    // keeps the version chain and the copies those versions offer.
    function saveMonolithToBrowserStorage(tw, pageText, callback) {
      if (typeof pageText !== 'string' || pageText === '') {
        callback(new Error(${JSON.stringify(copy.status.monolithSaveFailed)}));
        return;
      }
      var fileName = (handle && handle.name) || ${suggestedNameJson};
      var target = browserOnlyHandle(fileName);
      handle = target;
      root.__LITHIC_FILE_HANDLE__ = target;
      var savedRow = idbKeyval.get('recentFiles').then(function(raw) {
        var rows = (raw || []).map(function(f) { return (f && (f.handle || f.name)) ? f : { handle: f, name: f ? f.name : '', tauriPath: null }; });
        rows = rows.filter(function(f) { return (f.handle ? f.handle.name : f.name) !== fileName; });
        rows.unshift({ handle: null, name: fileName, tauriPath: null, browserOnly: true, text: pageText });
        if (rows.length > 20) rows = rows.slice(0, 20);
        return idbKeyval.set('recentFiles', rows);
      });
      var jsonText = (tw && tw.wiki && tw.wiki.getTiddlersAsJson) ? tw.wiki.getTiddlersAsJson(userTiddlerFilter) : '';
      return Promise.all([
        savedRow,
        jsonText ? saveSearchCache(fileName, jsonText) : null
      ]).then(function() { callback(null); }, function(err) {
        console.error('Lithic monolith browser-storage save failed:', err);
        callback(err);
      });
    }

    var save = function(_text, _method, callback) {
      var tw = root.$tw;
      if (remote) {
        saveRemote(tw, callback);
        return true;
      }
      if (browserOnly) {
        if (${htmlModeLiteral}) {
          saveMonolithToBrowserStorage(tw, _text, callback);
        } else {
          saveToBrowserStorage(tw, callback);
        }
        return true;
      }
      var saveOptions = {
        suggestedName: ${suggestedNameJson},
        types: ${saveTypesJson}
      };

      var select = handle
        ? Promise.resolve(handle)
        : (pending || (pending = resolveStoredHandle().then(function(stored) {
            if (stored) return stored;
            if (tauriInvoke) {
              // No path on record (new file): let Rust show the native save
              // dialog, then keep writing in place to the chosen path.
              return tauriInvoke('save_lith_file', { text: '', suggestedName: ${suggestedNameJson} }).then(function(saved) {
                var savedPath = saved && (saved.path || saved.name);
                if (!savedPath) throw new Error('Save cancelled');
                handle = tauriHandle((saved && saved.name) || ${suggestedNameJson}, savedPath);
                root.__LITHIC_FILE_HANDLE__ = handle;
                return handle;
              });
            }
            if (shimToken) {
              // No path on record (a new file): the desktop's own chooser names one and the
              // normal writable write below lands there.
              return shimCommand('pick', { mode: 'save', suggestedName: ${suggestedNameJson} }).then(function(result) {
                var picked = result && result.paths && result.paths[0];
                if (!picked) throw new Error('Save cancelled');
                var pickedName = String(picked).split('/').pop() || ${suggestedNameJson};
                handle = shimHandle(pickedName, picked);
                root.__LITHIC_FILE_HANDLE__ = handle;
                return handle;
              });
            }
            return root.showSaveFilePicker ? root.showSaveFilePicker(saveOptions) : Promise.reject(new Error('Native file picker not available'));
          })));

      select.then(function(selected) {
        handle = selected;
        root.__LITHIC_FILE_HANDLE__ = selected;
        pending = null;
        // Scratch mode first: serialize the wiki back to the original flat
        // text before touching the writable, so a serialization failure
        // (or a missing runtime) leaves the file untouched.
        if (scratchMode !== 'off') {
          var payload = serializeScratchPayload();
          if (typeof payload !== 'string') {
            callback(new Error(${JSON.stringify(copy.status.scratchSaveFailed)}));
            return;
          }
          var writableP = handle.createWritable
            ? handle.createWritable()
            : root.__LITHIC_WRITE_FILE__(handle);
          var writeP = Promise.resolve(writableP).then(function(writable) {
            return writable.write(payload).then(function() { return writable.close(); });
          });
          return writeP.then(function() {
            var jsonText = (tw && tw.wiki && tw.wiki.getTiddlersAsJson) ? tw.wiki.getTiddlersAsJson(userTiddlerFilter) : '[]';
            return Promise.all([addRecent(handle), saveSearchCache(handle.name, jsonText)]);
          });
        }
        var writableFactory = handle.createWritable
          ? function() { return handle.createWritable(); }
          : function() { return Promise.resolve(root.__LITHIC_WRITE_FILE__(handle)); };
        return Promise.resolve(writableFactory()).then(function(writable) {
          if (${htmlModeLiteral}) {
            // HTML monolith mode: write the payload TW hands us (its own
            // serialized page), then record the same searchable cache and
            // version chain every other mount records, so a monolith is
            // findable by search and its row offers history. An HTML page with
            // no TiddlyWiki store in it has no wiki to snapshot, so nothing is
            // recorded for it rather than an empty version; a real wiki with no
            // user tiddlers records an empty one, exactly as a blank .lith does.
            return writable.write(_text).then(function() {
              return writable.close();
            }).then(function() {
              var jsonText = (tw && tw.wiki && tw.wiki.getTiddlersAsJson) ? tw.wiki.getTiddlersAsJson(userTiddlerFilter) : '';
              return jsonText ? saveSearchCache(handle.name, jsonText) : null;
            });
          }
          var jsonText = (tw && tw.wiki && tw.wiki.getTiddlersAsJson) ? tw.wiki.getTiddlersAsJson(userTiddlerFilter) : '[]';
          var lithText = serializeJsonToLith(jsonText);
          return writable.write(lithText).then(function() {
            return writable.close();
          }).then(function() {
            return Promise.all([
              addRecent(handle),
              saveSearchCache(handle.name, jsonText)
            ]);
          });
        });
      }).then(function() {
        if (tw && tw.wiki && tw.wiki.deleteTiddler) {
          tw.wiki.deleteTiddler('$:/state/DisableAutoSaver');
        }
        // Git-synced file (Tauri): auto-commit the save best-effort. Never
        // blocks or fails the save itself, and Rust skips non-Lithic repos.
        // Reports what the backup did, not just that it ran, so the launcher's
        // icon can show a push that never landed instead of pulsing green over
        // it (the engine document is a rewrite of the launcher page, so a
        // direct reference back into the launcher UI is impossible).
        var savedPath = handle && handle.__lithicTauriPath__;
        // An app whose Rust was built without the repository prong (--sync=iroh) has no
        // git_sync_commit, so this invoke is refused there. It is caught below like any other
        // failed backup, and the launcher listens to the outcome only when it draws the
        // repository controls at all (hasLocalSync), so a build without the prong reports
        // nothing anywhere rather than a backup that could not have happened.
        if (tauriInvoke && savedPath) {
          var announce = function(outcome) {
            var payload = {
              type: 'lithic-git-sync-saved',
              ok: !outcome.error,
              // "Nothing to do" is not proof of a healthy backup, so the launcher
              // is told whether this folder is one Lithic actually syncs.
              managed: Boolean(outcome.managed),
              error: outcome.error || null
            };
            try {
              window.parent.postMessage(payload, '*');
            } catch (e) { /* same-window dispatch below still fires */ }
            try {
              window.dispatchEvent(new CustomEvent('lithic-git-sync-saved', { detail: payload }));
            } catch (e) { /* best effort */ }
          };
          try {
            tauriInvoke('git_sync_commit', {
              path: savedPath,
              message: 'Save ' + (handle.name || 'file') + ' from Lithic'
            }).then(function(result) {
              announce(result || {});
            }).catch(function(error) {
              // The save is on disk either way; the backup is what did not
              // happen, and a managed folder is the only place that matters.
              announce({ managed: true, error: (error && error.message) || copy.sync.backendSilent });
            });
          } catch (e) { /* sync is opportunistic */ }
        }
        callback(null);
      }, function(error) {
        pending = null;
        if (error && (error.name === 'AbortError' || String(error).indexOf('AbortError') !== -1)) {
          console.log('Save As dialog cancelled by user');
          callback(null);
        } else {
          console.error('Lithic save failed:', error);
          callback(error);
        }
      });
      return true;
    };

    root.$tw = root.$tw || {};
    // Read-only remote mounts deliberately install no saver: TiddlyWiki keeps
    // its default one and $:/state/DisableAutoSaver keeps autosave off, so the
    // other session's lock and file stay untouched until the user saves by hand.
    if (!${readOnlyLiteral}) {
      root.$tw.customSaver = { save: save };
    }
  })();</script>`;

  const bootScript = /<script[^>]+(?:src=["'][^"']*boot[^"']*["']|data-tiddler-title=["']\$:\/boot\/)/i;
  if (bootScript.test(html)) {
    const tag = html.match(bootScript)?.[0] ?? '';
    return html.replace(tag, `${bootstrap}\n${tag}`);
  }
  return html.replace(/<\/head>/i, `${bootstrap}\n</head>`);
}

/**
 * The one place a mounted wiki can put an external link.
 *
 * The desktop webview has no second window, so a `target="_blank"` click inside a mounted wiki
 * lands nowhere at all: every reference in the document is a dead control, the same failure the
 * launcher's own project link and device-login page had. A browser opens the tab itself, so this
 * script does nothing outside the app.
 *
 * It has to live *inside* the document the mount writes. `document.open()` builds a fresh document
 * and drops every event listener the launcher registered on the one it replaced (measured: a
 * listener held over from launcher JS never fires again, while window properties survive), which is
 * the same reason the injected saver resolves `__TAURI__` for itself and reports back through
 * `postMessage` rather than through a reference into the launcher UI.
 */
const MOUNTED_LINK_BOOTSTRAP = `(function(){
    var root = window;
    var doc = root.document;
    if (!doc || root.__LITHIC_LINK_OPENER__) return;

    // v2 exposes the invoke on __TAURI__.core, v1 on __TAURI__.tauri, and the bare
    // __TAURI__.invoke is accepted as well, since the global's shape is the one thing
    // that differs between the app builds this bundle is loaded into.
    var tauriInvoke = (function() {
      var tauri = root.__TAURI__;
      if (!tauri) return null;
      if (tauri.invoke) return tauri.invoke;
      if (tauri.core && tauri.core.invoke) return tauri.core.invoke;
      return (tauri.tauri && tauri.tauri.invoke) || null;
    })();
    if (!tauriInvoke) return;
    root.__LITHIC_LINK_OPENER__ = true;

    // Capture phase, so the click is claimed before anything in the document acts on it. Only a
    // plain left click is: the middle click, the context menu, "Copy link" and the modifier keys
    // all stay the document's own, which is what they are in a browser too.
    doc.addEventListener('click', function(event) {
      if (event.defaultPrevented || event.button !== 0) return;
      var target = event.target;
      var anchor = target && target.closest ? target.closest('a[href]') : null;
      if (!anchor) return;
      // http and https only, the same limit Rust's open_external enforces, so an anchor in a page
      // cannot reach a local file or a shell scheme through this. A tiddler link, a fragment, a
      // relative address and a mailto are each left to the document that produced them.
      if (!/^https?:$/i.test(anchor.protocol || '')) return;
      // An address on this page's own origin is the page's own business: it is the one click a
      // wiki can serve from where it already is.
      if (anchor.origin === root.location.origin) return;
      event.preventDefault();
      try {
        tauriInvoke('open_external', { url: anchor.href });
      } catch (e) { /* refused, and the address is still in the href */ }
    }, true);
  })();`;

/**
 * Put the link bootstrap in a document, ahead of its boot script where there is one so it shares the
 * injected saver's place in the boot order.
 *
 * A monolith is an ordinary page rather than an engine and has no boot script to precede: the script
 * lands at the end of its head, or at the end of the document when it has neither a head nor a body
 * to aim at. Arriving late costs nothing, because the only thing it has to beat is a person clicking
 * a link, and it is registered while the document is still being parsed.
 */
function injectMountedLinkBootstrap(html: string): string {
  const script = `<script>${MOUNTED_LINK_BOOTSTRAP}</script>`;
  const bootScript = /<script[^>]+(?:src=["'][^"']*boot[^"']*["']|data-tiddler-title=["']\$:\/boot\/)/i;
  const tag = html.match(bootScript)?.[0] ?? '';
  if (tag) return html.replace(tag, `${script}\n${tag}`);
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${script}\n</head>`);
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${script}\n</body>`);
  return `${html}\n${script}`;
}

/**
 * The engine boots in place via document.open/write/close, which preserves
 * the launcher window and its globals. Injecting the ones the mounted engine
 * needs (e.g. __EPHEMERAL_MODE__ for the Ephemeral widget) is kept as a
 * belt-and-suspenders measure so the engine boots correctly even if the
 * boot path later changes to a fresh navigation.
 */
function injectEngineGlobals(html: string, globals: Record<string, string>): string {
  const entries = Object.entries(globals)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `window[${JSON.stringify(key)}] = ${JSON.stringify(value)};`)
    .join('\n');
  if (!entries) return html;
  const script = `<script>\n${entries}\n</script>`;

  const bootScript = /<script[^>]+(?:src=["'][^"']*boot[^"']*["']|data-tiddler-title=["']\$:\/boot\/)/i;
  if (bootScript.test(html)) {
    const tag = html.match(bootScript)?.[0] ?? '';
    return html.replace(tag, `${script}\n${tag}`);
  }
  return html.replace(/<\/head>/i, `${script}\n</head>`);
}

/**
 * The scratch mount's root tiddler title: the parsed plan's base (the file
 * name with its extension) matching parseScratchSource's injected root
 * tiddler. Asked of resolveScratchPlan rather than re-derived here, so the
 * injected root and the engine global the saver serializes from cannot
 * disagree. Returns the name unchanged for non-scratch files.
 */
function scratchRootTitle(name: string): string {
  return resolveScratchPlan(name)?.base ?? name;
}

/**
 * Parse a mounted file's payload into store tiddlers: scratch files
 * (.md/.txt/.tid/.json) become their stream representation, JSON backups
 * (a top-level array) and lith payloads parse as lith tiddlers.
 */
function parseHandoffImported(name: string, text: string): Array<Record<string, string>> {
  const kind = resolveScratchKind(name);
  if (kind === 'json') {
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) return parseLithToJSON(text);
  }
  if (kind && text) {
    const plan = { kind, base: scratchRootTitle(name) };
    const parsed = parseScratchSource(text, plan);
    if (kind === 'tid') {
      // .tid saves re-serialize header fields, so anything the mount injected
      // for editor UX must be tracked and stripped on save to keep round-trips
      // byte-identical. `lithic-tid-injected` lists those field names; the
      // injected saver removes them (plus the lithic-tid marker) before
      // serializing. Dogear is only added when the file has no tags of its
      // own, so authored tags are never rewritten.
      const root = parsed[0];
      if (!root) return parsed;
      const injected: string[] = [];
      if (!root.tags) injected.push('tags');
      if (!parseTidFile(text).fields.some(([key]) => key === 'type')) injected.push('type');
      if (injected.length === 0) return parsed;
      const marked: Record<string, string> = { ...root, 'lithic-tid-injected': injected.join(' ') };
      if (injected.includes('tags')) marked.tags = 'Dogear';
      return [marked, ...parsed.slice(1)];
    }
    // .md/.txt/.json saves never serialize the tags field, so the root can
    // carry Dogear unconditionally. It opens the document at the top of
    // the story river, matching shared payloads.
    return tagRootDogear(parsed);
  }
  return text ? parseLithToJSON(text) : [];
}

/**
 * Build the bootable engine HTML for a handoff plus any pending imports.
 * Pure helper so the injection order and journal/saver defaults are unit
 * testable without a browser.
 */
export function buildEngineHtml(
  engineHtml: string,
  handoff: LauncherHandoff,
  extraTiddlers: Array<Record<string, string>> = [],
  engineGlobals: Record<string, string> = {},
  options: MountSaveOptions = {}
): string {
  const imported = handoff.text
    ? parseHandoffImported(handoff.name, handoff.text)
    : (handoff.payloadTiddlers ?? []);
  // File tiddlers first, then queued pending imports (payload, Ephemeral
  // integration, etc.) so later entries win on title conflicts. Mirrors the
  // legacy launcher, which appends window.pendingImports after the store.
  // An entry without a title is dropped rather than injected: TiddlyWiki cannot
  // store an unnamed tiddler, and handing it one aborts the boot into a blank
  // page with no error form. A malformed file should cost the user the tiddler
  // it mangled, not the whole mount.
  const tiddlers = [...imported, ...extraTiddlers].filter(
    (tiddler) => typeof tiddler.title === 'string' && tiddler.title.trim() !== ''
  );
  // The engine's journal stub creates the today entry at boot, so blank
  // liths no longer need a pre-hydrated journal tiddler here. Saver and
  // plugin-library defaults are still injected before the store.
  if (options.remote && !options.remote.readOnly) {
    // Enables the engine-side lock release (tm-lithic-stop-lock); excluded from
    // saves by LITHIC_BASE_FILTER so it never lands in the wiki.
    tiddlers.push({
      title: '$:/lithic/startup/webdav-utils.js',
      type: 'application/javascript',
      'module-type': 'startup',
      text: WEBDAV_UTILS_JS
    });
  }
  tiddlers.push({ title: '$:/state/DisableAutoSaver', text: 'yes' });
  tiddlers.push({ title: '$:/config/OfficialPluginLibrary', text: 'yes' });

  // TiddlyWiki's boot script is usually present in lithic.html. Keep this
  // guard so a future engine build without an initial store still boots.
  let html = injectSaverBootstrap(
    injectTiddlers(engineHtml, tiddlers),
    handoff.name,
    options.isHtmlMode === true,
    options.driftedFromHead === true,
    options.scratchMode ?? 'off',
    options.remote ?? null,
    options.browserOnly === true,
    options.shimToken ?? null
  );
  if (options.remote && !options.remote.readOnly) {
    // The saver diffs the wiki against the exact text the launcher loaded, so
    // hand it that base and its digest as globals.
    html = injectEngineGlobals(html, {
      __LITHIC_REMOTE_BASE__: options.remote.baseText,
      __LITHIC_REMOTE_DIGEST__: options.remote.digest,
      __LITHIC_REMOTE_FILE__: options.remote.fileName
    });
  }
  if (options.scratchMode && options.scratchMode !== 'off') {
    // The scratch saver serializes the stream rooted at the document title;
    // publish it as an engine global so the injected saver can find it. The
    // root title is the parsed plan's base (the file stem), matching the
    // root tiddler injected by the scratch mount.
    html = injectEngineGlobals(html, { __LITHIC_SCRATCH_ROOT__: scratchRootTitle(handoff.name) });
  }
  // Last, so the link bootstrap sits closest to the boot script the mount also injects ahead of.
  return injectMountedLinkBootstrap(injectEngineGlobals(html, engineGlobals));
}

export async function bootLegacyWiki(
  handoff: LauncherHandoff,
  extraTiddlers: Array<Record<string, string>> = [],
  engineGlobals: Record<string, string> = {},
  options: MountSaveOptions = {}
): Promise<void> {
  const engine = await fetchEngine();
  const html = buildEngineHtml(engine, handoff, extraTiddlers, engineGlobals, options);

  // A pointer, not the document: the injected saver reads a name and a path from here and never
  // the body, which is what the monolith branch below has always recorded. This used to be handed
  // the whole handoff (body and all) so it threw on the line after the launcher's own, on the
  // same mount, for the same reason (see writeHandoff).
  setActiveFile({ name: handoff.name, path: handoff.path });
  // Boot the engine into the current document so the launcher URL stays in
  // the address bar. A plain refresh / "return to launcher" lands back on
  // the launcher UI. This mirrors the legacy launcher.html boot path, which
  // uses the same document.open/write/close mechanism from a module script.
  document.open();
  document.write(html);
  document.close();
}

/**
 * Mount a TiddlyWiki HTML monolith directly (legacy "Mount ... HTML from
 * Disk" behavior): the file is itself a full wiki page, so it is served
 * as-is rather than injected into a fresh engine.
 *
 * `browserOnly` is the index-db-only fallback, and for a monolith it is a different
 * answer than the file path: the serialized page text goes back into the recents row
 * the launcher reads the monolith from, because tiddler JSON cannot rebuild a page
 * that carries its own scripts, plugins and styles.
 */
export function bootLegacyHtml(
  html: string,
  suggestedFileName?: string,
  path?: string,
  browserOnly = false,
  shimToken: string | null = null
): void {
  // HTML monoliths keep their own tiddler store and are served as-is, but a
  // raw-HTML saver is injected so saves write the engine's serialized page back
  // to a .html file instead of falling through to TiddlyWiki's built-in
  // download behavior (legacy setTwCustomSaveAsSaver(false) parity). The link
  // bootstrap goes in with it, because this rewrite of the launcher document is
  // exactly where an external link in the mounted page dies the same way.
  const withSaver = injectMountedLinkBootstrap(
    suggestedFileName ? injectSaverBootstrap(html, suggestedFileName, true, false, 'off', null, browserOnly, shimToken) : html
  );
  if (suggestedFileName) {
    // Record which file this is, exactly as the engine mount does. The injected
    // saver resolves its target from here, and without it a monolith adopted
    // whatever handoff the previously mounted wiki had left, writing this page
    // over an unrelated file.
    setActiveFile({ name: suggestedFileName, path });
  }
  // Same in-place boot as bootLegacyWiki: the mounted HTML replaces the
  // launcher document, keeping the real launcher URL in the address bar.
  document.open();
  document.write(withSaver);
  document.close();
}

export function readHandoff(): LauncherHandoff | null {
  try {
    const raw = sessionStorage.getItem(HANDOFF_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(HANDOFF_KEY);
    return JSON.parse(raw) as LauncherHandoff;
  } catch {
    return null;
  }
}

/**
 * Leave the handoff the legacy `?mount` boot reads, as far as the session store will take it.
 *
 * This build does not rely on it: the engine boots into the launcher's own document and the
 * payload is already in the page `buildEngineHtml` writes, and nothing navigates to the engine
 * with `?mount` any more. It is kept for the reader that is left (an engine cached from an older
 * build) and it is exactly what broke a big file. A session store's whole budget is a few
 * megabytes, and this key was handed the entire document: a 10 MB Lith failed its own mount with
 * `QuotaExceededError`, surfaced as "Could not open …", on an instance and in the desktop app
 * alike. Note this is not the key `persistRecentRows` fixed. That one was the recents mirror, and
 * the mount died here first.
 *
 * A handoff is bookkeeping, and bookkeeping may never cost a mount, so this never throws: a
 * handoff the store will not take is one no reader would have been able to read either.
 */
export function writeHandoff(handoff: LauncherHandoff): void {
  storeInSession(HANDOFF_KEY, handoff);
}

/**
 * The file this engine is mounted on, as its own injected saver reads it: a name and a path.
 *
 * Never the body. The saver resolves its write target from these two fields, and the body is what
 * the store cannot hold (see `writeHandoff`).
 */
function setActiveFile(pointer: { name?: string; path?: string }): void {
  storeInSession(ACTIVE_FILE_KEY, pointer);
}

/**
 * Write a session-store entry, or leave it unwritten.
 *
 * What these entries hold can be re-read from disk or the server, so a store that refuses one (a
 * full quota, a quarantined storage area) must not be able to stop a mount. The failures here are
 * the store's business, not the mount's.
 */
function storeInSession(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Nothing to do: the mount does not depend on it.
  }
}
