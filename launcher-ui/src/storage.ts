import { KeyvalWikiHistory, isHistoryKey, type VersionSummary, type DownloadableVersion } from './wiki-history.ts';
import { parseLithToJSON } from './lithic-format.ts';
import { tiddlersToMap } from './json-patch.ts';

export interface RecentEntry {
  handle: FileSystemFileHandle;
  tauriPath: string | null;
  name?: string;
  text?: string;
  path?: string;
  /**
   * No file anywhere, on any platform: this row's Lith exists only as a cached
   * copy in this browser's storage (the index-db-only fallback: see
   * browser-storage.ts). Recorded on the row rather than inferred from the
   * current mode, because the row outlives the mode it was made in.
   */
  browserOnly?: boolean;
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

/** How many rows the launcher's list holds, and therefore how many the store keeps. */
export const RECENT_LIMIT = 20;

/**
 * Write the whole recent list, and answer with what was written.
 *
 * The list is one list, and this is the write half of that rule: whoever has decided what the
 * list is hands it over whole. The read half is the bug this closes. Adding a row used to work
 * by asking *a store* what it held and adopting that answer as the new list, and the two stores
 * did not hold the same rows: a Lith adopted from a synced folder arrives as a path row and was
 * written to localStorage only, so its answer to "what do I hold" was "nothing of mine".
 * Saving one new blank Lith over a connected backup therefore emptied the list of every synced
 * Lith, and the row that replaced them was a handle row with no path, which is also what turned
 * the panel's foot from `Rebuild Recents` into `Reset Recents`: coverage is computed from the
 * paths those rows carried, and it had none left to compute from.
 *
 * Every kind of row goes in the one store, which is the rule a browser-only row already stated
 * for itself and this states for all of them: a row parked in the mirror is the one part of the
 * list a relaunch cannot see. Rows are spelled for the store on the way in, because the
 * launcher's own shape is not the stored one (a path row is `{ name, path }` out there and
 * `{ handle: null, name, tauriPath }` in here, which is what `normalizeRecentEntry` reads).
 *
 * A write that fails keeps the caller's list rather than emptying it. The store is the durable
 * copy, not the authoritative one, and an IndexedDB that refuses a write is not a reason to
 * take every row off the screen.
 */
export async function setRecentRows(rows: readonly RecentRow[], store: CacheStore = idb): Promise<RecentEntry[]> {
  const stored = rows.filter((row) => !isAnonymousRow(row)).slice(0, RECENT_LIMIT).map(storedRow);
  try {
    await store.set('recentFiles', stored);
  } catch (err) {
    console.error('Failed to write the recent list to IndexedDB:', err);
  }
  return stored;
}

/** One row in the shape the store keeps, which is what `normalizeRecentEntry` reads back. */
function storedRow(row: RecentRow): RecentEntry {
  const raw = row as any;
  const handle = raw?.handle ?? null;
  const diskPath = recentDiskPath(row);
  // A path row has no handle to carry its path, so the path has to survive in the field the
  // store reads. With a handle, the handle's own stash is what `recentDiskPath` falls back to,
  // and `tauriPath` is only ever what a caller passed explicitly.
  const tauriPath = raw?.tauriPath ?? (handle ? null : diskPath);
  const hasSource = Boolean(handle) || Boolean(diskPath);
  return {
    handle,
    name: recentRowName(row) || undefined,
    tauriPath: tauriPath ?? null,
    ...(raw?.browserOnly === true ? { browserOnly: true } : {}),
    // A row's own text rides along only where it is the row's last copy, the rule the
    // localStorage mirror already follows: a row with a path is re-read from disk, and a
    // Lith's content is in the search cache its own saver writes. It matters more here than
    // there, because this is the store a body can actually bloat.
    ...(!hasSource && typeof raw?.text === 'string' && raw.text ? { text: raw.text } : {})
  } as RecentEntry;
}

/**
 * The list with `row` in front of it, and any row for the same Lith dropped.
 *
 * Comparing against the *list* rather than against a store is the whole point: a store is
 * where the rows it happens to hold are, the list is what the user sees, and a save has to
 * add to the second without consulting the first.
 */
export async function mergeRecentRow(current: readonly RecentRow[], row: RecentRow): Promise<RecentEntry[]> {
  const rest: RecentEntry[] = [];
  for (const existing of current) {
    if (await sameRecentRow(existing, row)) continue;
    rest.push(existing as RecentEntry);
  }
  return [row as RecentEntry, ...rest].slice(0, RECENT_LIMIT);
}

/**
 * The store's rows and the mirror's, as one list.
 *
 * The two are copies of the same list, so they are read as one. Reading the store alone when it
 * happens to be non-empty is how they drifted apart in the first place: a list of synced Liths
 * in the mirror beside one saved row in the store reads as the one row, and a rebuild over that
 * list has no folder left to crawl. The store's order wins, because it is the copy a save
 * writes last, and what only the mirror holds follows it: those rows are older by construction.
 *
 * Keyed the way `mergeRecentsSidecar` keys its own merge, by the path where there is one and by
 * the name otherwise, so the three copies of this list agree about what is the same row.
 */
export function mergeRecentLists(primary: readonly RecentRow[], mirror: readonly RecentRow[]): RecentEntry[] {
  const keyOf = (row: RecentRow) => (recentDiskPath(row) ?? recentRowName(row)).toLowerCase();
  const seen = new Set<string>();
  const merged: RecentEntry[] = [];
  for (const row of [...primary, ...mirror]) {
    if (isAnonymousRow(row)) continue;
    const key = keyOf(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(row as RecentEntry);
  }
  return merged.slice(0, RECENT_LIMIT);
}

/**
 * A row that names a Lith without saying where it is and without keeping a copy of it: no path,
 * no handle, not the browser's own copy, and no text of its own.
 *
 * There is nothing such a row can be opened from, nothing it can be backed up to, and no folder
 * for a rebuild to find it in again, which is what makes it not a row rather than merely an
 * unhelpful one. The one mount that produced them was a blank Lith: created with nowhere to save
 * it yet, so the launcher could only remember its name, and the save that followed wrote the
 * real row through the engine's own saver. The placeholder was then a duplicate waiting to
 * happen, sitting beside a row that can be opened and backed up. `remember` no longer writes
 * one; this is the read that drops the ones already stored, so the rule holds for a list written
 * by an older build too.
 *
 * The two flags are each a location a row can have instead of a path, which is why neither is
 * one of these. A browser-only row says its Lith is in this browser's storage and nowhere else;
 * a row carrying `text` holds the document itself, which the launcher can mount read-only
 * (an HTML monolith written before the flag, or a row the mount that made it could not do
 * better than).
 */
export function isAnonymousRow(row: RecentRow): boolean {
  const raw = row as any;
  const holdsItsOwnCopy = typeof raw?.text === 'string' && raw.text !== '';
  return !raw?.handle && !recentDiskPath(row) && raw?.browserOnly !== true && !holdsItsOwnCopy;
}

/**
 * Whether two rows are the same Lith.
 *
 * Three answers, in order, and each of them is a kind of row the launcher writes. A path either
 * row knows is the strongest identity there is: the same path is the same file whatever is
 * holding it. Two comparable handles answer through `isSameEntry`, which is how picking one
 * file twice moves its row instead of adding a second. Anything else is a name, which is all a
 * path row or a browser-only row has, and is the comparison those two already made between
 * themselves.
 *
 * Handles that cannot be compared are not a name match. Two files called `notes.lith` in two
 * folders are two of the user's Liths, and collapsing them would hide one of them.
 */
export async function sameRecentRow(a: RecentRow, b: RecentRow): Promise<boolean> {
  const aPath = recentDiskPath(a);
  const bPath = recentDiskPath(b);
  if (aPath && bPath) return aPath === bPath;
  const aHandle = (a as any)?.handle;
  const bHandle = (b as any)?.handle;
  if (aHandle && bHandle) {
    if (typeof aHandle.isSameEntry !== 'function') return false;
    try {
      return Boolean(await aHandle.isSameEntry(bHandle));
    } catch {
      return false;
    }
  }
  const aName = recentRowName(a);
  return Boolean(aName) && aName === recentRowName(b);
}

/** Normalize a stored recents row into RecentEntry shape. */
function normalizeRecentEntry(f: any): RecentEntry {
  // Already shaped (has handle/tauriPath keys). Keep as-is.
  if (f && typeof f === 'object' && ('handle' in f || 'tauriPath' in f)) {
    return {
      handle: f.handle ?? null,
      name: f.name,
      tauriPath: f.tauriPath ?? null,
      browserOnly: f.browserOnly === true,
      // A browser-only row for an HTML monolith carries its own page text: a
      // monolith has no tiddler snapshot to read the page back from.
      ...(typeof f.text === 'string' && f.text ? { text: f.text } : {})
    } as RecentEntry;
  }
  // Legacy raw rows: a bare handle (or string name).
  return { handle: f, tauriPath: null } as RecentEntry;
}

/** The name a recents row is listed under, whatever shape it arrived in. */
export function recentRowName(entry: RecentRow): string {
  const raw = entry as any;
  return raw?.handle?.name ?? raw?.name ?? '';
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
 * Saves made from *inside* a Lith (a brand-new blank one included) are
 * recorded by the engine's saver, which stores `tauriPath` (or a pseudo-handle)
 * rather than `path`. Opening a row has always understood every one of those
 * shapes; anything else that needs the row's folder has to ask the same
 * question the same way, or it concludes no file is open for a Lith that was
 * just saved. A plain browser file handle has no path, so that returns null; the shim writes a
 * path onto its own handle (`__lithicShimPath__`) the same way the app writes `__lithicTauriPath__`.
 */
export function recentDiskPath(entry: RecentRow): string | null {
  const rawHandle = (entry as any)?.handle;
  const path =
    (entry as any)?.tauriPath ??
    (entry as any)?.path ??
    rawHandle?.__lithicTauriPath__ ??
    rawHandle?.__lithicShimPath__ ??
    rawHandle?.handle?.__lithicTauriPath__ ??
    rawHandle?.handle?.__lithicShimPath__;
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
 * "Dismiss install offer" flag for browser modes: user chose to hide the
 * install button (e.g. using the launcher as a plain bookmark). Reset Recents
 * restores it, while clearing site data also clears this IndexedDB value.
 *
 * Per device, and deliberately lasting. A shim's storage is scoped to a fixed origin by
 * construction (a fixed port, and `localhost` redirected to `127.0.0.1`), so this one flag
 * covers every copy that machine will run, including a build downloaded tomorrow: somebody who
 * has hidden the offer has said they do not want the app installed here, and a new download is
 * not a new question. Restoring it is a deliberate trip through "clear site data" for the same
 * reason, while Reset Recents offers the browser a simple restore path. The desktop app records
 * the same answer beside its exe in `recents.txt`, and deleting that file is its restore.
 *
 * Do not scope this to the build it was made on. It looks tempting, because a new AppImage
 * would then ask again, but it is the opposite of what the control means: dismissing is how
 * somebody says they are happy running the AppImage they have.
 */
export async function isInstallDismissed(store: Pick<CacheStore, 'get'> = idb): Promise<boolean> {
  try {
    return (await store.get<boolean>(INSTALL_DISMISS_KEY)) === true;
  } catch {
    return false;
  }
}

export async function setInstallDismissed(
  dismissed: boolean,
  store: Pick<CacheStore, 'set' | 'del'> = idb
): Promise<void> {
  try {
    if (dismissed) {
      await store.set(INSTALL_DISMISS_KEY, true);
    } else {
      await store.del(INSTALL_DISMISS_KEY);
    }
  } catch {
    /* best effort */
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
 * bk1/bk2 deep-copy backups are intentionally NOT migrated or written. The
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
 * snapshot carries a `text` field just like a cache does, so a reader that
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
 * Used wherever a wiki is deliberately dropped. The row's own remove button,
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
 * pending-imports queue so the user keeps or discards explicitly. Nothing
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

/** The copy of a Lith this device fetched, and the instance's digest for it. */
export type FetchedLith = { text: string; digest: string };

/**
 * The file this device last fetched for a Lith, if it kept one.
 *
 * Keyed inside the wiki's own cache record, so every cleanup path that already forgets a wiki.
 * A deleted row, a rebuild's orphan sweep, the storage purge) takes this with it.
 */
export async function readFetchedLith(fileName: string, store: CacheStore = idb): Promise<FetchedLith | null> {
  try {
    const record = await store.get<SearchCacheRecord>(`search_cache_${fileName}`);
    if (!record || typeof record.sourceText !== 'string' || !record.sourceDigest) return null;
    return { text: record.sourceText, digest: record.sourceDigest };
  } catch {
    return null;
  }
}

/**
 * Keep the file a fetch just returned, beside the digest it was fetched at.
 *
 * The parsed cache text is what search reads; this is the document as the instance had it, which
 * is the only form the patch API's base can take, so a device holding both can ask whether the
 * instance has moved on and, when it has not, mount its own copy instead of downloading the file
 * again. A file with no digest is not saved: without one there is nothing to compare against, and
 * a copy nobody can check is storage spent on nothing.
 */
export async function rememberFetchedLith(
  fileName: string,
  file: { text: string; digest: string; rev?: string },
  store: CacheStore = idb
): Promise<void> {
  if (!file.digest) return;
  try {
    const key = `search_cache_${fileName}`;
    const existing = await store.get<SearchCacheRecord>(key);
    await store.set(key, {
      ...existing,
      sourceText: file.text,
      sourceDigest: file.digest,
      sourceRev: file.rev
    });
  } catch (err) {
    console.error('Failed to keep the fetched Lith:', err);
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

export type SearchCacheRecord = {
  text?: string;
  lastModified?: string;
  backupTimestamp?: number;
  /**
   * The file exactly as this device received it, and the digest the instance gave for it.
   *
   * `text` above is *parsed* tiddlers (what search reads, and the baseline the drift check saves,
   * so it cannot be handed back to the patch API, whose base has to be the bytes the server
   * hashed. These three are that copy, and they are what makes a second open of a 10 MB Lith cost
   * one metadata read rather than the file (see `readFetchedLith`).
   */
  sourceText?: string;
  sourceDigest?: string;
  sourceRev?: string;
};

export type CacheStore = {
  keys(): Promise<IDBValidKey[]>;
  get<T = any>(key: IDBValidKey): Promise<T | undefined>;
  set(key: IDBValidKey, value: any): Promise<void>;
  del(key: IDBValidKey): Promise<void>;
};

/**
 * Proactive storage purge: when overall origin usage crosses the threshold,
 * delete the oldest-modified wikis' caches (flat key plus their full
 * versioned history) (never the last one) until usage drops below it.
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
        // Both copies in the record count towards what purging it frees, or the policy would
        // measure a 10 MB Lith as its parsed index and keep more of them than it means to.
        size: new Blob([cache.text ?? '', cache.sourceText ?? '']).size
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
