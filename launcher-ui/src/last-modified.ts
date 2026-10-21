import { copy } from './copy.ts';

/**
 * When a recents row's Lith was last written, and the hover that says so.
 *
 * A row knows its name and, usually, where the document lives. When it was last touched is a
 * different question, and each shape of the launcher answers it from a different place:
 *
 *   - the desktop app has the file itself, so the file's own modification time is the answer;
 *   - the shim is a process too, so the page asks it for the same stamp;
 *   - an instance reports one in its listing, which is the store's own answer;
 *   - a browser page cannot read a file it was not just handed. Its handle would need a
 *     permission the person has not been asked for, and asking on hover is a prompt nobody
 *     wanted. So the browser's answer is the copy it already holds, whose save recorded when
 *     that copy was written. That is the last time *this device* wrote the Lith, which is the
 *     closest true thing a page can name, and it moves as the copy does.
 *
 * The two halves are kept apart so each can be tested without a page: `cachedStamp` reads the
 * moment out of a stored cache record, and `modifiedTitle` turns any moment into the one
 * sentence a hover carries. Choosing between the file's answer and the copy's is the caller's
 * job, because only the caller knows which shapes it is running in.
 */

/** The fields of a stored cache record that carry when it was written. */
export type CachedStampRecord = {
  /** A locale string, written by `saveSearchCache` and by the legacy launcher. */
  lastModified?: string;
  /** The same moment as a number, which is the field to prefer when it is there. */
  backupTimestamp?: number;
};

/**
 * The moment a cached copy was written, in milliseconds, or null when the record cannot say.
 *
 * `backupTimestamp` is tried first because it is already a number and cannot be misread. The
 * older `lastModified` string is the fallback, because every copy written before the number
 * existed carries only that, and a row with a stamp is better than one without.
 *
 * The string is written with `toLocaleString()`, so it is a *display* spelling and not a wire
 * format: `21/10/2026` is right in half the world and unreadable to `Date.parse` in the other
 * half, and `1/2/2026` means two different days. It is therefore parsed when this machine can
 * read it and treated as no answer when it cannot, because guessing day from month is exactly
 * the mistake a tooltip must not make. A blank, malformed or absent field is null rather than
 * zero: a row that says 1970 is worse than one that says nothing.
 */
export function cachedStamp(record: CachedStampRecord | null | undefined): number | null {
  if (!record) return null;
  if (
    typeof record.backupTimestamp === 'number' &&
    Number.isFinite(record.backupTimestamp) &&
    record.backupTimestamp > 0
  ) {
    return record.backupTimestamp;
  }
  if (typeof record.lastModified !== 'string' || !record.lastModified.trim()) return null;
  const parsed = Date.parse(record.lastModified);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * The hover a row carries, in the reader's language, or null when there is no moment to name.
 *
 * The date and the time are both there, in the medium style so a tooltip stays one line, and
 * the tag is the page's own locale rather than the host's: a date is part of the document's
 * language exactly as its words are, so a `?lang=fr` launcher says its dates in French too.
 * A stamp of zero, or of something that is not a moment at all, draws no sentence.
 */
export function modifiedTitle(stamp: number | null | undefined, tag: string): string | null {
  if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) return null;
  const when = new Date(stamp).toLocaleString(tag, { dateStyle: 'medium', timeStyle: 'short' });
  return copy.row.lastModified(when);
}
