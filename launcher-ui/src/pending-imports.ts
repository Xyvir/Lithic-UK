import { parseLithToJSON } from './lithic-format.ts';

export type PendingTiddler = Record<string, string>;

/**
 * Tag the root parent tiddler with Dogear so a shared payload opens at the
 * top of the story river (legacy behavior for ?json= / ?url= / intro).
 */
export function tagRootDogear(tiddlers: PendingTiddler[]): PendingTiddler[] {
  if (tiddlers.length === 0) return tiddlers;
  const root = { ...tiddlers[0] };
  const existing = Array.isArray(root.tags) ? root.tags : typeof root.tags === 'string' ? root.tags.split(' ') : [];
  root.tags = [...new Set([...existing, 'Dogear'])].join(' ');
  return [root, ...tiddlers.slice(1)];
}

/**
 * Parse a payload blob that may be either a JSON tiddler array or a .lith
 * monolith. Used for remote (?url=) payloads and the intro.
 */
export function parsePayloadText(text: string): PendingTiddler[] {
  const trimmed = text.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed as PendingTiddler[];
    } catch {
      // Fall through to the lith parser.
    }
  }
  return parseLithToJSON(text);
}

/**
 * Parse dropped data files: .lith uses the lith parser, .json must already
 * be a JSON array (legacy behavior).
 */
export function parseDroppedData(text: string, isLith: boolean): PendingTiddler[] {
  if (!isLith) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed as PendingTiddler[];
      return [];
    } catch {
      return [];
    }
  }
  return parseLithToJSON(text);
}

/**
 * Decode a ?json= / ?lith= URL param. Supports both raw JSON arrays and
 * base64-encoded payloads, then tags the root with Dogear. Returns null when
 * the value does not decode to a non-empty tiddler array.
 */
export function decodePayloadParam(value: string): PendingTiddler[] | null {
  let jsonString = value;
  if (!value.trim().startsWith('[')) {
    try {
      jsonString = decodeURIComponent(escape(atob(value)));
    } catch {
      return null;
    }
  }
  const parsed = parsePayloadText(jsonString);
  return parsed.length > 0 ? tagRootDogear(parsed) : null;
}

/**
 * Fetch a remote payload URL (?url= param) and parse it as JSON or lith.
 * Tags the root with Dogear and returns null on any failure.
 */
export async function fetchRemotePayload(url: string): Promise<PendingTiddler[] | null> {
  let target = url;
  if (!target.toLowerCase().startsWith('http') && !target.toLowerCase().startsWith('file:') && !target.startsWith('/')) {
    try {
      target = decodeURIComponent(escape(atob(target)));
    } catch {
      // Keep the original value; the fetch below will surface the error.
    }
  }
  try {
    const response = await fetch(target);
    if (!response.ok) return null;
    const text = await response.text();
    const parsed = parsePayloadText(text);
    return parsed.length > 0 ? tagRootDogear(parsed) : null;
  } catch {
    return null;
  }
}

/** Concatenate pending imports without mutating the existing queue. */
export function mergePendingImports(existing: PendingTiddler[], incoming: PendingTiddler[]): PendingTiddler[] {
  return [...existing, ...incoming];
}

/**
 * Drop one queued tiddler by position, leaving the rest in the order they arrived.
 *
 * Position rather than title: a queue can hold two tiddlers with the same title (two dropped
 * files are each their own payload), and removing "the one called X" would then take the
 * wrong row or both.
 */
export function removePendingImport(existing: PendingTiddler[], index: number): PendingTiddler[] {
  if (index < 0 || index >= existing.length) return existing;
  return existing.filter((_, at) => at !== index);
}

/**
 * What a queue addition did: the rows the panel should draw, and the copies it refused.
 *
 * A refused title is one the queue already holds. The engine keeps one tiddler per title and
 * the last writer wins, so queueing both copies would draw two rows for one tiddler and import
 * only the second. The first copy is kept, and the person is told which file's copy did not
 * arrive, because the remedy (remove the queued row, then drop again) is theirs to take.
 */
export type QueuedImports = { queued: PendingTiddler[]; refused: string[] };

export function queuePendingImports(existing: PendingTiddler[], incoming: PendingTiddler[]): QueuedImports {
  const queued = [...existing];
  const titles = new Set(
    queued
      .map((tiddler) => (typeof tiddler.title === 'string' ? tiddler.title : ''))
      .filter((title) => title.trim() !== '')
  );
  const refused: string[] = [];
  for (const tiddler of incoming) {
    const title = typeof tiddler.title === 'string' ? tiddler.title : '';
    // An untitled entry is kept as it always was: the panel names it, and the mount is what
    // drops it, since a tiddler with no title cannot be stored at all.
    if (title.trim() === '') {
      queued.push(tiddler);
      continue;
    }
    if (titles.has(title)) {
      refused.push(title);
      continue;
    }
    titles.add(title);
    queued.push(tiddler);
  }
  return { queued, refused };
}

/**
 * Queued titles that would replace a tiddler the document being opened already holds.
 *
 * Only a real change counts. Dropping a file back into the Lith it came from, or pinning a
 * note the document already holds unchanged, replaces nothing, and a question about it would
 * be noise on a merge that costs nothing. A title that is not in the document is a plain
 * addition. Titles are compared as exact strings, which is how the wiki keys them: `Notes` and
 * `notes` are two tiddlers, so neither is a replacement for the other.
 */
export function replacingTitles(documentTiddlers: PendingTiddler[], queue: PendingTiddler[]): string[] {
  const held = new Map<string, PendingTiddler>();
  for (const tiddler of documentTiddlers) {
    const title = typeof tiddler.title === 'string' ? tiddler.title : '';
    if (title.trim() !== '') held.set(title, tiddler);
  }
  const replacing: string[] = [];
  for (const queued of queue) {
    const title = typeof queued.title === 'string' ? queued.title : '';
    const existing = held.get(title);
    if (!existing) continue;
    if (sameFields(existing, queued)) continue;
    replacing.push(title);
  }
  return replacing;
}

/** Every field of two tiddlers, with a missing field equal to an empty one. */
function sameFields(left: PendingTiddler, right: PendingTiddler): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (String(left[key] ?? '') !== String(right[key] ?? '')) return false;
  }
  return true;
}

/**
 * True when a dropped string looks like a Lithic share URL carrying a
 * payload (?json=, ?lith=, or ?url=).
 */
export function isPayloadShareUrl(text: string): boolean {
  return text.includes('?json=') || text.includes('?lith=') || text.includes('?url=');
}

/**
 * Build a pin payload from a search cache: the tiddler matching `title` gets
 * the Dogear tag (which pins it to the top of the story river: the modern
 * replacement for the deprecated $:/config/TiddlyTools/Pin mechanism). Only
 * the pinned tiddler is returned. Injecting it over the engine's store
 * refreshes that one tiddler with its cached (last-saved) content plus the
 * pin tag, and the next save persists the Dogear tag into the file.
 * Returns null when the cache does not contain the tiddler.
 */
export function pinCachedTiddler(cacheText: string, title: string): PendingTiddler[] | null {
  let tiddlers: PendingTiddler[];
  try {
    const parsed = JSON.parse(cacheText);
    if (!Array.isArray(parsed)) return null;
    tiddlers = parsed as PendingTiddler[];
  } catch {
    return null;
  }

  const match = tiddlers.find((tiddler) => tiddler.title === title);
  if (!match) return null;
  return tagRootDogear([{ ...match, tags: appendTag(match.tags, 'Dogear') }]);
}

function appendTag(tags: PendingTiddler['tags'], tag: string): string {
  const existing = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(' ') : [];
  return [...new Set([...existing, tag])].join(' ');
}
