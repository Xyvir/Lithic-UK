import { searchCachedWiki } from './cache-search.ts';

/**
 * What one instance's storage held, as the app's own reader answered for it.
 *
 * `caches` arrives newest-first, which is the only ordering signal that survives the
 * read: the app's reader sorts by the stamp each cache records, and this module is not
 * given the stamps themselves.
 */
export type InstanceCacheRead = {
  origin: string;
  caches: { name: string; text: string }[];
  /** A cap stopped that read short. Nothing is said about it yet; it is here so a
   * surface that wants to be honest about it can be. */
  truncated: boolean;
};

/** The single match an instance contributes to the launcher's search. */
export type InstanceHit = {
  origin: string;
  /** The Lith inside that instance: the cache key without its prefix. */
  name: string;
  title?: string;
  preview: string;
};

/** Reads keyed by origin, which is the shape the launcher keeps for the session. */
export type InstanceReads = Record<string, InstanceCacheRead>;

/**
 * The one cache an instance contributes for this query.
 *
 * One, because this search is orientation rather than destination: it says that an
 * instance holds something for these words, and the instance's own search is where the
 * rest of them are. Two rules, in order:
 *
 *   1. A note whose *name* matched beats one that matched in its body. A name is what
 *      the user typed looking for a thing; body text is a word that happens to appear.
 *   2. Within that, the instance's most recently saved wiki wins, which is the order
 *      the caches arrived in.
 *
 * A cache whose only match is a stamp contributes nothing — `searchCachedWiki` decides
 * that, and this does not second-guess it.
 */
export function topHit(read: InstanceCacheRead, query: string): InstanceHit | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  let best: InstanceHit | null = null;
  let bestRank = 2;
  for (const cache of read.caches) {
    const result = searchCachedWiki(cache.text, query);
    if (!result.matched) continue;
    const rank = result.title && result.title.toLowerCase().includes(q) ? 0 : 1;
    if (rank < bestRank) {
      bestRank = rank;
      best = { origin: read.origin, name: cache.name, title: result.title, preview: result.preview };
    }
  }
  return best;
}

/**
 * Every instance's contribution to one query, keyed by origin.
 *
 * A record rather than a list because the launcher renders it against the bookmark rows
 * it already has: the row for an instance is the same row, and the hit is what appears
 * beside it.
 */
export function topHits(reads: InstanceReads, query: string): Record<string, InstanceHit> {
  const hits: Record<string, InstanceHit> = {};
  if (!query.trim()) return hits;
  for (const read of Object.values(reads)) {
    const hit = topHit(read, query);
    if (hit) hits[hit.origin] = hit;
  }
  return hits;
}
