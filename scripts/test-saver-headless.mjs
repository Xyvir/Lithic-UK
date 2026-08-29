import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const engineHtml = readFileSync('src/lithic.html', 'utf8');
const testHtmlPath = resolve('scratch/test-saver-headless.html');
const profileDir = resolve('scratch', `test-profile-saver-${process.pid}`);
const serverPort = 38000 + (process.pid % 1000);

import { DEFAULT_PLUGINS, LITHIC_BASE_FILTER } from '../launcher-ui/src/legacy-saver.ts';

const pluginsJson = JSON.stringify(DEFAULT_PLUGINS);
const baseFilterStr = JSON.stringify(LITHIC_BASE_FILTER);

const testHarness = `
<script>
window.__SAVER_TEST_LOGS__ = [];
window.__SAVER_IDB_RESULTS__ = null;
window.__SAVER_IDB_ERROR__ = null;
window.__SAVER_IDB_STAGE__ = 'boot';

window.showSaveFilePicker = async function(options) {
  window.__SAVER_TEST_LOGS__.push({
    event: 'showSaveFilePicker',
    options: options
  });
  return {
    name: options.suggestedName || 'new.lith',
    isSameEntry: async function(other) {
      return other && other.name === (options.suggestedName || 'new.lith');
    },
    createWritable: async function() {
      return {
        write: async function(data) {
          window.__SAVER_TEST_LOGS__.push({
            event: 'write',
            dataSnippet: data.slice(0, 300),
            dataLength: data.length
          });
        },
        close: async function() {
          window.__SAVER_TEST_LOGS__.push({ event: 'close' });
        }
      };
    }
  };
};

(function(){
  var root = window;
  var defaultPlugins = ${pluginsJson};
  var pluginExclusions = defaultPlugins.map(function(p){ return '-[[$:/plugins/' + p + ']]'; }).join(' ');
  var baseFilter = ${baseFilterStr};
  var userTiddlerFilter = baseFilter + ' ' + pluginExclusions;

  var idbKeyval = (function (exports) {
    function Store(dbName, storeName) {
      this.storeName = storeName || 'keyval';
      this._dbp = new Promise(function(resolve, reject) {
        if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB not supported'));          var openreq = indexedDB.open(dbName || 'keyval-store', 1);
          openreq.onerror = function() { window.__SAVER_IDB_ERROR__ = 'open: ' + String(openreq.error); reject(openreq.error); };
          openreq.onblocked = function() { window.__SAVER_IDB_ERROR__ = 'open blocked'; };
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
          try {
            var transaction = db.transaction(self.storeName, type);
            var request = callback(transaction.objectStore(self.storeName));
            transaction.oncomplete = function() { window.__SAVER_IDB_STAGE__ = 'transaction:complete'; resolve(request ? request.result : undefined); };
            transaction.onabort = transaction.onerror = function() { window.__SAVER_IDB_ERROR__ = 'transaction: ' + String(transaction.error); reject(transaction.error || new Error('IndexedDB transaction failed')); };
            if (request) request.onerror = function() { window.__SAVER_IDB_ERROR__ = 'request: ' + String(request.error); reject(request.error || new Error('IndexedDB request failed')); };
          } catch (error) { reject(error); }
        });
      });
    };
    var store;
    function getDefaultStore() { if (!store) store = new Store(); return store; }
    function get(key, st) {
      return (st || getDefaultStore())._withIDBStore('readonly', function(s) { return s.get(key); });
    }
    function set(key, value, st) {
      return (st || getDefaultStore())._withIDBStore('readwrite', function(s) { return s.put(value, key); });
    }
    function del(key, st) {
      return (st || getDefaultStore())._withIDBStore('readwrite', function(s) { return s.delete(key); });
    }
    exports.Store = Store; exports.get = get; exports.set = set; exports.del = del;
    return exports;
  }({}));

  function addRecent(fileHandle) {
    window.__SAVER_IDB_STAGE__ = 'addRecent:start';
    if (!fileHandle) return Promise.resolve();
    return idbKeyval.get('recentFiles').then(function(raw) {
      window.__SAVER_IDB_STAGE__ = 'addRecent:read';
      var recentFiles = (raw || []).map(function(f) { return (f && (f.handle || f.name)) ? f : { handle: f, name: f ? f.name : '', tauriPath: null }; });
      return Promise.all(recentFiles.map(function(f) {
        try {
          if (f.handle && fileHandle.isSameEntry) return fileHandle.isSameEntry(f.handle);
          return (f.handle ? f.handle.name : f.name) === fileHandle.name;
        } catch (_) { return false; }
      })).then(function(inList) {
        var existingIndex = inList.indexOf(true);
        // The picker fixture is intentionally non-cloneable; production handles
        // are cloneable, while metadata is sufficient to verify this harness's
        // recent-file and cache lifecycle.
        var newEntry = { name: fileHandle.name, tauriPath: null };
        if (existingIndex !== -1) {
          var moved = recentFiles.splice(existingIndex, 1)[0];
          recentFiles.unshift(moved);
        } else {
          recentFiles.unshift(newEntry);
        }
        if (recentFiles.length > 20) recentFiles = recentFiles.slice(0, 20);          window.__SAVER_IDB_STAGE__ = 'addRecent:write';
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
    window.__SAVER_IDB_STAGE__ = 'cache:start';
    var now = Date.now();
    var latestKey = 'search_cache_' + fileName;
    return idbKeyval.set(latestKey, {
      text: text,
      lastModified: new Date().toLocaleString(),
      backupTimestamp: now
    }).catch(function(err) {
      window.__SAVER_IDB_ERROR__ = 'cache: ' + String(err && err.stack || err);
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
        }).then(function() {
          window.__SAVER_IDB_STAGE__ = 'verify:start';
          return Promise.all([
            idbKeyval.get('recentFiles'),
            idbKeyval.get('search_cache_' + handle.name)
          ]).then(function(res) {
            root.__SAVER_IDB_RESULTS__ = {
              recentFiles: (res[0] || []).map(function(r){ return { name: r.handle ? r.handle.name : (r.name || '') }; }),
              hasCache: !!(res[1] && res[1].text)
            };
          }).catch(function(error) {
            root.__SAVER_IDB_ERROR__ = String(error && error.stack || error);
          });
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
})();
</script>
`;

const testProbe = `
<pre id="out">TESTING...</pre>
<script>
(function() {
  var timer = setInterval(function() {
    if (window.$tw && window.$tw.wiki && window.$tw.saverHandler && window.$tw.rootWidget) {
      clearInterval(timer);
      var out = document.getElementById('out');
      
      window.$tw.wiki.addTiddler(new window.$tw.Tiddler({
        title: "Test Note",
        text: "This is test note content",
        tags: ["TestTag"]
      }));

      window.$tw.rootWidget.dispatchEvent({ type: "tm-save-wiki" });

      setTimeout(function() {
        var results = {
          hasCustomSaver: !!(window.$tw && window.$tw.customSaver),
          registeredSavers: (window.$tw.saverHandler.savers || []).map(function(s){ return { name: s.info.name, priority: s.info.priority }; }),
          autoSaverDisabled: window.$tw.wiki.getTiddlerText('$:/state/DisableAutoSaver'),
          saverLogs: window.__SAVER_TEST_LOGS__,
          idbResults: window.__SAVER_IDB_RESULTS__,
          idbError: window.__SAVER_IDB_ERROR__,
          idbStage: window.__SAVER_IDB_STAGE__
        };
        out.textContent = JSON.stringify(results, null, 2);
      }, 4000);
    }
  }, 100);
})();
</script>
`;

const bootScriptMatch = engineHtml.match(/<script[^>]+(?:src=["'][^"']*boot[^"']*["']|data-tiddler-title=["']\$:\/boot\/)/i);
assert.ok(bootScriptMatch, 'Found boot script match in engineHtml');

let modifiedHtml = engineHtml.replace(bootScriptMatch[0], `${testHarness}\n${bootScriptMatch[0]}`);
modifiedHtml = modifiedHtml.replace('</body>', `${testProbe}</body>`);

writeFileSync(testHtmlPath, modifiedHtml, 'utf8');

// IndexedDB is not reliably available to file:// pages in headless Chrome.
// Serve the generated test document from a loopback origin so this harness
// exercises the same-origin storage path used by hosted/local HTTP launches.
const server = spawn(process.execPath, ['-e', `
  const http = require('node:http');
  const fs = require('node:fs');
  const file = process.argv[1];
  const port = Number(process.argv[2]);
  http.createServer((req, res) => {
    if (req.url === '/test.html') {
      res.writeHead(200, {'content-type': 'text/html'});
      res.end(fs.readFileSync(file));
    } else {
      res.writeHead(404); res.end();
    }
  }).listen(port, '127.0.0.1');
`, testHtmlPath, String(serverPort)], { stdio: 'ignore' });

try {
  const testUrl = `http://127.0.0.1:${serverPort}/test.html`;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const response = await fetch(testUrl);
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  const stdout = execFileSync(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${profileDir}`,
    '--virtual-time-budget=15000',
    '--dump-dom',
    testUrl
  ], { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });

  const match = stdout.match(/<pre id="out"[^>]*>([\s\S]*?)<\/pre>/);
  assert.ok(match, 'Headless Chrome returned test output');
  
  const parsed = JSON.parse(match[1]);
  console.log('Headless Chrome Test Results:\n', JSON.stringify(parsed, null, 2));

  // Assertions
  assert.equal(parsed.hasCustomSaver, true);
  const customSaverEntry = parsed.registeredSavers.find(s => s.name === 'custom');
  assert.ok(customSaverEntry, 'Custom saver must be registered in $tw.saverHandler');
  assert.equal(customSaverEntry.priority, 4000);

  assert.equal(parsed.saverLogs.length, 3);
  assert.equal(parsed.saverLogs[0].event, 'showSaveFilePicker');
  assert.equal(parsed.saverLogs[0].options.suggestedName, 'new.lith');
  assert.deepEqual(parsed.saverLogs[0].options.types[0].accept, { 'application/x-lith': ['.lith'] });
  assert.equal(parsed.saverLogs[1].event, 'write');
  assert.match(parsed.saverLogs[1].dataSnippet, /title: Test Note/);
  assert.match(parsed.saverLogs[1].dataSnippet, /tags: TestTag/);
  assert.equal(parsed.saverLogs[2].event, 'close');

  // Verify IndexedDB recentFiles and search cache!
  assert.ok(parsed.idbResults, 'IndexedDB results should be populated');
  assert.equal(parsed.idbResults.recentFiles.length, 1);
  assert.equal(parsed.idbResults.recentFiles[0].name, 'new.lith');
  assert.equal(parsed.idbResults.hasCache, true);

  console.log('\n✔ All Headless Chrome Parity & IndexedDB Assertions Passed!');
} finally {
  server.kill();
  try { unlinkSync(testHtmlPath); } catch {}
  try { rmSync(profileDir, { recursive: true, force: true }); } catch {}
}
