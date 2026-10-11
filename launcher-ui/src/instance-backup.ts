/**
 * The instance backup: one file holding every Lith this browser's store knows.
 *
 * The fallback mode is the odd one out. Everywhere else a Lith is a file on a disk or a copy
 * the app owns, so the version history and the search cache are conveniences sitting beside a
 * document that would survive without them. In the browser storage fallback the store *is* the
 * document, so a single "clear site data" takes every Lith, its history and the list that named
 * them, and there is no other copy anywhere. This module is the one export that carries all of
 * it out in a single file and the one import that puts it back.
 *
 * What it holds, and why each part is in here rather than being read back from elsewhere:
 *
 *   recents   the list, as names. A path or a file handle is meaningless on the device this is
 *             restored to, and a browser-only row's own name is all it ever had.
 *   cache     each wiki's flat store record verbatim, which is the parsed tiddler JSON search
 *             reads and the version chain hangs off. Without it a restored wiki is history with no
 *             head, and it is the whole record rather than its `text` because the store orders
 *             caches by the `lastModified` beside that text, so a text-only copy would come back
 *             with a different eviction order.
 *   history   the store's own records, verbatim: the meta record and every base and delta the
 *             chain is made of. Exported as the raw keys and values rather than as materialized
 *             versions, because materializing every version would inflate the file and lose the
 *             delta chain a restore is supposed to hand back intact.
 *   dirty     an unsaved edit, which is the one piece of state a rewrite cannot rebuild.
 *
 *   bookmarks the saved instances, which live in localStorage beside the store rather than in
 *             it. This is the one part of the file that does not come from the store, so it is
 *             passed in rather than read (`collectInstanceBackup`) and handed back rather than
 *             written (`mergeBookmarks`), and it merges instead of replacing: a URL already on
 *             this device keeps the entry it has, and the rest are appended.
 *
 * Keys are carried rather than names and ids because the store's key is what a restore has to
 * write, and a name can contain the separators the keys are built from (`search_cache_base_`
 * is followed by the name, then `_`, then the version id), so reconstructing them is the part
 * that would get it wrong.
 *
 * What it deliberately leaves out: saved instance logins and the launcher's own preferences.
 * The vault's records have no business in a file somebody hands to another machine, and a
 * restore that wrote them would be replacing a decision rather than recovering a document.
 */

import { isHistoryKey } from './wiki-history.ts';
import { isFlatCacheKey, type CacheStore } from './storage.ts';
import { BOOKMARK_LIMIT, instanceLabel, type BookmarkEntry } from './bookmarks.ts';

/** The tag that says what a parsed file is, so a stray `.json` is refused rather than merged. */
export const BACKUP_FORMAT = 'lithic-instance-backup';
export const BACKUP_VERSION = 1;

const FLAT_PREFIX = 'search_cache_';
const META_PREFIX = 'search_cache_meta_';
const BASE_PREFIX = 'search_cache_base_';
const DELTA_PREFIX = 'search_cache_delta_';
const DIRTY_PREFIX = 'dirty_state_';
const RECENTS_KEY = 'recentFiles';

/** One store record, kept as the key it lives under and the value it holds. */
export interface BackupRecord {
  key: string;
  value: unknown;
}

/** A Lith, with its flat store record, whatever history it has, and any unsaved edit. */
export interface BackupWiki {
  name: string;
  /** The `search_cache_<name>` record as stored, or null for a wiki only history knows about. */
  cache: unknown | null;
  history: BackupRecord[];
  dirty: unknown | null;
}

/**
 * A recent row, as much of it as travels. `browserOnly` is what keeps a restored row from
 * looking like a name with nothing behind it, and `text` is the one case a row carries its own
 * document: an HTML monolith has no tiddler snapshot to be read back from.
 */
export interface BackupRecent {
  name: string;
  browserOnly?: true;
  text?: string;
}

/**
 * A saved instance as it travels: the address, its label, and whatever icon was cached for it.
 *
 * The icon is the whole reason the list is usable, so it travels with the entry rather than
 * being re-fetched: the address in a backup is usually an instance the reading device cannot
 * reach yet, and a list of bare hostnames cannot tell a personal instance from a work one.
 */
export interface BackupBookmark {
  url: string;
  label?: string;
  icon?: string;
  iconFetchedAt?: number;
}

export interface InstanceBackup {
  format: string;
  version: number;
  /** When this file was written, which is the moment it was asked for (`backupFileName`). */
exportedAt: string;
  source: { mode: string; origin: string | null };
  recents: BackupRecent[];
  wikis: BackupWiki[];
  /** Absent in a file written before the list travelled; the reader treats that as empty. */
  bookmarks: BackupBookmark[];
}

export type ParseResult =
  | { ok: true; backup: InstanceBackup }
  | { ok: false; reason: 'json' | 'format' | 'version' | 'shape' };

export type ImportPlan =
  | { ok: true; backup: InstanceBackup }
  | { ok: false; collisions: string[] };

/** The store surface this needs, so tests can hand it a map instead of IndexedDB. */
export type BackupStore = Pick<CacheStore, 'keys' | 'get' | 'set'>;

/** Compact, sortable, filesystem-safe stamp for the download's name. */
export function backupStamp(now: number = Date.now()): string {
  const date = new Date(now);
  if (Number.isNaN(date.getTime())) return '00000000-000000';
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

export function backupFileName(now: number = Date.now()): string {
  return `lithic-instance-backup-${backupStamp(now)}.json`;
}

/** The wiki a history key belongs to, given every wiki name the store knows. */
function wikiForHistoryKey(key: string, names: readonly string[]): string | null {
  // Longest first, because a name can be a prefix of another one and the longer name owns the
  // key: with `notes` and `notes_2026` both stored, `search_cache_base_notes_2026_<id>` is the
  // second wiki's base and not the first one's, whatever order the names arrived in.
  const ordered = [...names].sort((a, b) => b.length - a.length);
  for (const name of ordered) {
    if (
      key === `${META_PREFIX}${name}` ||
      key.startsWith(`${BASE_PREFIX}${name}_`) ||
      key.startsWith(`${DELTA_PREFIX}${name}_`)
    ) {
      return name;
    }
  }
  return null;
}

/**
 * Read everything this store holds into one document.
 *
 * The wiki list is built from the names the store itself names wikis by (a flat cache key, or a
 * history meta key), which is the only place a name appears unambiguously: base and delta keys
 * embed the same name beside a version id, and are attributed to those names afterwards.
 */
/**
 * One entry as the list keeps it, or null when it names no address.
 *
 * Shared by the export and the import on purpose: an entry that travels and an entry that
 * arrives are held to the same rules, which is what stops a file from writing a list the list
 * itself would not hold. The label falls back to the host, and an icon travels only with the
 * moment it was fetched, so a stale one is refetched by whoever reads the file rather than
 * trusted there.
 */
function toListEntry(entry: BackupBookmark): BookmarkEntry | null {
  const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
  if (!url) return null;
  const clean: BookmarkEntry = { url, label: (entry.label || '').trim() || instanceLabel(url) };
  if (typeof entry.icon === 'string' && entry.icon) {
    clean.icon = entry.icon;
    clean.iconFetchedAt = typeof entry.iconFetchedAt === 'number' ? entry.iconFetchedAt : 0;
  }
  return clean;
}

/** The bookmark list as it travels: entries that have an address, in order, deduped and capped. */
function sanitizeBookmarks(entries: readonly BackupBookmark[]): BackupBookmark[] {
  const seen = new Set<string>();
  const result: BackupBookmark[] = [];
  for (const entry of entries) {
    const clean = toListEntry(entry);
    if (!clean || seen.has(clean.url)) continue;
    seen.add(clean.url);
    result.push(clean);
    if (result.length === BOOKMARK_LIMIT) break;
  }
  return result;
}

export async function collectInstanceBackup(
  store: BackupStore,
  source: { mode: string; origin: string | null },
  now: number = Date.now(),
  bookmarks: readonly BackupBookmark[] = []
): Promise<InstanceBackup> {
  const keys = ((await store.keys()) as IDBValidKey[]).map(String);

  const names = new Set<string>();
  for (const key of keys) {
    if (key.startsWith(META_PREFIX)) names.add(key.slice(META_PREFIX.length));
    else if (!isHistoryKey(key) && isFlatCacheKey(key)) names.add(key.slice(FLAT_PREFIX.length));
  }

  const recordsByWiki = new Map<string, BackupRecord[]>();
  for (const name of names) recordsByWiki.set(name, []);
  for (const key of keys) {
    if (!isHistoryKey(key)) continue;
    const name = wikiForHistoryKey(key, [...names]);
    if (!name) continue;
    recordsByWiki.get(name)!.push({ key, value: await store.get(key) });
  }

  const wikis: BackupWiki[] = [];
  for (const name of names) {
    const record = await store.get(`${FLAT_PREFIX}${name}`);
    const dirty = await store.get(`${DIRTY_PREFIX}${name}`);
    wikis.push({
      name,
      cache: record ?? null,
      history: recordsByWiki.get(name) ?? [],
      dirty: dirty ?? null
    });
  }

  const rawRecents = (await store.get<any[]>(RECENTS_KEY)) ?? [];
  const recents: BackupRecent[] = [];
  for (const row of Array.isArray(rawRecents) ? rawRecents : []) {
    const name = String(row?.name ?? row?.handle?.name ?? '');
    if (!name) continue;
    recents.push({
      name,
      ...(row?.browserOnly === true ? { browserOnly: true as const } : {}),
      ...(typeof row?.text === 'string' && row.text ? { text: row.text } : {})
    });
  }

  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date(now).toISOString(),
    source,
    recents,
    wikis,
    bookmarks: sanitizeBookmarks(bookmarks)
  };
}

/** The document as the bytes that leave: one JSON object, no indentation, nothing else. */
export function serializeInstanceBackup(backup: InstanceBackup): string {
  return JSON.stringify(backup);
}

// Arrays are not records here. A `.json` tiddler payload is a top-level array, so it has to read as
// a shape this module does not handle and let the drop handler fall through to the payload path,
// instead of being taken for a backup file that is missing its header.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A file as a backup, or why it is not one.
 *
 * Refused rather than salvaged. A `.json` that is not this format is a tiddler payload the drop
 * handler already knows what to do with, and a version this build does not know is a file
 * written by a newer launcher, which is a thing to say rather than a thing to guess at.
 */
export function parseInstanceBackup(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'json' };
  }
  if (!isRecord(raw)) return { ok: false, reason: 'shape' };
  if (raw.format !== BACKUP_FORMAT) return { ok: false, reason: 'format' };
  if (raw.version !== BACKUP_VERSION) return { ok: false, reason: 'version' };
  if (!Array.isArray(raw.recents) || !Array.isArray(raw.wikis)) return { ok: false, reason: 'shape' };
  for (const wiki of raw.wikis) {
    if (!isRecord(wiki) || typeof wiki.name !== 'string' || !wiki.name) return { ok: false, reason: 'shape' };
    if (!Array.isArray(wiki.history)) return { ok: false, reason: 'shape' };
    // The key has to be here even when it holds null, or a wiki written without one would restore
    // as a name with nothing behind it.
    if (!('cache' in wiki)) return { ok: false, reason: 'shape' };
  }
  if (raw.bookmarks !== undefined) {
    if (!Array.isArray(raw.bookmarks)) return { ok: false, reason: 'shape' };
    for (const entry of raw.bookmarks) {
      if (!isRecord(entry) || typeof entry.url !== 'string' || !entry.url) return { ok: false, reason: 'shape' };
    }
  }
  // A missing list is a file written before bookmarks travelled, which is not a reason to refuse
  // it: the version that reads this one is the version that writes files older than itself.
  const backup = raw as unknown as InstanceBackup;
  return { ok: true, backup: { ...backup, bookmarks: Array.isArray(backup.bookmarks) ? backup.bookmarks : [] } };
}

/**
 * Whether this backup can land here, or the names that stop it.
 *
 * Refused whole rather than merged around. A name that is already here is either the same Lith
 * with its own history and its own list position, or a different one wearing the same name, and
 * neither can be told from the other by the file. Importing the rest and quietly leaving the
 * clashes behind would make one drop mean two things; the answer is the list of names to settle
 * first, and a re-drop once they are out of the way.
 *
 * Compared case-insensitively, the way the list itself compares names, and against the caches as
 * well as the rows: a wiki whose row is gone but whose text is still in the store is still a
 * wiki this device holds.
 */
export function planBackupImport(backup: InstanceBackup, existingNames: readonly string[]): ImportPlan {
  const taken = new Set(existingNames.map((name) => name.toLowerCase()));
  const collisions: string[] = [];
  for (const wiki of backup.wikis) {
    if (taken.has(wiki.name.toLowerCase())) collisions.push(wiki.name);
  }
  return collisions.length > 0 ? { ok: false, collisions } : { ok: true, backup };
}

/**
 * The bookmark list a restore leaves behind: what this device already had, plus what the file
 * brought that it did not.
 *
 * Additive on purpose. A backup is a snapshot of somewhere else, so a restore that replaced the
 * local list would silently delete instances somebody keeps here, and there is no undo for that
 * in a dialog that only said a file was being imported. Where both hold an address the local
 * entry wins, because its icon was fetched from a live instance rather than carried in a file.
 * The list's own limit is applied by the writer, so two long lists trim rather than refuse.
 */
export function mergeBookmarks(
  existing: readonly BookmarkEntry[],
  incoming: readonly BackupBookmark[]
): BookmarkEntry[] {
  const known = new Set(existing.map((entry) => entry.url));
  const merged: BookmarkEntry[] = [...existing];
  for (const entry of incoming) {
    const clean = toListEntry(entry);
    if (!clean || known.has(clean.url)) continue;
    known.add(clean.url);
    merged.push(clean);
  }
  return merged;
}

/**
 * Put a backup back into the store.
 *
 * Every record is written under the key it was read from, then the recent list is written whole,
 * which is the rule the list already keeps for itself (`setRecentRows` in `storage.ts`): one
 * writer decides what the list is, and it hands it over complete.
 *
 * The bookmarks are the one part this does not write, and cannot: they live in localStorage,
 * which is the page's rather than the store's. The caller merges them (`mergeBookmarks`) and
 * hands the result to `writeBookmarkList` in `bookmarks.ts`.
 */
export async function restoreInstanceBackup(store: BackupStore, backup: InstanceBackup): Promise<void> {
  for (const wiki of backup.wikis) {
    if (wiki.cache !== null && wiki.cache !== undefined) {
      await store.set(`${FLAT_PREFIX}${wiki.name}`, wiki.cache);
    }
    for (const record of wiki.history) await store.set(record.key, record.value);
    if (wiki.dirty !== null && wiki.dirty !== undefined) {
      await store.set(`${DIRTY_PREFIX}${wiki.name}`, wiki.dirty);
    }
  }
  const rows = backup.recents.map((recent) => ({
    name: recent.name,
    browserOnly: true,
    ...(recent.text ? { text: recent.text } : {})
  }));
  await store.set(RECENTS_KEY, rows);
}
