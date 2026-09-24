export type CachedSearchResult = {
  matched: boolean;
  preview: string;
  title?: string;
};

export type CachedWiki = {
  name: string;
  text: string;
};

export type CachedWikiMatch = CachedSearchResult & {
  text: string;
};

/**
 * The tiddler fields a query is allowed to match.
 *
 * A cached wiki is a tiddler array, and a tiddler carries bookkeeping as well as
 * content: `created` and `modified` stamps, `type`, `tags`, and whatever a mount
 * injected. Searching every field made those strings search surface — the query
 * `te` matched `creaTEd` — and because the context was then cut from a field that
 * was not the body, the panel printed raw JSON at the user instead of their note.
 * Only the note's own text and its own name are content anyone would search for.
 */
const MATCHABLE_FIELDS = ['text', 'title'] as const;

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function normalize(value: string): string {
  return value.replace(/(?:\\n|\r?\n|\r)/g, ' ');
}

/**
 * The tiddler array a cache holds, or null when the cache is not one.
 *
 * Null is the HTML-monolith case and any other cache that is not tiddler JSON: its
 * whole text is the body, and the caller matches against it directly.
 */
function parseTiddlers(text: string): Array<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<Record<string, unknown>>) : null;
  } catch {
    return null;
  }
}

/**
 * Mark every occurrence of the query inside a short value — a tiddler's own name.
 *
 * Every occurrence rather than the first, because a title is read at a glance and a
 * second occurrence left unmarked reads as a different word. The mark is classed so
 * the title can carry the app's blue while the body context keeps its amber.
 */
function highlightAll(value: string, query: string): string {
  if (!query) return escape(value);
  const lower = value.toLowerCase();
  let out = '';
  let index = 0;
  let at = lower.indexOf(query);
  while (at !== -1) {
    out += escape(value.slice(index, at));
    out += `<mark class="cache-preview-title-mark">${escape(value.slice(at, at + query.length))}</mark>`;
    index = at + query.length;
    at = lower.indexOf(query, index);
  }
  return out + escape(value.slice(index));
}

function highlightContext(text: string, query: string, width: number): string {
  const normalized = normalize(text);
  const index = normalized.toLowerCase().indexOf(query);
  if (index < 0) return escape(normalized.slice(0, width));

  const start = Math.max(0, index - width);
  const end = Math.min(normalized.length, index + query.length + width * 2);
  const before = escape(normalized.slice(start, index));
  const match = escape(normalized.slice(index, index + query.length));
  const after = escape(normalized.slice(index + query.length, end));
  return `${start ? '…' : ''}${before}<mark>${match}</mark>${after}${end < normalized.length ? '…' : ''}`;
}

/**
 * Search one cached wiki: does it hold the query, and where?
 *
 * Only content fields match (see `MATCHABLE_FIELDS`), so a query appearing solely in
 * a tiddler's stamps is not a match: the row and the panel it drives stay away for
 * it. The tiddler that matched decides both the title line and the body the context
 * is cut from, and a cache that is not tiddler JSON is treated as one body of text.
 * A title that matched and a body that did not still reports the head of the body,
 * because there is no body hit to centre a context on.
 */
export function searchCachedWiki(text: string, query: string, width = 46): CachedSearchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { matched: false, preview: '' };

  const normalized = normalize(text);
  // A cheap gate before parsing: a query this cache does not contain anywhere cannot
  // appear in one of its fields either.
  if (!normalized.toLowerCase().includes(q)) return { matched: false, preview: '' };

  const tiddlers = parseTiddlers(text);
  if (!tiddlers) return { matched: true, preview: highlightContext(normalized, q, width) };

  const hit = tiddlers.find((tiddler) =>
    MATCHABLE_FIELDS.some((field) => {
      const value = tiddler?.[field];
      return typeof value === 'string' && value.toLowerCase().includes(q);
    })
  );
  if (!hit) return { matched: false, preview: '' };

  const title = typeof hit.title === 'string' ? hit.title : undefined;
  const body = typeof hit.text === 'string' ? hit.text : '';
  const titleLine = title ? `<strong class="cache-preview-title">${highlightAll(title, q)}</strong><br>` : '';
  return { matched: true, title, preview: `${titleLine}${highlightContext(body, q, width)}` };
}

export function searchCachedWikis(entries: readonly CachedWiki[], query: string, width = 46): Record<string, CachedWikiMatch> {
  const matches: Record<string, CachedWikiMatch> = {};
  for (const entry of entries) {
    const result = searchCachedWiki(entry.text, query, width);
    if (result.matched) matches[entry.name] = { ...result, text: entry.text };
  }
  return matches;
}
