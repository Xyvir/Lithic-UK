/**
 * What a search matches in a Lith's name, and where the match lands.
 *
 * The extension is not part of a title. It is the same few characters on every row,
 * so matching it turns any query containing "lith" into "every file here" (the list
 * answers with everything and says nothing) and the highlighted fragment lands on
 * the suffix rather than on the word that was typed. `abcd.lith` is not a match for
 * "lith"; `lithography.lith` is, because the word is in its name.
 *
 * Both halves live here because they are one question asked twice. Whether a row is
 * listed and which characters of its title are shown as the reason the row is there
 * have to agree, and a rule spelled out at each call site is a rule that drifts: the
 * row would be filtered by one answer and drawn by another.
 *
 * The drawing half returns HTML, as `cache-search` does for a tiddler's own name, and
 * for the same reason: a name is a short value read at a glance, so its marks are
 * inline runs rather than nodes a template has to cut around. Every occurrence is
 * marked, not just the first. A second one left plain reads as a different word.
 */

function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}

/**
 * The searchable half of a name: everything before its extension.
 *
 * A leading dot is part of the name rather than an extension, and a name with no dot
 * has nothing to strip. Only the last suffix is an extension, so a stacked name like
 * `notes.lith.json` keeps the `lith` it is really called.
 */
export function lithTitle(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * Whether this name is a match for the query: a substring of its title, case
 * insensitive, and never anything in the extension.
 */
export function titleMatches(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle.length > 0 && lithTitle(name).toLowerCase().includes(needle);
}

/**
 * Whether a row with this name belongs in the list at all. An empty query is not a
 * search: it lists everything, which is the state the launcher opens in.
 */
export function showsForQuery(name: string, query: string): boolean {
  return !query.trim() || titleMatches(name, query);
}

/**
 * The name as it is drawn by a row: the whole of it, with every run the query
 * matched inside the title wrapped in a mark, escaped on the way through.
 *
 * The offsets are read off the displayed name and the title is a prefix of it, so a
 * match can never reach the extension and everything after the last one (the suffix
 * this mark does not cover) is passed through as it was.
 */
export function titleMarkup(name: string, query: string): string {
  const needle = query.trim().toLowerCase();
  const title = lithTitle(name);
  if (!needle) return escape(name);

  const haystack = title.toLowerCase();
  let out = '';
  let index = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    out += escape(name.slice(index, at));
    out += `<mark class="name-match">${escape(name.slice(at, at + needle.length))}</mark>`;
    index = at + needle.length;
    at = haystack.indexOf(needle, index);
  }
  return out + escape(name.slice(index));
}
