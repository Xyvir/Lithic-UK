import { parseLithToJSON } from './lithic-format.ts';
import { DEFAULT_PLUGINS, LITHIC_BASE_FILTER } from './legacy-saver.ts';

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
    new URL('lithic.html', base).href,
    new URL('pre-launcher-engine.html', base).href,
    new URL('src/lithic.html', base).href,
    location.origin === 'null' ? 'file:///lithic.html' : new URL('/lithic.html', location.origin).href,
    location.origin === 'null' ? 'file:///src/lithic.html' : new URL('/src/lithic.html', location.origin).href
  ];
}

function getTodayTitle(): string {
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const date = new Date();
  const day = date.getDate();
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  return `${day}${suffix} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function getTwTime(): string {
  const date = new Date();
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}${String(date.getUTCHours()).padStart(2, '0')}${String(date.getUTCMinutes()).padStart(2, '0')}${String(date.getUTCSeconds()).padStart(2, '0')}${String(date.getUTCMilliseconds()).padStart(3, '0')}`;
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

function injectSaverBootstrap(html: string): string {
  const pluginsJson = JSON.stringify(DEFAULT_PLUGINS);
  const baseFilterStr = JSON.stringify(LITHIC_BASE_FILTER);

  const bootstrap = `<script>(function(){
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
          var newEntry = { handle: fileHandle, name: fileHandle.name, tauriPath: null };
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

    function saveSearchCache(fileName, text) {
      var now = Date.now();
      var latestKey = 'search_cache_' + fileName;
      return idbKeyval.set(latestKey, {
        text: text,
        lastModified: new Date().toLocaleString(),
        backupTimestamp: now
      }).catch(function(err) {
        console.error('Failed to update search cache in IndexedDB:', err);
      });
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

    var save = function(_text, _method, callback) {
      var tw = root.$tw;
      var saveOptions = {
        suggestedName: 'new.lith',
        types: [{ description: 'Lithic Monolith', accept: { 'application/x-lith': ['.lith'] } }]
      };

      var select = handle
        ? Promise.resolve(handle)
        : (pending || (pending = (root.showSaveFilePicker ? root.showSaveFilePicker(saveOptions) : Promise.reject(new Error('Native file picker not available')))));

      select.then(function(selected) {
        handle = selected;
        root.__LITHIC_FILE_HANDLE__ = selected;
        pending = null;
        return handle.createWritable().then(function(writable) {
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
    root.$tw.customSaver = { save: save };
  })();</script>`;

  const bootScript = /<script[^>]+(?:src=["'][^"']*boot[^"']*["']|data-tiddler-title=["']\$:\/boot\/)/i;
  if (bootScript.test(html)) {
    const tag = html.match(bootScript)?.[0] ?? '';
    return html.replace(tag, `${bootstrap}\n${tag}`);
  }
  return html.replace(/<\/head>/i, `${bootstrap}\n</head>`);
}

export async function bootLegacyWiki(handoff: LauncherHandoff): Promise<void> {
  const engine = await fetchEngine();
  const imported = handoff.text ? parseLithToJSON(handoff.text) : (handoff.payloadTiddlers ?? []);
  const today = getTodayTitle();
  if (!imported.some((tiddler) => tiddler.title === today)) {
    imported.push({ created: getTwTime(), modified: getTwTime(), tags: 'Journal', title: today, type: '' });
  }
  imported.push({ title: '$:/state/DisableAutoSaver', text: 'yes' });
  imported.push({ title: '$:/config/OfficialPluginLibrary', text: 'yes' });

  // TiddlyWiki's boot script is usually present in lithic.html. Keep this
  // guard so a future engine build without an initial store still boots.
  const html = injectSaverBootstrap(injectTiddlers(engine, imported));

  sessionStorage.setItem('lithic-active-file', JSON.stringify(handoff));
  // Use location.replace() so the blob: URL is not added to browser history
  // (prevents the Back button from revisiting an invalid blob URL).
  const blob = new Blob([html], { type: 'text/html' });
  location.replace(URL.createObjectURL(blob));
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
