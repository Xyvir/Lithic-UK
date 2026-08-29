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

export async function addRecentFile(fileHandle: FileSystemFileHandle, tauriPath: string | null = null): Promise<RecentEntry[]> {
  try {
    const raw = (await idb.get<any[]>('recentFiles')) || [];
    let recentFiles: RecentEntry[] = raw.map((f) => (f && f.handle ? f : { handle: f, tauriPath: null }));

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

export async function getRecentFiles(): Promise<RecentEntry[]> {
  try {
    const raw = (await idb.get<any[]>('recentFiles')) || [];
    return raw.map((f) => (f && f.handle ? f : { handle: f, tauriPath: null }));
  } catch {
    return [];
  }
}

export async function removeRecentFile(fileHandleToRemove: FileSystemFileHandle): Promise<RecentEntry[]> {
  try {
    const raw = (await idb.get<any[]>('recentFiles')) || [];
    const recentFiles: RecentEntry[] = raw.map((f) => (f && f.handle ? f : { handle: f, tauriPath: null }));
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

export async function clearAllRecentFiles(): Promise<void> {
  try {
    await idb.del('recentFiles');
  } catch (err) {
    console.error('Failed to clear recent files from IndexedDB:', err);
  }
}

export async function saveSearchCache(fileName: string, text: string): Promise<void> {
  try {
    const now = Date.now();
    const latestKey = 'search_cache_' + fileName;
    const bk1Key = 'search_cache_bk1_' + fileName;
    const bk2Key = 'search_cache_bk2_' + fileName;

    const currentCache = await idb.get<{ text: string; lastModified: string; backupTimestamp?: number }>(latestKey);
    const bk1 = await idb.get(bk1Key);
    const bk2 = await idb.get(bk2Key);

    const TWO_HOURS = 2 * 60 * 60 * 1000;
    const lastBackupTime = currentCache?.backupTimestamp ?? 0;
    const backupsNotFull = !bk1 || !bk2;

    if (currentCache && (backupsNotFull || now - lastBackupTime >= TWO_HOURS)) {
      if (bk1) await idb.set(bk2Key, bk1);
      await idb.set(bk1Key, currentCache);

      await idb.set(latestKey, {
        text: text,
        lastModified: new Date().toLocaleString(),
        backupTimestamp: now
      });
      if (backupsNotFull) {
        if (!bk1) await idb.set(bk1Key, currentCache);
        else if (!bk2) await idb.set(bk2Key, currentCache);
      }
    } else {
      await idb.set(latestKey, {
        text: text,
        lastModified: new Date().toLocaleString(),
        backupTimestamp: currentCache ? currentCache.backupTimestamp : now
      });
    }
  } catch (err) {
    console.error('Failed to save search cache to IndexedDB:', err);
  }
}
