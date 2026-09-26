import test from 'node:test';
import assert from 'node:assert/strict';
import { folderOf, folderNameOf, computeBackupCoverage, hasBackedUpRepo, folderTargets, reindexFolders, orphanedEntries, syncedDirFor } from './backup-coverage.ts';

test('folderOf keeps the separator and tolerates either OS', () => {
  assert.equal(folderOf('C:\\Users\\me\\Documents\\Lithic\\work.lith'), 'C:\\Users\\me\\Documents\\Lithic\\');
  assert.equal(folderOf('/home/me/lithic/work.lith'), '/home/me/lithic/');
});

test('folderOf handles a drive root, a trailing slash and a bare name', () => {
  assert.equal(folderOf('C:\\work.lith'), 'C:\\');
  assert.equal(folderOf('/data/lithic/'), '/data/');
  assert.equal(folderOf('work.lith'), '');
});

test('folderNameOf names the folder, wherever it came from', () => {
  assert.equal(folderNameOf('D:\\backups\\archive'), 'archive');
  assert.equal(folderNameOf('/home/me/lithic/'), 'lithic');
  // The drive root has no name to give but its own, and a bare name is already one.
  assert.equal(folderNameOf('C:\\'), 'C:');
  assert.equal(folderNameOf('archive'), 'archive');
});

test('coverage counts only rows that record a disk path', () => {
  const coverage = computeBackupCoverage(
    [
      { name: 'backed.lith', path: 'C:\\Lithic\\backed.lith' },
      { name: 'orphan.lith', path: 'D:\\notes\\orphan.lith' },
      // A browser-handle row has no path: neither backed up nor local-only.
      { name: 'web.lith', path: null }
    ],
    // The root backs up a nested wiki, which is the case a folder-keyed
    // comparison got wrong.
    { 'C:\\Lithic\\backed.lith': 'C:\\Lithic', 'C:\\Lithic\\projects\\deep.lith': 'C:\\Lithic' }
  );
  assert.equal(coverage.tracked, 2);
  assert.equal(coverage.backedUp, 1);
  assert.deepEqual(coverage.localOnlyPaths, ['D:\\notes\\orphan.lith']);
});

test('a row inside a backed-up folder counts as covered wherever it nests', () => {
  const coverage = computeBackupCoverage(
    [{ name: 'deep.lith', path: '/data/lithic/projects/deep.lith' }],
    { '/data/lithic/projects/deep.lith': '/data/lithic' }
  );
  assert.equal(coverage.backedUp, 1);
  assert.deepEqual(coverage.localOnlyPaths, []);
});

test('a partial answer does not mark an unanswered row as backed up', () => {
  const coverage = computeBackupCoverage(
    [
      { name: 'known.lith', path: '/data/a.lith' },
      { name: 'unknown.lith', path: 'E:\\stick\\b.lith' }
    ],
    { '/data/a.lith': '/data' }
  );
  assert.equal(coverage.backedUp, 1);
  assert.deepEqual(coverage.localOnlyPaths, ['E:\\stick\\b.lith']);
});

test('hasBackedUpRepo is false while nothing is backed up', () => {
  assert.equal(hasBackedUpRepo({}), false);
  assert.equal(hasBackedUpRepo({ '/data/a.lith': '/data' }), true);
});

test('syncedDirFor picks the covered folder of the newest row that has one', () => {
  // The newest rows are the stray ones — which is exactly the state a local-only
  // mark appears in, so walking past them to the first covered row is the case
  // that matters, not an edge case.
  const rows = [
    { name: 'tiddlers.lith', path: 'C:\\Users\\me\\Downloads\\tiddlers.lith' },
    { name: 'stray.lith', path: 'D:\\scratch\\stray.lith' },
    { name: 'notes.lith', path: 'C:\\Users\\me\\Documents\\Lithic\\notes.lith' },
    { name: 'older.lith', path: 'C:\\Users\\me\\Documents\\Lithic\\older.lith' }
  ];
  const roots = { 'C:\\Users\\me\\Documents\\Lithic\\notes.lith': 'C:\\Users\\me\\Documents\\Lithic', 'C:\\Users\\me\\Documents\\Lithic\\older.lith': 'C:\\Users\\me\\Documents\\Lithic' };
  assert.equal(syncedDirFor(rows, roots), 'C:\\Users\\me\\Documents\\Lithic');
});

test('syncedDirFor answers nothing while no folder is covered', () => {
  assert.equal(syncedDirFor([{ name: 'a.lith', path: 'D:\\a.lith' }], {}), null);
  assert.equal(syncedDirFor([{ name: 'a.lith', path: null }], { '/data/a.lith': '/data' }), null);
});

test('folderTargets yields one representative file per distinct folder', () => {
  const targets = folderTargets([
    { name: 'a.lith', path: '/data/a.lith' },
    { name: 'b.lith', path: '/data/nested/b.lith' },
    { name: 'c.lith', path: '/other/c.lith' },
    { name: 'web.lith', path: null }
  ]);
  assert.deepEqual(targets, [
    { folder: '/data/', path: '/data/a.lith' },
    { folder: '/data/nested/', path: '/data/nested/b.lith' },
    { folder: '/other/', path: '/other/c.lith' }
  ]);
  // A nested wiki belongs to the folder it lives in, not the walked root:
  // every folder keeps its own repository.
  assert.equal(folderOf('/data/nested/b.lith'), '/data/nested/');
});

test('orphanedEntries reports exactly what a fresh listing would remove', () => {
  const rows = [
    { name: 'here.lith', path: '/data/here.lith' },
    { name: 'moved.lith', path: '/data/moved.lith' },
    { name: 'offline.lith', path: 'Z:\\drive\\offline.lith' },
    // A handle-only row was never a path on disk, so nothing of it is dropped.
    { name: 'web.lith', path: null }
  ];
  const listed = new Set(['/data/here.lith']);
  assert.deepEqual(
    orphanedEntries(rows, [], listed, new Set(['here.lith'])),
    [
      { name: 'moved.lith', path: '/data/moved.lith' },
      { name: 'offline.lith', path: 'Z:\\drive\\offline.lith' }
    ]
  );
});

test('a cached copy with no row is an orphan too, so nothing is left searchable only', () => {
  const listedNames = new Set(['here.lith']);
  assert.deepEqual(
    orphanedEntries(
      [{ name: 'here.lith', path: '/data/here.lith' }],
      ['here.lith', 'deleted-long-ago.lith'],
      new Set(['/data/here.lith']),
      listedNames
    ),
    [{ name: 'deleted-long-ago.lith', path: null }]
  );
});

test('a cached copy whose file is back is not an orphan, and a row is listed once', () => {
  // Both the row and its cache point at the same wiki: one entry, not two.
  const entries = orphanedEntries(
    [{ name: 'gone.lith', path: '/data/gone.lith' }],
    ['gone.lith', 'GONE.LITH'],
    new Set(),
    new Set()
  );
  assert.deepEqual(entries, [{ name: 'gone.lith', path: '/data/gone.lith' }]);

  assert.deepEqual(
    orphanedEntries(
      [{ name: 'back.lith', path: '/data/back.lith' }],
      ['back.lith'],
      new Set(['/data/back.lith']),
      new Set(['back.lith'])
    ),
    []
  );
});

test('a rebuild that finds everything asks nothing', () => {
  assert.deepEqual(
    orphanedEntries([{ name: 'a.lith', path: '/data/a.lith' }], ['a.lith'], new Set(['/data/a.lith']), new Set(['a.lith'])),
    []
  );
});

test('reindexFolders walks repository roots first, then every known folder', () => {
  const folders = reindexFolders(
    [
      { name: 'a.lith', path: 'C:\\Lithic\\a.lith' },
      { name: 'deep.lith', path: 'C:\\Lithic\\projects\\deep.lith' },
      { name: 'orphan.lith', path: 'D:\\notes\\orphan.lith' }
    ],
    { 'C:\\Lithic\\a.lith': 'C:\\Lithic', 'C:\\Lithic\\projects\\deep.lith': 'C:\\Lithic' }
  );
  assert.deepEqual(folders, [
    'C:\\Lithic',
    'C:\\Lithic\\',
    'C:\\Lithic\\projects\\',
    'D:\\notes\\'
  ]);
});
