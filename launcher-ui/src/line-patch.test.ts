import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  splitLines,
  diffLines,
  createUnifiedPatch,
  quoteHeaderPath,
  patchIsWorthSending,
  LINE_PATCH_RUNTIME,
  MAX_DIFF_DISTANCE
} from './line-patch.ts';

/**
 * These tests do not trust our own patch parser: every generated patch is fed
 * to the real `git apply` in a throwaway repo, because that is exactly what the
 * self-host server does. If git rejects the patch, the save path is broken no
 * matter how plausible the diff looks.
 */
function withRepo(files: Record<string, string>, run: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lithic-patch-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    // Git for Windows defaults to core.autocrlf=true, which would rewrite the
    // working tree with CRLF on apply and make these byte comparisons lie. The
    // Alpine server never does that, so pin it off here too.
    spawnSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content, 'utf8');
    }
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Apply a patch with git the way the server does. */
function gitApply(dir: string, patch: string): { ok: boolean; status: number | null; stderr: string } {
  const patchFile = path.join(dir, '..', `patch-${Math.random().toString(36).slice(2)}.diff`);
  fs.writeFileSync(patchFile, patch, 'utf8');
  try {
    const result = spawnSync('git', ['apply', '--whitespace=nowarn', patchFile], { cwd: dir, encoding: 'utf8' });
    return { ok: result.status === 0, status: result.status, stderr: result.stderr ?? '' };
  } finally {
    fs.rmSync(patchFile, { force: true });
  }
}

/** Round-trip helper: patch base -> next under git and assert the bytes match. */
function assertPatchRoundTrips(base: string, next: string, name = 'wiki.lith'): string {
  const patch = createUnifiedPatch(base, next, name);
  assert.ok(patch !== null, 'diff should not bail out for this fixture');
  assert.notEqual(patch, '', 'fixture should actually differ');
  withRepo({ [name]: base }, (dir) => {
    const applied = gitApply(dir, patch!);
    assert.equal(applied.ok, true, `git apply rejected the patch: ${applied.stderr}\n${patch}`);
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), next, 'patched bytes differ from the target');
  });
  return patch!;
}

function lith(tiddlers: Array<{ title: string; text: string }>): string {
  return tiddlers
    .map((tiddler) => `created: 20260918120000000\nmodified: 20260918120000000\ntags: Journal\ntitle: ${tiddler.title}\ntype: \n\n${tiddler.text}`)
    .join('\n⁂⁂⁂\n');
}

test('splitLines preserves every terminator so join round-trips', () => {
  for (const text of ['', 'a', 'a\n', 'a\nb\n', 'a\nb', 'a\n\nb\n', '\n', '\n\n']) {
    assert.equal(splitLines(text).join(''), text);
  }
  assert.deepEqual(splitLines('a\nb'), ['a\n', 'b']);
  assert.deepEqual(splitLines(''), []);
});

test('identical texts produce an empty patch (a no-op save sends nothing)', () => {
  const text = lith([{ title: 'Home', text: 'hello' }]);
  assert.equal(createUnifiedPatch(text, text, 'wiki.lith'), '');
});

test('a localized edit produces a small patch git accepts', () => {
  // A realistically sized wiki: the whole point of the patch path is that the
  // bytes on the wire scale with the edit, not with the file.
  const lines = Array.from({ length: 200 }, (_, index) => `line ${index} of the journal body`);
  const preserve = { title: 'Other', text: 'untouched' };
  const base = lith([{ title: 'Home', text: lines.join('\n') }, preserve]);
  const edited = [...lines];
  edited[100] = 'line 100 EDITED';
  const next = lith([{ title: 'Home', text: edited.join('\n') }, preserve]);
  const patch = assertPatchRoundTrips(base, next);
  assert.ok(patch.includes('--- a/wiki.lith'), 'patch has git headers');
  assert.ok(patch.includes('+++ b/wiki.lith'));
  assert.ok(patch.length < base.length / 10, `patch should be a fraction of the file (${patch.length} vs ${base.length})`);
  assert.equal(patchIsWorthSending(patch, next), true);
});

test('inserting and deleting lines round-trips', () => {
  const base = lith([{ title: 'Home', text: 'a\nb\nc\nd\ne' }]);
  const next = lith([{ title: 'Home', text: 'a\nb\ninserted\nc\ne' }]);
  assertPatchRoundTrips(base, next);

  const removed = lith([{ title: 'Home', text: 'a\nc\nd\ne' }]);
  assertPatchRoundTrips(base, removed);
});

test('an appended tiddler round-trips across the ⁂ delimiter', () => {
  const base = lith([{ title: 'Home', text: 'hello' }]);
  const next = lith([
    { title: 'Home', text: 'hello' },
    { title: 'Second', text: 'brand new tiddler\nwith two lines' }
  ]);
  assertPatchRoundTrips(base, next);
});

test('multiple separated edits produce multiple hunks and round-trip', () => {
  const lines = Array.from({ length: 60 }, (_, index) => `line ${index}`);
  const base = lith([{ title: 'Home', text: lines.join('\n') }]);
  const edited = [...lines];
  edited[2] = 'line 2 changed';
  edited[57] = 'line 57 changed';
  const next = lith([{ title: 'Home', text: edited.join('\n') }]);
  const patch = assertPatchRoundTrips(base, next);
  assert.equal((patch.match(/^@@ /gm) ?? []).length, 2, 'distant edits split into two hunks');
});

test('a file without a trailing newline round-trips through git', () => {
  const base = 'title: Home\n\nno trailing newline here';
  const next = 'title: Home\n\nno trailing newline CHANGED';
  const patch = assertPatchRoundTrips(base, next);
  assert.ok(patch.includes('\\ No newline at end of file'), 'git newline marker is emitted');
  // Adding a terminating newline must also round-trip (marker on the old side only).
  assertPatchRoundTrips('a\nb', 'a\nB\n');
});

test('CRLF content round-trips without corrupting line endings', () => {
  const base = 'title: Home\r\n\r\nwindows line\r\nsecond\r\n';
  const next = 'title: Home\r\n\r\nwindows line CHANGED\r\nsecond\r\n';
  assertPatchRoundTrips(base, next);
});

test('paths needing quoting are C-quoted the way git expects', () => {
  assert.equal(quoteHeaderPath('a/', 'wiki.lith'), 'a/wiki.lith');
  // Spaces are NOT special: git parses the rest of the header line as the path,
  // so quoting a spaced name makes git look for a file literally named '"name"'.
  assert.equal(quoteHeaderPath('a/', 'my wiki.lith'), 'a/my wiki.lith');
  // The whole prefixed path is quoted when the name holds unusual bytes.
  assert.equal(quoteHeaderPath('a/', 'back\\slash.lith'), '"a/back\\\\slash.lith"');
  assert.equal(quoteHeaderPath('a/', 'quote".lith'), '"a/quote\\".lith"');
  assert.equal(quoteHeaderPath('a/', 'tab\tname.lith'), '"a/tab\\tname.lith"');
  // A spaced name must survive as an unquoted header in real git.
  assertPatchRoundTrips('title: A\n\none\n', 'title: A\n\ntwo\n', 'my wiki file.lith');
});

test('a whole-file rewrite bails out so the caller uploads instead', () => {
  const base = Array.from({ length: MAX_DIFF_DISTANCE + 500 }, (_, index) => `old ${index}`).join('\n');
  const next = Array.from({ length: MAX_DIFF_DISTANCE + 500 }, (_, index) => `new ${index}`).join('\n');
  const patch = createUnifiedPatch(base, next, 'wiki.lith');
  assert.equal(patch, null, 'unsatisfiable diff distance reports null, never a silent empty patch');
  assert.equal(patchIsWorthSending(patch, next), false);
  assert.equal(patchIsWorthSending('', next), false, 'no-op patches are not worth sending either');
  assert.equal(patchIsWorthSending(createUnifiedPatch('a\n', 'b\n', 'x.lith'), 'b\n'), false, 'tiny file prefers a full write');
});

test('diffLines trims common head and tail before diffing', () => {
  const before = ['a\n', 'b\n', 'c\n', 'd\n', 'e\n'];
  const after = ['a\n', 'b\n', 'C\n', 'd\n', 'e\n'];
  const lines = diffLines(before, after);
  assert.ok(lines);
  assert.deepEqual(
    lines!.filter((entry) => entry.type !== 'context').map((entry) => [entry.type, entry.line]),
    [['remove', 'c\n'], ['add', 'C\n']]
  );
  // 2 trimmed head + (remove, add) + 2 trimmed tail — the untouched ends are
  // carried as context rather than re-emitted, which is what keeps hunks valid.
  assert.equal(lines!.length, 6, 'head/tail are kept as context, not re-emitted as changes');
});

/* --- ES5 runtime parity: the engine bootstrap uses this mirror --- */

function loadRuntime(): Record<string, any> {
  const sandbox: Record<string, any> = {};
  new Function('window', 'globalThis', LINE_PATCH_RUNTIME)(sandbox, sandbox);
  return sandbox.__LITHIC_LINE_PATCH__;
}

test('ES5 runtime registers the patch builder', () => {
  const runtime = loadRuntime();
  assert.equal(typeof runtime.create, 'function');
  assert.equal(typeof runtime.worthSending, 'function');
});

test('ES5 runtime matches the module byte-for-byte and its patches apply in git', () => {
  const runtime = loadRuntime();
  const fixtures: Array<[string, string, string]> = [
    [lith([{ title: 'Home', text: 'one\ntwo' }]), lith([{ title: 'Home', text: 'one\nTWO' }]), 'wiki.lith'],
    ['title: A\n\nx', 'title: A\n\nx\ny', 'no-newline.lith'],
    [lith([{ title: 'Home', text: 'a\nb\nc' }]), lith([{ title: 'Home', text: 'a\nb\nc' }, { title: 'New', text: 'n' }]), 'my wiki.lith'],
    ['title: A\r\n\r\nkeep\r\n', 'title: A\r\n\r\nchanged\r\n', 'crlf.lith']
  ];
  for (const [base, next, name] of fixtures) {
    const expected = createUnifiedPatch(base, next, name);
    const actual = runtime.create(base, next, name);
    assert.equal(actual, expected, `runtime diverged from the module for ${name}`);
    assert.notEqual(actual, '', 'fixture should differ');
    withRepo({ [name]: base }, (dir) => {
      // String() keeps the type narrow: a null (bail) result would become the
      // literal "null", which git rejects, so the assertion still catches it.
      const applied = gitApply(dir, String(actual));
      assert.equal(applied.ok, true, `runtime patch rejected by git for ${name}: ${applied.stderr}`);
      assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), next);
    });
  }
});

test('ES5 runtime reports null (not empty) when the diff is too large', () => {
  const runtime = loadRuntime();
  const base = Array.from({ length: MAX_DIFF_DISTANCE + 500 }, (_, index) => `old ${index}`).join('\n');
  const next = Array.from({ length: MAX_DIFF_DISTANCE + 500 }, (_, index) => `new ${index}`).join('\n');
  assert.equal(runtime.create(base, next, 'wiki.lith'), null);
  assert.equal(runtime.create('same\n', 'same\n', 'wiki.lith'), '');
});
