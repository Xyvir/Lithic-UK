  <script type="module">
    // Global State
    window.pendingImports = [];
    window.lithicSessionId = sessionStorage.getItem('lithicSessionId') || Math.random().toString(36).substring(2, 15);
    sessionStorage.setItem('lithicSessionId', window.lithicSessionId);
    window.currentLockFileName = null;
    let isNewOrInjected = false;

    // --- WEBDAV MODE DETECTION ---
    const IS_WEBDAV = ((window.__ORIGINAL_PATH__ || window.location.pathname).startsWith('/sync/'))
      || document.querySelector('meta[name="lithic-webdav"]') !== null
      || (window.location.protocol.startsWith('http') &&
        !['localhost', '127.0.0.1'].includes(window.location.hostname) &&
        !['lithic.uk', 'www.lithic.uk'].includes(window.location.hostname) &&
        !window.location.hostname.endsWith('github.io') &&
        !window.__TAURI__);

    // How the Ephemeral code-runner reaches the swarm:
    //   'self-host'   -> relative /ephemeral/api/v1/* (the WebDAV backend proxies it)
    //   'paper-light' -> discover a bastion from docs/swarm.json and POST over https
    window.__EPHEMERAL_MODE__ = IS_WEBDAV ? 'self-host' : 'paper-light';

    /* IDB-KEYVAL & FILE MANAGER LOGIC */
    let idbKeyval = (function (exports) {
      'use strict';
      class Store {
        constructor(dbName = 'keyval-store', storeName = 'keyval') {
          this.storeName = storeName;
          this._dbp = new Promise((resolve, reject) => {
            const openreq = indexedDB.open(dbName, 1);
            openreq.onerror = () => reject(openreq.error);
            openreq.onsuccess = () => resolve(openreq.result);
            openreq.onupgradeneeded = () => {
              openreq.result.createObjectStore(storeName);
            };
          });
        }
        _withIDBStore(type, callback) {
          return this._dbp.then(db => new Promise((resolve, reject) => {
            const transaction = db.transaction(this.storeName, type);
            transaction.oncomplete = () => resolve();
            transaction.onabort = transaction.onerror = () => reject(transaction.error);
            callback(transaction.objectStore(this.storeName));
          }));
        }
      }
      let store;
      function getDefaultStore() { if (!store) store = new Store(); return store; }
      function get(key, store = getDefaultStore()) {
        let req;
        return store._withIDBStore('readonly', store => { req = store.get(key); }).then(() => req.result);
      }
      function set(key, value, store = getDefaultStore()) {
        return store._withIDBStore('readwrite', store => { store.put(value, key); });
      }
      function del(key, store = getDefaultStore()) {
        return store._withIDBStore('readwrite', store => { store.delete(key); });
      }
      function clear(store = getDefaultStore()) {
        return store._withIDBStore('readwrite', store => { store.clear(); });
      }
      function keys(store = getDefaultStore()) {
        let req;
        return store._withIDBStore('readonly', store => { req = store.getAllKeys(); }).then(() => req.result);
      }
      exports.Store = Store; exports.get = get; exports.set = set; exports.del = del; exports.clear = clear; exports.keys = keys;
      return exports;
    }({}));

    /* --- PROACTIVE CACHE PURGE --- */
    async function purgeOldestCachesIfNeeded() {
      if (!navigator.storage || !navigator.storage.estimate) return;

      const { usage, quota } = await navigator.storage.estimate();
      const usageRatio = usage / quota;
      const THRESHOLD = 0.80;

      if (usageRatio < THRESHOLD) return;

      console.log(`[Lithic] Storage at ${(usageRatio * 100).toFixed(1)}% (${(usage / 1048576).toFixed(1)}MB / ${(quota / 1048576).toFixed(1)}MB). Checking caches...`);

      const allKeys = await idbKeyval.keys();
      const cacheKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('search_cache_'));

      // Never purge if only 1 cache exists
      if (cacheKeys.length <= 1) {
        console.log(`[Lithic] Only ${cacheKeys.length} cache(s). Skipping purge.`);
        return;
      }

      // Gather metadata for each cache
      const caches = [];
      for (const key of cacheKeys) {
        const cache = await idbKeyval.get(key);
        if (cache) {
          caches.push({
            key,
            lastModified: cache.lastModified ? new Date(cache.lastModified) : new Date(0),
            size: cache.text ? new Blob([cache.text]).size : 0
          });
        }
      }

      // Sort oldest-modified first
      caches.sort((a, b) => a.lastModified - b.lastModified);

      let currentUsage = usage;
      let purged = 0;

      while (caches.length > 1 && (currentUsage / quota) >= THRESHOLD) {
        const oldest = caches.shift();
        await idbKeyval.del(oldest.key);
        currentUsage -= oldest.size;
        purged++;
        console.log(`[Lithic] Purged cache: ${oldest.key} (~${(oldest.size / 1024).toFixed(0)}KB, modified: ${oldest.lastModified.toLocaleString()})`);
      }

      if (purged > 0) {
        console.log(`[Lithic] Purged ${purged} cache(s). Est. usage now: ${(currentUsage / 1048576).toFixed(1)}MB (${((currentUsage / quota) * 100).toFixed(1)}%)`);
      }
    }

    /* --- SEARCH CACHE BACKUP SYSTEM --- */
    async function saveSearchCache(fileName, text) {
      const now = Date.now();
      const latestKey = 'search_cache_' + fileName;
      const bk1Key = 'search_cache_bk1_' + fileName;
      const bk2Key = 'search_cache_bk2_' + fileName;

      const currentCache = await idbKeyval.get(latestKey);
      const bk1 = await idbKeyval.get(bk1Key);
      const bk2 = await idbKeyval.get(bk2Key);

      const TWO_HOURS = 2 * 60 * 60 * 1000;
      const lastBackupTime = (currentCache && currentCache.backupTimestamp) ? currentCache.backupTimestamp : 0;
      const backupsNotFull = !bk1 || !bk2;

      if (currentCache && (backupsNotFull || (now - lastBackupTime >= TWO_HOURS))) {
        // Rotate: bk1 -> bk2, latest -> bk1
        if (bk1) await idbKeyval.set(bk2Key, bk1);
        await idbKeyval.set(bk1Key, currentCache);

        // Save new latest and reset backup timer
        await idbKeyval.set(latestKey, {
          text: text,
          lastModified: new Date().toLocaleString(),
          backupTimestamp: now
        });
        if (backupsNotFull) {
          console.log(`[Lithic] Filling backup slots for ${fileName}...`);
        } else {
          console.log(`[Lithic] Search cache rotated for ${fileName}. Next backup in 2h.`);
        }
      } else {
        // Update latest but keep previous backup timestamp
        await idbKeyval.set(latestKey, {
          text: text,
          lastModified: new Date().toLocaleString(),
          backupTimestamp: lastBackupTime
        });
      }
    }

    /* --- LITHIC FORMAT HELPERS --- */
    function parseLithToJSON(lithText) {
      const blocks = lithText.split(/(?:\r?\n)*⁂⁂⁂(?:\r?\n)*/);
      const tiddlers = [];
      for (let block of blocks) {
        if (!block.trim()) continue;

        let delimiterIdx = block.indexOf("\n\n");
        let delimiterLen = 2;
        let altRN = block.indexOf("\r\n\r\n");
        if (altRN !== -1 && (delimiterIdx === -1 || altRN < delimiterIdx)) {
          delimiterIdx = altRN;
          delimiterLen = 4;
        }

        let fieldsStr = "";
        let text = "";
        if (delimiterIdx !== -1) {
          fieldsStr = block.substring(0, delimiterIdx);
          text = block.substring(delimiterIdx + delimiterLen);
        } else {
          fieldsStr = block;
        }

        const tiddlerObj = {};
        if (text) tiddlerObj.text = text;

        const lines = fieldsStr.split(/\r?\n/);
        for (let line of lines) {
          let colon = line.indexOf(":");
          if (colon !== -1) {
            const key = line.substring(0, colon).trim();
            const val = line.substring(colon + 1).trim();
            if (key) tiddlerObj[key] = val;
          }
        }
        if (Object.keys(tiddlerObj).length > 0) {
          tiddlers.push(tiddlerObj);
        }
      }
      return tiddlers;
    }

    function serializeJsonToLith(jsonArrayText) {
      try {
        const tiddlers = JSON.parse(jsonArrayText);

        tiddlers.sort((a, b) => {
          const isBulky = (t) => {
            if (t.type && (t.type.startsWith('image/') || t.type === 'application/pdf' || t.type === 'application/tldr')) return true;
            if (t.text && t.text.length > 50000) return true;
            return false;
          };
          const aBulky = isBulky(a);
          const bBulky = isBulky(b);

          if (aBulky && !bBulky) return 1;
          if (!aBulky && bBulky) return -1;

          const titleA = a.title || "";
          const titleB = b.title || "";
          return titleA.localeCompare(titleB);
        });

        const lithBlocks = tiddlers.map(t => {
          let text = "";
          let fields = Object.keys(t).filter(k => k !== "text").sort();
          for (let k of fields) {
            if (t[k] !== undefined && t[k] !== null && t[k] !== "") {
              text += `${k}: ${t[k]}\n`;
            }
          }
          if (t.text) {
            text += "\n" + t.text;
          } else {
            text += "\n";
          }
          return text;
        });
        return lithBlocks.join("\n⁂⁂⁂\n");
      } catch (err) {
        console.error("Failed to serialize array to .lith format:", err);
        return "";
      }
    }

    /* --- CORE ENGINE FETCHER --- */
    const EPHEMERAL_INTEGRATION_JSON = [
      {
        "title": "$:/plugins/lithic/ephemeral/action-ephemeral.js",
        "type": "application/javascript",
        "module-type": "widget",
        "text": `/*\\
title: $:/plugins/lithic/ephemeral/action-ephemeral.js
type: application/javascript
module-type: widget

Action widget to run Ephemeral code.
\\*/
(function(){
"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;

// Resolve where to POST a job:
//   self-host   -> the same-origin /ephemeral/api/v1/run path
//   paper-light -> the fastest/nearest bastion advertised in docs/swarm.json
async function _resolveEphemeralEndpoint() {
    var mode = (typeof window !== "undefined" && window.__EPHEMERAL_MODE__) || "self-host";
    if (mode !== "paper-light") {
        return "/ephemeral/api/v1/run";
    }
    var swarmUrls = [
        "https://raw.githubusercontent.com/Xyvir/Ephemeral.exe/main/docs/swarm.json",
        "https://xyvir.github.io/Ephemeral.exe/docs/swarm.json"
    ];
    var bastions = [];
    for (var i = 0; i < swarmUrls.length && bastions.length === 0; i++) {
        try {
            var res = await fetch(swarmUrls[i]);
            if (!res.ok) continue;
            var data = await res.json();
            bastions = (data.bastions || []).filter(function (b) {
                return b && b.url && b.probe !== "failed";
            });
        } catch (e) {
            // try the next mirror
        }
    }
    if (!bastions.length) {
        throw new Error("No bastion server found in swarm.json (paper-light mode)");
    }
    // Fastest/nearest first: lowest recorded probe latency wins.
    bastions.sort(function (a, b) {
        return (a.probe_ms || 999999999) - (b.probe_ms || 999999999);
    });
    var base = bastions[0].url;
    while (base.charAt(base.length - 1) === "/") { base = base.slice(0, -1); }
    return base + "/ephemeral/api/v1/run";
}

class ActionEphemeralWidget extends Widget {
    render(parent, nextSibling) {
        this.computeAttributes();
        this.execute();
    }
    execute() {
        this.code = this.getAttribute("code");
        this.language = this.getAttribute("language") || "bash";
        this.parentTiddler = this.getAttribute("parentTiddler") || this.getVariable("currentTiddler");
    }
    refresh(changedTiddlers) {
        var changedAttributes = this.computeAttributes();
        if(changedAttributes.code || changedAttributes.parentTiddler) {
            this.refreshSelf();
            return true;
        }
        return this.refreshChildren(changedTiddlers);
    }

    async invokeAction(triggeringWidget, event) {
        if (!this.code) return true;
        
        let btn = null;
        if (event && event.target) {
            btn = typeof event.target.closest === "function" ? event.target.closest('.run-jspython-btn') : null;
            if (!btn && event.target.classList && event.target.classList.contains('run-jspython-btn')) btn = event.target;
            if (btn) btn.classList.add("ephemeral-running");
        }
        
        try {
            // Ephemeral parses Markdown documents, so retain an explicit shebang
            // exactly as supplied (it overrides the fence language), and otherwise
            // wrap the code in a language-labelled triple-backtick block. This is
            // the same contract used by the self-hosted/local API client.
            const code = String(this.code).replace(/^\uFEFF/, "");
            const hasShebang = /^\s*#!/.test(code);
            const markdownPayload = hasShebang
                ? code
                : "\\\`\\\`\\\`" + this.language + "\\n" + code + "\\n\\\`\\\`\\\`";
            const utf8str = new TextEncoder().encode(markdownPayload);
            let binary = '';
            for (let i = 0; i < utf8str.byteLength; i++) {
                binary += String.fromCharCode(utf8str[i]);
            }
            const base64code = window.btoa(binary);
            
            const endpoint = await _resolveEphemeralEndpoint();
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ document_blob: base64code, timeout: 300 })
            });

            // Surface HTTP errors instead of silently swallowing them: the
            // bastion answers 422 with {"detail": "..."} when a job cannot be
            // run (e.g. orchestration-only bastion with no peer holding the
            // required image warm). Before, the error body was parsed and
            // discarded, so a failed run looked like it did nothing.
            let data = null;
            try {
                data = await response.json();
            } catch (parseErr) {
                data = null; // non-JSON error body — fall through to status handling
            }
            if (!response.ok) {
                const detail = (data && typeof data.detail === "string" && data.detail.trim())
                    ? data.detail
                    : ("HTTP " + response.status + ((data && data.error) ? " - " + data.error : ""));
                throw new Error("Ephemeral API returned HTTP " + response.status + ": " + detail);
            }
            if (!data) data = {};

            if (data.stderr && data.stderr.trim()) {
                console.warn("Ephemeral API Stderr:", data.stderr);
            }
              if (data.stdout && data.stdout.trim()) {
                const childTitle = $tw.wiki.generateNewTitle(this.parentTiddler + "/stdout");
                
                if (data.artifact_ext) {
                    const ext = data.artifact_ext.toLowerCase();
                    if (ext === ".svg") {
                        $tw.wiki.addTiddler(new $tw.Tiddler({
                            title: childTitle,
                            text: data.stdout,
                            type: "image/svg+xml",
                            parent: this.parentTiddler,
                            "stream-type": "default"
                        }));
                        this.appendToStream(this.parentTiddler, childTitle);
                    } else if (ext.match(/^\.(png|jpe?g|webp|gif)$/)) {
                        const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : ext === ".gif" ? "image/gif" : "image/jpeg";
                        const dataUri = "data:" + mime + ";base64," + data.stdout.trim();
                        
                        const img = new Image();
                        img.onload = () => {
                            const payload = this.generateWhiteboardData([{
                                filename: "artifact" + ext,
                                dataUri: dataUri,
                                width: img.width,
                                height: img.height
                            }]);
                            
                            const wbTitle = $tw.wiki.generateNewTitle(this.parentTiddler + "/artifact-wb");
                            
                            $tw.wiki.addTiddler(new $tw.Tiddler({
                                title: wbTitle,
                                text: JSON.stringify(payload),
                                type: "application/tldr"
                            }));
                            
                            $tw.wiki.addTiddler(new $tw.Tiddler({
                                title: childTitle,
                                text: "<<wb-image \\"[[" + wbTitle + "]]\\" \\"80%\\">>",
                                type: "text/vnd.tiddlywiki",
                                parent: this.parentTiddler,
                                "stream-type": "default"
                            }));
                            this.appendToStream(this.parentTiddler, childTitle);
                        };
                        img.src = dataUri;
                    } else if (ext === ".csv") {
                        $tw.wiki.addTiddler(new $tw.Tiddler({
                            title: childTitle,
                            text: data.stdout,
                            type: "text/csv",
                            parent: this.parentTiddler,
                            "stream-type": "default"
                        }));
                        this.appendToStream(this.parentTiddler, childTitle);
                    } else {
                        $tw.wiki.addTiddler(new $tw.Tiddler({
                            title: childTitle,
                            text: data.stdout,
                            type: "text/plain",
                            parent: this.parentTiddler,
                            "stream-type": "default"
                        }));
                        this.appendToStream(this.parentTiddler, childTitle);
                    }
                } else {
                    $tw.wiki.addTiddler(new $tw.Tiddler({
                        title: childTitle,
                        text: data.stdout,
                        type: "text/x-markdown",
                        parent: this.parentTiddler,
                        "stream-type": "default"
                    }));
                    this.appendToStream(this.parentTiddler, childTitle);
                }
            }
            
            if (data.artifact_file && (!data.artifact_ext || data.artifact_ext === ".zip")) {
                const artifactUrl = '/sync/ephemeral/' + encodeURIComponent(data.artifact_file);
                const a = document.createElement("a");
                a.href = artifactUrl;
                a.download = data.artifact_file;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            }
            
        } catch (e) {
            console.error("Ephemeral API Error:", e);
            const errTitle = $tw.wiki.generateNewTitle(this.parentTiddler + "/error");
            $tw.wiki.addTiddler(new $tw.Tiddler({
                title: errTitle,
                text: "❌ **Ephemeral API Error:**\\n\\n\\\`\\\`\\\`\\n" + e.toString() + "\\n\\\`\\\`\\\`",
                type: "text/x-markdown",
                parent: this.parentTiddler,
                "stream-type": "default"
            }));
            this.appendToStream(this.parentTiddler, errTitle);
        } finally {
            if (btn) btn.classList.remove("ephemeral-running");
        }
        
        return true;
    }
    
    appendToStream(parentTitle, childTitle) {
        var parent = $tw.wiki.getTiddler(parentTitle);
        var list = parent ? ($tw.utils.parseStringArray(parent.fields["stream-list"]) || []) : [];
        if (!list.includes(childTitle)) {
            list.push(childTitle);
            $tw.wiki.addTiddler(new $tw.Tiddler(parent, {"stream-list": $tw.utils.stringifyList(list)}));
        }
    }
    
    generateUUID() {
        if (typeof crypto !== "undefined" && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }

    generateWhiteboardData(images) {
        const documentId = "doc";
        const pages = {};
        const assets = {};
        const pageStates = {};

        images.forEach((img, index) => {
            const i = index + 1;
            const uuidAsset = this.generateUUID();
            const uuidShape = this.generateUUID();
            const uuidPage = i === 1 ? "page" : this.generateUUID();

            pages[uuidPage] = {
                id: uuidPage,
                name: \`Page \${i}\`,
                childIndex: i,
                shapes: {},
                bindings: {}
            };

            assets[uuidAsset] = {
                id: uuidAsset,
                type: "image",
                fileName: img.filename,
                src: img.dataUri,
                size: [img.width, img.height]
            };

            pages[uuidPage].shapes[uuidShape] = {
                id: uuidShape,
                type: "image",
                name: "Image",
                parentId: uuidPage,
                childIndex: 1,
                point: [0, 0],
                size: [img.width, img.height],
                rotation: 0,
                style: {
                    color: "black",
                    size: "small",
                    isFilled: false,
                    dash: "draw",
                    scale: 1
                },
                assetId: uuidAsset,
                isLocked: true
            };

            const sidebarMargin = 0; 
            const topMargin = 50;
            const viewerWidth = 1200;
            const isPortrait = img.height > img.width;

            let zoom, viewerHeight;
            if (isPortrait) {
                zoom = 0.75;
                viewerHeight = 1056; 
            } else {
                viewerHeight = 540;
                zoom = Math.min(
                    (viewerWidth - sidebarMargin) / img.width,
                    (viewerHeight - topMargin) / img.height,
                    1
                );
            }

            pageStates[uuidPage] = {
                id: uuidPage,
                selectedIds: [],
                camera: {
                    point: [sidebarMargin / zoom, topMargin / zoom],
                    zoom: zoom
                }
            };
        });

        return {
            document: {
                id: documentId,
                name: "PDF Canvas",
                version: 15.5,
                pages: pages,
                pageStates: pageStates,
                assets: assets
            }
        };
    }
}

exports["action-ephemeral"] = ActionEphemeralWidget;
})();`
      },
      {
        "title": "~$:/plugins/lithic/ephemeral/codeblock-override",
        "tags": "$:/tags/Global",
        "text": `\\widget $codeblock(code, language)
<div class="wilk-copy-code-button">
	<$list filter="[<language>match[jspython]]" variable="ignore">
		<$button tooltip="Run Code" class="tc-btn-invisible run-jspython-btn">&gt;_
			<$set name="consoleTiddler" value={{{ [<currentTiddler>addsuffix[/console]] }}}>
				<$action-jspython code=<<code>> outputTiddler=<<consoleTiddler>> />
				<$action-listops $tiddler=<<currentTiddler>> $field="stream-list" $subfilter="[<consoleTiddler>]" />
				<$action-setfield $tiddler=<<consoleTiddler>> parent=<<currentTiddler>> />
			</$set>
		</$button>
	</$list>
	<$list filter="[<language>!match[jspython]]" variable="ignore">
		<$button tooltip="Run on Ephemeral API" class="tc-btn-invisible run-jspython-btn">&gt;_
			<$action-ephemeral code=<<code>> language=<<language>> parentTiddler=<<currentTiddler>> />
		</$button>
	</$list>
	<$button
	message="tm-copy-to-clipboard"
	param=<<code>>
	tooltip="Copy"
	class="tc-btn-invisible">
		{{$:/core/images/copy-clipboard}}
	</$button>
	<$genesis $type="$codeblock" $remappable="no" code=<<code>> language=<<language>>/>
</div>
\\end`
      },
      {
        "title": "$:/plugins/lithic/ephemeral/styles.css",
        "tags": "$:/tags/Stylesheet",
        "type": "text/vnd.tiddlywiki",
        "text": `
@keyframes ephemeral-bob {
    0% { transform: translateY(0px); color: <<colour foreground>>; }
    50% { transform: translateY(-3px); color: <<colour primary>>; }
    100% { transform: translateY(0px); color: <<colour foreground>>; }
}
.ephemeral-running {
    animation: ephemeral-bob 1s infinite ease-in-out !important;
}
`
      }
    ];

    /* --- CORE ENGINE FETCHER --- */
    const WEBDAV_UTILS_JS = `/*
title: $:/lithic/startup/webdav-utils.js
type: application/javascript
module-type: startup

WebDAV Utilities for Lithic
*/
(function(){
"use strict";
exports.name = "webdav-utils";
exports.platforms = ["browser"];
exports.after = ["startup"];
exports.synchronous = true;
exports.startup = function() {
    if(typeof window === "undefined") return;
    $tw.rootWidget.addEventListener("tm-lithic-stop-lock", function(event) {
        if (window.webdavStopHeartbeat) window.webdavStopHeartbeat();
        return false;
    });
};
})();`;

    async function fetchCoreEngine() {
      const pathsToTry = [
        '/src/lithic.html',
        'src/lithic.html',
        '/lithic.html',
        'lithic.html'
      ];

      for (const path of pathsToTry) {
        try {
          const res = await fetch(path);
          if (res.ok) {
            console.log(`[Lithic] Found core engine at: ${path}`);
            return await res.text();
          }
        } catch (e) {
          // Continue to next path
        }
      }

      // Fallback for local file:// execution where CORS blocks fetch
      console.log("[Lithic] Local fetch failed (likely CORS). Attempting to fetch core engine from GitHub...");
      try {
        const res = await fetch('https://raw.githubusercontent.com/Xyvir/Lithic-UK/refs/heads/main/src/lithic.html');
        if (res.ok) {
          const text = await res.text();
          await idbKeyval.set('cachedOnlineCoreEngine', text);
          return text;
        }
      } catch (e) {
        console.warn("[Lithic] Failed to fetch from GitHub (offline?).", e);
      }

      // Fallback to offline cache
      const cachedEngine = await idbKeyval.get('cachedOnlineCoreEngine');
      if (cachedEngine) {
        console.log("[Lithic] Using cached online core engine.");
        return cachedEngine;
      }

      throw new Error("Could not find lithic.html locally, could not reach GitHub, and no offline cache found.");
    }

    /* --- WEBDAV LOCKING (Presence) --- */
    async function webdavCheckLock(fileName) {
      try {
        const res = await fetch(WEBDAV_BASE + encodeURIComponent(fileName) + '.lock');
        if (res.status === 404) return null;
        if (!res.ok) return null;
        const lock = await res.json();
        // A lock is active if updated in the last 60s
        if (lock && lock.timestamp && (Date.now() - lock.timestamp < 60000)) {
          // If it's our own lock (same session), ignore it
          if (lock.sessionId === window.lithicSessionId) return null;
          return lock;
        }
        return null;
      } catch (e) { return null; }
    }

    let heartbeatInterval = null;
    async function webdavStartHeartbeat(fileName) {
      window.currentLockFileName = fileName;
      if (heartbeatInterval) clearInterval(heartbeatInterval);
      const updateLock = async () => {
        const lockData = {
          user: "Someone",
          timestamp: Date.now(),
          sessionId: window.lithicSessionId
        };
        try {
          await fetch(WEBDAV_BASE + encodeURIComponent(fileName) + '.lock', {
            method: 'PUT',
            body: JSON.stringify(lockData)
          });
        } catch (e) { }
      };
      await updateLock();
      heartbeatInterval = setInterval(updateLock, 30000);
    }

    function webdavStopHeartbeat() {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      if (window.currentLockFileName) {
        fetch(WEBDAV_BASE + encodeURIComponent(window.currentLockFileName) + '.lock', {
          method: 'DELETE',
          keepalive: true
        }).catch(() => { });
        window.currentLockFileName = null;
      }
    }
    window.webdavStopHeartbeat = webdavStopHeartbeat;

    window.addEventListener('beforeunload', () => {
      if (window.currentLockFileName) {
        // Use synchronous-ish fetch if allowed or just fire and forget
        webdavStopHeartbeat();
      }
    });

    /* --- WEBDAV MODE HELPERS --- */
    const WEBDAV_BASE = '/sync/';

    async function webdavPropfind() {
      const res = await fetch(WEBDAV_BASE, {
        method: 'PROPFIND',
        headers: { 'Depth': '1' }
      });
      if (!res.ok) throw new Error('PROPFIND failed: ' + res.status);

      const xmlText = await res.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(xmlText, 'application/xml');

      const files = [];
      const responses = doc.getElementsByTagNameNS('DAV:', 'response');

      for (const resp of responses) {
        const href = resp.getElementsByTagNameNS('DAV:', 'href')[0]?.textContent || '';
        const decodedHref = decodeURIComponent(href);

        // Skip the collection itself
        if (decodedHref.endsWith('/')) continue;

        // Only include .lith files
        if (!decodedHref.toLowerCase().endsWith('.lith')) continue;

        const fileName = decodedHref.split('/').pop();

        const lastModEl = resp.getElementsByTagNameNS('DAV:', 'getlastmodified')[0];
        const lastModified = lastModEl ? new Date(lastModEl.textContent) : null;

        files.push({ name: fileName, href: href, lastModified });
      }

      // Sort by last modified, newest first
      files.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));

      return files;
    }

    async function webdavUpload(fileName, body) {
      const res = await fetch(WEBDAV_BASE + encodeURIComponent(fileName), {
        method: 'PUT',
        body: body
      });
      if (!res.ok && res.status !== 201 && res.status !== 204) {
        throw new Error('PUT failed: ' + res.status);
      }
      return res;
    }

    async function webdavDelete(fileName) {
      const res = await fetch(WEBDAV_BASE + encodeURIComponent(fileName), {
        method: 'DELETE'
      });
      if (!res.ok && res.status !== 204) {
        throw new Error('DELETE failed: ' + res.status);
      }
      return res;
    }

    function createWebdavSaver(fileName) {
      return function (text, method, callback) {
        let jsonText;
        try {
          const defaultPlugins = [
              "ahanniga/context-menu-plugin",
              "bj/Calendar",
              "bj/unieditor",
              "byper/advanced-search",
              "flibbles/relink",
              "flibbles/relink-markdown",
              "flibbles/relink-titles",
              "kebi/relink-tweaks",
              "kebi/tiddlystudy",
              "kebi/tiddlystudy-references",
              "kookma/quickview",
              "linonetwo/tw-react",
              "linonetwo/tw-whiteboard",
              "mklauber/aliases",
              "nico/notebook-mobile",
              "oeyoews/notebook-theme-sidebar-resizer",
              "orange/mermaid-tw5",
              "snowgoon88/edit-comptext",
              "sq/streams",
              "tiddlywiki/dynaview",
              "tiddlywiki/freelinks",
              "tiddlywiki/highlight",
              "tiddlywiki/katex",
              "tiddlywiki/markdown",
              "xyvir/anchors-for-streams",
              "xyvir/lithic-core",
              "xyvir/lithic-default-configs",
              "xyvir/lithic-patch-appear",
              "xyvir/lithic-patch-calendar",
              "xyvir/lithic-patch-comptext",
              "xyvir/lithic-patch-markdown",
              "xyvir/lithic-patch-streams",
              "xyvir/lithic-patch-whiteboard",
              "xyvir/lithic-pdf-to-whiteboard",
              "xyvir/lithic-python-codeblocks",
              "xyvir/lithic-richlinks",
              "xyvir/lithic-tweaks",
              "xyvir/lithic-wikitext-highlight",
              "xyvir/tw-jspython"
            ];
          const pluginExclusions = defaultPlugins.map(p => `-[[$:/plugins/${p}]]`).join(' ');
          const baseFilter = "[all[tiddlers]!is[system]] [all[tiddlers]is[system]!prefix[$:/core]!prefix[$:/themes]!prefix[$:/temp]!prefix[$:/state]!prefix[$:/HistoryList]] [is[shadow]] -[prefix[$:/boot/]] -[[$:/isEncrypted]] -[[$:/library/sjcl.js]] -[[$:/status/RequireReloadDueToPluginChange]] -[[$:/StoryList]] -[[$:/config/PageControlButtons/Visibility/$:/core/ui/Buttons/new-journal]] -[[$:/lithic/startup/webdav-utils.js]]";
          const userTiddlerFilter = `${baseFilter} ${pluginExclusions}`;
          jsonText = window.$tw.wiki.getTiddlersAsJson(userTiddlerFilter);
          const lithContent = serializeJsonToLith(jsonText);

          fetch(WEBDAV_BASE + encodeURIComponent(fileName), {
            method: 'PUT',
            body: lithContent
          }).then(res => {
            if (res.ok || res.status === 201 || res.status === 204) {
              saveSearchCache(fileName, jsonText);
              callback(null);
            } else {
              callback('WebDAV save failed: ' + res.status);
            }
          }).catch(err => {
            console.error("WebDAV save failed:", err);
            callback(err.message || err);
          });
        } catch (e) {
          console.error("Lithic Launcher: Failed to extract payload for WebDAV save.", e);
          callback("Data extraction failed: " + e.message);
        }
        return true;
      };
    }

    async function webdavOpenFile(fileName) {
      if (document.getElementById('loading-overlay')) document.getElementById('loading-overlay').style.display = 'flex';

      const proceed = async (readOnly = false) => {
        try {
          const res = await fetch(WEBDAV_BASE + encodeURIComponent(fileName));
          if (!res.ok) throw new Error('Failed to fetch file: ' + res.status);
          let contents = await res.text();

          let coreHtml = await fetchCoreEngine();

          // Parse lith content. If the file is actually a raw JSON array (e.g. uploaded
          // as .json then renamed, or an older format), fall back to JSON parsing so
          // it doesn't produce a single "super-tiddler" with all the rawtext.
          let tiddlers = parseLithToJSON(contents);
          if (tiddlers.length === 0 || (tiddlers.length === 1 && !tiddlers[0].title && contents.trim().startsWith('['))) {
            try {
              const jsonParsed = JSON.parse(contents);
              if (Array.isArray(jsonParsed) && jsonParsed.length > 0) {
                tiddlers = jsonParsed;
                console.log('[Lithic] File appeared to be JSON-in-lith; parsed as JSON array.');
              }
            } catch (e) { /* not JSON, stick with lith parse result */ }
          }
          const tiddlerArrayText = JSON.stringify(tiddlers);

          if (tiddlers.length > 0) {
            const stripped = tiddlerArrayText.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
            coreHtml = coreHtml.replace(/(<script class="tiddlywiki-tiddler-store" type="application\/json">\[)([\s\S]*?)(\]\s*<\/script>)/is, (match, p1, p2, p3) => {
              const hasItems = p2.trim().length > 0;
              return p1 + p2 + (hasItems ? ',' : '') + stripped + p3;
            });
          }

          // Populate search cache
          await saveSearchCache(fileName, tiddlerArrayText);

          if (readOnly) {
            // In Read-Only, we do NOT set $tw.customSaver and we disable autosaver
            window.pendingImports.push({ title: "$:/state/DisableAutoSaver", text: "yes" });
          } else {
            // Set up WebDAV saver
            window.$tw = { customSaver: { save: createWebdavSaver(fileName) } };
            // Acquire lock
            webdavStartHeartbeat(fileName).catch(console.error);
            // Inject cleanup helper
            window.pendingImports.push({
              title: "$:/lithic/startup/webdav-utils.js",
              text: WEBDAV_UTILS_JS,
              type: "application/javascript",
              "module-type": "startup"
            });
            // Inject Ephemeral integration
            window.pendingImports.push(...EPHEMERAL_INTEGRATION_JSON);
          }

          replacePageContents(coreHtml, true);
        } catch (err) {
          if (document.getElementById('loading-overlay')) document.getElementById('loading-overlay').style.display = 'none';
          console.error("Failed to open remote file:", err);
          alert("Failed to open remote file. See console for details.");
        }
      };

      try {
        // 1. Check for existing lock
        const existingLock = await webdavCheckLock(fileName);

        if (existingLock) {
          const modal = document.getElementById('collision-modal');
          const msg = document.getElementById('collision-message');
          msg.innerHTML = `Another user is currently editing <b>${fileName}</b>. Opening it may lead to data loss as Lithic does not support collaboration (last-write-wins).`;
          modal.style.display = 'flex';

          document.getElementById('collision-btn-readonly').onclick = () => {
            modal.style.display = 'none';
            if (document.getElementById('loading-overlay')) document.getElementById('loading-overlay').style.display = 'flex';
            proceed(true);
          };

          document.getElementById('collision-btn-ignore').onclick = () => {
            modal.style.display = 'none';
            if (document.getElementById('loading-overlay')) document.getElementById('loading-overlay').style.display = 'flex';
            proceed(false);
          };
        } else {
          await proceed(false);
        }
      } catch (err) {
        if (document.getElementById('loading-overlay')) document.getElementById('loading-overlay').style.display = 'none';
        console.error("Lock check failed:", err);
        await proceed(false); // Fallback to normal if lock check fails
      }
    }

    /* Saver Logic */
    function createTwCustomSaver(fileHandle, isJsonMode = false) {
      return function (text, method, callback) {
        let textToWrite = text;
        let jsonText;

        if (isJsonMode) {
          try {
            const defaultPlugins = [
              "ahanniga/context-menu-plugin",
              "bj/Calendar",
              "bj/unieditor",
              "byper/advanced-search",
              "flibbles/relink",
              "flibbles/relink-markdown",
              "flibbles/relink-titles",
              "kebi/relink-tweaks",
              "kebi/tiddlystudy",
              "kebi/tiddlystudy-references",
              "kookma/quickview",
              "linonetwo/tw-react",
              "linonetwo/tw-whiteboard",
              "mklauber/aliases",
              "nico/notebook-mobile",
              "oeyoews/notebook-theme-sidebar-resizer",
              "orange/mermaid-tw5",
              "snowgoon88/edit-comptext",
              "sq/streams",
              "tiddlywiki/dynaview",
              "tiddlywiki/freelinks",
              "tiddlywiki/highlight",
              "tiddlywiki/katex",
              "tiddlywiki/markdown",
              "xyvir/anchors-for-streams",
              "xyvir/lithic-core",
              "xyvir/lithic-default-configs",
              "xyvir/lithic-patch-appear",
              "xyvir/lithic-patch-calendar",
              "xyvir/lithic-patch-comptext",
              "xyvir/lithic-patch-markdown",
              "xyvir/lithic-patch-streams",
              "xyvir/lithic-patch-whiteboard",
              "xyvir/lithic-pdf-to-whiteboard",
              "xyvir/lithic-python-codeblocks",
              "xyvir/lithic-richlinks",
              "xyvir/lithic-tweaks",
              "xyvir/lithic-wikitext-highlight",
              "xyvir/tw-jspython"
            ];
            const pluginExclusions = defaultPlugins.map(p => `-[[$:/plugins/${p}]]`).join(' ');
            const baseFilter = "[all[tiddlers]!is[system]] [all[tiddlers]is[system]!prefix[$:/core]!prefix[$:/themes]!prefix[$:/temp]!prefix[$:/state]!prefix[$:/HistoryList]] [is[shadow]] -[prefix[$:/boot/]] -[[$:/isEncrypted]] -[[$:/library/sjcl.js]] -[[$:/status/RequireReloadDueToPluginChange]] -[[$:/StoryList]] -[[$:/config/PageControlButtons/Visibility/$:/core/ui/Buttons/new-journal]] -[[$:/lithic/startup/webdav-utils.js]]";

            const userTiddlerFilter = `${baseFilter} ${pluginExclusions}`;
            jsonText = window.$tw.wiki.getTiddlersAsJson(userTiddlerFilter);

            if (fileHandle && fileHandle.name.endsWith('.lith')) {
              textToWrite = serializeJsonToLith(jsonText);
            } else {
              textToWrite = jsonText;
            }
          } catch (e) {
            console.error("Lithic Launcher: Failed to extract payload from live TW engine.", e);
            callback("Data extraction failed: " + e.message);
            return true;
          }
        }

        fileHandle.createWritable()
          .then(writable => { writable.write(textToWrite); return writable; })
          .then(writable => {
            writable.close();
            if (isJsonMode) {
              saveSearchCache(fileHandle.name, jsonText);
            }
            callback(null);
          })
          .catch(err => {
            if (err.name === 'AbortError') {
              console.log("Save operation aborted by user");
            } else {
              console.error("Save failed", err);
              callback(err);
            }
          });
        return true;
      }
    }

    function setTwCustomSaver(fileHandle, isJsonMode = false) {
      window.$tw = { customSaver: { save: createTwCustomSaver(fileHandle, isJsonMode) } };
    }

    function setTwCustomSaveAsSaver(isJsonMode = false) {
      let writeTw;
      let save = function (text, method, callback) {
        if (writeTw) {
          writeTw(text, method, callback);
        } else {
          const saveOptions = isJsonMode ? {
            suggestedName: 'new.lith',
            types: [
              { description: 'Lithic Monolith', accept: { 'application/x-lith': ['.lith'] } }
            ],
          } : {
            suggestedName: 'lith.html',
            types: [{ description: 'Lithic HTML File', accept: { 'text/html': ['.html', '.htm'] } }],
          };

          window.showSaveFilePicker(saveOptions)
            .then(fileHandle => {
              writeTw = createTwCustomSaver(fileHandle, isJsonMode);
              writeTw(text, method, callback);
              twFileManager.addRecent(fileHandle, null); // Manual Save As doesn't have a tauriPath link

              // SUCCESS: Clear the suppression lock once we have a file handle!
              if (window.$tw && window.$tw.wiki) {
                window.$tw.wiki.deleteTiddler("$:/state/DisableAutoSaver");
              }
            })
            .catch(err => {
              if (err.name === 'AbortError') {
                console.log("Save As dialog cancelled by user");
              } else {
                console.error("Save failed", err);
                callback(err);
              }
            });
        }
        return true;
      }
      if (!window.$tw) window.$tw = {};
      window.$tw.customSaver = { save: save };
    }

    const twFileManager = {
      openFile: async function (fileHandle) {
        let isJsonMode = false;
        if (fileHandle) {
          const options = { mode: 'read' };
          if ((await fileHandle.queryPermission(options)) !== 'granted') {
            await fileHandle.requestPermission(options);
          }
          isJsonMode = fileHandle.name.endsWith('.lith') || fileHandle.name.endsWith('.json');
        } else {
          const openOptions = {
            types: [
              { description: 'Lithic Monolith', accept: { 'application/x-lith': ['.lith'] } },
              { description: 'Lithic JSON Backups', accept: { 'application/json': ['.json'] } },
              { description: 'Lithic HTML Files', accept: { 'text/html': ['.html', '.htm'] } }
            ]
          };
          [fileHandle] = await window.showOpenFilePicker(openOptions);
          isJsonMode = fileHandle.name.endsWith('.lith') || fileHandle.name.endsWith('.json');
        }

        const file = await fileHandle.getFile();
        let contents = await file.text();

        if (isJsonMode) {
          let coreHtml = await fetchCoreEngine();

          let tiddlerArrayText = "";
          if (fileHandle && fileHandle.name.endsWith('.lith')) {
            const tiddlers = parseLithToJSON(contents);
            tiddlerArrayText = JSON.stringify(tiddlers);
          } else {
            tiddlerArrayText = contents.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
          }

          if (tiddlerArrayText) {
            // Strip leading '[' and trailing ']' if it is a JSON array string
            tiddlerArrayText = tiddlerArrayText.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
            contents = coreHtml.replace(/\]\s*<\/script>/is, () => ',' + tiddlerArrayText + ']<\/script>');
          } else {
            contents = coreHtml;
          }
        }

        setTwCustomSaver(fileHandle, isJsonMode);
        return { fileHandle, contents, isJsonMode };
      },

      addRecent: async function (fileHandle, tauriPath = null) {
        let recentFiles = (await idbKeyval.get('recentFiles')) || [];

        // --- Schema Migration & Validation ---
        // Ensure all stored items are { handle, tauriPath }
        recentFiles = recentFiles.map(f => f.handle ? f : { handle: f, tauriPath: null });

        if (!fileHandle || !fileHandle.isSameEntry) return recentFiles;

        const inList = await Promise.all(recentFiles.map((f) => fileHandle.isSameEntry(f.handle)));
        const existingIndex = inList.findIndex((val) => val);

        const newEntry = { handle: fileHandle, tauriPath };

        if (existingIndex !== -1) {
          // If we are passing a tauriPath now but it didn't have one before, update it.
          if (tauriPath) {
            recentFiles[existingIndex].tauriPath = tauriPath;
          }
          // Move to front
          const [moved] = recentFiles.splice(existingIndex, 1);
          recentFiles.unshift(moved);
        } else {
          recentFiles.unshift(newEntry);
        }

        if (recentFiles.length > 20) recentFiles.pop();
        idbKeyval.set('recentFiles', recentFiles);
        return recentFiles;
      },

      removeRecent: async function (fileHandleToRemove) {
        let recentFiles = (await idbKeyval.get('recentFiles')) || [];
        recentFiles = recentFiles.map(f => f.handle ? f : { handle: f, tauriPath: null });

        let newRecentFiles = [];
        for (let f of recentFiles) {
          if (f.handle.isSameEntry && !(await f.handle.isSameEntry(fileHandleToRemove))) {
            newRecentFiles.push(f);
          }
        }

        await idbKeyval.set('recentFiles', newRecentFiles);
        return newRecentFiles;
      },

      getRecent: async function () {
        let recentFiles = (await idbKeyval.get('recentFiles')) || [];
        // Map old schema on read
        return recentFiles.map(f => f.handle ? f : { handle: f, tauriPath: null });
      },

      clearRecent: async function () {
        await idbKeyval.del('recentFiles');
      }
    }

    function getTwTime() {
      const d = new Date();
      return d.getUTCFullYear() +
        String(d.getUTCMonth() + 1).padStart(2, '0') +
        String(d.getUTCDate()).padStart(2, '0') +
        String(d.getUTCHours()).padStart(2, '0') +
        String(d.getUTCMinutes()).padStart(2, '0') +
        String(d.getUTCSeconds()).padStart(2, '0') +
        String(d.getUTCMilliseconds()).padStart(3, '0');
    }

    function getOrdinalNum(n) {
      return n + (n > 0 ? ['th', 'st', 'nd', 'rd'][(n > 3 && n < 21) || n % 10 > 3 ? 0 : n % 10] : '');
    }

    function getTodayTitle() {
      const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
      const d = new Date();
      return `${getOrdinalNum(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()}`;
    }

    function replacePageContents(contents, isJsonMode = false) {
      if (contents) {
        // --- CONTEXT SENSITIVE AUTO-SAVER SUPPRESSION ---
        // If this is a new or injected wiki, we disable auto-save until the first manual save.
        if (isNewOrInjected) {
          window.pendingImports.push({ title: "$:/state/DisableAutoSaver", text: "yes" });
          isNewOrInjected = false; // Reset for the next engine mount
        }

        // --- EPHEMERAL INTEGRATION (local / file-access mode) ---
        // The WebDAV path injects EPHEMERAL_INTEGRATION_JSON itself when it
        // opens a read-write remote file. In local/file-access mode there is
        // no backend, so inject it here — the widget resolves a bastion from
        // swarm.json instead of the same-origin /ephemeral API path. Every
        // replacePageContents call mounts a FRESH engine, so re-inject on
        // each mount (mirrors the WebDAV branch, which pushes every open).
        if (!IS_WEBDAV) {
          window.pendingImports.push(...EPHEMERAL_INTEGRATION_JSON);
        }

        // --- INJECT PENDING IMPORTS ---
        if (window.pendingImports && window.pendingImports.length > 0) {
          console.log(`Injecting ${window.pendingImports.length} pending tiddlers...`);
          const jsonBundle = JSON.stringify(window.pendingImports);

          if (contents.includes('<script class="tiddlywiki-tiddler-store" type="application/json">')) {
            // Appending to an existing JSON store boot script.
            const items = jsonBundle.substring(1, jsonBundle.length - 1);
            contents = contents.replace(/(<script class="tiddlywiki-tiddler-store" type="application\/json">\[)([\s\S]*?)(\]\s*<\/script>)/is, (match, p1, p2, p3) => {
              const hasItems = p2.trim().length > 0;
              return p1 + p2 + (hasItems ? ',' : '') + items + p3;
            });
          } else {
            // Injecting a new script block before </body>
            const scriptTag = `<script class="tiddlywiki-tiddler-store" type="application/json">${jsonBundle}<\/script>`;
            contents = contents.replace(/<\/body>/i, () => scriptTag + '\n</body>');
          }

          window.pendingImports = []; // clear after injection
        }

        document.open();
        document.write(contents);
        document.close();
      }
    }

    window.clearPendingImports = function () {
      window.pendingImports = [];
      const win = document.getElementById("pending-imports-window");
      if (win) win.style.display = "none";
    }

    window.updatePendingImportsWindow = function () {
      const win = document.getElementById("pending-imports-window");
      const list = document.getElementById("pending-imports-list");
      if (!win || !list) return;

      if (window.pendingImports.length === 0) {
        win.style.display = "none";
        return;
      }

      list.innerHTML = "";
      // Grouping logic based on stream-list node paths could go here, 
      // but for simplicity we'll just list titles.
      window.pendingImports.forEach(tiddler => {
        const li = document.createElement("li");
        li.textContent = tiddler.title || "Untitled Payload";

        // Optional: dim stream sub-nodes if we can detect them
        if (tiddler.title && (tiddler.title.match(/^\d{14}-\d{3,4}$/) || tiddler['stream-type'])) {
          li.classList.add("subtiddler-list");
        }

        list.appendChild(li);
      });

      win.style.display = "flex";
    }

    window.openFile = async function (fileHandle) {
      if (document.getElementById('loading-overlay')) document.getElementById('loading-overlay').style.display = 'flex';
      try {
        const file = await twFileManager.openFile(fileHandle);
        replacePageContents(file.contents, file.isJsonMode);
        if (file.fileHandle) {
          // If a file picker was shown, this might be a brand new path we haven't seen during the boot linking
          // But usually we just pass `null` for the tauri path for manually opened files.
          // twFileManager.addRecent is idempotent so it's fine.
          await twFileManager.addRecent(file.fileHandle, null);
        }
        return file;
      } catch (err) {
        if (document.getElementById('loading-overlay')) document.getElementById('loading-overlay').style.display = 'none';
        if (err.name === 'AbortError') {
          console.log("User cancelled file selection");
          return;
        }
        console.error("Failed to mount Lithic:", err);
        alert("Failed to mount file. See console for details.");
      }
    }

    window.openFromUrl = async function (url) {
      if (document.getElementById('loading-overlay')) document.getElementById('loading-overlay').style.display = 'flex';
      try {
        let contents = await fetchCoreEngine(url);
        isNewOrInjected = true;
        setTwCustomSaveAsSaver(false);
        replacePageContents(contents, false);
      } catch (err) {
        if (document.getElementById('loading-overlay')) document.getElementById('loading-overlay').style.display = 'none';
        console.error("Failed to load engine HTML:", err);
        alert("Failed to load engine. See console for details.");
      }
    }

    async function bootSvelteHandoff() {
      const params = new URLSearchParams(window.location.search);
      if (!params.has('new') && !params.has('mount')) return false;
      window.history.replaceState({}, document.title, window.location.pathname);
      if (params.has('mount')) {
        // The Svelte launcher already supplied the selected bytes. Parse them
        // before booting the engine; openNewBlankLith then adds the normal
        // local saver and blank journal only when appropriate.
        const handoff = sessionStorage.getItem('lithic-launcher-file');
        if (handoff) {
          const data = JSON.parse(handoff);
          window.pendingImports.push(...parseLithToJSON(data.text || ''));
          sessionStorage.removeItem('lithic-launcher-file');
        }
      }
      window.openNewBlankLith();
      return true;
    }

    window.openNewBlankLith = async function () {
      if (document.getElementById('loading-overlay')) document.getElementById('loading-overlay').style.display = 'flex';
      try {
        let coreHtml = await fetchCoreEngine();
        isNewOrInjected = true;
        setTwCustomSaveAsSaver(true);
        const todayTitle = getTodayTitle();
        const twDate = getTwTime();
        // Only push a blank journal tiddler if one with the same title
        // isn't already queued (e.g. from a ?json= share URL payload).
        // Otherwise the blank entry overwrites the payload's fields
        // (stream-list, Dogear tag, etc.) during TiddlyWiki boot.
        const alreadyQueued = window.pendingImports.some(
          t => t.title === todayTitle
        );
        if (!alreadyQueued) {
          window.pendingImports.push({
            created: twDate,
            modified: twDate,
            tags: "Journal",
            title: todayTitle,
            type: ""
          });
        }
        replacePageContents(coreHtml, false);
      } catch (err) {
        if (document.getElementById('loading-overlay')) document.getElementById('loading-overlay').style.display = 'none';
        console.error("Failed to load New Blank Lith:", err);
        alert("Failed to create new blank lith. See console for details.");
      }
    }

    function clearRecent() {
      twFileManager.getRecent().then(recentFiles => {
        if (recentFiles && recentFiles.length > 0) {
          const promises = [];
          recentFiles.forEach(r => {
            if (r.handle && r.handle.name) {
              const name = r.handle.name;
              promises.push(idbKeyval.del('search_cache_' + name));
              promises.push(idbKeyval.del('search_cache_bk1_' + name));
              promises.push(idbKeyval.del('search_cache_bk2_' + name));
            }
          });
          return Promise.all(promises);
        }
        return Promise.resolve();
      }).then(() => {
        return twFileManager.clearRecent();
      }).then(() => {
        const elem = document.getElementById("recent-files");
        if (elem) elem.innerHTML = "";
      });
    }
    window.clearRemoteSearchCache = async function () {
      if (!confirm('Are you sure? This will clear all local search caches and backups for your remote files. The remote files themselves will NOT be affected.')) return;

      try {
        const files = await webdavPropfind();
        const promises = [];
        files.forEach(f => {
          const name = f.name;
          promises.push(idbKeyval.del('search_cache_' + name));
          promises.push(idbKeyval.del('search_cache_bk1_' + name));
          promises.push(idbKeyval.del('search_cache_bk2_' + name));
        });
        await Promise.all(promises);
        displayRemoteFiles(); // Refresh to update icons
      } catch (err) {
        console.error('Failed to clear search cache:', err);
      }
    };


    const mobilePreviewQuery = window.matchMedia('(max-width: 950px)');

    window.updatePreviewsPosition = function () {
      if (mobilePreviewQuery.matches) return;
      const container = document.querySelector('.container');
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const rightX = containerRect.right + 10;

      const listItems = document.querySelectorAll('#recent-files ul li');
      listItems.forEach(li => {
        const previewDiv = li.querySelector('.search-preview');
        if (li.style.display !== 'none' && previewDiv && previewDiv.style.display === 'block') {
          const rect = li.getBoundingClientRect();
          const ul = li.closest('ul');
          const ulRect = ul.getBoundingClientRect();

          if (rect.bottom < ulRect.top || rect.top > ulRect.bottom) {
            previewDiv.style.opacity = '0';
          } else {
            previewDiv.style.position = 'fixed';
            previewDiv.style.left = rightX + 'px';
            previewDiv.style.top = (rect.top + rect.height / 2) + 'px';
            previewDiv.style.transform = 'translateY(-50%)';
            previewDiv.style.opacity = '1';
          }
        }
      });
    };

    window.openIntro = async function (e) {
      e.preventDefault();

      const el = e.currentTarget;
      const originalHtml = el.innerHTML;
      el.innerHTML = '...';
      el.style.pointerEvents = 'none';

      let targetUrl = (window.location.protocol === 'file:')
        ? 'https://raw.githubusercontent.com/Xyvir/Lithic-UK/refs/heads/main/intro.lith'
        : '/intro.lith';

      try {
        const res = await fetch(targetUrl);
        if (res.ok) {
          const text = await res.text();
          let parsedData;
          try {
            parsedData = JSON.parse(text);
          } catch (e) {
            parsedData = parseLithToJSON(text);
          }

          if (Array.isArray(parsedData) && parsedData.length > 0) {
            let node = parsedData[0];
            node.tags = node.tags ? [...new Set([...(Array.isArray(node.tags) ? node.tags : (typeof node.tags === 'string' ? node.tags.split(' ') : [])), 'Dogear'])].join(' ') : 'Dogear';

            window.pendingImports = window.pendingImports.concat(parsedData);
            window.openNewBlankLith();

            el.innerHTML = originalHtml;
            el.style.pointerEvents = 'auto';
            return;
          }
        }
      } catch (err) {
        console.warn("Failed to load intro.lith:", err);
      }

      // Fallback
      if (navigator.onLine) {
        window.open('https://lithic.uk/intro.html', '_blank');
      } else {
        alert("Could not load introduction. You appear to be offline and the local intro file is missing.");
      }

      el.innerHTML = originalHtml;
      el.style.pointerEvents = 'auto';
    };

    window.handleSearchKeydown = function (e, inputElem) {
      if (e.key === 'Escape') {
        e.preventDefault();
        inputElem.value = '';
        window.handleSearch('');
        inputElem.focus();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const listItems = document.querySelectorAll('#recent-files ul li');
        for (const li of listItems) {
          if (li.style.display !== 'none') {
            // Find the main actionable button, ignoring cache/remove utility buttons
            const btn = li.querySelector('button:not(.cache-icon-btn):not(.remove-item-btn)');
            if (btn) {
              btn.click();
              break;
            }
          }
        }
      }
    };

    window.handleSearch = function (query) {
      window.currentSearchTick = query;
      const q = query.toLowerCase();
      const listItems = document.querySelectorAll('#recent-files ul li');
      if (!listItems) return;

      listItems.forEach(li => {
        const fileBtn = li.querySelector('button');
        if (!fileBtn) return;

        const labelSpan = fileBtn.querySelector('.file-name-label');
        let rawText = labelSpan ? labelSpan.textContent : fileBtn.innerText;
        let fileNameMatch = rawText.trim();
        if (fileNameMatch.endsWith(' (Linked)')) fileNameMatch = fileNameMatch.slice(0, -9);

        const previewDiv = li.querySelector('.search-preview');

        const escapeHtml = (str) => str.replace(/</g, '&lt;').replace(/>/g, '&gt;');

        if (!q) {
          if (labelSpan) labelSpan.innerHTML = escapeHtml(rawText);
          li.style.display = 'flex';
          if (previewDiv) { previewDiv.style.display = 'none'; previewDiv.style.opacity = '0'; }
          return;
        }

        let nameMatches = fileNameMatch.toLowerCase().includes(q);

        if (labelSpan) {
          let lowerText = rawText.toLowerCase();
          let matchIdx = lowerText.indexOf(q);
          if (matchIdx !== -1) {
            let before = rawText.substring(0, matchIdx);
            let match = rawText.substring(matchIdx, matchIdx + q.length);
            let after = rawText.substring(matchIdx + q.length);
            labelSpan.innerHTML = escapeHtml(before) + `<span style="color:var(--accent-color);">${escapeHtml(match)}</span>` + escapeHtml(after);
          } else {
            labelSpan.innerHTML = escapeHtml(rawText);
          }
        }

        idbKeyval.get('search_cache_' + fileNameMatch).then(cache => {
          if (window.currentSearchTick !== query) return;
          if (!cache || !cache.text) {
            li.style.display = nameMatches ? 'flex' : 'none';
            if (previewDiv) { previewDiv.style.display = 'none'; previewDiv.style.opacity = '0'; }
            return;
          }

          let cleanText = cache.text.replace(/(\\n|\n|\r)/g, ' ');
          let textLower = cleanText.toLowerCase();
          let matchIndex = textLower.indexOf(q);

          if (matchIndex !== -1) {
            li.style.display = 'flex';
            if (previewDiv && !mobilePreviewQuery.matches) {
              const L = 46;
              let charsBeforeMatchInLine2 = Math.floor((L - q.length) / 2);
              let charsAfterMatchInLine2 = L - q.length - charsBeforeMatchInLine2;

              let requiredBefore = L + charsBeforeMatchInLine2;
              let requiredAfter = charsAfterMatchInLine2 + L;

              let actualBefore = Math.min(requiredBefore, matchIndex);
              let actualAfter = Math.min(requiredAfter, cleanText.length - (matchIndex + q.length));

              let missingBefore = requiredBefore - actualBefore;
              let missingAfter = requiredAfter - actualAfter;

              let textBefore = cleanText.substring(matchIndex - actualBefore, matchIndex);
              let textMatch = cleanText.substring(matchIndex, matchIndex + q.length);
              let textAfter = cleanText.substring(matchIndex + q.length, matchIndex + q.length + actualAfter);

              if (missingBefore > 0) textBefore = '.'.repeat(missingBefore) + textBefore;
              if (missingAfter > 0) textAfter = textAfter + '.'.repeat(missingAfter);

              let escapeHtml = (str) => str.replace(/</g, '&lt;').replace(/>/g, '&gt;');

              let line1 = textBefore.substring(0, L);
              let line2Front = textBefore.substring(L);
              let line2Back = textAfter.substring(0, charsAfterMatchInLine2);
              let line3 = textAfter.substring(charsAfterMatchInLine2);

              let tiddlerTitle = "";
              let titleSearchText = cache.text.substring(0, matchIndex);
              let idx = titleSearchText.lastIndexOf('"title":');
              if (idx !== -1) {
                let startTitle = titleSearchText.indexOf('"', idx + 8);
                if (startTitle !== -1) {
                  let endTitle = -1;
                  for (let i = startTitle + 1; i < titleSearchText.length; i++) {
                    if (titleSearchText[i] === '"' && titleSearchText[i - 1] !== '\\') {
                      endTitle = i;
                      break;
                    }
                  }
                  if (endTitle !== -1) {
                    tiddlerTitle = titleSearchText.substring(startTitle + 1, endTitle).replace(/\\"/g, '"');
                  }
                }
              }

              let line1Html = escapeHtml(line1);
              if (tiddlerTitle) {
                let prefix = tiddlerTitle + ' ';
                if (prefix.length > L) prefix = prefix.substring(0, L - 3) + '...';
                let pLen = prefix.length;
                line1Html = `<b style="color:var(--accent-color)">${escapeHtml(prefix)}</b>` + escapeHtml(line1.substring(pLen));
              }

              previewDiv.innerHTML =
                line1Html + '<br>' +
                escapeHtml(line2Front) + '<mark>' + escapeHtml(textMatch) + '</mark>' + escapeHtml(line2Back) + '<br>' +
                escapeHtml(line3);

              previewDiv.onclick = (e) => {
                e.stopPropagation();
                if (tiddlerTitle) {
                  try {
                    const tiddlers = JSON.parse(cache.text);
                    let existingPinFile = tiddlers.find(t => t.title === "$:/config/TiddlyTools/Pin");
                    let currentList = existingPinFile && existingPinFile.list ? existingPinFile.list : "";

                    let items = [];
                    let regex = /\[\[(.*?)\]\]|(\S+)/g;
                    let matchVar;
                    while ((matchVar = regex.exec(currentList)) !== null) {
                      let val = matchVar[1] || matchVar[2];
                      if (val !== tiddlerTitle) items.push(matchVar[0]);
                    }

                    let titleForList = tiddlerTitle.includes(" ") ? `[[${tiddlerTitle}]]` : tiddlerTitle;
                    items.unshift(titleForList);

                    let payload = existingPinFile ? { ...existingPinFile, list: items.join(' ') } : { title: "$:/config/TiddlyTools/Pin", list: items.join(' ') };
                    window.pendingImports.push(payload);
                  } catch (err) {
                    console.log("Could not parse pin config from cache:", err);
                  }
                }
                fileBtn.click();
              };

              previewDiv.style.display = 'block';
              window.updatePreviewsPosition();
            }
          } else if (nameMatches) {
            li.style.display = 'flex';
            if (previewDiv) { previewDiv.style.display = 'none'; previewDiv.style.opacity = '0'; }
          } else {
            li.style.display = 'none';
            if (previewDiv) { previewDiv.style.display = 'none'; previewDiv.style.opacity = '0'; }
          }
        });
      });
      setTimeout(window.updatePreviewsPosition, 20);
    };

    window.openBookmarkModal = function () {
      const input = document.getElementById('bookmark-url-input');
      input.value = '';
      document.getElementById('bookmark-modal').style.display = 'flex';
      setTimeout(() => {
        input.focus();
        input.onkeydown = (e) => { if (e.key === 'Enter') window.saveBookmark(); };
      }, 100);
    };

    window.saveBookmark = async function () {
      let urlStr = document.getElementById('bookmark-url-input').value.trim();
      if (!urlStr) return;

      if (!urlStr.startsWith('http://') && !urlStr.startsWith('https://')) {
        urlStr = 'https://' + urlStr;
      }

      try {
        const urlObj = new URL(urlStr);
        const normalizedUrl = urlObj.origin;

        let requiresManualConfirm = false;

        if (document.getElementById('global-loading-overlay')) {
          document.getElementById('global-loading-text').innerText = "Verifying Instance...";
          document.getElementById('global-loading-overlay').style.display = 'flex';
        }

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000);

          const res = await fetch(normalizedUrl + '/manifest.json', { method: 'GET', signal: controller.signal });
          clearTimeout(timeoutId);

          if (res.ok) {
            const manifest = await res.json();
            if (manifest && (manifest.name === "Lithic" || manifest.short_name === "Lithic")) {
              // Validated perfectly via manifest!
            } else {
              if (document.getElementById('global-loading-overlay')) document.getElementById('global-loading-overlay').style.display = 'none';
              alert("The provided URL has a manifest.json but it does not appear to be a Lithic instance.");
              return;
            }
          } else if (res.status === 401 || res.status === 403) {
            // Basic auth or forbidden
            requiresManualConfirm = true;
          } else {
            if (document.getElementById('global-loading-overlay')) document.getElementById('global-loading-overlay').style.display = 'none';
            alert(`The server returned an error (${res.status}). Please check the URL.`);
            return;
          }
        } catch (err) {
          // CORS error, network error, invalid JSON, or timeout
          if (document.getElementById('global-loading-overlay')) document.getElementById('global-loading-overlay').style.display = 'none';
          alert("The provided URL could not be verified. It may not be a Lithic instance, or it may be blocking access via CORS.");
          return;
        }

        if (document.getElementById('global-loading-overlay')) document.getElementById('global-loading-overlay').style.display = 'none';

        if (requiresManualConfirm) {
          if (!confirm(`We couldn't verify the manifest (it appears to be protected by Basic Authentication or Forbidden).\n\nAre you sure you want to bookmark ${normalizedUrl}?`)) {
            return;
          }
        }

        let bookmarks = (await idbKeyval.get('bookmarkedInstances')) || [];
        if (!bookmarks.includes(normalizedUrl)) {
          bookmarks.push(normalizedUrl);
          await idbKeyval.set('bookmarkedInstances', bookmarks);
        }
        document.getElementById('bookmark-modal').style.display = 'none';
        displayRecentFiles();
      } catch (e) {
        if (document.getElementById('global-loading-overlay')) document.getElementById('global-loading-overlay').style.display = 'none';
        alert("Please enter a valid URL.");
      }
    };

    window.removeBookmark = async function (urlToRemove) {
      let bookmarks = (await idbKeyval.get('bookmarkedInstances')) || [];
      bookmarks = bookmarks.filter(u => u !== urlToRemove);
      await idbKeyval.set('bookmarkedInstances', bookmarks);
      displayRecentFiles();
    };

    function displayRecentFiles() {
      const elem = document.getElementById("recent-files");
      if (elem) {
        Promise.all([
          twFileManager.getRecent(),
          idbKeyval.get('bookmarkedInstances')
        ]).then(([recentFiles, bookmarks]) => {
          if ((recentFiles && recentFiles.length > 0) || (bookmarks && bookmarks.length > 0)) {
            elem.innerHTML = "";
            const sectionDiv = document.createElement('div');
            sectionDiv.className = 'section';

            const searchContainer = document.createElement('div');
            searchContainer.className = 'search-container';
            searchContainer.innerHTML = `
                <input type="text" class="search-input" placeholder="Search recent liths..." oninput="handleSearch(this.value)" onkeydown="handleSearchKeydown(event, this)">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
                <button type="button" class="search-clear-btn" onclick="const i=this.previousElementSibling.previousElementSibling; i.value=''; handleSearch(''); i.focus();" title="Clear search">&times;</button>
              `;
            sectionDiv.appendChild(searchContainer);

            const list = document.createElement('ul');

            if (bookmarks && bookmarks.length > 0) {
              for (const url of bookmarks) {
                const li = document.createElement('li');

                const button = document.createElement('button');
                button.type = 'button';
                button.style.display = 'flex';
                button.style.alignItems = 'center';
                button.style.gap = '10px';
                button.style.paddingLeft = '10px';

                const iconUrl = url + (url.endsWith('/') ? '' : '/') + 'favicon.ico';
                const displayUrl = url.replace(/^https?:\/\//, '');
                button.innerHTML = `<img src="${iconUrl}" style="width:16px;height:16px;border-radius:3px;" onerror="this.outerHTML='<svg viewBox=\\'0 0 24 24\\' width=\\'16\\' height=\\'16\\' fill=\\'none\\' stroke=\\'currentColor\\' stroke-width=\\'2\\' stroke-linecap=\\'round\\' stroke-linejoin=\\'round\\'><path d=\\'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71\\'></path><path d=\\'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71\\'></path></svg>'"> <span class="file-name-label" style="flex-grow:1; text-align:left; overflow:hidden; text-overflow:ellipsis;">${displayUrl}</span>`;
                button.onclick = () => {
                  window.location.href = url;
                };

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.innerHTML = '&times;';
                removeBtn.className = 'remove-item-btn';
                removeBtn.title = "Remove bookmark";
                removeBtn.onclick = async (e) => {
                  e.stopPropagation();
                  window.removeBookmark(url);
                };

                const previewDiv = document.createElement('div');
                previewDiv.className = 'search-preview';

                li.appendChild(button);
                li.appendChild(removeBtn);
                li.appendChild(previewDiv);
                list.appendChild(li);
              }
            }

            if (recentFiles && recentFiles.length > 0) {
              for (const recent of recentFiles) {
                const li = document.createElement('li');

                const button = document.createElement('button');
                button.type = 'button';
                button.innerHTML = `<span class="file-name-label">${recent.handle.name + (recent.tauriPath ? ' (Linked)' : '')}</span>`;
                button.onclick = () => window.openFile(recent.handle);

                const cacheBtn = document.createElement('button');
                cacheBtn.type = 'button';
                cacheBtn.className = 'cache-icon-btn';
                cacheBtn.title = "No search cache found for this file.";
                cacheBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;"><ellipse cx="9" cy="5" rx="6" ry="2.5"/><path d="M3 5v4c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V5"/><path d="M3 9v4c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V9"/><circle cx="19" cy="17" r="3"/><line x1="21.2" y1="19.2" x2="22.5" y2="20.5"/></svg>`;

                idbKeyval.get('search_cache_' + recent.handle.name).then(cache => {
                  if (cache && cache.text) {
                    cacheBtn.classList.add('has-cache');
                    cacheBtn.title = `Browser Storage Search Cache\n(Last updated: ${cache.lastModified})\nClick to download for disaster recovery.`;
                    cacheBtn.onclick = async (e) => {
                      e.stopPropagation();
                      const name = recent.handle.name;
                      const keys = ['search_cache_' + name, 'search_cache_bk1_' + name, 'search_cache_bk2_' + name];
                      for (let i = 0; i < keys.length; i++) {
                        const cache = await idbKeyval.get(keys[i]);
                        if (cache && cache.text) {
                          let textToDownload = cache.text;
                          if (textToDownload && textToDownload.trim().startsWith('[')) {
                            textToDownload = serializeJsonToLith(textToDownload);
                          }
                          const blob = new Blob([textToDownload], { type: 'application/x-lith' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          const suffix = i === 0 ? '_recovered' : `_bk${i}`;
                          a.download = name.replace(/\.lith$/, '') + `${suffix}.lith`;
                          a.click();
                          URL.revokeObjectURL(url);
                          if (i < keys.length - 1) await new Promise(r => setTimeout(r, 200));
                        }
                      }
                    };
                  }
                });

                const removeBtn = document.createElement('button');
                removeBtn.type = 'button';
                removeBtn.innerHTML = '&times;';
                removeBtn.className = 'remove-item-btn';
                removeBtn.title = "Remove from list";
                removeBtn.onclick = async (e) => {
                  e.stopPropagation();
                  await twFileManager.removeRecent(recent.handle);
                  const name = recent.handle.name;
                  await idbKeyval.del('search_cache_' + name);
                  await idbKeyval.del('search_cache_bk1_' + name);
                  await idbKeyval.del('search_cache_bk2_' + name);
                  displayRecentFiles();
                };

                const previewDiv = document.createElement('div');
                previewDiv.className = 'search-preview';

                li.appendChild(button);
                li.appendChild(cacheBtn);
                li.appendChild(removeBtn);
                li.appendChild(previewDiv);
                list.appendChild(li);
              }
            }
            list.addEventListener('scroll', () => { if (window.updatePreviewsPosition) window.updatePreviewsPosition(); });
            sectionDiv.appendChild(list);

            const clearButton = document.createElement('button');
            clearButton.type = 'button';
            clearButton.onclick = clearRecent;
            clearButton.innerText = 'Clear All Recent Files';
            clearButton.className = 'clear-btn';

            sectionDiv.appendChild(clearButton);
            elem.appendChild(sectionDiv);
          }
        })
      }
    }

    // --- WEBDAV REMOTE FILE DISPLAY ---
    async function displayRemoteFiles() {
      const elem = document.getElementById("recent-files");
      if (!elem) return;

      try {
        const files = await webdavPropfind();
        elem.innerHTML = "";

        const sectionDiv = document.createElement('div');
        sectionDiv.className = 'section';

        const searchContainer = document.createElement('div');
        searchContainer.className = 'search-container';
        searchContainer.innerHTML = `
          <input type="text" class="search-input" placeholder="Search Remote Liths" oninput="handleSearch(this.value)" onkeydown="handleSearchKeydown(event, this)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
          <button type="button" class="search-clear-btn" onclick="const i=this.previousElementSibling.previousElementSibling; i.value=''; handleSearch(''); i.focus();" title="Clear search">&times;</button>
        `;
        sectionDiv.appendChild(searchContainer);

        const list = document.createElement('ul');

        if (files.length === 0) {
          const emptyLi = document.createElement('li');
          emptyLi.style.cssText = 'justify-content:center; opacity:0.5; padding:20px 0;';
          emptyLi.textContent = 'No remote liths found.';
          list.appendChild(emptyLi);
        }

        const dbSearchSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="width:20px;height:20px;"><ellipse cx="9" cy="5" rx="6" ry="2.5"/><path d="M3 5v4c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V5"/><path d="M3 9v4c0 1.38 2.69 2.5 6 2.5s6-1.12 6-2.5V9"/><circle cx="19" cy="17" r="3"/><line x1="21.2" y1="19.2" x2="22.5" y2="20.5"/></svg>`;

        for (const file of files) {
          const li = document.createElement('li');

          const button = document.createElement('button');
          button.type = 'button';
          button.innerText = file.name;
          button.onclick = () => webdavOpenFile(file.name);

          const cacheBtn = document.createElement('button');
          cacheBtn.type = 'button';
          cacheBtn.className = 'cache-icon-btn';
          cacheBtn.title = "No search cache found for this file.";
          cacheBtn.innerHTML = dbSearchSvg;

          idbKeyval.get('search_cache_' + file.name).then(cache => {
            if (cache && cache.text) {
              cacheBtn.classList.add('has-cache');
              cacheBtn.title = `Search Cache\n(Last updated: ${cache.lastModified})\nClick to download.`;
              cacheBtn.onclick = async (e) => {
                e.stopPropagation();
                const name = file.name;
                const keys = ['search_cache_' + name, 'search_cache_bk1_' + name, 'search_cache_bk2_' + name];
                for (let i = 0; i < keys.length; i++) {
                  const cache = await idbKeyval.get(keys[i]);
                  if (cache && cache.text) {
                    let textToDownload = cache.text;
                    if (textToDownload && textToDownload.trim().startsWith('[')) {
                      textToDownload = serializeJsonToLith(textToDownload);
                    }
                    const blob = new Blob([textToDownload], { type: 'application/x-lith' });

                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    const suffix = i === 0 ? '_recovered' : `_bk${i}`;
                    a.download = name.replace(/\.lith$/, '') + `${suffix}.lith`;
                    a.click();
                    URL.revokeObjectURL(url);
                    if (i < keys.length - 1) await new Promise(r => setTimeout(r, 200));
                  }
                }
              };
            }
          });

          const removeBtn = document.createElement('button');
          removeBtn.type = 'button';
          removeBtn.innerHTML = '&times;';
          removeBtn.className = 'remove-item-btn';
          removeBtn.title = "Delete from remote storage";
          removeBtn.onclick = async (e) => {
            e.stopPropagation();
            if (!confirm('Are you sure? This will permanently delete the file from remote storage.')) return;
            try {
              await webdavDelete(file.name);
              // Also clean up the corresponding lock file (ignore 404 — it may not exist)
              try {
                const lockRes = await fetch(WEBDAV_BASE + encodeURIComponent(file.name) + '.lock', { method: 'DELETE' });
                if (!lockRes.ok && lockRes.status !== 404 && lockRes.status !== 204) {
                  console.warn('Lock file delete returned unexpected status:', lockRes.status);
                }
              } catch (lockErr) {
                console.warn('Could not delete lock file (non-fatal):', lockErr);
              }
              const name = file.name;
              await idbKeyval.del('search_cache_' + name);
              await idbKeyval.del('search_cache_bk1_' + name);
              await idbKeyval.del('search_cache_bk2_' + name);
              li.remove();
            } catch (err) {
              console.error('Delete failed:', err);
              alert('Delete failed: ' + err.message);
            }
          };

          const previewDiv = document.createElement('div');
          previewDiv.className = 'search-preview';

          li.appendChild(button);
          li.appendChild(cacheBtn);
          li.appendChild(removeBtn);
          li.appendChild(previewDiv);
          list.appendChild(li);
        }

        list.addEventListener('scroll', () => { if (window.updatePreviewsPosition) window.updatePreviewsPosition(); });
        sectionDiv.appendChild(list);

        const clearButton = document.createElement('button');
        clearButton.type = 'button';
        clearButton.onclick = window.clearAndReloadRemoteSearchCache;
        clearButton.innerText = 'Reset local search cache';
        clearButton.className = 'clear-btn';
        sectionDiv.appendChild(clearButton);
        elem.appendChild(sectionDiv);
      } catch (err) {
        console.error('Failed to list remote files:', err);
        // --- OFFLINE FALLBACK: render cached liths inline ---
        await displayOfflineCacheFiles(elem);
      }
    }

    /* --- OFFLINE FALLBACK: Load from IDB cache in read-only mode --- */
    async function openCachedLithReadOnly(fileName) {
      const overlay = document.getElementById('loading-overlay');
      if (overlay) overlay.style.display = 'flex';

      try {
        const cache = await idbKeyval.get('search_cache_' + fileName);
        if (!cache || !cache.text) throw new Error('No cached data found for: ' + fileName);

        let coreHtml = await fetchCoreEngine();

        // cache.text is a JSON array string (tiddlerArrayText)
        const tiddlers = JSON.parse(cache.text);
        const tiddlerArrayText = JSON.stringify(tiddlers);

        if (tiddlers.length > 0) {
          const stripped = tiddlerArrayText.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
          coreHtml = coreHtml.replace(/(<script class="tiddlywiki-tiddler-store" type="application\/json">\[)([\s\S]*?)(\]\s*<\/script>)/is, (match, p1, p2, p3) => {
            const hasItems = p2.trim().length > 0;
            return p1 + p2 + (hasItems ? ',' : '') + stripped + p3;
          });
        }

        // Read-only: disable autosaver, do NOT inject a custom saver
        // (falls back to TiddlyWiki's built-in monolith HTML download)
        window.pendingImports.push({ title: "$:/state/DisableAutoSaver", text: "yes" });

        replacePageContents(coreHtml, true);
      } catch (err) {
        if (overlay) overlay.style.display = 'none';
        console.error('Failed to load cached lith:', err);
        alert('Failed to load cached lith: ' + err.message);
      }
    }

    /* --- OFFLINE CACHE FILE LIST (inline in #recent-files) --- */
    async function displayOfflineCacheFiles(elem) {
      if (!elem) return;

      // Update the mode pill to REMOTE-OFFLINE
      const pill = document.querySelector('.mode-pill.remote');
      if (pill) {
        pill.textContent = 'REMOTE-OFFLINE';
        pill.classList.remove('remote');
        pill.classList.add('offline');
      }

      elem.innerHTML = '';

      const sectionDiv = document.createElement('div');
      sectionDiv.className = 'section';

      // Search box (same as live remote list — handleSearch works on IDB cache)
      const searchContainer = document.createElement('div');
      searchContainer.className = 'search-container';
      searchContainer.innerHTML = `
        <input type="text" class="search-input" placeholder="Search cached liths..." oninput="handleSearch(this.value)" onkeydown="handleSearchKeydown(event, this)">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>
        <button type="button" class="search-clear-btn" onclick="const i=this.previousElementSibling.previousElementSibling; i.value=''; handleSearch(''); i.focus();" title="Clear search">&times;</button>
      `;
      sectionDiv.appendChild(searchContainer);

      // Offline notice
      const notice = document.createElement('p');
      notice.style.cssText = 'font-size:0.8rem; opacity:0.55; margin:0 0 10px 0; line-height:1.5;';
      notice.innerHTML = '&#9888; Server unreachable &mdash; showing <strong>local cache</strong>. Files open in <strong>read-only</strong> mode.';
      sectionDiv.appendChild(notice);

      const list = document.createElement('ul');

      try {
        const allKeys = await idbKeyval.keys();
        const cacheKeys = allKeys.filter(k => typeof k === 'string' && k.startsWith('search_cache_') && !k.startsWith('search_cache_bk'));

        if (cacheKeys.length === 0) {
          const emptyLi = document.createElement('li');
          emptyLi.style.cssText = 'display:block;';
          emptyLi.innerHTML = '<div class="offline-empty">No cached liths found in local storage.</div>';
          list.appendChild(emptyLi);
        } else {
          // Build entries with metadata, sorted alphabetically
          const entries = [];
          for (const key of cacheKeys) {
            const cache = await idbKeyval.get(key);
            if (cache && cache.text) {
              const fileName = key.replace(/^search_cache_/, '');
              entries.push({ fileName, lastModified: cache.lastModified || '' });
            }
          }
          entries.sort((a, b) => a.fileName.localeCompare(b.fileName));

          for (const entry of entries) {
            const li = document.createElement('li');

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'offline-file-btn';
            btn.innerText = entry.fileName;
            btn.onclick = () => {
              const roModal = document.getElementById('offline-readonly-confirm-modal');
              const roFileName = document.getElementById('offline-readonly-filename');
              if (roModal && roFileName) {
                roFileName.textContent = entry.fileName;
                roModal.style.display = 'flex';
                document.getElementById('offline-readonly-confirm-btn').onclick = () => {
                  roModal.style.display = 'none';
                  openCachedLithReadOnly(entry.fileName);
                };
              } else {
                openCachedLithReadOnly(entry.fileName);
              }
            };

            const meta = document.createElement('span');
            meta.className = 'offline-meta';
            meta.textContent = entry.lastModified;

            li.appendChild(btn);
            li.appendChild(meta);
            list.appendChild(li);
          }
        }
      } catch (err) {
        console.error('Failed to enumerate IDB caches:', err);
        const errLi = document.createElement('li');
        errLi.style.cssText = 'display:block;';
        errLi.innerHTML = '<div class="offline-empty">Error reading local cache.</div>';
        list.appendChild(errLi);
      }

      list.addEventListener('scroll', () => { if (window.updatePreviewsPosition) window.updatePreviewsPosition(); });
      sectionDiv.appendChild(list);
      elem.appendChild(sectionDiv);
    }

    /* --- EMOJI ICON PICKER --- */
    const EMOJI_LIST = [
      // Study & Work
      '📚', '📖', '📝', '📋', '🗒️', '📁', '🗂️', '📦', '🔖', '📌', '📍', '🗃️', '🗄️', '📊', '📈', '📉',
      // Science & Tech
      '🔬', '🔭', '⚗️', '🧪', '🧫', '🧬', '💡', '🔋', '🔌', '💻', '🖥️', '⌨️', '📱', '📡', '🛰️', '🤖', '🧲', '⚙️', '🔩', '🧰',
      // World & Nature
      '🌐', '🗺️', '🧭', '🌍', '🌎', '🌏', '⭐', '🌙', '☀️', '🌊', '⚡', '🔥', '❄️', '🌿', '🌱', '🌸', '🌺', '🌻', '🍃', '🌴',
      // Places & Things
      '🏛️', '🏰', '⛩️', '🗼', '⏰', '⌚', '🕰️', '🔐', '🔑', '🗝️', '🔮', '🎯', '🧩', '🎲', '♟️', '🎺', '🗿',
      // Art & Creative
      '🎨', '🖌️', '🖍️', '🗳️', '🗯️', '✏️', '🖊️', '🖋️', '📷', '📸', '🎥', '🎞️', '🏗️', '🎭', '🎬', '🎤', '🎧', '🎈', '🎆', '🎇', '✨', '🌈', '🗣️', '🐞',
      // Faces (just a few)
      '😊', '😄', '😂', '😍', '🤔', '😎', '🤓', '😤', '😠', '😢', '😴', '🥳', '🤯', '😇', '🥶'
    ];
    let _pickerEmoji = null;

    window.openEmojiPicker = function () {
      const gridWrap = document.getElementById('emoji-picker-scroll');
      if (gridWrap && !gridWrap.dataset.built) {
        gridWrap.dataset.built = '1';
        const row = document.createElement('div');
        row.className = 'emoji-grid';
        EMOJI_LIST.forEach(em => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'emoji-btn'; b.textContent = em;
          b.onclick = () => _setPickerPreview(em);
          row.appendChild(b);
        });
        gridWrap.appendChild(row);
      }
      idbKeyval.get('lithic-icon-emoji').then(saved => { if (saved) _setPickerPreview(saved, false); });
      document.getElementById('emoji-save-status').textContent = '';
      document.getElementById('emoji-save-status').className = 'emoji-save-status';
      document.getElementById('emoji-picker-modal').style.display = 'flex';
    };

    function _setPickerPreview(em, scroll = true) {
      _pickerEmoji = em;
      const disp = document.getElementById('emoji-preview-display');
      if (disp) disp.textContent = em;
      document.querySelectorAll('.emoji-btn').forEach(b => b.classList.toggle('selected', b.textContent === em));
      if (scroll) {
        const sel = document.querySelector('.emoji-btn.selected');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
      }
    }

    function applyEmojiToHeader(em) {
      let el = document.querySelector('h1 img, h1 .fallback-icon, h1 .emoji-icon-trigger');
      if (!el) return;
      // Replace if it's still an <img> or the bare fallback span (not yet an emoji span)
      if (el.tagName !== 'SPAN') {
        const span = document.createElement('span');
        span.className = 'fallback-icon emoji-icon-trigger';
        span.style.cssText = 'font-size:1em; background:transparent; cursor:pointer;';
        el.replaceWith(span);
        el = span;
      }
      el.textContent = em;
      // Update browser-tab favicon via canvas
      try {
        const c = document.createElement('canvas'); c.width = 32; c.height = 32;
        const ctx = c.getContext('2d');
        ctx.fillStyle = '#333'; ctx.fillRect(0, 0, 32, 32);
        ctx.font = '22px serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(em, 16, 17);
        let lnk = document.querySelector("link[rel='shortcut icon']") || document.querySelector("link[rel='icon']");
        if (!lnk) { lnk = document.createElement('link'); lnk.rel = 'shortcut icon'; document.head.appendChild(lnk); }
        lnk.type = 'image/png'; lnk.href = c.toDataURL('image/png');
      } catch (e) { }
    }

    async function _emojiToBlob(em, size) {
      const c = document.createElement('canvas'); c.width = size; c.height = size;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#333'; ctx.fillRect(0, 0, size, size);
      ctx.font = `${Math.floor(size * 0.65)}px serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(em, size / 2, size / 2 + 2);
      return new Promise(r => c.toBlob(r, 'image/png'));
    }

    async function _backupOriginalIcon() {
      if (await idbKeyval.get('lithic-original-icon-backup')) return;
      try {
        const res = await fetch('/mstile-150x150.png');
        if (!res.ok) return;
        const blob = await res.blob();
        const dataUrl = await new Promise((ok, err) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = err; r.readAsDataURL(blob); });
        await idbKeyval.set('lithic-original-icon-backup', dataUrl);
      } catch (e) { console.warn('[Lithic] Icon backup failed:', e); }
    }

    window.confirmEmojiIcon = async function () {
      if (!_pickerEmoji) return;
      const em = _pickerEmoji;
      const statusEl = document.getElementById('emoji-save-status');
      applyEmojiToHeader(em);
      await idbKeyval.set('lithic-icon-emoji', em);
      statusEl.textContent = 'Saving…'; statusEl.className = 'emoji-save-status';
      try {
        // Resize all icon sizes client-side via canvas and PUT each directly to /sync/.
        // The inotify watcher detects custom.ico (PUT last) and cp's all pre-sized files
        // into /app/public/ — no server-side imagemagick needed.
        const ICON_SIZES = [
          { path: '/sync/favicon-16x16.png', size: 16 },
          { path: '/sync/favicon-32x32.png', size: 32 },
          { path: '/sync/favicon.ico', size: 32 },
          { path: '/sync/mstile-150x150.png', size: 150 },
          { path: '/sync/android-chrome-192x192.png', size: 192 },
          { path: '/sync/apple-touch-icon.png', size: 180 },
          { path: '/sync/android-chrome-512x512.png', size: 512 },
          { path: '/sync/custom.ico', size: 512 }, // PUT last — signals watcher to copy
        ];
        for (let i = 0; i < ICON_SIZES.length; i++) {
          const { path, size } = ICON_SIZES[i];
          statusEl.textContent = `Saving\u2026 (${i + 1} of ${ICON_SIZES.length})`;
          const blob = await _emojiToBlob(em, size);
          const res = await fetch(path, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/png' } });
          if (!res.ok && res.status !== 201 && res.status !== 204) throw new Error('PUT ' + path + ' \u2192 ' + res.status);
        }
        statusEl.textContent = '\u2713 Saved!';
        statusEl.className = 'emoji-save-status ok';
        // Wait for the inotify watcher to finish copying the icons to /app/public/
        // (watcher has a 1s sleep before copying, so 2s covers that + margin).
        setTimeout(() => {
          try {
            const sw = navigator.serviceWorker && navigator.serviceWorker.controller;
            if (sw) { sw.postMessage({ type: 'BUST_ICON_CACHE' }); }
          } catch (e) { }
        }, 2000);
      } catch (e) {
        statusEl.textContent = '\u2139\ufe0f Saved locally only (server write failed).';
        statusEl.className = 'emoji-save-status';
      }
      // Close picker briefly after so the status flashes, then the updated header is visible
      setTimeout(() => { document.getElementById('emoji-picker-modal').style.display = 'none'; }, 900);
    };

    window.restoreDefaultIcon = async function () {
      await idbKeyval.del('lithic-icon-emoji');
      // Reset header to original img
      let el = document.querySelector('h1 .emoji-icon-trigger');
      if (el) {
        const img = document.createElement('img');
        img.src = '/mstile-150x150.png'; img.alt = 'L';
        img.style.cssText = 'background:#333; padding:2px;';
        img.setAttribute('onerror', "this.outerHTML='<span class=\'fallback-icon\'>L</span>'");
        img.classList.add('emoji-icon-trigger');
        el.replaceWith(img);
      }
      // Reset browser favicon to default
      let lnk = document.querySelector("link[rel='shortcut icon']") || document.querySelector("link[rel='icon']");
      if (lnk) lnk.href = '/favicon.ico';
      // Signal the backend to restore defaults by deleting custom.ico
      const statusEl = document.getElementById('emoji-save-status');
      try {
        await fetch('/sync/custom.ico', { method: 'DELETE' });
        if (statusEl) { statusEl.textContent = '✓ Default icon restored server-wide.'; statusEl.className = 'emoji-save-status ok'; }
      } catch (e) {
        if (statusEl) { statusEl.textContent = 'Restored locally.'; statusEl.className = 'emoji-save-status ok'; }
      }
    };

    /* --- GLOBAL UI HELPERS --- */
    function showLoading(text) {
      const overlay = document.getElementById('global-loading-overlay');
      if (overlay) {
        document.getElementById('global-loading-text').textContent = text || 'Processing...';
        overlay.style.display = 'flex';
      }
    }

    function hideLoading() {
      const overlay = document.getElementById('global-loading-overlay');
      if (overlay) overlay.style.display = 'none';
    }

    window.clearAndReloadRemoteSearchCache = async function () {
      if (!confirm('This will crawl all remote files and index them for global search. Depending on your server speed, this may take a moment. Proceed?')) return;

      showLoading('Crawling remote liths...');
      try {
        const files = await webdavPropfind();
        if (files.length === 0) {
          hideLoading();
          return;
        }

        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          showLoading(`Indexing [${i + 1}/${files.length}]: ${file.name}...`);

          try {
            const res = await fetch(WEBDAV_BASE + encodeURIComponent(file.name));
            if (res.ok) {
              const contents = await res.text();
              let parsedData;
              if (file.name.toLowerCase().endsWith('.lith')) {
                parsedData = parseLithToJSON(contents);
                if (Array.isArray(parsedData)) {
                  await saveSearchCache(file.name, JSON.stringify(parsedData));
                }
              } else if (file.name.toLowerCase().endsWith('.json')) {
                parsedData = JSON.parse(contents);
                if (Array.isArray(parsedData)) {
                  // If it's already valid JSON text, we can just save it directly
                  await saveSearchCache(file.name, contents);
                }
              }
            }
          } catch (e) {
            console.warn(`Failed to index ${file.name}:`, e);
          }
        }

        hideLoading();
        displayRemoteFiles();
      } catch (err) {
        console.error('Crawl failed:', err);
        hideLoading();
        alert('Crawl failed: ' + err.message);
      }
    };

    // --- INITIALIZATION INTERCEPT ---
    window.onload = async () => {

      const debugLog = document.getElementById('debug-log');
      const log = (msg) => {
        if (debugLog) { debugLog.innerHTML += `<div>${msg}</div>`; }
        console.log(`[DEBUG] ${msg}`);
      };

      log("Launcher loaded.");





      // --- WEBDAV MODE ---
      if (IS_WEBDAV) {
        document.body.classList.add('webdav-mode');
        if (document.getElementById('intro-link')) document.getElementById('intro-link').style.display = 'none';

        // Inject REMOTE pill
        const titleDiv = document.querySelector('h1 div');
        if (titleDiv) {
          const pill = document.createElement('span');
          pill.className = 'mode-pill remote';
          pill.textContent = 'REMOTE';
          titleDiv.appendChild(pill);
        }

        // Wire icon click to emoji picker + restore saved emoji
        const headerIcon = document.querySelector('h1 img, h1 .fallback-icon');
        if (headerIcon) headerIcon.classList.add('emoji-icon-trigger');
        document.querySelector('h1').addEventListener('click', e => {
          if (e.target.closest('img, .fallback-icon, .emoji-icon-trigger')) openEmojiPicker();
        });
        idbKeyval.get('lithic-icon-emoji').then(saved => { if (saved) applyEmojiToHeader(saved); });

        const mountBtn = document.getElementById('btn-mount');
        const newLithBtn = document.getElementById('btn-new-lith');
        const bookmarkBtn = document.getElementById('btn-bookmark-trigger');

        if (bookmarkBtn) {
          bookmarkBtn.style.display = 'none';
        }

        if (mountBtn) {
          mountBtn.innerText = 'Upload a Lith';
          mountBtn.onclick = async () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.lith,.json';
            input.onchange = async (e) => {
              const file = e.target.files[0];
              if (!file) return;
              const overlay = document.getElementById('loading-overlay');
              if (overlay) overlay.style.display = 'flex';
              try {
                let body = await file.text();
                const uploadName = file.name.endsWith('.lith') ? file.name : file.name.replace(/\.[^.]+$/, '') + '.lith';

                // If uploading a .json file (being renamed to .lith), convert it to lith format
                // so parseLithToJSON can correctly split it on ⁂⁂⁂ delimiters when opened.
                if (!file.name.endsWith('.lith')) {
                  try {
                    const parsed = JSON.parse(body);
                    if (Array.isArray(parsed)) {
                      body = serializeJsonToLith(body);
                    }
                  } catch (jsonErr) {
                    console.warn('Uploaded file is not valid JSON; uploading as-is.', jsonErr);
                  }
                }

                // Collision check
                const files = await webdavPropfind();
                if (files.some(f => f.name.toLowerCase() === uploadName.toLowerCase())) {
                  if (overlay) overlay.style.display = 'none';
                  document.getElementById('name-collision-modal').style.display = 'flex';
                  return;
                }

                await webdavUpload(uploadName, body);
                await displayRemoteFiles();
              } catch (err) {
                console.error('Upload failed:', err);
                alert('Upload failed: ' + err.message);
              } finally {
                if (overlay) overlay.style.display = 'none';
              }
            };
            input.click();
          };
        }

        if (newLithBtn) {
          newLithBtn.onclick = async () => {
            const name = prompt('Enter a name for the new lith:');
            if (!name || !name.trim()) return;
            const fileName = name.trim().replace(/\.lith$/i, '') + '.lith';

            const overlay = document.getElementById('loading-overlay');
            if (overlay) overlay.style.display = 'flex';

            try {
              // Collision check
              const files = await webdavPropfind();
              if (files.some(f => f.name.toLowerCase() === fileName.toLowerCase())) {
                if (overlay) overlay.style.display = 'none';
                document.getElementById('name-collision-modal').style.display = 'flex';
                return;
              }

              const twDate = getTwTime();
              const todayTitle = getTodayTitle();
              const minimalLith = `created: ${twDate}\nmodified: ${twDate}\ntags: Journal\ntitle: ${todayTitle}\ntype: \n\n`;

              await webdavUpload(fileName, minimalLith);
              await displayRemoteFiles();
            } catch (err) {
              console.error('Create failed:', err);
              alert('Failed to create new lith: ' + err.message);
            } finally {
              if (overlay) overlay.style.display = 'none';
            }
          };
        }

        // Show a mini spinner in #recent-files while PROPFIND resolves
        const recentElem = document.getElementById('recent-files');
        if (recentElem) {
          recentElem.innerHTML = `<div class="section" style="display:flex; align-items:center; justify-content:center; padding:30px; opacity:0.5;">
            <div class="spinner" style="width:28px; height:28px; border-width:3px; margin:0;"></div>
          </div>`;
        }

        await displayRemoteFiles();

        // --- GITHUB SYNC INTEGRATION ---
        const githubBtn = document.getElementById('github-sync-btn');
        if (githubBtn) githubBtn.style.display = 'flex';

        let tempToken = null;
        let isAuthFlowActive = false;

        window.updateGithubStatus = async function () {
          try {
            const res = await fetch('/api/github/status');
            const data = await res.json();
            const btn = document.getElementById('github-sync-btn');
            if (!btn) return;

            if (data.connected) {
              btn.classList.add('active');
              btn.classList.remove('error');

              // Only auto-update the modal view if we aren't in the middle of setup
              if (!tempToken && !isAuthFlowActive) {
                setGithubState('connected');
              }

              document.getElementById('github-active-repo').textContent = data.repo;

              if (data.last_sync > 0) {
                const date = new Date(data.last_sync * 1000);
                const timeStr = date.toLocaleString();
                document.getElementById('github-last-sync').textContent = timeStr;
                btn.title = `GitHub Sync: Last synced at ${timeStr}`;

                // If synced in the last 5 seconds, show active state
                const age = (Date.now() / 1000) - data.last_sync;
                if (age < 5) {
                  btn.classList.add('syncing');
                } else {
                  btn.classList.remove('syncing');
                }
              }
            } else {
              btn.classList.remove('active', 'syncing');

              // Only reset to disconnected if we aren't busy with a new setup
              if (!tempToken && !isAuthFlowActive) {
                setGithubState('disconnected');
              }
            }
          } catch (err) {
            console.error('Failed to get GitHub status:', err);
            const btn = document.getElementById('github-sync-btn');
            if (btn) btn.classList.add('error');
          }
        };

        function setGithubState(state) {
          const states = ['disconnected', 'installing', 'connecting', 'selecting', 'connected'];
          states.forEach(s => {
            const el = document.getElementById(`github-state-${s}`);
            if (el) el.style.display = (s === state) ? 'block' : 'none';
          });
        }

        window.openGithubSyncModal = () => {
          document.getElementById('github-sync-modal').style.display = 'flex';
          window.updateGithubStatus();
        };

        window.initiateGithubAuth = async () => {
          // Do NOT disconnect immediately anymore, so user can cancel back to current sync
          tempToken = null;
          isAuthFlowActive = true;

          setGithubState('installing');
          resetInstallStep();

          // Show disconnect button in the nested view if we are already connected
          const res = await fetch('/api/github/status');
          const data = await res.json();
          const nestedDisconnect = document.getElementById('btn-github-disconnect-nested');
          if (nestedDisconnect) {
            nestedDisconnect.style.display = data.connected ? 'block' : 'none';
          }
        };

        function resetInstallStep() {
          const btn = document.getElementById('btn-github-proceed-to-auth');
          btn.disabled = true;
          btn.textContent = 'Wait for Installation...';
          document.getElementById('github-install-check').style.display = 'none';
        }

        window.onGithubInstallClick = () => {
          const btn = document.getElementById('btn-github-proceed-to-auth');
          let count = 15;
          const timer = setInterval(() => {
            count--;
            if (count > 0) {
              btn.textContent = `Wait for GitHub (${count}s)...`;
            } else {
              clearInterval(timer);
              unlockAuthStep();
            }
          }, 1000);
        };

        window.unlockAuthStep = () => {
          const btn = document.getElementById('btn-github-proceed-to-auth');
          btn.disabled = false;
          btn.textContent = 'Generate Authorization Code';
          document.getElementById('github-install-check').style.display = 'inline-block';
        };

        window.generateDeviceCode = async () => {
          setGithubState('connecting');
          document.getElementById('btn-github-connect').disabled = true;

          try {
            const res = await fetch('/api/github/device-code');
            const data = await res.json();

            if (data.user_code) {
              document.getElementById('github-user-code').textContent = data.user_code;
              pollGithubToken(data.device_code, (data.interval || 5) * 1000);
            } else if (data.error) {
              alert(`Error: ${data.error_description || data.error}`);
              resetAuthUI();
            }
          } catch (err) {
            alert('Failed to initiate GitHub auth.');
            resetAuthUI();
          }
        };

        window.resetAuthUI = function () {
          setGithubState('disconnected');
          document.getElementById('btn-github-connect').disabled = false;
          tempToken = null;
          isAuthFlowActive = false;
          window.updateGithubStatus();
        }

        window.disconnectGithub = async () => {
          if (!confirm('Are you sure you want to disconnect from GitHub? Automatic sync will stop.')) return;
          try {
            await fetch('/api/github/disconnect');
            window.resetAuthUI();
            document.getElementById('github-sync-modal').style.display = 'none';
          } catch (err) {
            console.error('Failed to disconnect:', err);
            alert('Failed to disconnect.');
          }
        };

        async function pollGithubToken(deviceCode, interval) {
          const poll = async () => {
            try {
              const res = await fetch(`/api/github/poll?device_code=${deviceCode}`);
              const data = await res.json();

              if (data.access_token) {
                tempToken = data.access_token;
                showRepoSelection();
              } else if (data.error === 'authorization_pending') {
                setTimeout(poll, interval);
              } else {
                alert('Auth failed or expired: ' + (data.error_description || data.error));
                resetAuthUI();
              }
            } catch (err) {
              console.error('Polling error:', err);
              setTimeout(poll, interval);
            }
          };
          poll();
        }

        let allRepos = [];
        let highlightIndex = -1;
        let pendingRepoName = "";

        function generateRepoName() {
          const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Avoid ambiguous chars
          let id = '';
          for (let i = 0; i < 4; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
          pendingRepoName = `lithic-sync-${id.toLowerCase()}`;
          const btn = document.getElementById('btn-github-create-new');
          if (btn) btn.textContent = `+ Create ${pendingRepoName} and sync`;
        }

        async function showRepoSelection() {
          setGithubState('selecting');
          generateRepoName();
          const discoveryList = document.getElementById('github-discovery-list');
          const searchWrapper = document.getElementById('github-custom-search-wrapper');
          discoveryList.innerHTML = '<p style="text-align:center; opacity:0.5;">Scanning for sync repos...</p>';
          searchWrapper.style.display = 'none';

          try {
            const res = await fetch(`/api/github/list-repos?token=${tempToken}`);
            allRepos = await res.json();
            if (!Array.isArray(allRepos)) allRepos = [];

            renderDiscovery();
          } catch (err) {
            discoveryList.innerHTML = '<p class="discovery-empty">Failed to load repositories</p>';
          }
        }

        function renderDiscovery() {
          const discoveryList = document.getElementById('github-discovery-list');
          const managed = allRepos.filter(r => r.name.startsWith('lithic-sync-') || r.name.startsWith('lithic-backup-'));

          discoveryList.innerHTML = '';

          if (managed.length === 0) {
            discoveryList.innerHTML = '<div class="discovery-empty">No existing sync repos found</div>';
          } else {
            managed.forEach((repo, idx) => {
              const card = document.createElement('div');
              card.className = 'radio-card' + (idx === 0 ? ' selected' : '');
              card.innerHTML = `
                <input type="radio" name="github-repo-choice" value="${repo.full_name}" ${idx === 0 ? 'checked' : ''}>
                <span class="label">${repo.full_name}</span>
              `;
              card.onclick = (e) => {
                if (e.target.tagName !== 'INPUT') card.querySelector('input').checked = true;
                updateDiscoveryUI();
              };
              discoveryList.appendChild(card);
            });
          }

          // Always add "Custom" card
          const customCard = document.createElement('div');
          customCard.className = 'radio-card';
          customCard.innerHTML = `
            <input type="radio" name="github-repo-choice" value="custom">
            <span class="label">Advanced: Custom Repository</span>
          `;
          customCard.onclick = (e) => {
            if (e.target.tagName !== 'INPUT') customCard.querySelector('input').checked = true;
            updateDiscoveryUI();
          };
          discoveryList.appendChild(customCard);

          updateDiscoveryUI();
          renderRepos(''); // In case they pick custom
        }

        function updateDiscoveryUI() {
          const choice = document.querySelector('input[name="github-repo-choice"]:checked')?.value;
          const searchWrapper = document.getElementById('github-custom-search-wrapper');
          const finalizeBtn = document.getElementById('btn-github-finalize');

          // Style cards
          document.querySelectorAll('.radio-card').forEach(card => {
            card.classList.toggle('selected', card.querySelector('input').checked);
          });

          if (choice === 'custom') {
            searchWrapper.style.display = 'block';
            finalizeBtn.disabled = !document.getElementById('github-repo-search').value;
          } else {
            searchWrapper.style.display = 'none';
            finalizeBtn.disabled = !choice;
          }
        }

        function renderRepos(filter) {
          const resultsDiv = document.getElementById('github-search-results');
          const matches = allRepos.filter(r => r.full_name.toLowerCase().includes(filter.toLowerCase()));

          resultsDiv.innerHTML = '';
          highlightIndex = -1;

          matches.forEach((repo, idx) => {
            const el = document.createElement('div');
            el.className = 'search-item';
            el.textContent = repo.full_name;
            el.onclick = () => selectRepo(repo.full_name);
            resultsDiv.appendChild(el);
          });

          if (matches.length === 0) {
            resultsDiv.innerHTML = '<div class="search-item" style="opacity:0.5;">No matches found</div>';
          }
          resultsDiv.classList.add('active');
        }

        function selectRepo(name) {
          document.getElementById('github-repo-search').value = name;
          document.getElementById('github-search-results').classList.remove('active');
          updateDiscoveryUI();
        }

        // Search Input listeners
        document.addEventListener('input', e => {
          if (e.target.id === 'github-repo-search') renderRepos(e.target.value);
        });

        document.addEventListener('keydown', e => {
          const searchInput = document.getElementById('github-repo-search');
          if (document.activeElement !== searchInput) return;

          const resultsDiv = document.getElementById('github-search-results');
          const items = resultsDiv.querySelectorAll('.search-item');

          if (e.key === 'ArrowDown') {
            e.preventDefault();
            highlightIndex = Math.min(highlightIndex + 1, items.length - 1);
            updateHighlight(items);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            highlightIndex = Math.max(highlightIndex - 1, 0);
            updateHighlight(items);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            const highlighted = resultsDiv.querySelector('.search-item.highlight');
            if (highlighted) selectRepo(highlighted.textContent);
          }
        });

        function updateHighlight(items) {
          items.forEach((item, idx) => {
            item.classList.toggle('highlight', idx === highlightIndex);
            if (idx === highlightIndex) item.scrollIntoView({ block: 'nearest' });
          });
        }

        // Close dropdown on outside click
        document.addEventListener('click', e => {
          const wrapper = document.querySelector('.search-wrapper');
          const resultsDiv = document.getElementById('github-search-results');
          if (wrapper && !wrapper.contains(e.target) && resultsDiv) {
            resultsDiv.classList.remove('active');
          }
        });

        window.createGithubRepo = async () => {
          if (!tempToken || !pendingRepoName) return;
          showLoading(`Creating ${pendingRepoName}...`);
          try {
            const res = await fetch('/api/github/create-repo', {
              method: 'POST',
              body: JSON.stringify({ token: tempToken, name: pendingRepoName })
            });
            const data = await res.json();
            if (data.full_name) {
              await finalizeGithubSetup(data.full_name);
            } else {
              hideLoading();
              alert('Failed to create repository: ' + (data.message || 'Unknown error'));
            }
          } catch (err) {
            hideLoading();
            console.error('Creation failed:', err);
          }
        };

        window.finalizeGithubSetup = async (targetRepo) => {
          let repo = targetRepo;
          if (!repo) {
            const choice = document.querySelector('input[name="github-repo-choice"]:checked')?.value;
            repo = (choice === 'custom') ? document.getElementById('github-repo-search').value : choice;
          }

          if (!repo) {
            alert('Please select a repository.');
            return;
          }

          showLoading(`Setting up ${repo}...`);
          try {
            const res = await fetch('/api/github/setup', {
              method: 'POST',
              body: JSON.stringify({ token: tempToken, repo: repo })
            });
            const data = await res.json();
            if (data.status === 'success') {
              tempToken = null;
              isAuthFlowActive = false;
              window.updateGithubStatus();
              document.getElementById('github-sync-modal').style.display = 'none';
              if (typeof displayRemoteFiles === 'function') {
                displayRemoteFiles();
              }
            } else {
              alert('Setup failed: ' + data.message);
            }
          } catch (err) {
            console.error('Setup failed:', err);
          } finally {
            hideLoading();
          }
        };

        // Initial status check and periodic refresh
        window.updateGithubStatus();
        setInterval(window.updateGithubStatus, 15000);

        return;
      }

      // --- LOCAL MODE ---
      displayRecentFiles();

      // Inject APP pill if running in Tauri
      if (window.__TAURI__ || window.__TAURI_INTERNALS__) {
        const titleDiv = document.querySelector('h1 div');
        if (titleDiv) {
          const pill = document.createElement('span');
          pill.className = 'mode-pill app';
          pill.textContent = 'APP';
          titleDiv.appendChild(pill);
        }
      }

      // --- URL QUERY STRING INJECTION ---
      const urlParams = new URLSearchParams(window.location.search);
      let b64Json = urlParams.get('json') || urlParams.get('lith');
      let remoteUrl = urlParams.get('url');

      const svelteHandoff = urlParams.get('new') || urlParams.get('mount');
      if (svelteHandoff) {
        const handoff = sessionStorage.getItem('lithic-launcher-file');
        if (handoff) {
          try {
            const data = JSON.parse(handoff);
            const imported = data.text ? parseLithToJSON(data.text) : [];
            window.pendingImports = window.pendingImports.concat(imported);
            sessionStorage.removeItem('lithic-launcher-file');
          } catch (e) { log('Unable to parse launcher handoff: ' + e.message); }
        }
        window.history.replaceState({}, document.title, window.location.pathname);
        window.openNewBlankLith();
        return;
      }

      if (remoteUrl || b64Json) {
        document.getElementById('loading-overlay').style.display = 'flex';
      }

      if (remoteUrl) {
        try {
          // intelligently support b64 or plain url string
          if (!remoteUrl.toLowerCase().startsWith('http') && !remoteUrl.toLowerCase().startsWith('file:') && !remoteUrl.startsWith('/')) {
            try {
              remoteUrl = decodeURIComponent(escape(atob(remoteUrl)));
            } catch (e) { /* fallback to original */ }
          }
          log("Fetching remote payload from URL: " + remoteUrl);
          const res = await fetch(remoteUrl);
          const text = await res.text();
          let parsedData;
          try {
            parsedData = JSON.parse(text);
          } catch (e) {
            parsedData = parseLithToJSON(text);
          }
          if (Array.isArray(parsedData) && parsedData.length > 0) {
            // Replicate ?json behavior by tagging only the root parent with Dogear
            let node = parsedData[0];
            node.tags = node.tags ? [...new Set([...(Array.isArray(node.tags) ? node.tags : (typeof node.tags === 'string' ? node.tags.split(' ') : [])), 'Dogear'])].join(' ') : 'Dogear';
            window.pendingImports = window.pendingImports.concat(parsedData);
            log("Remote Payload loaded. Booting fresh lithic.html...");
            // Clear URL query params to prevent reload loop
            window.history.replaceState({}, document.title, window.location.pathname);
            window.openNewBlankLith();
            return;
          }
        } catch (e) {
          log("Failed to fetch/inject ?url= parameter: " + e.message);
          console.error("Query param url injection error:", e);
        }
      }

      if (b64Json) {
        try {
          let jsonString;
          // intelligently support b64 or plain json
          if (b64Json.trim().startsWith('[')) {
            jsonString = b64Json;
          } else {
            // Native base64 decoding in JS
            jsonString = decodeURIComponent(escape(atob(b64Json)));
          }

          let parsedData;
          try {
            parsedData = JSON.parse(jsonString);
          } catch (e) {
            log("Invalid JSON in url param.");
          }

          if (Array.isArray(parsedData) && parsedData.length > 0) {
            let node = parsedData[0];
            node.tags = node.tags ? [...new Set([...(Array.isArray(node.tags) ? node.tags : (typeof node.tags === 'string' ? node.tags.split(' ') : [])), 'Dogear'])].join(' ') : 'Dogear';
            window.pendingImports = window.pendingImports.concat(parsedData);
            // Automatically boot into a fresh lithic.html
            log("Payload from URL loaded. Booting fresh lithic.html...");
            // Clear URL query params to prevent reload loop
            window.history.replaceState({}, document.title, window.location.pathname);
            window.openNewBlankLith();
            return;
          }

        } catch (e) {
          log("Failed to parse/inject ?json= parameter: " + e.message);
          console.error("Query param injection error:", e);
        }
      }

      log("window.__TAURI__ present? " + !!window.__TAURI__);

      // Check if running inside the Tauri wrapper
      if (window.__TAURI__) {
        const introLink = document.getElementById('intro-link');
        if (introLink) introLink.style.display = 'none';
        try {
          const { invoke } = window.__TAURI__.tauri;
          const { readTextFile, writeTextFile } = window.__TAURI__.fs;

          log("Calling get_startup_file...");
          // Ask Rust for any file passed via double-click / file association
          const startupFilePath = await invoke('get_startup_file');
          log("Returned startupFilePath: " + startupFilePath);


          if (startupFilePath) {
            log("Launched via file association:", startupFilePath);

            // 1. Check if we already have a FileSystem API handle mapped to this Tauri Path
            const recentFiles = await twFileManager.getRecent();
            const linkedEntry = recentFiles.find(f => f.tauriPath === startupFilePath);

            if (linkedEntry && linkedEntry.handle) {
              log("Found linked browser handle! Simulating Recent Files click.");
              // Passing the handle directly triggers standard twFileManager.openFile logic,
              // which will prompt for permission quickly and elegantly.
              window.openFile(linkedEntry.handle);
              return;
            }

            // 2. We don't have a mapping. We must force the user to select the file manually
            // using the browser Picker to grant persistent FileSystem API permissions.
            log("No linked handle found. Triggering first-time linking prompt.");

            // We need to show some UI to explain why the picker is appearing
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed; inset: 0; background: rgba(0,0,0,0.8); z-index: 10000;
                display: flex; flex-direction: column; align-items: center; justify-content: center;
                color: white; font-family: sans-serif; text-align: center; padding: 40px;
              `;
            overlay.innerHTML = `
                <h2>Link File Association</h2>
                <p style="margin-bottom: 20px; max-width: 500px">
                  To open files directly from Windows, Lithic needs permission to access your file system.<br><br>
                  Please select <b>${startupFilePath.split('\\').pop().split('/').pop()}</b> in the dialog that appears next to permanently link it.
                </p>
                <button id="btn-link" style="padding: 10px 20px; font-size: 16px; cursor: pointer; color: black">Select File Now</button>
              `;
            document.body.appendChild(overlay);

            document.getElementById('btn-link').onclick = async () => {
              try {
                // Heuristic to guess best "startIn" directory from the OS path
                const lowerPath = startupFilePath.toLowerCase();
                const wellKnownDirs = ['desktop', 'documents', 'downloads', 'music', 'pictures', 'videos'];
                let bestStartIn = undefined;

                for (const dir of wellKnownDirs) {
                  // Look for \dir\ or /dir/ or ending in \dir
                  if (lowerPath.includes(`\\${dir}\\`) ||
                    lowerPath.includes(`/${dir}/`) ||
                    lowerPath.endsWith(`\\${dir}`) ||
                    lowerPath.endsWith(`/${dir}`)) {
                    bestStartIn = dir;
                    break;
                  }
                }

                const pickerOptions = {
                  types: [
                    { description: 'Lithic Monolith', accept: { 'application/x-lith': ['.lith'] } },
                    { description: 'Lithic JSON Backups', accept: { 'application/json': ['.json'] } }
                  ]
                };
                if (bestStartIn) {
                  pickerOptions.startIn = bestStartIn;
                }

                const [fileHandle] = await window.showOpenFilePicker(pickerOptions);

                // Wrap and store the mapping!
                await twFileManager.addRecent(fileHandle, startupFilePath);

                // Boot the wiki using standard browser flow
                overlay.remove();
                window.openFile(fileHandle);

              } catch (e) {
                log("User cancelled file linkage.");
                overlay.innerHTML += `<p style="color: coral; margin-top:20px">Linkage cancelled. Please restart the app or select Mount from Disk.</p>`;
              }
            };
          }
        } catch (err) {
          console.error("Failed to load Tauri startup file:", err);
        }
      }
    };

    // --- DRAG AND DROP HANDLING ---
    let dragCounter = 0;

    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    });

    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dragCounter++;
      if (dragCounter === 1) {
        document.body.classList.add('drag-over');
      }
    });

    window.addEventListener('dragleave', (e) => {
      e.preventDefault();
      dragCounter--;
      if (dragCounter === 0) {
        document.body.classList.remove('drag-over');
      }
    });

    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      document.body.classList.remove('drag-over');

      // 1. Try to process dropped text/URLs (e.g., from the Lithic Share URL)
      const droppedUrl = e.dataTransfer.getData('URL') || e.dataTransfer.getData('text/plain');
      if (droppedUrl && (droppedUrl.includes('?json=') || droppedUrl.includes('?lith=') || droppedUrl.includes('?url='))) {
        try {
          const urlObj = new URL(droppedUrl);
          let b64Json = urlObj.searchParams.get('json') || urlObj.searchParams.get('lith');
          let remoteUrl = urlObj.searchParams.get('url');

          if (remoteUrl) {
            if (!remoteUrl.toLowerCase().startsWith('http') && !remoteUrl.startsWith('/')) {
              try { remoteUrl = decodeURIComponent(escape(atob(remoteUrl))); } catch (e) { }
            }
            const res = await fetch(remoteUrl);
            const text = await res.text();
            const parsedData = JSON.parse(text);
            if (Array.isArray(parsedData) && parsedData.length > 0) {
              let node = parsedData[0];
              node.tags = node.tags ? [...new Set([...(Array.isArray(node.tags) ? node.tags : (typeof node.tags === 'string' ? node.tags.split(' ') : [])), 'Dogear'])].join(' ') : 'Dogear';
              window.pendingImports = window.pendingImports.concat(parsedData);
              window.updatePendingImportsWindow();
              return; // Handled as deferred payload
            }
          } else if (b64Json) {
            let jsonString = b64Json;
            if (!b64Json.trim().startsWith('[')) {
              jsonString = decodeURIComponent(escape(atob(b64Json)));
            }
            const parsedData = JSON.parse(jsonString);
            if (Array.isArray(parsedData) && parsedData.length > 0) {
              let node = parsedData[0];
              node.tags = node.tags ? [...new Set([...(Array.isArray(node.tags) ? node.tags : (typeof node.tags === 'string' ? node.tags.split(' ') : [])), 'Dogear'])].join(' ') : 'Dogear';
              window.pendingImports = window.pendingImports.concat(parsedData);
              window.updatePendingImportsWindow();
              return; // Handled as deferred payload
            }
          }
        } catch (err) {
          console.warn("Dropped text looked like a payload URL but failed to parse", err);
        }
      }

      if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) {
        return;
      }

      const file = e.dataTransfer.files[0];
      const fileName = file.name.toLowerCase();
      const isJsonMode = fileName.endsWith('.lith') || fileName.endsWith('.json');
      const isHtmlMode = fileName.endsWith('.html') || fileName.endsWith('.htm');

      if (!isJsonMode && !isHtmlMode) {
        return;
      }

      try {
        let contents = await file.text();

        if (isJsonMode) {
          // Instead of mounting immediately, we parse the data and add to pendingImports
          try {
            let parsedData;
            if (fileName.endsWith('.lith')) {
              parsedData = parseLithToJSON(contents);
            } else {
              parsedData = JSON.parse(contents);
            }

            if (Array.isArray(parsedData)) {
              window.pendingImports = window.pendingImports.concat(parsedData);
              window.updatePendingImportsWindow();
              return; // Handled as deferred payload
            }
          } catch (err) {
            console.error("Failed to parse dropped data file:", err);
            alert("Dropped file is not valid data format.");
          }
        } else if (isHtmlMode) {
          setTwCustomSaveAsSaver(false);
          replacePageContents(contents); // HTML files still mount immediately
        }
      } catch (err) {
        console.error("Failed to mount dropped file:", err);
        alert("Failed to mount dropped file. See console for details.");
      }
    });
  </script>

  <script>
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/offline-service-worker.js').catch(function (error) {
        console.error('Service Worker registration failed:', error);
      });
    }
  </script>
