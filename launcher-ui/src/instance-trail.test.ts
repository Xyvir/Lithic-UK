import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTrailCommits, trailGapLabel, trailPill, trailRows } from './instance-trail.ts';
import { utcStamp } from './wiki-history.ts';

/** The newest commit in every fixture below, so the timestamps are readable as a story. */
const NEWEST = 1_700_000_600;
const OLDER = 1_700_000_000;

test('the desktop array and the two wire envelopes read into the same commits', () => {
  // The app answers an array, because IPC has no envelope; the shim and a server answer
  // `{ commits: [...] }`, because a bare array is the shape a truncated answer is confused with.
  const row = { hash: 'abcdef1234567890', short: 'abcdef1', summary: 'Add notes.lith', time: NEWEST };
  const fromApp = parseTrailCommits([row]);
  const fromWire = parseTrailCommits({ commits: [row] });
  assert.deepEqual(fromApp, [row]);
  assert.deepEqual(fromWire, fromApp);
});

test('a short id is derived when a backend sends only the full one', () => {
  const [commit] = parseTrailCommits([{ hash: 'abcdef1234567890', time: 1 }]) ?? [];
  assert.equal(commit.short, 'abcdef1');
  // And one the backend did send is kept as it is, because git's own abbreviation is its rule.
  const [given] = parseTrailCommits([{ hash: 'abcdef1234567890', short: 'abcdef12', time: 1 }]) ?? [];
  assert.equal(given.short, 'abcdef12');
});

test('a payload that is not a trail is null, which is not the same as an empty trail', () => {
  // An empty repository has an empty trail: the dialog says there is nothing yet.
  assert.deepEqual(parseTrailCommits([]), []);
  assert.deepEqual(parseTrailCommits({ commits: [] }), []);
  // A payload nobody can read is a backend that did not answer, and the dialog says that
  // instead. Collapsing the two would tell somebody their history is empty when it was never
  // read at all.
  for (const junk of ['nonsense', 42, null, undefined, {}, { commits: 'soon' }, { commits: [{}] }]) {
    assert.equal(parseTrailCommits(junk), null, `${JSON.stringify(junk)} should not read as a trail`);
  }
  // A row with no id, or one with no usable time, makes the whole answer unreadable rather than
  // being skipped: a trail with a hole in it is not the history it claims to be.
  assert.equal(parseTrailCommits([{ hash: 'a'.repeat(40), time: 1 }, { short: 'abc' }]), null);
  assert.equal(parseTrailCommits([{ hash: 'a'.repeat(40), time: 'yesterday' }]), null);
});

test('a row missing a subject still draws, with no words where the subject would be', () => {
  const [commit] = parseTrailCommits([{ hash: 'abcdef1234567890', time: NEWEST }]) ?? [];
  assert.equal(commit.summary, '');
});

test('rows carry the wiki trail stamp, and the gap is measured from the row above', () => {
  const commits = parseTrailCommits([
    { hash: 'b'.repeat(40), summary: 'Second', time: NEWEST },
    { hash: 'a'.repeat(40), summary: 'First', time: OLDER }
  ]);
  assert.ok(commits);
  const rows = trailRows(commits);
  // The same stamp the saved-versions trail draws, from the same function: one column, one
  // format, whichever list is being read.
  assert.equal(rows[0].stamp, utcStamp(NEWEST * 1000));
  assert.match(rows[0].stamp, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
  assert.equal(rows[1].stamp, utcStamp(OLDER * 1000));
  // The newest row has nothing above it, so there is no distance to state.
  assert.equal(rows[0].gap, null);
  // Ten minutes separate the two, stated as the newer row's own distance.
  assert.deepEqual(rows[1].gap, { unit: 'minutes', value: 10 });
  // And each row carries the kind its own message earns it, so the list draws a pill rather
  // than a sentence that has to be read to be understood. "Second" is nobody's shape.
  assert.equal(rows[0].pill, 'other');
  assert.equal(rows[1].pill, 'other');
});

test('a commit wears the pill its own message earns it', () => {
  // Lithic's own writers, each spelled the way the thing that writes it spells it: the
  // self-host timer, the first push, the setup commits, the shim's save, a safety copy taken
  // before a clobber, a Lith copied into the folder, and one file saved by the server.
  for (const message of [
    'Automated Sync: 2026-10-11 12:00:00',
    'Automated Sync: GitHub Clobber (Source of Truth applied)',
    'Initial Sync: notes.lith',
    'Initial sync from Lithic',
    'System: Initialize .gitignore',
    'System: finalize GitHub sync',
    'Lithic backup',
    'CONFLICT BACKUP: Local state at 2026-10-11 12:00:00',
    'Add three.lith from Lithic',
    'Save notes.lith',
    'Save diary.tid'
  ]) {
    assert.equal(trailPill(message), 'auto', `${message} is a save Lithic made on its own`);
  }
  // A go-back is two commits, one of them the save made so the move cannot discard an edit,
  // and the server's restore of a single file to an earlier revision is the same act.
  for (const message of ['Revert to bbbbbbb', 'Save before revert', 'Restore notes.lith to abc1234']) {
    assert.equal(trailPill(message), 'revert', `${message} is part of a go-back`);
  }
  // Everything else is somebody's own commit, which is the only safe reading of a message
  // this module does not recognise: a wrong "Lithic did this" is worse than a plain word.
  for (const message of [
    'Fix the typo in chapter three',
    'wip',
    '',
    '   ',
    'Save',
    'Reverted the settings change',
    'automated sync: lower case'
  ]) {
    assert.equal(trailPill(message), 'other', `${JSON.stringify(message)} is not a message Lithic writes`);
  }
});

test('the distance is one unit, the greatest that fits, and nothing when there is no gap', () => {
  const gapFor = (laterSeconds: number) => {
    const commits = parseTrailCommits([
      { hash: 'b'.repeat(40), time: 2_000_000_000 },
      { hash: 'a'.repeat(40), time: 2_000_000_000 - laterSeconds }
    ]);
    assert.ok(commits);
    return trailRows(commits)[1].gap;
  };
  assert.deepEqual(gapFor(30), { unit: 'seconds', value: 30 });
  assert.deepEqual(gapFor(90), { unit: 'minutes', value: 2 });
  assert.deepEqual(gapFor(5_400), { unit: 'hours', value: 1.5 });
  assert.deepEqual(gapFor(3 * 86_400), { unit: 'days', value: 3 });
  // Two commits stamped in the same second: the chevron joins them and no distance is claimed.
  assert.equal(gapFor(0), null);
  // And a clock that ran backwards is not a negative distance to draw.
  assert.equal(gapFor(-60), null);
});

test('the distance is stated in the locale\'s own numbers, in the trail\'s own words', () => {
  const later = {
    seconds: (count: string) => `${count} second(s) later`,
    minutes: (count: string) => `${count} minute(s) later`,
    hours: (count: string) => `${count} hour(s) later`,
    days: (count: string) => `${count} day(s) later`
  };
  assert.equal(trailGapLabel({ unit: 'hours', value: 1.5 }, later, 'en-GB'), '1.5 hour(s) later');
  // Spanish writes the decimal mark with a comma, and the number is the locale's while the
  // words are the deck's.
  assert.equal(trailGapLabel({ unit: 'hours', value: 1.5 }, later, 'es-ES'), '1,5 hour(s) later');
});
