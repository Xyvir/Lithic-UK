/**
 * What a search matches in a Lith's name, and where a match lands in a short value a row draws.
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
 *
 * `matchMarkup` is that half on its own, for the rows whose value is not a file name. A
 * bookmark row draws an instance's address, and the query that listed it has to be visible
 * inside it for the same reason: the row is the answer to "why is this here", and an
 * address is read at a glance too. Nothing there is an extension, so nothing is held back.
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
 * A short value as a row draws it with a query marked in it: every run the query matched
 * wrapped in a mark, and everything else escaped on the way through.
 *
 * The mark carries no meaning of its own beyond being a run of the row's own text, so the
 * caller only has to be inside something `styles.css` dresses (`mark.name-match`, which
 * every row that draws one already is). Marking is a substring rule rather than a word rule:
 * the query is what somebody typed, and a half-typed word has to land where it landed.
 */
export function matchMarkup(value: string, query: string): string {
  const needle = query.trim().toLowerCase();
  if (!needle) return escape(value);

  const haystack = value.toLowerCase();
  let out = '';
  let index = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    out += escape(value.slice(index, at));
    out += `<mark class="name-match">${escape(value.slice(at, at + needle.length))}</mark>`;
    index = at + needle.length;
    at = haystack.indexOf(needle, index);
  }
  return out + escape(value.slice(index));
}

/**
 * The name as it is drawn by a row: the whole of it, with every run the query
 * matched inside the title wrapped in a mark, escaped on the way through.
 *
 * The title is a prefix of the displayed name, so marking the title and passing the
 * suffix through is the same string the row would draw unsearched: a match can never
 * reach the extension, which is not search surface in the first place.
 */
export function titleMarkup(name: string, query: string): string {
  const title = lithTitle(name);
  return matchMarkup(title, query) + escape(name.slice(title.length));
}
