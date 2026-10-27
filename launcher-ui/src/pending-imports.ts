import { parseLithToJSON } from './lithic-format.ts';
import { parseScratchSource } from './scratch-editor.ts';

export type PendingTiddler = Record<string, string>;

/** Longest a derived title may be before it is cut, so a shared paragraph is not a title. */
export const SHARED_TITLE_LIMIT = 120;

/**
 * One line of text, with its whitespace collapsed, or the empty string.
 *
 * A shared payload arrives with whatever whitespace the other app thought fit: a trailing
 * newline on a URL, a run of spaces around a page title. Collapsed here rather than at each use,
 * so a title compared against another title is compared on its text.
 *
 * Square brackets go the same way, because a name derived here becomes part of a `stream-list`
 * and brackets are that field's own syntax. A page called `Index of /[stuff]` would otherwise name
 * a node that no reader can point at, and the shared article would arrive with one of its nodes
 * dropped from the tree. Nothing else about the name is rewritten: it is whatever the sending app
 * chose to call the thing.
 */
function sharedLine(value: string): string {
  return value.replace(/[[\]]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * The title a payload shared into this app takes in the queue.
 *
 * The sharing app's own title wins, because a phone that offers one has already given the content
 * a name a person would recognise (Chrome names the page a link came from). With none, the first
 * non-empty line names it, which is what the content itself says it is. A line longer than the
 * limit is cut there rather than at a word, since a title is a name to press rather than prose,
 * and the whole content is in the note either way.
 *
 * The empty string is the answer when there is neither, which is a share of nothing: the caller
 * queues nothing rather than a nameless row the wiki cannot store.
 */
export function sharedTitle(title: string, text: string): string {
  const offered = sharedLine(title);
  if (offered) return offered.length > SHARED_TITLE_LIMIT ? offered.slice(0, SHARED_TITLE_LIMIT).trimEnd() : offered;
  for (const line of text.split(/\r?\n/)) {
    const named = sharedLine(line);
    if (named) return named.length > SHARED_TITLE_LIMIT ? named.slice(0, SHARED_TITLE_LIMIT).trimEnd() : named;
  }
  return '';
}

/**
 * The note another app shared into this one, as the queue holds it.
 *
 * The conversion is the desktop's own rather than a second one. When the system hands this app a
 * `.md` or `.txt` through an "Open with" association, `parseScratchSource` is what turns it into
 * wiki tiddlers: blank lines separate nodes, leading tabs (or four-space groups) nest them, every
 * node renders as markdown, and the root carries the `stream-list` the outliner walks. A share is
 * the same kind of thing arriving by another route, so it goes through the same function with the
 * kind the association gives markdown. A shared article therefore lands in the chosen Lith looking
 * as it would have if the same text had been opened as a file, and a copy of the parser here
 * cannot drift from the association, because there is no copy. The `lithic-scratch` marker the
 * function writes comes with it: nothing reads it, and what it records, that the document began
 * its life as flat text, is true of a share.
 *
 * The one thing that differs is where the name comes from: the association names a document after
 * the file, and a share has no file, so the sending app's own title is that name.
 *
 * The root is tagged Dogear on top of that, which is the queue's own rule for every payload it
 * accepts (`?json=`, `?url=`, the introduction): what just arrived sits at the top of the story
 * river rather than somewhere inside it.
 *
 * The empty array is a share of nothing: no name and no text is not a note, and the alternative is
 * a row the engine refuses at mount time.
 */
export function sharedPayload(text: string, title: string): PendingTiddler[] {
  const base = sharedTitle(title, text);
  if (!base) return [];
  return tagRootDogear(parseScratchSource(text, { kind: 'text', base }));
}

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
