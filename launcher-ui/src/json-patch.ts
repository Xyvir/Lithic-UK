/**
 * Minimal RFC 6902-style JSON Patch implementation for wiki version history.
 *
 * Diffs operate on tiddlers keyed by title (the natural "git blob" identity of
 * a wiki): the cache stores a JSON array of tiddlers, but versioning diffs it
 * as a `Record<title, tiddler>` map so an edit to one tiddler produces a
 * handful of tiny field-level ops instead of a full-text deep copy.
 *
 * JSON Pointer tokens are escaped per RFC 6901 (`~` -> `~0`, `/` -> `~1`) so
 * tiddler titles containing either character survive the round trip.
 *
 * JSON_PATCH_RUNTIME below is an ES5-string mirror of this module for the
 * engine bootstrap (the mounted wiki writes history from its own inline
 * saver script, where no module graph exists). json-patch.test.ts asserts
 * both implementations stay behaviorally identical.
 */

export type JsonPatchOp =
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: unknown };

export type TiddlerMap = Record<string, Record<string, unknown>>;

export function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

export function unescapePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Parse a tiddler-array JSON string into a title-keyed map. Returns null when the text is not a tiddler array. */
export function tiddlersToMap(text: string): TiddlerMap | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!Array.isArray(parsed)) return null;
    const map: TiddlerMap = {};
    for (const tiddler of parsed as Array<Record<string, unknown>>) {
      if (tiddler && typeof tiddler.title === 'string' && tiddler.title) map[tiddler.title] = { ...tiddler };
    }
    return map;
  } catch {
    return null;
  }
}

/** Serialize a title-keyed map back into the tiddler-array JSON text used by the search cache. */
export function mapToTiddlerArrayText(map: TiddlerMap): string {
  return JSON.stringify(Object.values(map));
}

function diffTiddler(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  basePath: string,
  ops: JsonPatchOp[]
): void {
  for (const field of Object.keys(after)) {
    const path = `${basePath}/${escapePointerToken(field)}`;
    if (!Object.prototype.hasOwnProperty.call(before, field)) ops.push({ op: 'add', path, value: after[field] });
    else if (before[field] !== after[field]) ops.push({ op: 'replace', path, value: after[field] });
  }
  for (const field of Object.keys(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, field)) ops.push({ op: 'remove', path: `${basePath}/${escapePointerToken(field)}` });
  }
}

/** Diff two title-keyed tiddler maps into a list of add/remove/replace ops. */
export function diffTiddlerMaps(before: TiddlerMap, after: TiddlerMap): JsonPatchOp[] {
  const ops: JsonPatchOp[] = [];
  for (const title of Object.keys(after)) {
    const path = `/${escapePointerToken(title)}`;
    if (!Object.prototype.hasOwnProperty.call(before, title)) ops.push({ op: 'add', path, value: after[title] });
    else diffTiddler(before[title], after[title], path, ops);
  }
  for (const title of Object.keys(before)) {
    if (!Object.prototype.hasOwnProperty.call(after, title)) ops.push({ op: 'remove', path: `/${escapePointerToken(title)}` });
  }
  return ops;
}

/** Apply a patch to a title-keyed map, returning a new map (inputs are never mutated). */
export function applyTiddlerPatch(base: TiddlerMap, patch: readonly JsonPatchOp[]): TiddlerMap {
  const map: TiddlerMap = {};
  for (const title of Object.keys(base)) map[title] = { ...base[title] };

  for (const op of patch) {
    const segments = op.path.split('/').slice(1).map(unescapePointerToken);
    if (segments.length === 0) continue;
    const title = segments[0];

    if (segments.length === 1) {
      if (op.op === 'add' || op.op === 'replace') map[title] = { ...(op.value as Record<string, unknown>) };
      else if (op.op === 'remove') delete map[title];
      continue;
    }

    if (!map[title]) {
      if (op.op === 'remove') continue;
      map[title] = {};
    }
    const tiddler = { ...map[title] };
    const field = segments[1];
    if (op.op === 'remove') delete tiddler[field];
    else tiddler[field] = op.value;
    map[title] = tiddler;
  }
  return map;
}

/**
 * ES5 source for the engine bootstrap. Evaluated inline inside the mounted
 * wiki (no module graph there); defines window.__LITHIC_JSON_PATCH__ with the
 * exact same behavior as the functions above — kept in lockstep by tests.
 */
export const JSON_PATCH_RUNTIME = `(function (root) {
  'use strict';
  function escapeToken(token) { return String(token).replace(/~/g, '~0').replace(/\\//g, '~1'); }
  function unescapeToken(token) { return String(token).replace(/~1/g, '/').replace(/~0/g, '~'); }
  function clone(object) {
    var out = {};
    for (var key in object) { if (Object.prototype.hasOwnProperty.call(object, key)) out[key] = object[key]; }
    return out;
  }
  function tiddlersToMap(text) {
    try {
      var parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return null;
      var map = {};
      for (var i = 0; i < parsed.length; i++) {
        var t = parsed[i];
        if (t && typeof t.title === 'string' && t.title) map[t.title] = clone(t);
      }
      return map;
    } catch (e) { return null; }
  }
  function mapToTiddlerArrayText(map) { return JSON.stringify(Object.keys(map).map(function (k) { return map[k]; })); }
  function has(object, key) { return Object.prototype.hasOwnProperty.call(object, key); }
  function diffTiddler(before, after, basePath, ops) {
    var afterFields = Object.keys(after);
    for (var i = 0; i < afterFields.length; i++) {
      var field = afterFields[i];
      var path = basePath + '/' + escapeToken(field);
      if (!has(before, field)) ops.push({ op: 'add', path: path, value: after[field] });
      else if (before[field] !== after[field]) ops.push({ op: 'replace', path: path, value: after[field] });
    }
    var beforeFields = Object.keys(before);
    for (var j = 0; j < beforeFields.length; j++) {
      if (!has(after, beforeFields[j])) ops.push({ op: 'remove', path: basePath + '/' + escapeToken(beforeFields[j]) });
    }
  }
  function diffTiddlerMaps(before, after) {
    var ops = [];
    var afterTitles = Object.keys(after);
    for (var i = 0; i < afterTitles.length; i++) {
      var title = afterTitles[i];
      var path = '/' + escapeToken(title);
      if (!has(before, title)) ops.push({ op: 'add', path: path, value: after[title] });
      else diffTiddler(before[title], after[title], path, ops);
    }
    var beforeTitles = Object.keys(before);
    for (var j = 0; j < beforeTitles.length; j++) {
      if (!has(after, beforeTitles[j])) ops.push({ op: 'remove', path: '/' + escapeToken(beforeTitles[j]) });
    }
    return ops;
  }
  function applyTiddlerPatch(base, patch) {
    var map = {};
    var titles = Object.keys(base);
    for (var i = 0; i < titles.length; i++) map[titles[i]] = clone(base[titles[i]]);
    for (var j = 0; j < patch.length; j++) {
      var op = patch[j];
      var segments = String(op.path).split('/').slice(1).map(unescapeToken);
      if (segments.length === 0) continue;
      var title = segments[0];
      if (segments.length === 1) {
        if (op.op === 'add' || op.op === 'replace') map[title] = clone(op.value);
        else if (op.op === 'remove') delete map[title];
        continue;
      }
      if (!map[title]) { if (op.op === 'remove') continue; map[title] = {}; }
      var tiddler = clone(map[title]);
      var field = segments[1];
      if (op.op === 'remove') delete tiddler[field];
      else tiddler[field] = op.value;
      map[title] = tiddler;
    }
    return map;
  }
  root.__LITHIC_JSON_PATCH__ = {
    tiddlersToMap: tiddlersToMap,
    mapToTiddlerArrayText: mapToTiddlerArrayText,
    diffTiddlerMaps: diffTiddlerMaps,
    applyTiddlerPatch: applyTiddlerPatch
  };
})(typeof window !== 'undefined' ? window : globalThis);
`;
