import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupFileName,
  backupStamp,
  collectInstanceBackup,
  mergeBookmarks,
  parseInstanceBackup,
  planBackupImport,
  restoreInstanceBackup,
  serializeInstanceBackup,
  type BackupBookmark,
  type BackupStore,
  type InstanceBackup
} from './instance-backup.ts';
import { BOOKMARK_LIMIT, type BookmarkEntry } from './bookmarks.ts';

/** An in-memory store with the three calls the backup makes. */
function memoryStore(seed: Array<[string, unknown]> = []) {
  const data = new Map<string, unknown>(seed);
  const store: BackupStore = {
    keys: async () => [...data.keys()],
    get: async <T>(key: string) => data.get(key) as T | undefined,
    set: async (key: string, value: unknown) => void data.set(key, value)
  };
  return { store, data };
}

const source = { mode: 'webapp', origin: 'https://lithic.uk' };

/** Two saved instances, one with the icon its file carries and one without. */
const saved = (): BackupBookmark[] => [
  { url: 'https://personal.lithic.uk', label: 'personal.lithic.uk', icon: 'data:image/png;base64,AAAA', iconFetchedAt: 1_700_000_000_000 },
  { url: 'https://work.lithic.uk', label: 'work.lithic.uk' }
];

test('a full store round-trips through the file and back', async () => {
  const seeded: Array<[string, unknown]> = [
    ['recentFiles', [{ name: 'recipes.lith', browserOnly: true }]],
    ['search_cache_recipes.lith', { text: '[{"title":"a"}]', lastModified: 'x' }],
    ['search_cache_meta_recipes.lith', { headId: 'v1', versions: [{ id: 'v1', ts: 1, sizeBytes: 10, isBase: true }] }],
    ['search_cache_base_recipes.lith_v1', { id: 'v1', text: '[{"title":"a"}]' }],
    ['search_cache_delta_recipes.lith_v2', { id: 'v2', parentId: 'v1', ts: 2, ops: [] }],
    ['dirty_state_recipes.lith', { ts: 9, tiddlers: [] }],
    ['search_cache_notes.lith', { text: '[{"title":"b"}]' }]
  ];
  const from = memoryStore(seeded);
  const backup = await collectInstanceBackup(from.store, source, 1_700_000_000_000, saved());

  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.version, BACKUP_VERSION);
  assert.equal(backup.source.mode, 'webapp');
  // Names come from the flat and meta keys, so both wikis are here even though only one has history.
  assert.deepEqual(backup.wikis.map((wiki) => wiki.name).sort(), ['notes.lith', 'recipes.lith']);
  const recipes = backup.wikis.find((wiki) => wiki.name === 'recipes.lith')!;
  assert.deepEqual(recipes.cache, { text: '[{"title":"a"}]', lastModified: 'x' }, 'the flat record travels whole');
  assert.equal(recipes.history.length, 3, 'the meta record and both chain records');
  assert.deepEqual(recipes.dirty, { ts: 9, tiddlers: [] });
  // The list travels as names, and a browser-only row keeps the flag that makes it a row.
  assert.deepEqual(backup.recents, [{ name: 'recipes.lith', browserOnly: true }]);
  // The saved instances travel with the file, labels, icons and all: the address in a backup is
  // usually an instance the reading device cannot reach, so an icon is not something to refetch.
  assert.deepEqual(backup.bookmarks, saved());

  // Through the bytes and back, which is the contract the drop handler relies on.
  const parsed = parseInstanceBackup(serializeInstanceBackup(backup));
  assert.equal(parsed.ok, true, 'a document this module wrote parses');

  const to = memoryStore();
  await restoreInstanceBackup(to.store, (parsed as { ok: true; backup: InstanceBackup }).backup);
  for (const [key, value] of seeded) {
    assert.deepEqual(to.data.get(key), value, `${key} is restored verbatim`);
  }
  assert.deepEqual(
    to.data.get('recentFiles'),
    [{ name: 'recipes.lith', browserOnly: true }],
    'a restored row is the browser-only row it was, not an anonymous name'
  );

  const again = await collectInstanceBackup(to.store, source, 1_700_000_000_000, saved());
  assert.deepEqual(again, backup, 'a restored store exports the same document it came from');
});

test('the bookmark list travels whole, and only as much of it as the list holds', async () => {
  const { store } = memoryStore([['search_cache_a.lith', { text: '[]' }]]);

  // A label falls back to the host, an icon only travels with the moment it was fetched, an
  // entry with no address is not an entry, and one address appears once however often it is
  // handed over.
  const messy: BackupBookmark[] = [
    { url: 'https://a.example', label: '' },
    { url: 'https://a.example', label: 'twice' },
    { url: ' ', label: 'no address' },
    { url: 'https://b.example', icon: 'data:image/png;base64,AAAA' },
    { url: 'https://c.example', icon: '', iconFetchedAt: 5 },
    { url: 'https://d.example', icon: 'data:image/png;base64,BBBB', iconFetchedAt: 7 }
  ];
  const backup = await collectInstanceBackup(store, source, 0, messy);
  assert.deepEqual(backup.bookmarks, [
    { url: 'https://a.example', label: 'a.example' },
    { url: 'https://b.example', label: 'b.example', icon: 'data:image/png;base64,AAAA', iconFetchedAt: 0 },
    { url: 'https://c.example', label: 'c.example' },
    { url: 'https://d.example', label: 'd.example', icon: 'data:image/png;base64,BBBB', iconFetchedAt: 7 }
  ]);

  const many: BackupBookmark[] = Array.from({ length: BOOKMARK_LIMIT + 5 }, (_unused, index) => ({
    url: `https://instance-${index}.example`
  }));
  const capped = await collectInstanceBackup(store, source, 0, many);
  assert.equal(capped.bookmarks.length, BOOKMARK_LIMIT, 'the file carries what the list holds, and no more');
});

test('an import adds the file\'s bookmarks and removes none of this device\'s', () => {
  const here: BookmarkEntry[] = [
    { url: 'https://work.lithic.uk', label: 'work.lithic.uk', icon: 'data:image/png;base64,LOCAL' }
  ];
  const merged = mergeBookmarks(here, saved());
  assert.deepEqual(
    merged.map((entry) => entry.url),
    ['https://work.lithic.uk', 'https://personal.lithic.uk'],
    'what is here stays and stays in front, and what the file adds is appended'
  );
  // The local entry wins, icon included: its icon came from a live instance rather than from a file.
  assert.equal(merged[0].icon, 'data:image/png;base64,LOCAL');
  assert.deepEqual(mergeBookmarks(here, []).map((entry) => entry.url), ['https://work.lithic.uk']);
  assert.deepEqual(mergeBookmarks([], saved()).map((entry) => entry.url), saved().map((entry) => entry.url));
  // Twice in one file is still once in the list.
  assert.deepEqual(
    mergeBookmarks([], [saved()[0], saved()[0]]).map((entry) => entry.url),
    ['https://personal.lithic.uk']
  );
});

test('history is attributed to the wiki whose name is the longer match', async () => {
  // `notes` is a prefix of `notes_2026`, so the naive reader hands the second wiki's base to
  // the first one and the restore writes it under the wrong name.
  const { store } = memoryStore([
    ['search_cache_notes', { text: '[]' }],
    ['search_cache_notes_2026', { text: '[]' }],
    ['search_cache_base_notes_2026_v1', { id: 'v1', text: '[]' }]
  ]);
  const backup = await collectInstanceBackup(store, source, 0);
  const short = backup.wikis.find((wiki) => wiki.name === 'notes')!;
  const long = backup.wikis.find((wiki) => wiki.name === 'notes_2026')!;
  assert.equal(short.history.length, 0, 'the short name does not claim the other wiki history');
  assert.deepEqual(long.history.map((record) => record.key), ['search_cache_base_notes_2026_v1']);
});

test('an import is refused whole when any name is already here', () => {
  const backup = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: '',
    source,
    recents: [],
    bookmarks: [],
    wikis: [
      { name: 'recipes.lith', cache: { text: '[]' }, history: [], dirty: null },
      { name: 'Notes.lith', cache: { text: '[]' }, history: [], dirty: null }
    ]
  } as InstanceBackup;

  // Case-insensitive, the way the list compares names, and the refusal names what clashes.
  const refused = planBackupImport(backup, ['notes.lith']);
  assert.equal(refused.ok, false);
  assert.deepEqual((refused as { ok: false; collisions: string[] }).collisions, ['Notes.lith']);
  // A name only the caches know is still a name this device holds.
  assert.equal(planBackupImport(backup, ['recipes.lith', 'other.lith']).ok, false);
  // Nothing in common means it lands.
  assert.equal(planBackupImport(backup, ['unrelated.lith']).ok, true);
  assert.equal(planBackupImport(backup, []).ok, true);
});

test('a file that is not this backup is refused with the reason', () => {
  assert.deepEqual(parseInstanceBackup('not json'), { ok: false, reason: 'json' });
  assert.deepEqual(parseInstanceBackup('[]'), { ok: false, reason: 'shape' });
  assert.deepEqual(parseInstanceBackup('{}'), { ok: false, reason: 'format' });
  // A tiddler payload is a JSON array, so it is refused as a shape rather than mistaken for one.
  assert.deepEqual(parseInstanceBackup('[{"title":"a"}]'), { ok: false, reason: 'shape' });
  const wrongVersion = JSON.stringify({ format: BACKUP_FORMAT, version: 99, recents: [], wikis: [] });
  assert.deepEqual(parseInstanceBackup(wrongVersion), { ok: false, reason: 'version' });
  // A file written before the list travelled has no `bookmarks` at all, and reads as none.
  const noList = parseInstanceBackup(
    JSON.stringify({
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      recents: [],
      wikis: [{ name: 'a.lith', cache: null, history: [], dirty: null }]
    })
  );
  assert.equal(noList.ok, true, 'an older file is read rather than refused');
  assert.deepEqual((noList as { ok: true; backup: InstanceBackup }).backup.bookmarks, []);
  const badList = (bookmarks: unknown) =>
    parseInstanceBackup(
      JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        recents: [],
        wikis: [],
        bookmarks
      })
    );
  assert.deepEqual(badList('https://one.example'), { ok: false, reason: 'shape' });
  assert.deepEqual(badList([{ label: 'no address' }]), { ok: false, reason: 'shape' });
  assert.deepEqual(badList([{ url: '' }]), { ok: false, reason: 'shape' });
  assert.deepEqual(badList([{ url: 'https://ok.example' }]), { ok: true, backup: { format: BACKUP_FORMAT, version: BACKUP_VERSION, recents: [], wikis: [], bookmarks: [{ url: 'https://ok.example' }] } });

  const noWikis = JSON.stringify({ format: BACKUP_FORMAT, version: BACKUP_VERSION, recents: [] });
  assert.deepEqual(parseInstanceBackup(noWikis), { ok: false, reason: 'shape' });
  // A wiki with no cache key at all is refused, because it would restore as a name with nothing
  // behind it. An explicit null is how the file says "history only".
  const noCache = JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    recents: [],
    wikis: [{ name: 'a.lith', history: [], dirty: null }]
  });
  assert.deepEqual(parseInstanceBackup(noCache), { ok: false, reason: 'shape' });
  const nameless = JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    recents: [],
    wikis: [{ name: '', cache: null, history: [], dirty: null }]
  });
  assert.deepEqual(parseInstanceBackup(nameless), { ok: false, reason: 'shape' });
});

test('the download name is sortable and safe, whatever the clock says', () => {
  assert.equal(backupStamp(Date.UTC(2026, 0, 2, 3, 4, 5)).length, 15);
  assert.match(backupFileName(0), /^lithic-instance-backup-\d{8}-\d{6}\.json$/);
  assert.match(backupFileName(Number.NaN), /^lithic-instance-backup-00000000-000000\.json$/);
});
