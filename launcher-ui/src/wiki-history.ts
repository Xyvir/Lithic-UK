import { tiddlersToMap, mapToTiddlerArrayText, diffTiddlerMaps, applyTiddlerPatch, type TiddlerMap, type JsonPatchOp } from './json-patch.ts';
import type { CacheStore } from './storage.ts';

/**
 * Per-wiki version history for search caches.
 *
 * Replaces the old `search_cache_` / `search_cache_bk1_` / `search_cache_bk2_`
 * deep-copy pair with a git-lite chain per wiki:
 *
 *   search_cache_meta_<name>       -> { headId, versions: VersionMeta[] }
 *   search_cache_base_<name>_<id>  -> { id, text }                  (full snapshot)
 *   search_cache_delta_<name>_<id> -> { id, parentId, ts, ops }     (patch from parent)
 *
 * Every save diffs the new state against HEAD (RFC 6902-style ops over
 * title-keyed tiddlers), so versions are tiny field-level deltas instead of
 * full-text deep copies — a chain of N versions costs roughly one snapshot
 * plus the size of what actually changed. Materializing any version is
 * deterministic: newest base at-or-before it + replayed deltas, exactly like
 * `git checkout <sha>`.
 *
 * History is append-only and non-destructive: recovering an old version
 * touches nothing, and a huge rewrite starts a NEW base segment rather than
 * resetting the chain. Retention trims oldest-first while keeping every
 * retained version materializable (the oldest base is re-based onto its
 * successor instead of being dropped blindly).
 *
 * `WikiHistoryStore` is the unified interface both local/tauri (IndexedDB
 * keyval) and a future git-backed server implementation should satisfy, so
 * the launcher modal works against either backend unchanged.
 */

export interface VersionMeta {
  id: string;
  ts: number;
  /** Size of the materialized tiddler JSON, in bytes. */
  sizeBytes: number;
  /** True when this version is a full-text base snapshot (a chain root). */
  isBase?: boolean;
}

export interface WikiHistoryMeta {
  headId: string;
  versions: VersionMeta[];
}

export interface VersionSummary extends VersionMeta {
  /** Human-readable timestamp mirroring the old cache's lastModified format. */
  lastModified: string;
}

export interface DownloadableVersion {
  /** Suggested file name, e.g. `mywiki_recover_20260903T154500Z.lith`. */
  fileName: string;
  /** Tiddler-array JSON text for the materialized version. */
  text: string;
}

export interface WikiHistoryStore {
  listVersions(name: string): Promise<VersionSummary[]>;
  saveVersion(name: string, tiddlerJsonText: string, now?: number): Promise<void>;
  getVersion(name: string, id: string): Promise<DownloadableVersion | null>;
  deleteHistory(name: string): Promise<void>;
}

export const HISTORY_VERSIONS_PER_WIKI = 30;

const metaKey = (name: string) => `search_cache_meta_${name}`;
const baseKey = (name: string, id: string) => `search_cache_base_${name}_${id}`;
const deltaKey = (name: string, id: string) => `search_cache_delta_${name}_${id}`;

/** True for every per-version delta key (`search_cache_delta_..._...`). */
function isDeltaKey(key: string, name?: string): boolean {
  if (!key.startsWith('search_cache_delta_')) return false;
  if (name === undefined) return true;
  return key.startsWith(`search_cache_delta_${name}_`);
}

function bytesOf(text: string): number {
  return new Blob([text]).size;
}

function toIso(ts: number): string {
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

/** File-name stamp for recovered copies: compact, sortable, filesystem-safe. */
export function recoverStamp(ts: number): string {
  return toIso(ts).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Suggested download name for a recovered version: `<original>_recover_<stamp>.lith`. */
export function recoveredFileName(name: string, ts: number): string {
  const stem = name.replace(/\.(?:html?|lith|json)$/i, '') || 'untitled';
  return `${stem}_recover_${recoverStamp(ts)}.lith`;
}

/** Short deterministic version id: timestamp + content/parent hash. */
function versionId(ts: number, text: string, parentId = ''): string {
  let hash = 5381;
  const seed = `${parentId}|${text}`;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) + hash + seed.charCodeAt(i)) >>> 0;
  return `${ts.toString(36)}-${hash.toString(36)}`;
}

interface Materialized {
  map: TiddlerMap | null;
  reached: boolean;
}

export class KeyvalWikiHistory implements WikiHistoryStore {
  private readonly store: CacheStore;
  private readonly maxVersions: number;

  constructor(store: CacheStore, maxVersions: number = HISTORY_VERSIONS_PER_WIKI) {
    this.store = store;
    this.maxVersions = maxVersions;
  }

  async listVersions(name: string): Promise<VersionSummary[]> {
    try {
      const meta = await this.store.get<WikiHistoryMeta>(metaKey(name));
      if (!meta?.versions) return [];
      return meta.versions
        .map((version) => ({
          ...version,
          lastModified: toIso(version.ts).replace('T', ' ').replace('Z', ' UTC')
        }))
        .sort((a, b) => b.ts - a.ts);
    } catch {
      return [];
    }
  }

  async saveVersion(name: string, tiddlerJsonText: string, now: number = Date.now()): Promise<void> {
    const nextMap = tiddlersToMap(tiddlerJsonText);
    if (!nextMap) return;

    const meta = (await this.store.get<WikiHistoryMeta>(metaKey(name))) ?? { headId: '', versions: [] };
    const head = meta.headId ? await this.materializeVersion(name, meta, meta.headId) : null;
    const ops: JsonPatchOp[] = head?.map ? diffTiddlerMaps(head.map, nextMap) : [];

    let id: string;
    if (!head?.map || bytesOf(JSON.stringify(ops)) > bytesOf(tiddlerJsonText) / 2) {
      // First version for this wiki, or the delta stopped paying for itself
      // (more than half the size of a full snapshot): start a new base
      // segment — prior history stays intact and materializable.
      id = versionId(now, tiddlerJsonText);
      await this.store.set(baseKey(name, id), { id, text: tiddlerJsonText });
      meta.versions.push({ id, ts: now, sizeBytes: bytesOf(tiddlerJsonText), isBase: true });
    } else {
      id = versionId(now, tiddlerJsonText, meta.headId);
      await this.store.set(deltaKey(name, id), { id, parentId: meta.headId, ts: now, ops });
      meta.versions.push({ id, ts: now, sizeBytes: bytesOf(mapToTiddlerArrayText(nextMap)) });
    }

    meta.headId = id;
    await this.prune(name, meta);
    await this.store.set(metaKey(name), meta);
  }

  async getVersion(name: string, id: string): Promise<DownloadableVersion | null> {
    try {
      const meta = await this.store.get<WikiHistoryMeta>(metaKey(name));
      if (!meta?.versions?.some((version) => version.id === id)) return null;
      const materialized = await this.materializeVersion(name, meta, id);
      if (!materialized.reached || !materialized.map) return null;
      const version = meta.versions.find((entry) => entry.id === id)!;
      return { fileName: recoveredFileName(name, version.ts), text: mapToTiddlerArrayText(materialized.map) };
    } catch {
      return null;
    }
  }

  async deleteHistory(name: string): Promise<void> {
    try {
      const keys = (await this.store.keys()) as IDBValidKey[];
      for (const key of keys) {
        const asString = String(key);
        if (
          asString === metaKey(name) ||
          asString.startsWith(`search_cache_base_${name}`) ||
          isDeltaKey(asString, name)
        ) {
          await this.store.del(asString);
        }
      }
    } catch {
      // Best effort, mirroring the legacy cache cleanup.
    }
  }

  /**
   * Materialize a version by walking back to the newest base at-or-before it,
   * then replaying deltas forward with parent-continuity checks. A broken
   * chain reports `reached: false` instead of silently yielding wrong text.
   */
  private async materializeVersion(name: string, meta: WikiHistoryMeta, targetId: string): Promise<Materialized> {
    const ordered = [...meta.versions].sort((a, b) => a.ts - b.ts);
    const targetIndex = ordered.findIndex((version) => version.id === targetId);
    if (targetIndex < 0) return { map: null, reached: false };

    let baseIndex = -1;
    for (let i = targetIndex; i >= 0; i--) {
      if (ordered[i].isBase) {
        baseIndex = i;
        break;
      }
    }
    if (baseIndex < 0) return { map: null, reached: false };

    const base = await this.store.get<{ id: string; text: string }>(baseKey(name, ordered[baseIndex].id));
    let map = base ? tiddlersToMap(base.text) : null;
    if (!map) return { map: null, reached: false };

    let parentId = ordered[baseIndex].id;
    for (let i = baseIndex + 1; i <= targetIndex; i++) {
      const version = ordered[i];
      const delta = await this.store.get<{ id: string; parentId: string; ops: JsonPatchOp[] }>(deltaKey(name, version.id));
      if (!delta || delta.parentId !== parentId) return { map: null, reached: false };
      map = applyTiddlerPatch(map, delta.ops);
      parentId = version.id;
    }
    return { map, reached: true };
  }

  /**
   * Trim the chain to `maxVersions`, oldest-first, keeping every retained
   * version materializable. When the oldest entry is a base (the common
   * case — bases root every chain), it is "re-based away": its successor is
   * materialized and promoted to the new base, so we only ever shed the
   * single oldest state.
   */
  private async prune(name: string, meta: WikiHistoryMeta): Promise<void> {
    let overflow = meta.versions.length - this.maxVersions;
    while (overflow > 0) {
      const ordered = [...meta.versions].sort((a, b) => a.ts - b.ts);
      const oldest = ordered[0];

      if (oldest.isBase && ordered.length > 1) {
        const second = ordered[1];
        const materialized = await this.materializeVersion(name, meta, second.id);
        if (!materialized.reached || !materialized.map) return;
        const text = mapToTiddlerArrayText(materialized.map);
        await this.store.set(baseKey(name, second.id), { id: second.id, text });
        await this.store.del(baseKey(name, oldest.id));
        await this.store.del(deltaKey(name, second.id));
        meta.versions = ordered.slice(1).map((version) =>
          version.id === second.id ? { ...version, isBase: true, sizeBytes: bytesOf(text) } : { ...version }
        );
        overflow -= 1;
        continue;
      }

      if (oldest.isBase) return; // Single version and still over — nothing safe to drop.
      await this.store.del(deltaKey(name, oldest.id));
      meta.versions = meta.versions.filter((version) => version.id !== oldest.id);
      overflow -= 1;
    }
  }
}

/** Keys owned by any wiki's history (meta + bases + deltas), for cleanup flows. */
export function isHistoryKey(key: string): boolean {
  return (
    key.startsWith('search_cache_meta_') ||
    key.startsWith('search_cache_base_') ||
    isDeltaKey(key)
  );
}
