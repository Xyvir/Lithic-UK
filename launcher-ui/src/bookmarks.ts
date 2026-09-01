export const BOOKMARKS_KEY = 'bookmarkedInstances';

export function normalizeInstanceUrl(value: string): string {
  const input = value.trim();
  if (!input) throw new Error('Enter a self-hosted Lithic instance URL.');
  const url = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Use an HTTP or HTTPS instance URL.');
  return url.origin;
}

export function readBookmarks(storage: Storage = localStorage): string[] {
  try {
    const value = JSON.parse(storage.getItem(BOOKMARKS_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function saveBookmark(value: string, storage: Storage = localStorage): string[] {
  const normalized = normalizeInstanceUrl(value);
  const bookmarks = readBookmarks(storage).filter((url) => url !== normalized);
  bookmarks.unshift(normalized);
  const result = bookmarks.slice(0, 20);
  storage.setItem(BOOKMARKS_KEY, JSON.stringify(result));
  return result;
}

export function removeBookmark(value: string, storage: Storage = localStorage): string[] {
  const result = readBookmarks(storage).filter((url) => url !== value);
  storage.setItem(BOOKMARKS_KEY, JSON.stringify(result));
  return result;
}
