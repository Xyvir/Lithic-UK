/**
 * Git-compatible unified diffs for the self-host save path.
 *
 * The legacy launcher re-serialized the entire wiki and PUT the whole `.lith`
 * on every save. The git-backed workflow instead sends only what changed: the
 * mounted wiki serializes itself, this module diffs that text against the copy
 * it loaded, and the server applies the patch with `git apply` before
 * committing. Git therefore stays the source of truth, and the on-disk `.lith`
 * keeps its plain-text form so WebDAV, VS Code, backups, the sync watcher and
 * GitHub restore all keep working untouched.
 *
 * Format notes (these are the parts `git apply` is strict about):
 *   - headers are `--- a/<path>` / `+++ b/<path>`, which git strips with its
 *     default `-p1`; paths needing it are C-quoted exactly like git does.
 *   - hunks carry up to CONTEXT lines of context; contiguous changes are
 *     emitted as a single hunk (git does not require separate hunks).
 *   - a final line without a trailing newline is followed by git's
 *     `\ No newline at end of file` marker on the side that lacks it.
 *
 * Diffing is Myers' greedy algorithm over lines, which is O(ND) — fast exactly
 * when the edit is small, which is the case for a wiki save. A rewrite that
 * exceeds MAX_DIFF_DISTANCE bails out (returns null) so the caller sends a full
 * file instead of a patch that is larger than the file it replaces. That is the
 * same base-vs-delta heuristic `wiki-history.ts` uses for version chains.
 *
 * LINE_PATCH_RUNTIME below is an ES5-string mirror of this module for the
 * engine bootstrap (the mounted wiki builds its own patch from its inline saver
 * script, where no module graph exists). line-patch.test.ts asserts both
 * implementations produce patches that real `git apply` accepts.
 */

/** Lines of context wrapped around each change, matching `git diff -U3`. */
export const CONTEXT_LINES = 3;

/**
 * Gives up past this edit distance (~2x the changed lines). Past it the patch
 * is no longer smaller than the file, so a full upload is cheaper and safer.
 */
export const MAX_DIFF_DISTANCE = 4000;

export type DiffLine = { type: 'context' | 'remove' | 'add'; line: string };

/**
 * Split text into lines, each keeping its own terminator, so
 * `splitLines(text).join('') === text`. A final line without a trailing
 * newline is preserved as-is (that is what drives the "\ No newline" marker).
 */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Drop the trailing newline a line carries, for emitting into a patch body. */
function bodyOf(line: string): string {
  return line.endsWith('\n') ? line.slice(0, -1) : line;
}

/** True when a line arrived without its terminating newline. */
function lacksNewline(line: string | undefined): boolean {
  return typeof line === 'string' && line !== '' && !line.endsWith('\n');
}

/**
 * Myers' greedy diff (the classic `diff` algorithm) over two line arrays.
 * Returns null when the edit distance exceeds `maxDistance`.
 */
export function diffLines(before: readonly string[], after: readonly string[], maxDistance = MAX_DIFF_DISTANCE): DiffLine[] | null {
  // Trim the shared head/tail first: wiki saves are overwhelmingly localized,
  // and trimming usually removes the whole problem before Myers runs.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const a = before.slice(head, before.length - tail);
  const b = after.slice(head, after.length - tail);
  const out: DiffLine[] = [];
  for (let i = 0; i < head; i++) out.push({ type: 'context', line: before[i] });

  const middle = diffMiddle(a, b, maxDistance);
  if (middle === null) return null;
  out.push(...middle);

  for (let i = before.length - tail; i < before.length; i++) out.push({ type: 'context', line: before[i] });
  return out;
}

function diffMiddle(a: readonly string[], b: readonly string[], maxDistance: number): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return b.map((line) => ({ type: 'add', line }) as DiffLine);
  if (m === 0) return a.map((line) => ({ type: 'remove', line }) as DiffLine);

  const max = n + m;
  const limit = Math.min(max, maxDistance);
  const offset = max + 1;
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 3).fill(-1);
  v[offset + 1] = 0;

  let finished = false;
  for (let d = 0; d <= limit && !finished; d++) {
    trace.push(Int32Array.from(v));
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
      else x = v[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) {
        finished = true;
        break;
      }
    }
  }
  if (!finished) return null;

  // Walk the recorded V arrays backwards to recover the edit script.
  const reversed: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    let prevK: number;
    if (k === -d || (k !== d && prev[offset + k - 1] < prev[offset + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = prev[offset + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      reversed.push({ type: 'context', line: a[x - 1] });
      x -= 1;
      y -= 1;
    }
    if (d > 0) {
      if (x === prevX) {
        reversed.push({ type: 'add', line: b[y - 1] });
        y -= 1;
      } else {
        reversed.push({ type: 'remove', line: a[x - 1] });
        x -= 1;
      }
    }
  }
  while (x > 0 && y > 0) {
    reversed.push({ type: 'context', line: a[x - 1] });
    x -= 1;
    y -= 1;
  }
  while (x > 0) {
    reversed.push({ type: 'remove', line: a[x - 1] });
    x -= 1;
  }
  while (y > 0) {
    reversed.push({ type: 'add', line: b[y - 1] });
    y -= 1;
  }
  reversed.reverse();
  return reversed;
}

/**
 * Emit a `git apply`-compatible patch for one file.
 *
 * Returns '' when the two texts are identical — nothing to send at all — and
 * null when the edit is too large to diff, which means "send the whole file".
 * The two cases MUST stay distinguishable: collapsing them would silently skip
 * a save whose diff bailed out.
 */
export function createUnifiedPatch(baseText: string, nextText: string, path: string): string | null {
  const lines = diffLines(splitLines(baseText), splitLines(nextText));
  if (lines === null) return null;
  if (!lines.some((entry) => entry.type !== 'context')) return '';
  let patch = `--- ${quoteHeaderPath('a/', path)}\n+++ ${quoteHeaderPath('b/', path)}\n`;
  for (const hunk of groupHunks(lines)) patch += renderHunk(hunk);
  return patch;
}

/**
 * Render the path half of a `---`/`+++` header the way git renders it.
 *
 * Spaces are NOT special — git's parser takes the rest of the line after the
 * `--- ` marker, so a spaced filename stays literal. Only quotes, backslashes
 * and control bytes force C-quoting, and when that happens git quotes the
 * WHOLE path including the `a/`/`b/` prefix (quoting just the name produces a
 * header git reads as a file literally named `"name"`).
 */
export function quoteHeaderPath(prefix: string, path: string): string {
  const full = `${prefix}${path}`;
  if (!/["\\\u0000-\u001f\u007f]/.test(full)) return full;
  let out = '';
  for (const char of full) {
    const code = char.codePointAt(0)!;
    if (char === '"' || char === '\\') out += `\\${char}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += char;
  }
  return `"${out}"`;
}

type Hunk = { beforeStart: number; beforeCount: number; afterStart: number; afterCount: number; lines: DiffLine[] };

/**
 * Group a full diff into hunks, keeping CONTEXT_LINES of context and splitting
 * only where the gap of untouched lines is large enough to be worth a new hunk.
 */
export function groupHunks(lines: readonly DiffLine[], context = CONTEXT_LINES): Hunk[] {
  const changeIndexes: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].type !== 'context') changeIndexes.push(i);
  if (changeIndexes.length === 0) return [];

  const ranges: Array<[number, number]> = [];
  for (const index of changeIndexes) {
    const start = Math.max(0, index - context);
    const end = Math.min(lines.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
    else ranges.push([start, end]);
  }

  // Translate line positions into file line numbers, counting both sides.
  const hunks: Hunk[] = [];
  let beforeCursor = 1;
  let afterCursor = 1;
  let cursor = 0;
  for (const [start, end] of ranges) {
    for (; cursor < start; cursor++) {
      if (lines[cursor].type !== 'add') beforeCursor += 1;
      if (lines[cursor].type !== 'remove') afterCursor += 1;
    }
    const beforeStart = beforeCursor;
    const afterStart = afterCursor;
    let beforeCount = 0;
    let afterCount = 0;
    for (let i = start; i <= end; i++) {
      if (lines[i].type !== 'add') beforeCount += 1;
      if (lines[i].type !== 'remove') afterCount += 1;
    }
    hunks.push({ beforeStart, beforeCount, afterStart, afterCount, lines: lines.slice(start, end + 1) });
    beforeCursor += beforeCount;
    afterCursor += afterCount;
    cursor = end + 1;
  }
  return hunks;
}

function renderHunk(hunk: Hunk): string {
  let out = `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@\n`;
  for (const entry of hunk.lines) {
    const prefix = entry.type === 'add' ? '+' : entry.type === 'remove' ? '-' : ' ';
    out += `${prefix}${bodyOf(entry.line)}\n`;
    // git marks the (at most one) side that ends without a newline.
    if (lacksNewline(entry.line)) out += '\\ No newline at end of file\n';
  }
  return out;
}

/**
 * Whether a patch is worth sending relative to uploading the whole file.
 * Mirrors the base-vs-delta rule in `wiki-history.ts`.
 */
export function patchIsWorthSending(patch: string | null, nextText: string): boolean {
  return typeof patch === 'string' && patch !== '' && patch.length <= nextText.length / 2;
}

/**
 * ES5 source for the engine bootstrap. Evaluated inline inside the mounted
 * wiki; defines window.__LITHIC_LINE_PATCH__.create(baseText, nextText, path).
 * Kept behaviorally identical to createUnifiedPatch by tests that run both
 * against real `git apply`.
 */
export const LINE_PATCH_RUNTIME = `(function (root) {
  'use strict';
  var CONTEXT_LINES = ${CONTEXT_LINES};
  var MAX_DIFF_DISTANCE = ${MAX_DIFF_DISTANCE};

  function splitLines(text) {
    var lines = [];
    var start = 0;
    for (var i = 0; i < text.length; i++) {
      if (text.charAt(i) === '\\n') { lines.push(text.slice(start, i + 1)); start = i + 1; }
    }
    if (start < text.length) lines.push(text.slice(start));
    return lines;
  }

  function bodyOf(line) { return line.charAt(line.length - 1) === '\\n' ? line.slice(0, -1) : line; }
  function lacksNewline(line) { return typeof line === 'string' && line !== '' && line.charAt(line.length - 1) !== '\\n'; }

  function diffLines(before, after) {
    var head = 0;
    while (head < before.length && head < after.length && before[head] === after[head]) head++;
    var tail = 0;
    while (tail < before.length - head && tail < after.length - head &&
           before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
    var a = before.slice(head, before.length - tail);
    var b = after.slice(head, after.length - tail);
    var out = [];
    var i;
    for (i = 0; i < head; i++) out.push({ type: 'context', line: before[i] });
    var middle = diffMiddle(a, b);
    if (middle === null) return null;
    for (i = 0; i < middle.length; i++) out.push(middle[i]);
    for (i = before.length - tail; i < before.length; i++) out.push({ type: 'context', line: before[i] });
    return out;
  }

  function diffMiddle(a, b) {
    var n = a.length;
    var m = b.length;
    var out = [];
    var i;
    if (n === 0 && m === 0) return out;
    if (n === 0) { for (i = 0; i < m; i++) out.push({ type: 'add', line: b[i] }); return out; }
    if (m === 0) { for (i = 0; i < n; i++) out.push({ type: 'remove', line: a[i] }); return out; }

    var max = n + m;
    var limit = Math.min(max, MAX_DIFF_DISTANCE);
    var offset = max + 1;
    var trace = [];
    var size = 2 * max + 3;
    var v = new Array(size);
    for (i = 0; i < size; i++) v[i] = -1;
    v[offset + 1] = 0;
    var finished = false;
    var d;
    for (d = 0; d <= limit && !finished; d++) {
      trace.push(v.slice());
      for (var k = -d; k <= d; k += 2) {
        var x;
        if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) x = v[offset + k + 1];
        else x = v[offset + k - 1] + 1;
        var y = x - k;
        while (x < n && y < m && a[x] === b[y]) { x++; y++; }
        v[offset + k] = x;
        if (x >= n && y >= m) { finished = true; break; }
      }
    }
    if (!finished) return null;

    var reversed = [];
    var x2 = n;
    var y2 = m;
    for (var d2 = trace.length - 1; d2 > 0; d2--) {
      var prev = trace[d2];
      var k2 = x2 - y2;
      var prevK;
      if (k2 === -d2 || (k2 !== d2 && prev[offset + k2 - 1] < prev[offset + k2 + 1])) prevK = k2 + 1;
      else prevK = k2 - 1;
      var prevX = prev[offset + prevK];
      var prevY = prevX - prevK;
      while (x2 > prevX && y2 > prevY) { reversed.push({ type: 'context', line: a[x2 - 1] }); x2--; y2--; }
      if (d2 > 0) {
        if (x2 === prevX) { reversed.push({ type: 'add', line: b[y2 - 1] }); y2--; }
        else { reversed.push({ type: 'remove', line: a[x2 - 1] }); x2--; }
      }
    }
    while (x2 > 0 && y2 > 0) { reversed.push({ type: 'context', line: a[x2 - 1] }); x2--; y2--; }
    while (x2 > 0) { reversed.push({ type: 'remove', line: a[x2 - 1] }); x2--; }
    while (y2 > 0) { reversed.push({ type: 'add', line: b[y2 - 1] }); y2--; }
    reversed.reverse();
    return reversed;
  }

  // Builds the escape/quote characters from char codes so this mirror needs no
  // backslash literals of its own, which keeps the hand-rolled ES5 in sync
  // with the module without a minefield of nested escaping.
  function quoteHeaderPath(prefix, path) {
    var full = prefix + path;
    var needs = false;
    var i;
    for (i = 0; i < full.length; i++) {
      var code = full.charCodeAt(i);
      if (code < 0x20 || code === 0x7f || code === 0x22 || code === 0x5c) { needs = true; break; }
    }
    if (!needs) return full;
    var ESC = String.fromCharCode(0x5c);
    var QUOTE = String.fromCharCode(0x22);
    var out = '';
    for (i = 0; i < full.length; i++) {
      var ch = full.charAt(i);
      var c2 = full.charCodeAt(i);
      if (c2 === 0x22 || c2 === 0x5c) out += ESC + ch;
      else if (c2 === 0x0a) out += ESC + 'n';
      else if (c2 === 0x0d) out += ESC + 'r';
      else if (c2 === 0x09) out += ESC + 't';
      else if (c2 < 0x20 || c2 === 0x7f) out += ESC + ('000' + c2.toString(8)).slice(-3);
      else out += ch;
    }
    return QUOTE + out + QUOTE;
  }

  function groupHunks(lines, context) {
    var changeIndexes = [];
    var i;
    for (i = 0; i < lines.length; i++) if (lines[i].type !== 'context') changeIndexes.push(i);
    if (changeIndexes.length === 0) return [];
    var ranges = [];
    for (i = 0; i < changeIndexes.length; i++) {
      var index = changeIndexes[i];
      var start = Math.max(0, index - context);
      var end = Math.min(lines.length - 1, index + context);
      var last = ranges.length > 0 ? ranges[ranges.length - 1] : null;
      if (last && start <= last[1] + 1) { if (end > last[1]) last[1] = end; }
      else ranges.push([start, end]);
    }
    var hunks = [];
    var beforeCursor = 1;
    var afterCursor = 1;
    var cursor = 0;
    for (i = 0; i < ranges.length; i++) {
      var range = ranges[i];
      for (; cursor < range[0]; cursor++) {
        if (lines[cursor].type !== 'add') beforeCursor++;
        if (lines[cursor].type !== 'remove') afterCursor++;
      }
      var beforeStart = beforeCursor;
      var afterStart = afterCursor;
      var beforeCount = 0;
      var afterCount = 0;
      var j;
      for (j = range[0]; j <= range[1]; j++) {
        if (lines[j].type !== 'add') beforeCount++;
        if (lines[j].type !== 'remove') afterCount++;
      }
      hunks.push({
        beforeStart: beforeStart,
        beforeCount: beforeCount,
        afterStart: afterStart,
        afterCount: afterCount,
        lines: lines.slice(range[0], range[1] + 1)
      });
      beforeCursor += beforeCount;
      afterCursor += afterCount;
      cursor = range[1] + 1;
    }
    return hunks;
  }

  function renderHunk(hunk) {
    var out = '@@ -' + hunk.beforeStart + ',' + hunk.beforeCount + ' +' + hunk.afterStart + ',' + hunk.afterCount + ' @@\\n';
    for (var i = 0; i < hunk.lines.length; i++) {
      var entry = hunk.lines[i];
      var prefix = entry.type === 'add' ? '+' : (entry.type === 'remove' ? '-' : ' ');
      out += prefix + bodyOf(entry.line) + '\\n';
      if (lacksNewline(entry.line)) out += '\\\\ No newline at end of file\\n';
    }
    return out;
  }

  function create(baseText, nextText, path) {
    var lines = diffLines(splitLines(baseText), splitLines(nextText));
    if (lines === null) return null;
    var changed = false;
    for (var i = 0; i < lines.length; i++) if (lines[i].type !== 'context') { changed = true; break; }
    if (!changed) return '';
    var patch = '--- ' + quoteHeaderPath('a/', path) + '\\n+++ ' + quoteHeaderPath('b/', path) + '\\n';
    var hunks = groupHunks(lines, CONTEXT_LINES);
    for (var h = 0; h < hunks.length; h++) patch += renderHunk(hunks[h]);
    return patch;
  }

  function worthSending(patch, nextText) {
    return typeof patch === 'string' && patch !== '' && patch.length <= nextText.length / 2;
  }

  root.__LITHIC_LINE_PATCH__ = { create: create, worthSending: worthSending, splitLines: splitLines };
})(typeof window !== 'undefined' ? window : globalThis);
`;
