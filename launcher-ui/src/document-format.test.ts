import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DOCUMENT_FORMAT,
  advertisesDocument,
  documentExtension,
  documentMimetype,
  documentPickerTypes,
  documentStem,
  inputAcceptTypes,
  isDocumentFormat,
  normalizeDocumentName,
  pickerFiltersByMimeType,
  resolveDocumentFormat,
  serverDocumentName,
  writesLith
} from './document-format.ts';

test('a chooser that filters by MIME type is not given a list it would drop .lith out of', () => {
  // Android, where the WebView maps each extension through the platform's MIME table and keeps
  // only the ones it knows: `.lith`, `.tid` and `.md` are not among them, so the extension list
  // is what greyed out every `.lith` in the folder.
  assert.equal(pickerFiltersByMimeType('Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36'), true);
  assert.equal(pickerFiltersByMimeType('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/141.0'), false);
  assert.equal(pickerFiltersByMimeType(''), false, 'a page with no user agent keeps the useful filter');
  assert.equal(inputAcceptTypes(true), '*/*');
  // Every kind this launcher opens, by extension as well as by media type, is still named where
  // the platform honours extensions.
  const filtered = inputAcceptTypes(false);
  for (const type of ['.lith', '.html', '.json', '.md', '.tid', '.ipynb', 'text/plain', 'text/html']) {
    assert.ok(filtered.split(',').includes(type), `${type} is offered to the picker`);
  }
});

test('the format pin defaults to lith and refuses a value that names nothing', () => {
  assert.equal(resolveDocumentFormat(undefined), 'lith');
  assert.equal(resolveDocumentFormat(''), 'lith');
  assert.equal(resolveDocumentFormat('  '), 'lith');
  assert.equal(resolveDocumentFormat('LITH'), 'lith', 'a typo is the default, not a format');
  assert.equal(resolveDocumentFormat('html'), 'html');
  assert.equal(resolveDocumentFormat('both'), 'both');
  assert.ok(isDocumentFormat('lith') && !isDocumentFormat('lithic'));
  // Node has no build and no location, so the artifact's own pin is the default here.
  assert.equal(DOCUMENT_FORMAT, 'lith');
});

test('lith is what every format but html writes, and it is the extension a new document gets', () => {
  assert.equal(writesLith('lith'), true);
  assert.equal(writesLith('both'), true);
  assert.equal(writesLith('html'), false);

  assert.equal(documentExtension('lith'), '.lith');
  assert.equal(documentExtension('both'), '.lith', 'both offers the other shape, it does not rename one');
  assert.equal(documentExtension('html'), '.html');

  assert.equal(documentMimetype('lith'), 'application/x-lith');
  assert.equal(documentMimetype('both'), 'application/x-lith');
  assert.equal(documentMimetype('html'), 'text/html');
});

test('a typed name takes the build extension, and an empty stem is untitled', () => {
  assert.equal(normalizeDocumentName('new'), 'new.lith');
  assert.equal(normalizeDocumentName('new.html'), 'new.lith');
  assert.equal(normalizeDocumentName('new.lith'), 'new.lith');
  assert.equal(normalizeDocumentName('new.json'), 'new.lith');
  assert.equal(normalizeDocumentName('.html'), 'untitled.lith');

  assert.equal(normalizeDocumentName('new', 'html'), 'new.html');
  assert.equal(normalizeDocumentName('notes.lith', 'html'), 'notes.html');
  assert.equal(normalizeDocumentName('.html', 'html'), 'untitled.html');
  assert.equal(normalizeDocumentName('new', 'both'), 'new.lith');
});

test('a stem is the name without whichever document extension it carries', () => {
  assert.equal(documentStem('notes.lith'), 'notes');
  assert.equal(documentStem('notes.html'), 'notes');
  assert.equal(documentStem('notes.htm'), 'notes');
  assert.equal(documentStem('notes.json'), 'notes');
  assert.equal(documentStem('notes.txt'), 'notes.txt', 'only document extensions are stripped');
});

test('the picker offers what the build writes, with the launcher own format first', () => {
  const accept = (types: Array<{ accept: Record<string, string[]> }>) =>
    types.flatMap((type) => Object.keys(type.accept));

  assert.deepEqual(accept(documentPickerTypes('lith')), ['application/x-lith', 'application/x-ipynb+json']);
  assert.deepEqual(accept(documentPickerTypes('html')), ['text/html']);
  assert.deepEqual(accept(documentPickerTypes('both')), [
    'application/x-lith',
    'text/html',
    'application/x-ipynb+json'
  ]);
});

test('advertising follows the pin, and reading does not', () => {
  // A lith build lists its own documents and nothing else.
  assert.equal(advertisesDocument('notes.lith', 'lith'), true);
  assert.equal(advertisesDocument('notes.html', 'lith'), false);

  // An html build advertises monoliths, and stops advertising the format it does not write.
  assert.equal(advertisesDocument('notes.html', 'html'), true);
  assert.equal(advertisesDocument('notes.htm', 'html'), true);
  assert.equal(advertisesDocument('notes.lith', 'html'), false);

  // both advertises either.
  assert.equal(advertisesDocument('notes.lith', 'both'), true);
  assert.equal(advertisesDocument('notes.html', 'both'), true);

  assert.equal(advertisesDocument('notes.txt', 'both'), false);
  assert.equal(advertisesDocument('NOTES.LITH', 'lith'), true, 'a name is judged without case');
});

test('an upload lands under the build extension unless it is already a document', () => {
  assert.equal(serverDocumentName('notes', 'lith'), 'notes.lith');
  assert.equal(serverDocumentName('notes.lith', 'lith'), 'notes.lith');
  assert.equal(
    serverDocumentName('notes.html', 'lith'),
    'notes.lith',
    'a lith build files what it writes, exactly as it did before this pin existed'
  );
  assert.equal(serverDocumentName('notes', 'html'), 'notes.html');
  assert.equal(serverDocumentName('notes.htm', 'html'), 'notes.htm');
  assert.equal(serverDocumentName('notes.lith', 'html'), 'notes.html');
  assert.equal(serverDocumentName('archive.tar', 'html'), 'archive.html');
  // both writes either shape, so it keeps either name.
  assert.equal(serverDocumentName('notes.html', 'both'), 'notes.html');
  assert.equal(serverDocumentName('notes.lith', 'both'), 'notes.lith');
  assert.equal(serverDocumentName('notes', 'both'), 'notes.lith');
});
