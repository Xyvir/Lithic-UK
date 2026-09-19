import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUnifiedPatch } from './line-patch.ts';

/**
 * End-to-end tests for the git-backed save API in `deploy/lithic-sync.sh`.
 *
 * These drive the real CGI against a real git repository with real patches
 * produced by line-patch.ts, so they fail if either side of the wire contract
 * drifts: they are the only check that the client's diff and the server's
 * `git apply` actually agree.
 */

const SCRIPT = fileURLToPath(new URL('../../deploy/lithic-sync.sh', import.meta.url));
const hasBash = spawnSync('bash', ['-c', 'true'], { encoding: 'utf8' }).status === 0;
const skip = hasBash ? false : 'bash is unavailable, cannot exercise the CGI';

type CgiResponse = { status: number; headers: Record<string, string>; body: string };

function cgi(dir: string, options: { method: string; uri: string; query?: string; body?: string }): CgiResponse {
  const body = options.body ?? '';
  const result = spawnSync('bash', [SCRIPT], {
    env: {
      ...process.env,
      DATA_DIR: dir,
      REQUEST_METHOD: options.method,
      REQUEST_URI: options.uri,
      QUERY_STRING: options.query ?? '',
      CONTENT_LENGTH: String(Buffer.byteLength(body))
    },
    input: body,
    encoding: 'utf8'
  });
  const lines = (result.stdout ?? '').split('\n');
  let status = 200;
  const headers: Record<string, string> = {};
  let index = 0;
  for (; index < lines.length; index++) {
    const line = lines[index];
    if (/^status:/i.test(line)) {
      status = Number(line.split(':')[1].trim().split(' ')[0]);
      continue;
    }
    if (line.trim() === '') {
      index += 1;
      break;
    }
    const separator = line.indexOf(':');
    if (separator > 0) headers[line.slice(0, separator).toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { status, headers, body: lines.slice(index).join('\n') };
}

function git(dir: string, args: string[]): string {
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8' }).stdout?.trim() ?? '';
}

/** A throwaway instance: a git repo with a seeded wiki, like /data on the server. */
function withInstance(run: (dir: string) => void, files: Record<string, string> = { 'wiki.lith': 'title: Home\ntype: \n\none\ntwo\nthree\n' }): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lithic-sync-'));
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir });
    // Pin EOL handling: the real server is Linux, and Git for Windows defaults
    // to autocrlf, which would silently rewrite the files under test.
    spawnSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir });
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content, 'utf8');
    spawnSync('git', ['add', '.'], { cwd: dir });
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd: dir });
    run(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readFile(dir: string, name: string): string {
  return fs.readFileSync(path.join(dir, name), 'utf8');
}

test('ping advertises the patch API so the launcher can pick the git path', { skip }, () => {
  withInstance((dir) => {
    const res = cgi(dir, { method: 'GET', uri: '/api/lithic/ping' });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.service, 'lithic-sync');
    assert.equal(payload.git, true);
  });
});

test('file returns the wiki text with a digest the server will trust', { skip }, () => {
  withInstance((dir) => {
    const res = cgi(dir, { method: 'GET', uri: '/api/lithic/file', query: 'file=wiki.lith' });
    assert.equal(res.status, 200);
    assert.equal(res.body, readFile(dir, 'wiki.lith'));
    assert.equal(res.headers['x-lithic-digest'], git(dir, ['hash-object', '--no-filters', 'wiki.lith']));
    assert.match(res.headers['x-lithic-rev'] ?? '', /^[0-9a-f]{40}$/);
  });
});

test('apply lands the patch, commits it, and reports the new digest', { skip }, () => {
  withInstance((dir) => {
    const base = readFile(dir, 'wiki.lith');
    const next = base.replace('two\n', 'two EDITED\n');
    const patch = createUnifiedPatch(base, next, 'wiki.lith');
    assert.ok(patch, 'patch was generated');

    const digest = git(dir, ['hash-object', '--no-filters', 'wiki.lith']);
    const res = cgi(dir, {
      method: 'POST',
      uri: '/api/lithic/apply',
      body: `wiki.lith\n${digest}\n${patch}`
    });

    assert.equal(res.status, 200, res.body);
    const payload = JSON.parse(res.body);
    assert.equal(payload.status, 'ok');
    assert.equal(readFile(dir, 'wiki.lith'), next, 'file content matches the client text');
    assert.equal(payload.digest, git(dir, ['hash-object', '--no-filters', 'wiki.lith']));
    // The save must be a real commit: that commit IS the history/rollback record.
    assert.equal(git(dir, ['log', '-1', '--format=%s']), 'Save wiki.lith');
    assert.equal(git(dir, ['status', '--porcelain']), '', 'working tree is clean after the commit');
  });
});

test('a spaced file name survives the patch headers end to end', { skip }, () => {
  withInstance(
    (dir) => {
      const base = readFile(dir, 'my wiki.lith');
      const next = base.replace('alpha\n', 'alpha changed\n');
      const patch = createUnifiedPatch(base, next, 'my wiki.lith');
      const digest = git(dir, ['hash-object', '--no-filters', 'my wiki.lith']);
      const res = cgi(dir, {
        method: 'POST',
        uri: '/api/lithic/apply',
        body: `my wiki.lith\n${digest}\n${patch}`
      });
      assert.equal(res.status, 200, res.body);
      assert.equal(readFile(dir, 'my wiki.lith'), next);
    },
    { 'my wiki.lith': 'title: Home\n\nalpha\nbeta\n' }
  );
});

test('a stale base is rejected without touching the file (optimistic concurrency)', { skip }, () => {
  withInstance((dir) => {
    const base = readFile(dir, 'wiki.lith');
    const next = base.replace('two\n', 'two EDITED\n');
    const patch = createUnifiedPatch(base, next, 'wiki.lith');
    const staleDigest = git(dir, ['hash-object', '--no-filters', 'wiki.lith']);

    // Somebody else saves first.
    fs.writeFileSync(path.join(dir, 'wiki.lith'), base.replace('one\n', 'one CHANGED ELSEWHERE\n'), 'utf8');

    const res = cgi(dir, {
      method: 'POST',
      uri: '/api/lithic/apply',
      body: `wiki.lith\n${staleDigest}\n${patch}`
    });

    assert.equal(res.status, 409);
    const payload = JSON.parse(res.body);
    assert.equal(payload.error, 'stale');
    assert.equal(payload.digest, git(dir, ['hash-object', '--no-filters', 'wiki.lith']), 'conflict reports the fresh digest');
    assert.equal(readFile(dir, 'wiki.lith'), base.replace('one\n', 'one CHANGED ELSEWHERE\n'), 'loser patch never applied');
  });
});

test('a corrupt patch is refused and changes nothing', { skip }, () => {
  withInstance((dir) => {
    const before = readFile(dir, 'wiki.lith');
    const digest = git(dir, ['hash-object', '--no-filters', 'wiki.lith']);
    const res = cgi(dir, {
      method: 'POST',
      uri: '/api/lithic/apply',
      body: `wiki.lith\n${digest}\n--- a/wiki.lith\n+++ b/wiki.lith\n@@ -1,2 +1,2 @@\n-nonexistent line\n+NOPE\n`
    });
    assert.equal(res.status, 422);
    assert.match(res.body, /patch_failed/);
    assert.equal(readFile(dir, 'wiki.lith'), before, 'file untouched');
  });
});

test('the API refuses path traversal and non-wiki targets', { skip }, () => {
  withInstance((dir) => {
    for (const name of ['../outside.lith', 'sub/wiki.lith', 'notes.txt', '.hidden.lith', '.git/config']) {
      const read = cgi(dir, { method: 'GET', uri: '/api/lithic/file', query: `file=${encodeURIComponent(name)}` });
      assert.equal(read.status, 400, `read should reject ${name}`);
      const write = cgi(dir, { method: 'POST', uri: '/api/lithic/apply', body: `${name}\ndeadbeef\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n` });
      assert.equal(write.status, 400, `apply should reject ${name}`);
    }
    // And an encoded traversal must not slip through the query decode.
    const encoded = cgi(dir, { method: 'GET', uri: '/api/lithic/file', query: 'file=%2E%2E%2Fsecret.lith' });
    assert.equal(encoded.status, 400);
  });
});

test('log lists the save commits for the rollback UI', { skip }, () => {
  withInstance((dir) => {
    const base = readFile(dir, 'wiki.lith');
    const next = base.replace('three\n', 'three EDITED\n');
    const digest = git(dir, ['hash-object', '--no-filters', 'wiki.lith']);
    cgi(dir, {
      method: 'POST',
      uri: '/api/lithic/apply',
      body: `wiki.lith\n${digest}\n${createUnifiedPatch(base, next, 'wiki.lith')}`
    });

    const res = cgi(dir, { method: 'GET', uri: '/api/lithic/log', query: 'file=wiki.lith&limit=5' });
    assert.equal(res.status, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.file, 'wiki.lith');
    assert.equal(payload.versions.length, 2, 'init plus the save');
    assert.equal(payload.versions[0].subject, 'Save wiki.lith');
    assert.match(payload.versions[0].rev, /^[0-9a-f]{40}$/);
    assert.ok(payload.versions[0].ts > 0);
  });
});

test('restore rolls a wiki back to an earlier commit', { skip }, () => {
  withInstance((dir) => {
    const original = readFile(dir, 'wiki.lith');
    const initialRev = git(dir, ['rev-parse', 'HEAD']);

    const next = original.replace('three\n', 'three EDITED\n');
    const digest = git(dir, ['hash-object', '--no-filters', 'wiki.lith']);
    cgi(dir, {
      method: 'POST',
      uri: '/api/lithic/apply',
      body: `wiki.lith\n${digest}\n${createUnifiedPatch(original, next, 'wiki.lith')}`
    });
    assert.equal(readFile(dir, 'wiki.lith'), next);

    const res = cgi(dir, { method: 'POST', uri: '/api/lithic/restore', body: `wiki.lith\n${initialRev}` });
    assert.equal(res.status, 200, res.body);
    assert.equal(readFile(dir, 'wiki.lith'), original, 'content is back to the older revision');
    assert.equal(git(dir, ['log', '-1', '--format=%s']), `Restore wiki.lith to ${initialRev}`);
  });
});

test('an unknown route answers 404 so an older instance is detected as unsupported', { skip }, () => {
  withInstance((dir) => {
    const res = cgi(dir, { method: 'GET', uri: '/api/lithic/nope' });
    assert.equal(res.status, 404);
    assert.match(res.body, /route_not_found/);
  });
});
