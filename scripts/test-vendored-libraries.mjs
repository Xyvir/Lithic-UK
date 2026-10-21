/**
 * Tests for `scripts/vendor-libraries.mjs`.
 *
 * The parts that can go wrong quietly are the ones covered here: a tiddler assembled with the
 * wrong line endings or a lost front matter, a transform whose `from` quietly stops matching, a
 * tar walk that picks the wrong entry, and the offline check that is supposed to notice a
 * vendored file edited by hand. The network half is exercised by `npm run vendor --dry-run`,
 * which is a deliberate manual step.
 *
 *   node --test scripts/test-vendored-libraries.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import {
  adoptEntry,
  applyTransform,
  assertLooksRight,
  buildTiddler,
  compareVersions,
  extractTarEntry,
  latestVersion,
  normalizeNewlines,
  readTargetFrontMatter,
  renderSummary,
  resolvedPackage,
  sha256,
  splitTiddler,
  verifyEntry
} from './vendor-libraries.mjs';

const FRONT_MATTER = [
  'title: $:/plugins/xyvir/example/library.js',
  'type: application/javascript',
  'module-type: library'
].join('\r\n');

function tiddler(frontMatter, body) {
  return buildTiddler(frontMatter, body);
}

test('a body written with LF comes out CRLF, like every other .tid in the repo', () => {
  assert.equal(normalizeNewlines('a\nb\r\nc\rd'), 'a\r\nb\r\nc\r\nd');
});

test('the front matter is kept and the body is what was fetched', () => {
  const text = tiddler(FRONT_MATTER, 'var x = 1;\nconsole.log(x);\n');
  const { frontMatter, body } = splitTiddler(text);
  assert.equal(frontMatter, FRONT_MATTER, 'the tiddler fields are not the updater\'s to invent');
  assert.equal(body, 'var x = 1;\r\nconsole.log(x);');
  assert.equal(/[\r\n]$/.test(text), false, 'a .tid must not end with a newline');
});

test('a library with no blank line is a body, not an empty tiddler', () => {
  const { frontMatter, body } = splitTiddler('title: x\r\ntype: text/plain');
  assert.equal(frontMatter, 'title: x\r\ntype: text/plain');
  assert.equal(body, '');
});

test('leading blank lines in the body are not part of it', () => {
  const { body } = splitTiddler(`${FRONT_MATTER}\r\n\r\n\r\nthe body`);
  assert.equal(body, 'the body');
});

test('append adds the module export after the library\'s last line', () => {
  const out = applyTransform('var pele=(()=>{})();', {
    append: ['// Lithic: expose the global', 'exports.pele = pele;']
  });
  assert.equal(out, 'var pele=(()=>{})();\r\n// Lithic: expose the global\r\nexports.pele = pele;');
  assert.equal(applyTransform('x\n\n', { append: ['y'] }), 'x\r\ny', 'blank lines at the end do not become gaps');
});

test('replace is applied, and a replacement that no longer matches is a failure', () => {
  assert.equal(applyTransform('require("scheduler")', { replace: [{ from: 'require("scheduler")', to: 'require("react-scheduler.js")' }] }), 'require("react-scheduler.js")');
  assert.throws(
    () => applyTransform('require("scheduler2")', { replace: [{ from: 'require("scheduler")', to: 'x' }] }),
    /transform replacement not found/,
    'an upstream rename must fail the sync rather than be skipped'
  );
});

test('a fetched body has to look like the library it claims to be', () => {
  const entry = { name: 'pele', minBytes: 10, expect: ['var pele'] };
  assert.deepEqual(assertLooksRight(entry, 'var pele=(()=>{})();'), []);
  assert.match(assertLooksRight(entry, 'var x=1').join(' '), /does not contain "var pele"/);
  assert.match(assertLooksRight(entry, 'var pele').join(' '), /under the 10 byte floor/);
});

test('versions are compared by number, not by string', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('3.11.174', '3.11.174'), 0);
  assert.equal(compareVersions('0.9.0', '1.0.0'), -1);
  assert.equal(compareVersions('19.0.0', '19.0.0-beta'), 0);
});

test('an unpinned entry follows the registry\'s own latest tag', () => {
  assert.equal(latestVersion({ 'dist-tags': { latest: '1.8.0' } }), '1.8.0');
  assert.throws(() => latestVersion({ 'dist-tags': {} }), /no dist-tags.latest/);
  assert.throws(() => latestVersion(undefined), /no dist-tags.latest/);
});

test('a pinned version has to exist, and has to have a tarball', () => {
  const packument = {
    name: 'pele',
    'dist-tags': { latest: '1.8.0' },
    versions: { '1.7.0': { dist: { tarball: 'https://example.test/pele-1.7.0.tgz', integrity: 'sha512-x' } } }
  };
  assert.deepEqual(resolvedPackage(packument, '1.7.0'), {
    tarball: 'https://example.test/pele-1.7.0.tgz',
    integrity: 'sha512-x',
    shasum: null
  });
  assert.throws(() => resolvedPackage(packument, '9.9.9'), /no published version 9\.9\.9/);
  assert.throws(
    () => resolvedPackage({ name: 'x', versions: { '1.0.0': { dist: {} } } }, '1.0.0'),
    /no tarball/
  );
});

/** A minimal ustar archive, enough to exercise the reader: fixed 512-byte headers. */
function tar(entries) {
  const blocks = [];
  for (const [name, contents] of entries) {
    const data = Buffer.from(contents, 'utf8');
    const header = Buffer.alloc(512, 0);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 8, 'utf8');
    header.write('0000000\0', 108, 8, 'utf8');
    header.write('0000000\0', 116, 8, 'utf8');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
    header.write('00000000000\0', 136, 12, 'utf8');
    header.write('        ', 148, 8, 'utf8');
    header.write('0', 156, 1, 'utf8');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512, 0));
  }
  blocks.push(Buffer.alloc(1024, 0));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('a file is pulled out of the tarball by its exact path inside the package', () => {
  const gz = tar([
    ['package/README.md', 'not this one'],
    ['package/dist/pele.global.js', 'var pele=1;'],
    ['package/dist/pele.js', 'export default 1;']
  ]);
  assert.equal(extractTarEntry(gz, 'package/dist/pele.global.js').toString('utf8'), 'var pele=1;');
  assert.equal(extractTarEntry(gz, './package/dist/pele.js').toString('utf8'), 'export default 1;');
  assert.equal(extractTarEntry(gz, 'package/dist/missing.js'), null);
});

test('a tar entry with a prefix is found under its full path', () => {
  const data = Buffer.from('prefixed', 'utf8');
  const header = Buffer.alloc(512, 0);
  header.write('deep.js', 0, 100, 'utf8');
  header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8');
  header.write('0', 156, 1, 'utf8');
  header.write('package/build', 345, 155, 'utf8');
  const gz = zlib.gzipSync(Buffer.concat([header, data, Buffer.alloc(1024, 0)]));
  assert.equal(extractTarEntry(gz, 'package/build/deep.js').toString('utf8'), 'prefixed');
});

test('a target with no title in its front matter is refused, not overwritten', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-test-'));
  try {
    const file = join(dir, 'nofront.tid');
    writeFileSync(file, 'just a body with no tiddler fields');
    assert.throws(() => readTargetFrontMatter(file, 'example'), /no title: line/);
    assert.throws(() => readTargetFrontMatter(join(dir, 'missing.tid'), 'example'), /target is missing/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the offline check notices a vendored file that was edited by hand', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-test-'));
  try {
    const file = join(dir, 'library.tid');
    const entry = { name: 'example', target: 'wiki/local-plugins/x/library.tid', expect: ['var lib'], minBytes: 4 };
    writeFileSync(file, tiddler(FRONT_MATTER, 'var lib=1;'));
    const recorded = adoptEntry(entry, null, file);
    assert.equal(recorded.version, 'unrecorded', 'a file that predates the manifest has no version to claim');
    assert.equal(recorded.bodySha256, sha256('var lib=1;'));

    // What the gate is for: the bytes on disk are the bytes the lock describes.
    assert.doesNotThrow(() => verifyEntry(entry, recorded, file));

    writeFileSync(file, tiddler(FRONT_MATTER, 'var lib=2;'));
    assert.throws(() => verifyEntry(entry, recorded, file), /not the body the lock describes/);

    // A pin that disagrees with what was written is the other half of the same question.
    const pinned = { ...entry, pin: '1.0.0' };
    assert.throws(
      () => verifyEntry(pinned, { ...adoptEntry(entry, null, file), version: '0.9.0' }, file),
      /pinned to 1\.0\.0, the lock says 0\.9\.0/
    );
    // Adopting a pinned entry records the pin, because that is what the manifest promises.
    assert.equal(adoptEntry(pinned, null, file).version, '1.0.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the check refuses a tiddler that ends with a newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-test-'));
  try {
    const file = join(dir, 'library.tid');
    const entry = { name: 'example', target: 'wiki/local-plugins/x/library.tid' };
    writeFileSync(file, `${tiddler(FRONT_MATTER, 'var lib=1;')}\r\n`);
    const recorded = { target: entry.target, bodySha256: sha256('var lib=1;'), version: '1.0.0' };
    assert.throws(() => verifyEntry(entry, recorded, file), /ends with a newline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the summary names a moved version, a moved body, and a major jump differently', () => {
  const summary = renderSummary(
    [
      { name: 'pele', version: '1.8.0', from: '1.7.0', changed: true, status: 'updated', detail: '1.7.0 -> 1.8.0' },
      { name: 'pdfjs', version: '3.11.174', from: '3.11.174', changed: true, status: 'updated', detail: '3.11.174 -> 3.11.174' },
      { name: 'other', version: '2.0.0', from: '1.4.0', changed: true, major: true, status: 'updated', detail: '1.4.0 -> 2.0.0' },
      { name: 'quiet', version: '1.0.0', from: '1.0.0', changed: false, status: 'up to date', detail: '1.0.0 -> 1.0.0' }
    ],
    { title: 'Vendored libraries' }
  );
  assert.match(summary, /\| pele \| 1\.8\.0 \| updated \| 1\.7\.0 -> 1\.8\.0 \|/);
  assert.match(summary, /\| pdfjs \| 3\.11\.174 \| updated \| content changed at 3\.11\.174 \|/);
  assert.match(summary, /\| other \| 2\.0\.0 \| updated \| major jump: 1\.4\.0 -> 2\.0\.0 \|/);
  assert.match(summary, /3 vendored files changed/, 'the count is the rows that moved, not the rows listed');
});
