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
   * Open without claiming the lock or installing a saver — the legacy
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

  throw new Error('Could not load the Lithic engine locally, from the offline cache, or online.');
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

function injectSaverBootstrap(
  html: string,
  suggestedFileName?: string,
  isHtmlMode = false,
  driftedFromHead = false,
  scratchMode: ScratchMode = 'off',
  remote: RemoteTarget | null = null
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
  // what the page does with its own edits. Searchable history is unaffected —
  // the save path records that for monoliths too, from what actually lands.
  const activeFileNameJson = isHtmlMode ? '""' : JSON.stringify(suggestedFileName || 'new.lith').replace(/</g, '\\u003c');
  const saveTypes = isHtmlMode
    ? [{ description: 'Lithic HTML File', accept: { 'text/html': ['.html', '.htm'] } }]
    : [{ description: 'Lithic Monolith', accept: { 'application/x-lith': ['.lith'] } }, { description: 'Jupyter Notebook', accept: { 'application/x-ipynb+json': ['.ipynb'] } }];
  const saveTypesJson = JSON.stringify(saveTypes);
  const htmlModeLiteral = isHtmlMode ? 'true' : 'false';
  const driftedFromHeadLiteral = driftedFromHead ? 'true' : 'false';
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
          // Rust read command, not the File System Access API.
          var newEntry = fileHandle.__lithicTauriPath__
            ? { handle: null, name: fileHandle.name, tauriPath: fileHandle.__lithicTauriPath__ }
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
        // Skip engine plumbing ($:/ state, plugins) — user content only.
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
    var tauriInvoke = (function() {
      var tauri = root.__TAURI__;
      return (tauri && (tauri.invoke || (tauri.tauri && tauri.tauri.invoke))) || null;
    })();

    // Pseudo-writable mirroring FileSystemWritableFileStream for the Tauri
    // bridge: write() performs the Rust write, close() is a no-op, so both
    // save branches (lith and scratch) share one code shape.
    root.__LITHIC_WRITE_FILE__ = function(fileHandle) {
      var tauriPath = fileHandle && fileHandle.__lithicTauriPath__;
      if (!tauriInvoke || !tauriPath) return Promise.reject(new Error('No writable target'));
      return {
        write: function(text) { return tauriInvoke('write_text_path', { path: tauriPath, text: text }); },
        close: function() { return Promise.resolve(); }
      };
    };
    function tauriHandle(name, tauriPath) {
      return { name: name, __lithicTauriPath__: tauriPath };
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
    // original flat format — stream nodes for .md/.txt, a .tid document for
    // .tid, verbatim body for .json — and write it to the same file.
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

    var save = function(_text, _method, callback) {
      var tw = root.$tw;
      if (remote) {
        saveRemote(tw, callback);
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
            callback(new Error('Scratch serialization failed; file left unchanged.'));
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
        // Git-synced file (Tauri): auto-commit the save best-effort — never
        // blocks or fails the save itself, and Rust skips non-Lithic repos.
        // Reports what the backup did, not just that it ran, so the launcher's
        // icon can show a push that never landed instead of pulsing green over
        // it (the engine document is a rewrite of the launcher page, so a
        // direct reference back into the launcher UI is impossible).
        var savedPath = handle && handle.__lithicTauriPath__;
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
              announce({ managed: true, error: (error && error.message) || 'the sync backend did not answer' });
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
 * The scratch mount's root tiddler title: the parsed plan's base — the file
 * name with its extension — matching parseScratchSource's injected root
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
    // carry Dogear unconditionally — it opens the document at the top of
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
  options: { isHtmlMode?: boolean; driftedFromHead?: boolean; scratchMode?: ScratchMode; remote?: RemoteTarget | null } = {}
): string {
  const imported = handoff.text
    ? parseHandoffImported(handoff.name, handoff.text)
    : (handoff.payloadTiddlers ?? []);
  // File tiddlers first, then queued pending imports (payload, Ephemeral
  // integration, etc.) so later entries win on title conflicts — mirrors the
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
    options.remote ?? null
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
  return injectEngineGlobals(html, engineGlobals);
}

export async function bootLegacyWiki(
  handoff: LauncherHandoff,
  extraTiddlers: Array<Record<string, string>> = [],
  engineGlobals: Record<string, string> = {},
  options: { isHtmlMode?: boolean; driftedFromHead?: boolean; scratchMode?: ScratchMode; remote?: RemoteTarget | null } = {}
): Promise<void> {
  const engine = await fetchEngine();
  const html = buildEngineHtml(engine, handoff, extraTiddlers, engineGlobals, options);

  sessionStorage.setItem('lithic-active-file', JSON.stringify(handoff));
  // Boot the engine into the current document so the launcher URL stays in
  // the address bar — a plain refresh / "return to launcher" lands back on
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
 */
export function bootLegacyHtml(html: string, suggestedFileName?: string, path?: string): void {
  // HTML monoliths keep their own tiddler store and are served as-is, but a
  // raw-HTML saver is injected so saves write the engine's serialized page back
  // to a .html file instead of falling through to TiddlyWiki's built-in
  // download behavior (legacy setTwCustomSaveAsSaver(false) parity).
  const withSaver = suggestedFileName ? injectSaverBootstrap(html, suggestedFileName, true) : html;
  if (suggestedFileName) {
    // Record which file this is, exactly as the engine mount does. The injected
    // saver resolves its target from here, and without it a monolith adopted
    // whatever handoff the previously mounted wiki had left, writing this page
    // over an unrelated file.
    sessionStorage.setItem('lithic-active-file', JSON.stringify({ name: suggestedFileName, path }));
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
