/* 
   idb-keyval minified standard implementation 
   (Required to access the directory handle from IndexedDB)
*/
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
  function getDefaultStore() {
    if (!store) store = new Store();
    return store;
  }
  function get(key, store = getDefaultStore()) {
    let req;
    return store._withIDBStore('readonly', store => {
      req = store.get(key);
    }).then(() => req.result);
  }
  exports.Store = Store;
  exports.get = get;
  return exports;
}({}));

/* Service Worker Logic */
const VERSION = '0.0.298'; // Updated by build pipeline
const CACHE_NAME = 'lithic-cache-v' + VERSION;
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/src/launcher.html',
  '/src/lithic.html',
  '/manifest.json',
  '/offline-service-worker.js',
  '/favicon.ico',
  '/android-chrome-192x192.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[SW] Pre-caching core assets');
      // One asset at a time rather than `cache.addAll`, which rejects as a whole: a
      // deployment missing any single file (a public dir that never got one icon, an
      // engine served from somewhere else) used to install a worker with an empty cache
      // and no way to tell. This cache is the only thing that can answer once the server
      // is down, so losing all of it to one 404 is losing offline mode itself.
      const missed = [];
      await Promise.all(ASSETS_TO_CACHE.map((path) => cache.add(path).catch(() => missed.push(path))));
      if (missed.length > 0) console.warn('[SW] Pre-cache missed:', missed.join(', '));
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Clean up old caches
      caches.keys().then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              console.log('[SW] Deleting old cache:', cacheName);
              return caches.delete(cacheName);
            }
          })
        );
      })
    ])
  );
});

self.addEventListener('fetch', function (event) {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // Filter out non-local/http requests
  if (!url.protocol.startsWith('http')) return;

  event.respondWith(
    (async () => {
      // 1. Try to serve from local directory handle (if active)
      try {
        const dirHandle = await idbKeyval.get('activeDirHandle');
        console.log('[SW] Checking for activeDirHandle:', !!dirHandle, 'URL:', url.pathname);

        if (dirHandle) {
          // Remove leading slash if present
          let path = url.pathname;
          if (path.startsWith('/')) path = path.slice(1);

          // Try to resolve file in the handle with fallback support
          // Problem: URL might be /src/states.png but mounted handle IS 'src', so file is at root.
          // Solution: Try full path ['src', 'states.png']. If fail, try ['states.png'].

          const fullParts = path.split('/').filter(p => p.length > 0 && p !== '.');
          console.log('[SW] Initial path parts:', fullParts);

          async function tryResolve(handle, parts) {
            let current = handle;
            for (let i = 0; i < parts.length; i++) {
              const part = parts[i];
              if (i === parts.length - 1) {
                // Expect file
                const fileHandle = await current.getFileHandle(part);
                return await fileHandle.getFile();
              } else {
                // Expect directory
                current = await current.getDirectoryHandle(part);
              }
            }
            throw new Error('End of path without file');
          }

          let file = null;
          // Loop: try full path, then shift(), then shift()...
          // Limit to preventing excessive recursion if path is huge, but usually it's short.

          let partsToTry = [...fullParts];
          while (partsToTry.length > 0) {
            try {
              console.log('[SW] Trying resolve with:', partsToTry);
              file = await tryResolve(dirHandle, partsToTry);
              console.log('[SW] Success resolving:', partsToTry);
              break; // Found it!
            } catch (e) {
              // console.log('[SW] Failed resolve:', partsToTry, e.name);
              partsToTry.shift(); // Remove first segment and retry
            }
          }

          if (file) {
            // Get MIME type from file or extensions
            const getMimeType = (name) => {
              if (name.endsWith('.pdf')) return 'application/pdf';
              if (name.endsWith('.txt')) return 'text/plain';
              if (name.endsWith('.html')) return 'text/html';
              if (name.endsWith('.css')) return 'text/css';
              if (name.endsWith('.js')) return 'application/javascript';
              if (name.endsWith('.json')) return 'application/json';
              if (name.endsWith('.png')) return 'image/png';
              if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
              if (name.endsWith('.gif')) return 'image/gif';
              if (name.endsWith('.svg')) return 'image/svg+xml';
              if (name.endsWith('.mp3')) return 'audio/mpeg';
              if (name.endsWith('.mp4')) return 'video/mp4';
              return null;
            };

            const mimeType = file.type || getMimeType(file.name) || 'application/octet-stream';

            return new Response(file, {
              headers: {
                'Content-Type': mimeType
              }
            });
          }
          console.log('[SW] Could not resolve file in local handle after all attempts.');

        }
      } catch (err) {
        // Not found locally or permission error, proceed to network/cache
        console.log('[SW] Local resolution skipped/failed:', err);
      }

      // 2. Cache/Network Fallback (Original Logic)
      const cachedResponse = await caches.match(event.request);
      if (cachedResponse) return cachedResponse;

      try {
        return await fetch(event.request);
      } catch (error) {
        console.log('Offline fetch failed for:', event.request.url);
        // A navigation with no cache entry of its own is the launcher handed over with
        // annotations on its address: `?mode=self-host&lithic-from=…` (see
        // `withLauncherHandoff`), and `?q=…` when the handover is a search. Cache keys are
        // whole URLs, so the document itself is not found, and the network that would
        // serve it is what just failed — which left a bookmarked instance that is down
        // showing a bare "Offline" page instead of the launcher it was told to open, with
        // no offline mode and no way back. The same path without the query is what was
        // precached, so this asks for it by path alone: those annotations name who handed
        // the page over, never which document was asked for.
        if (event.request.mode === 'navigate') {
          const shell = await caches.match(event.request, { ignoreSearch: true });
          if (shell) return shell;
        }
        return new Response('Offline', { status: 408, statusText: 'Offline' });
      }
    })()
  );
});

// --- Icon cache-bust message handler ---
// Receives { type: 'BUST_ICON_CACHE' } from the launcher after a custom icon is saved.
// Evicts all icon entries from every open cache and re-fetches them so the
// browser/PWA picks up the new artwork without a manual cache clear.
const ICON_PATHS = [
  '/favicon.ico',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/mstile-150x150.png',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/apple-touch-icon.png',
];

self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'BUST_ICON_CACHE') return;
  console.log('[SW] BUST_ICON_CACHE received — evicting and re-fetching icon entries.');
  event.waitUntil(
    caches.keys().then(async (cacheNames) => {
      for (const name of cacheNames) {
        const cache = await caches.open(name);
        for (const path of ICON_PATHS) {
          await cache.delete(new Request(path));
        }
      }
      // Re-populate the current cache with fresh copies
      const cache = await caches.open(CACHE_NAME);
      await Promise.allSettled(ICON_PATHS.map(path =>
        fetch(path, { cache: 'reload' }).then(res => {
          if (res.ok) return cache.put(path, res);
        }).catch(() => {})
      ));
      console.log('[SW] Icon cache busted and refreshed.');
    })
  );
});
