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

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

function normalize(value: string): string {
  return value.replace(/(?:\\n|\r?\n|\r)/g, ' ');
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

export function searchCachedWiki(text: string, query: string, width = 46): CachedSearchResult {
  const q = query.trim().toLowerCase();
  if (!q) return { matched: false, preview: '' };

  const normalized = normalize(text);
  if (!normalized.toLowerCase().includes(q)) return { matched: false, preview: '' };

  let title: string | undefined;
  let matchingText = normalized;
  try {
    const tiddlers = JSON.parse(text) as Array<Record<string, unknown>>;
    const matchingTiddler = tiddlers.find((tiddler) =>
      Object.values(tiddler).some((value) => typeof value === 'string' && value.toLowerCase().includes(q))
    );
    if (typeof matchingTiddler?.title === 'string') title = matchingTiddler.title;
    if (typeof matchingTiddler?.text === 'string' && matchingTiddler.text.toLowerCase().includes(q)) {
      matchingText = matchingTiddler.text;
    }
  } catch {
    // Search caches may contain a non-JSON text fallback; context still works.
  }

  const titleLine = title ? `<strong class="cache-preview-title">${escape(title)}</strong><br>` : '';
  return {
    matched: true,
    title,
    preview: `${titleLine}${highlightContext(matchingText, q, width)}`
  };
}

export function searchCachedWikis(entries: readonly CachedWiki[], query: string, width = 46): Record<string, CachedWikiMatch> {
  const matches: Record<string, CachedWikiMatch> = {};
  for (const entry of entries) {
    const result = searchCachedWiki(entry.text, query, width);
    if (result.matched) matches[entry.name] = { ...result, text: entry.text };
  }
  return matches;
}
