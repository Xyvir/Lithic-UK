/**
 * How much of the recent list is actually backed up.
 *
 * In the desktop app the sync unit is a *folder*, not the app: the connected
 * repository is the folder the wiki lives in, and every connected folder keeps
 * its own `.git`. So a Lith opened from anywhere else is perfectly safe but
 * outside the backup — a coverage fact worth stating, not a fault worth
 * flagging. Calling it an error would put a warning on every row of a fresh
 * install and teach people to ignore warnings.
 *
 * Self-host has no equivalent question: the server owns exactly one data
 * directory, so nothing on it can be un-backed-up. Coverage is a desktop
 * concern and the caller simply doesn't ask there.
 */

/** Directory part of a path, tolerating either separator and trailing slashes. */
export function folderOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  if (cut < 0) return '';
  // Keep the separator, so "C:\wiki.lith" -> "C:\" and "/a/b.lith" -> "/a/".
  return normalized.slice(0, cut + 1);
}

/**
 * The folder's own name: the last segment of a path, tolerating either separator
 * and trailing slashes. Naming a folder in copy needs the name, not the path —
 * "Copy to archive" fits a button, `D:\backups\archive` does not.
 */
export function folderNameOf(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '');
  const cut = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return cut < 0 ? normalized : normalized.slice(cut + 1);
}

/** One recent row, reduced to what coverage needs. */
export type CoverageRow = { name: string; path: string | null };

export type BackupCoverage = {
  /** Rows that record a disk path. Browser-handle rows are neither counted nor reported. */
  tracked: number;
  backedUp: number;
  /** Paths of rows no repository covers. */
  localOnlyPaths: string[];
};

/**
 * @param repoRootByPath wiki path -> the folder holding the repository that
 *   backs it up. Absent for paths outside every backed-up folder. The backend
 *   resolves the ancestor chain, so a wiki nested inside a synced folder counts
 *   as covered by the repository at that folder's root.
 */
export function computeBackupCoverage(
  rows: readonly CoverageRow[],
  repoRootByPath: Readonly<Record<string, string>>
): BackupCoverage {
  const localOnlyPaths: string[] = [];
  let tracked = 0;
  let backedUp = 0;
  for (const row of rows) {
    if (!row.path) continue;
    tracked += 1;
    if (repoRootByPath[row.path]) backedUp += 1;
    else localOnlyPaths.push(row.path);
  }
  return { tracked, backedUp, localOnlyPaths };
}

/**
 * Whether coverage is worth showing at all: with nothing backed up, "not backed
 * up" is true of every row and says nothing about any particular one.
 */
export function hasBackedUpRepo(repoRootByPath: Readonly<Record<string, string>>): boolean {
  return Object.keys(repoRootByPath).length > 0;
}

/**
 * One representative path per distinct folder, which is what the folder listing
 * takes. Separate from the repository roots on purpose: a row in a folder that
 * isn't backed up yet is still listed, so a rebuild finds its siblings too.
 */
export function folderTargets(rows: readonly CoverageRow[]): Array<{ folder: string; path: string }> {
  const targets = new Map<string, string>();
  for (const row of rows) {
    if (!row.path) continue;
    const folder = folderOf(row.path);
    if (!folder || targets.has(folder)) continue;
    targets.set(folder, row.path);
  }
  return [...targets].map(([folder, path]) => ({ folder, path }));
}

/**
 * The folder to copy a local-only Lith into: the root of the newest recent row
 * that already has one.
 *
 * Newest-first, not "the most common" or "the first alphabetically": the top of
 * the list is the folder the user has been working in, so it is the one they
 * mean by "the synced folder". Rows are the same order the list shows, which is
 * also the order things are adopted in.
 *
 * `null` when nothing is backed up — a state the caller cannot act in, since a
 * local-only mark only exists once some folder is covered.
 */
export function syncedDirFor(
  rows: readonly CoverageRow[],
  repoRootByPath: Readonly<Record<string, string>>
): string | null {
  for (const row of rows) {
    if (!row.path) continue;
    const root = repoRootByPath[row.path];
    if (root) return root;
  }
  return null;
}

/**
 * Something a rebuild is about to remove, held for confirmation. `path` is null
 * for an entry that only ever existed as a cached copy.
 */
export type RebuildOrphan = { name: string; path: string | null };

/**
 * Everything a rebuild would remove: recent rows whose file the fresh listing
 * does not contain, and cached copies whose wiki is not in the listing at all —
 * including ones no list shows any more.
 *
 * The second group matters as much as the first. An entry only a search can
 * find looks like a file and cannot be opened, so a refresh that removed the
 * row but kept its cache would trade one discongruity for a quieter one.
 *
 * Compared against the listing rather than the filesystem, because the listing
 * is what the rebuild acts on: what gets warned about is exactly what would go.
 */
export function orphanedEntries(
  rows: readonly CoverageRow[],
  cachedNames: readonly string[],
  listed: ReadonlySet<string>,
  listedNames: ReadonlySet<string>
): RebuildOrphan[] {
  const orphans: RebuildOrphan[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.path || listed.has(row.path)) continue;
    const key = row.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    orphans.push({ name: row.name, path: row.path });
  }
  for (const name of cachedNames) {
    const key = name.toLowerCase();
    if (seen.has(key) || listedNames.has(key)) continue;
    seen.add(key);
    orphans.push({ name, path: null });
  }
  return orphans;
}

/**
 * Folders a rebuild should list: every backed-up repository root, plus the
 * folder of every known row. The roots come first so what it discovers starts
 * where the backup does. Each is listed flat — a rebuild top-ups the list with
 * the folder's own files rather than descending into it, because a folder is
 * the unit the user adds.
 */
export function reindexFolders(
  rows: readonly CoverageRow[],
  repoRootByPath: Readonly<Record<string, string>>
): string[] {
  const folders: string[] = [];
  const seen = new Set<string>();
  const add = (folder: string) => {
    if (!folder || seen.has(folder)) return;
    seen.add(folder);
    folders.push(folder);
  };
  for (const row of rows) if (row.path) add(repoRootByPath[row.path] ?? '');
  for (const { folder } of folderTargets(rows)) add(folder);
  return folders;
}
