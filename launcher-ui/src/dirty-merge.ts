import { parseLithToJSON, serializeJsonToLith, type LithicTiddler } from './lithic-format.ts';

/**
 * The capture's edits, written on top of a document that is not open.
 *
 * A mount merges the capture by queueing its tiddlers and letting the engine's own save write
 * them, which costs the whole document being opened first. The history trail's Merge does the
 * same arithmetic without the mount: read the document as it stands, replace or add the titles
 * the capture carries, and serialize the result in the format a save writes.
 *
 * Title-keyed and last-writer-wins, exactly as the engine stores tiddlers, so the answer here
 * and the answer a recovery would give are the same document. A capture row with no title is
 * skipped rather than refused: the engine cannot store one, and a merge that failed over a
 * single bad row would strand every good edit beside it.
 */
export type MergeCaptureResult =
  | { ok: true; text: string; tiddlers: LithicTiddler[]; applied: number }
  | { ok: false; reason: 'empty' | 'unreadable' };

export function mergeCaptureIntoDocument(
  documentText: string,
  capture: Array<Record<string, string>>
): MergeCaptureResult {
  const edits = capture.filter((tiddler) => typeof tiddler?.title === 'string' && tiddler.title.trim() !== '');
  if (edits.length === 0) return { ok: false, reason: 'empty' };

  const trimmed = documentText.trim();
  let document: LithicTiddler[] = [];
  if (trimmed !== '') {
    // Both shapes a stored document has: the lith a file holds, and the tiddler array a cache
    // holds. A body that parses to nothing is a document this cannot merge onto, which is said
    // rather than merged over, because the alternative writes a file holding only the edits and
    // silently drops the wiki they belong to.
    if (trimmed.startsWith('[')) {
      // An empty array is a real answer here rather than a broken one: a Lith that has never
      // been saved with a tiddler in it is a blank document, and the edit is the first thing
      // in it. An empty *lith* is the same document and is handled below.
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) return { ok: false, reason: 'unreadable' };
        document = parsed as LithicTiddler[];
      } catch {
        return { ok: false, reason: 'unreadable' };
      }
    } else if (trimmed.startsWith('{')) {
      // A JSON object is not a document this can merge onto, and the lith parser would happily
      // read its braces and quotes as one untitled block rather than refuse them.
      return { ok: false, reason: 'unreadable' };
    } else {
      document = parseLithToJSON(documentText);
      // A titled block is what makes a body a document. Flat text of any kind parses into one
      // untitled tiddler, which is not a wiki to put edits into.
      if (!document.some((tiddler) => typeof tiddler.title === 'string' && tiddler.title.trim() !== '')) {
        return { ok: false, reason: 'unreadable' };
      }
    }
  }

  const merged = new Map<string, LithicTiddler>();
  for (const tiddler of document) {
    if (typeof tiddler.title === 'string' && tiddler.title.trim() !== '') merged.set(tiddler.title, tiddler);
  }
  for (const edit of edits) merged.set(edit.title, { ...edit });

  const tiddlers = [...merged.values()];
  return { ok: true, text: serializeJsonToLith(JSON.stringify(tiddlers)), tiddlers, applied: edits.length };
}
