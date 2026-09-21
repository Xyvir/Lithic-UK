import { KeyvalWikiHistory, isHistoryKey, type VersionSummary, type DownloadableVersion } from './wiki-history.ts';
import { parseLithToJSON } from './lithic-format.ts';
import { tiddlersToMap } from './json-patch.ts';

export interface RecentEntry {
  handle: FileSystemFileHandle;
  tauriPath: string | null;
  name?: string;
  text?: string;
  path?: string;
}

export class KeyvalStore {
  private dbp: Promise<IDBDatabase>;
  private unavailable = false;
  public dbName: string;
  public storeName: string;

  constructor(dbName = 'keyval-store', storeName = 'keyval') {
    this.dbName = dbName;
    this.storeName = storeName;
    if (typeof indexedDB === 'undefined') {
      this.unavailable = true;
      // Keep construction side-effect free. Methods reject when called, rather
      // than leaving a rejected promise that Node reports as unhandled.
      this.dbp = Promise.resolve(undefined as unknown as IDBDatabase);
    } else {
      this.dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open(dbName, 1);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = () => {
          req.result.createObjectStore(storeName);
        };
      });
    }
  }

  private withStore<T>(type: IDBTransactionMode, callback: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
    if (this.unavailable) return Promise.reject(new Error('IndexedDB not available'));
    return this.dbp.then((db) => new Promise<T>((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new Error(String(error ?? 'IndexedDB transaction failed')));
        }
      };
      try {
        const tx = db.transaction(this.storeName, type);
        let req: IDBRequest<T> | void;
        tx.oncomplete = () => {
          if (!settled) {
            settled = true;
            resolve((req as IDBRequest<T>)?.result as T);
          }
        };
        tx.onabort = tx.onerror = () => fail(tx.error);
        req = callback(tx.objectStore(this.storeName));
        if (req) req.onerror = () => fail(req?.error);
      } catch (error) {
        fail(error);
      }
    }));
  }

  get<T = any>(key: IDBValidKey): Promise<T | undefined> {
    return this.withStore('readonly', (store) => store.get(key));
  }

  set(key: IDBValidKey, value: any): Promise<void> {
    return this.withStore('readwrite', (store) => store.put(value, key)).then(() => undefined);
  }

  del(key: IDBValidKey): Promise<void> {
    return this.withStore('readwrite', (store) => store.delete(key)).then(() => undefined);
  }

  clear(): Promise<void> {
    return this.withStore('readwrite', (store) => store.clear()).then(() => undefined);
  }

  keys(): Promise<IDBValidKey[]> {
    return this.withStore('readonly', (store) => store.getAllKeys());
  }
}

export const idb = new KeyvalStore();

/** IndexedDB key holding the webapp install-offer dismissal flag. */
export const INSTALL_DISMISS_KEY = 'lithic-install-dismissed';

/** The shared history store used by the launcher UI and versioned saves. */
const historyStore = new KeyvalWikiHistory(idb);

export async function addRecentFile(fileHandle: FileSystemFileHandle, tauriPath: string | null = null): Promise<RecentEntry[]> {
  try {
    const raw = (await idb.get<any[]>('recentFiles')) || [];
    let recentFiles: RecentEntry[] = raw.map(normalizeRecentEntry);

    if (!fileHandle || !fileHandle.isSameEntry) return recentFiles;

    const inList = await Promise.all(
      recentFiles.map(async (f) => {
        try {
          return f.handle && (await fileHandle.isSameEntry(f.handle));
        } catch {
          return false;
        }
      })
    );
    const existingIndex = inList.findIndex((val) => val);
    const newEntry: RecentEntry = { handle: fileHandle, tauriPath };

    if (existingIndex !== -1) {
      if (tauriPath) recentFiles[existingIndex].tauriPath = tauriPath;
      const [moved] = recentFiles.splice(existingIndex, 1);
      recentFiles.unshift(moved);
    } else {
      recentFiles.unshift(newEntry);
    }

    if (recentFiles.length > 20) recentFiles = recentFiles.slice(0, 20);
    await idb.set('recentFiles', recentFiles);
    return recentFiles;
  } catch (err) {
    console.error('Failed to add recent file to IndexedDB:', err);
    return [];
  }
}

/** Normalize a stored recents row into RecentEntry shape. */
function normalizeRecentEntry(f: any): RecentEntry {
  // Already shaped (has handle/tauriPath keys) — keep as-is.
  if (f && typeof f === 'object' && ('handle' in f || 'tauriPath' in f)) {
    return { handle: f.handle ?? null, name: f.name, tauriPath: f.tauriPath ?? null } as RecentEntry;
  }
  // Legacy raw rows: a bare handle (or string name).
  return { handle: f, tauriPath: null } as RecentEntry;
}

/**
 * Loose recent row. The launcher writes `path`; the wiki's own saver writes
 * `tauriPath` or a Tauri pseudo-handle instead, and older data nests the handle
 * one level deeper. All of these turn up in the same recents store.
 */
export type RecentRow =
  | { name?: string; path?: string; tauriPath?: string | null; handle?: any; text?: string }
  | RecentEntry;

/**
 * The disk path behind a recent row, whatever shape it arrived in.
 *
 * Saves made from *inside* a Lith — a brand-new blank one included — are
 * recorded by the engine's saver, which stores `tauriPath` (or a pseudo-handle)
 * rather than `path`. Opening a row has always understood every one of those
 * shapes; anything else that needs the row's folder has to ask the same
 * question the same way, or it concludes no file is open for a Lith that was
 * just saved. Browser file handles have no path, so those return null.
 */
export function recentDiskPath(entry: RecentRow): string | null {
  const rawHandle = (entry as any)?.handle;
  const path =
    (entry as any)?.tauriPath ??
    (entry as any)?.path ??
    rawHandle?.__lithicTauriPath__ ??
    rawHandle?.handle?.__lithicTauriPath__;
  return typeof path === 'string' && path ? path : null;
}

export async function getRecentFiles(): Promise<RecentEntry[]> {
  try {
    const raw = (await idb.get<any[]>('recentFiles')) || [];
    return raw.map(normalizeRecentEntry);
  } catch {
    return [];
  }
}

/**
 * "Dismiss install offer" flag, webapp/PWA mode: user chose to hide the
 * install button (e.g. using the launcher as a plain bookmark). Cleared by
 * clearing site data — IndexedDB is the deliberate persistence choice so
 * "clear cache" is the manual restore path.
 */
export async function isInstallDismissed(): Promise<boolean> {
  try {
    return (await idb.get<boolean>(INSTALL_DISMISS_KEY)) === true;
  } catch {
    return false;
  }
}

export async function setInstallDismissed(dismissed: boolean): Promise<void> {
  try {
    if (dismissed) {
      await idb.set(INSTALL_DISMISS_KEY, true);
    } else {
      await idb.del(INSTALL_DISMISS_KEY);
    }
  } catch {
    /* best effort */
  }
}

export async function removeRecentFile(fileHandleToRemove: FileSystemFileHandle): Promise<RecentEntry[]> {
  try {
    const raw = (await idb.get<any[]>('recentFiles')) || [];
    const recentFiles: RecentEntry[] = raw.map(normalizeRecentEntry);
    const newRecentFiles: RecentEntry[] = [];

    for (const f of recentFiles) {
      try {
        if (f.handle?.isSameEntry && !(await f.handle.isSameEntry(fileHandleToRemove))) {
          newRecentFiles.push(f);
        }
      } catch {
        newRecentFiles.push(f);
      }
    }

    await idb.set('recentFiles', newRecentFiles);
    return newRecentFiles;
  } catch (err) {
    console.error('Failed to remove recent file from IndexedDB:', err);
    return [];
  }
}

export async function clearAllRecentFiles(store: CacheStore = idb): Promise<void> {
  try {
    // Drop every search cache, deep-copy backup, versioned history, and
    // transient dirty backup so a cleared recent list does not leave
    // orphaned recovery blobs behind.
    const allKeys = await store.keys();
    const cacheKeys = allKeys.filter(
      (key): key is string =>
        typeof key === 'string' && (key.startsWith('search_cache_') || isHistoryKey(key) || key.startsWith('dirty_state_'))
    );
    await Promise.all(cacheKeys.map((key) => store.del(key)));
  } catch (err) {
    console.error('Failed to clear search caches from IndexedDB:', err);
  }
  try {
    await store.del('recentFiles');
  } catch (err) {
    console.error('Failed to clear recent files from IndexedDB:', err);
  }
}

/**
 * Versioned search-cache save. Delegates to the per-wiki delta-chain history
 * (KeyvalWikiHistory): the new state is diffed against HEAD and stored as
 * tiny RFC 6902-style patch ops, with full snapshots only when diffs stop
 * paying for themselves. The legacy flat `search_cache_<name>` key is kept in
 * sync so search and cached-entry views keep working unchanged. The old
 * bk1/bk2 deep-copy backups are intentionally NOT migrated or written — the
 * frozen legacy launcher (assets/legacy-launcher.html) is the only producer of those.
 */
export async function saveSearchCache(fileName: string, text: string): Promise<void> {
  try {
    const now = Date.now();
    await historyStore.saveVersion(fileName, text, now);
    await idb.set('search_cache_' + fileName, {
      text,
      lastModified: new Date(now).toLocaleString(),
      backupTimestamp: now
    });
  } catch (err) {
    console.error('Failed to save search cache to IndexedDB:', err);
  }
}

/**
 * True only for the key holding a wiki's whole current text.
 *
 * History snapshots and deltas share the `search_cache_` prefix, and a base
 * snapshot carries a `text` field just like a cache does — so a reader that
 * filters on the prefix alone invents a wiki named after the key's suffix,
 * e.g. `base_recipes.lith_3f2a`. Such an entry is invisible in the list (cached
 * rows only render while a search is active), cannot be opened, and is enough
 * on its own to keep the Recent panel on screen. Every reader of "which wikis
 * are cached" has to agree on this predicate, which is why it lives here rather
 * than being spelled out at each call site.
 */
export function isFlatCacheKey(key: string): boolean {
  return key.startsWith('search_cache_') && !key.startsWith('search_cache_bk') && !isHistoryKey(key);
}

/** Names of the wikis with a cached copy, given a raw IndexedDB key list. */
export function cachedWikiNames(keys: IDBValidKey[]): string[] {
  return keys
    .filter((key): key is string => typeof key === 'string' && isFlatCacheKey(key))
    .map((key) => key.slice('search_cache_'.length));
}

/** Delete every history key (meta, bases, deltas) for one wiki. */
export async function deleteWikiHistory(name: string, store: CacheStore = idb): Promise<void> {
  await new KeyvalWikiHistory(store).deleteHistory(name);
}

/**
 * Forget everything remembered *about* one wiki on this device: its searchable
 * cache, the legacy launcher's bk1/bk2 deep copies, its versioned history, and
 * any unsaved-edit backup.
 *
 * Used wherever a wiki is deliberately dropped — the row's own remove button,
 * or a rebuild the user confirmed. Leaving any of it behind produces an entry
 * that no list shows and only a search can find: it looks like a file, cannot
 * be opened, and belongs to nothing. Deleting is the honest half of dropping.
 */
export async function forgetWikiCache(name: string, store: CacheStore = idb): Promise<void> {
  const keys = [
    dirtyKey(name),
    `search_cache_${name}`,
    `search_cache_bk1_${name}`,
    `search_cache_bk2_${name}`
  ];
  for (const key of keys) {
    try {
      await store.del(key);
    } catch {
      // Best effort: one unreadable key must not strand the rest.
    }
  }
  try {
    await deleteWikiHistory(name, store);
  } catch {
    // Best effort.
  }
}

/* ---
 * Transient (dirty) backups.
 *
 * The mounted engine streams changed tiddlers into
 * `dirty_state_<name>` in realtime, debounced; if the tab dies before a
 * real save the unsaved edits survive there. Recovery merges them into the
 * pending-imports queue so the user keeps or discards explicitly — nothing
 * is overwritten behind their back. Cleared when the merged handoff is
 * accepted, and treated as orphans by all cleanup flows.
 * --- */

export type DirtyStateRecord = { ts: number; tiddlers: Record<string, string>[] };

export const dirtyKey = (name: string) => `dirty_state_${name}`;

export async function getDirtyState(name: string, store: CacheStore = idb): Promise<DirtyStateRecord | null> {
  try {
    const record = await store.get<DirtyStateRecord>(dirtyKey(name));
    return record && Array.isArray(record.tiddlers) && record.tiddlers.length > 0 ? record : null;
  } catch {
    return null;
  }
}

export async function clearDirtyState(name: string, store: CacheStore = idb): Promise<void> {
  try {
    await store.del(dirtyKey(name));
  } catch {
    // Best effort.
  }
}

/**
 * Canonicalize a tiddler-array JSON string for content comparison. The Lithic
 * serializer omits empty fields, so empty values are omitted here as well;
 * titles and fields are sorted to make ordering irrelevant.
 */
function canonicalTiddlerText(text: string): string | null {
  const map = tiddlersToMap(text);
  if (!map) return null;
  return JSON.stringify(Object.keys(map).sort().map((title) => {
    const fields = map[title];
    const normalized: Record<string, unknown> = {};
    for (const field of Object.keys(fields).sort()) {
      if (fields[field] !== '' && fields[field] !== null && fields[field] !== undefined) {
        normalized[field] = fields[field];
      }
    }
    return normalized;
  }));
}

/**
 * Detect a file that changed outside this device since the latest local
 * history save. No history is created here; the caller decides whether to
 * quietly mark the next save as a SYNC snapshot.
 */
export async function isWikiDriftedFromHead(name: string, lithText: string, store: CacheStore = idb): Promise<boolean> {
  try {
    const history = new KeyvalWikiHistory(store);
    const versions = await history.listVersions(name);
    if (versions.length === 0) return false;
    const head = await history.getVersion(name, versions[0].id);
    if (!head) return true;
    const fileText = JSON.stringify(parseLithToJSON(lithText));
    const fileCanonical = canonicalTiddlerText(fileText);
    const headCanonical = canonicalTiddlerText(head.text);
    return fileCanonical === null || headCanonical === null || fileCanonical !== headCanonical;
  } catch {
    // A failed comparison should not block mounting or saving.
    return false;
  }
}

/**
 * Dirty-recovery candidates for the recent-files list: wikis with unsaved
 * edits that would otherwise be lost on the next mount.
 */
export async function listDirtyRecoveries(names: string[], store: CacheStore = idb): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    names.map(async (name) => {
      const record = await getDirtyState(name, store);
      if (record) out[name] = record.ts;
    })
  );
  return out;
}

/**
 * Read the searchable cache text for a file: prefers the live flat key,
 * falling back to materializing the newest history version (e.g. right after
 * the legacy backups were migrated away).
 */
export async function getSearchCacheText(fileName: string): Promise<string> {
  try {
    const legacy = await idb.get<{ text?: string }>('search_cache_' + fileName);
    if (typeof legacy?.text === 'string' && legacy.text) return legacy.text;
    const versions = await historyStore.listVersions(fileName);
    if (versions.length === 0) return '';
    const newest = await historyStore.getVersion(fileName, versions[0].id);
    return newest?.text ?? '';
  } catch {
    return '';
  }
}

/** Version summaries for the launcher's history modal (newest first). */
export async function listWikiVersions(name: string): Promise<VersionSummary[]> {
  return historyStore.listVersions(name);
}

/**
 * Per-wiki availability flag for the recents list: which of these wikis
 * have any recorded versions? Lets the UI hide the history affordance on
 * wikis (e.g. never-saved ones) where the modal would only report emptiness.
 */
export async function wikiHasHistory(names: string[]): Promise<Record<string, boolean>> {
  const availability: Record<string, boolean> = {};
  await Promise.all(names.map(async (name) => {
    try {
      availability[name] = (await historyStore.listVersions(name)).length > 0;
    } catch {
      availability[name] = false;
    }
  }));
  return availability;
}

/** Materialize one version for download as `<stem>_recover_<stamp>.lith`. */
export async function downloadWikiVersion(name: string, id: string): Promise<DownloadableVersion | null> {
  return historyStore.getVersion(name, id);
}

export type SearchCacheRecord = { text?: string; lastModified?: string; backupTimestamp?: number };

export type CacheStore = {
  keys(): Promise<IDBValidKey[]>;
  get<T = any>(key: IDBValidKey): Promise<T | undefined>;
  set(key: IDBValidKey, value: any): Promise<void>;
  del(key: IDBValidKey): Promise<void>;
};

/**
 * Proactive storage purge: when overall origin usage crosses the threshold,
 * delete the oldest-modified wikis' caches — flat key plus their full
 * versioned history — (never the last one) until usage drops below it.
 * Runs at launcher boot; best-effort on every environment.
 * The store and estimate fn are injectable for tests.
 */
export async function purgeOldestCachesIfNeeded(
  options: {
    threshold?: number;
    estimate?: () => Promise<{ usage?: number; quota?: number }>;
    store?: CacheStore;
  } = {}
): Promise<number> {
  const threshold = options.threshold ?? 0.8;
  const estimate = options.estimate ?? (() => navigator.storage!.estimate());
  const store: CacheStore = options.store ?? idb;

  let usage = 0;
  let quota = 0;
  try {
    const result = await estimate();
    usage = result.usage ?? 0;
    quota = result.quota ?? 0;
  } catch {
    return 0;
  }
  if (!quota || usage / quota < threshold) return 0;

  const dirtyKeys = ((await store.keys()) as IDBValidKey[])
    .filter((key): key is string => typeof key === 'string' && key.startsWith('dirty_state_'));

  const cacheKeys = (await store.keys()).filter((key): key is string => typeof key === 'string' && isFlatCacheKey(key));

  // Never purge when only one cache exists.
  if (cacheKeys.length <= 1) return 0;

  const caches: Array<{ key: string; name: string; lastModified: number; size: number }> = [];
  for (const key of cacheKeys) {
    const cache = await store.get<SearchCacheRecord>(key);
    if (cache) {
      const parsed = cache.lastModified ? new Date(cache.lastModified).getTime() : NaN;
      caches.push({
        key,
        name: key.slice('search_cache_'.length),
        lastModified: Number.isNaN(parsed) ? 0 : parsed,
        size: cache.text ? new Blob([cache.text]).size : 0
      });
    }
  }

  caches.sort((a, b) => a.lastModified - b.lastModified);

  // Dirty backups whose wiki is being purged are orphans.
  const purgedNames = new Set(caches.map((cache) => cache.name));
  for (const key of dirtyKeys) {
    if (purgedNames.has(key.slice('dirty_state_'.length))) await store.del(key);
  }

  const purgeHistory = new KeyvalWikiHistory(store);
  let currentUsage = usage;
  let purged = 0;
  while (caches.length > 1 && currentUsage / quota >= threshold) {
    const oldest = caches.shift()!;
    await store.del(oldest.key);
    // The purged wiki's version history goes with it.
    try {
      await purgeHistory.deleteHistory(oldest.name);
    } catch {
      // Best effort.
    }
    currentUsage -= oldest.size;
    purged += 1;
  }
  return purged;
}
