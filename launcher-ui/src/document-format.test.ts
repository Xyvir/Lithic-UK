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
  typedDocumentName,
  pickerFiltersByMimeType,
  resolveDocumentFormat,
  runsInWebView,
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

  // The window a board's sign-in page is drawn in, and the reason the mount control can hand the
  // page to a browser on the first press: a WebView says it is one, Chrome does not.
  assert.equal(
    runsInWebView(
      'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.7390.122 Mobile Safari/537.36; wv'
    ),
    true
  );
  assert.equal(
    runsInWebView(
      'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.7390.122 Mobile Safari/537.36'
    ),
    false,
    'Chrome on the same phone picks files, so its control stays a button'
  );
  assert.equal(runsInWebView('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0'), false);
  assert.equal(runsInWebView(''), false, 'a page with no user agent is not taken for a WebView');
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

test('a control character in a name is dropped, not refused', () => {
  // The three a name meets by accident: a pasted line break, a tab, and the NUL a bad join
  // leaves behind. None of them is a request about what the document is called, and none can
  // be honoured: no filesystem takes them, and a line-oriented list splits on a break.
  assert.equal(normalizeDocumentName('two\nlines'), 'twolines.lith');
  assert.equal(normalizeDocumentName('two\r\nlines'), 'twolines.lith', 'the same break in the other ending');
  assert.equal(normalizeDocumentName('a\tb'), 'ab.lith');
  assert.equal(normalizeDocumentName('a\u0000b'), 'ab.lith');
  assert.equal(normalizeDocumentName('del\u007f'), 'del.lith');
  // A stray space is the same kind of accident, so the ends are trimmed too.
  assert.equal(normalizeDocumentName('  notes  '), 'notes.lith');
  assert.equal(normalizeDocumentName('  notes .lith '), 'notes.lith', 'trimmed after the extension goes');
  assert.equal(normalizeDocumentName('\n\t '), 'untitled.lith', 'a name of nothing but accidentals is still a document');
});

test('a name is made legal for Windows, which is the strictest of the three', () => {
  // The nine characters Windows refuses, separators included, since a name legal there is legal
  // on macOS and Linux as well and the reverse is not true. A hyphen keeps the boundary the
  // person wrote, where removing the character would invent a word nobody typed.
  assert.equal(normalizeDocumentName('MP3/FLAC notes'), 'MP3-FLAC notes.lith');
  assert.equal(normalizeDocumentName('a\\b'), 'a-b.lith');
  assert.equal(normalizeDocumentName('Re: notes'), 'Re- notes.lith');
  assert.equal(normalizeDocumentName('what?*'), 'what-.lith', 'a run of them is one hyphen');
  assert.equal(normalizeDocumentName('"quoted"'), '-quoted-.lith');
  // A pasted path stops being a path: the name lands in the folder being saved into rather
  // than walking out of it.
  assert.equal(normalizeDocumentName('../../etc/passwd'), '..-..-etc-passwd.lith');
  assert.equal(normalizeDocumentName('C:\\Users\\me\\notes'), 'C-Users-me-notes.lith');
});

test('a name is tidied where Windows would create it differently', () => {
  // Windows drops a trailing space and a trailing dot when it creates the file, so a name that
  // keeps one is a name a row shows and a disk never had.
  assert.equal(normalizeDocumentName('notes.'), 'notes.lith');
  assert.equal(normalizeDocumentName('notes .lith'), 'notes.lith');
  assert.equal(normalizeDocumentName('notes. '), 'notes.lith', 'a dot and the space after it go together');
  assert.equal(normalizeDocumentName('...'), 'untitled.lith', 'nothing but dots is no name');
  assert.equal(normalizeDocumentName('.notes'), '.notes.lith', 'a leading dot is deliberate');
});

test('a device name moves out of the way, whatever extension or dot follows it', () => {
  // `CON.lith` is the console with a suffix rather than a file, so Windows will not create it.
  assert.equal(normalizeDocumentName('CON'), '_CON.lith');
  assert.equal(normalizeDocumentName('nul.lith'), '_nul.lith', 'the document extension does not save it');
  assert.equal(normalizeDocumentName('CON.notes'), '_CON.notes.lith', 'a dot does not save it either');
  assert.equal(normalizeDocumentName('com1'), '_com1.lith');
  assert.equal(normalizeDocumentName('conin$'), '_conin$.lith');
  // Names that merely start with one are ordinary documents.
  assert.equal(normalizeDocumentName('console'), 'console.lith');
  assert.equal(normalizeDocumentName('com10'), 'com10.lith');
  assert.equal(normalizeDocumentName('my con'), 'my con.lith');
});

test('the typed name and the written name differ exactly when the launcher renamed it', () => {
  // The comparison the New Blank Lith field draws its notice from. It has to be silent for the
  // ordinary case, or the notice becomes noise nobody reads.
  for (const plain of ['notes', 'notes.lith', '  notes  ', 'My Notes', 'ملف عربي']) {
    assert.equal(typedDocumentName(plain), normalizeDocumentName(plain), `${JSON.stringify(plain)} is kept as typed`);
  }
  // And it has to speak for every rewrite: the characters Windows refuses, the endings, the
  // device names, the extension of a document this build writes, and the length cap.
  assert.equal(typedDocumentName('a/b'), 'a/b.lith');
  assert.equal(normalizeDocumentName('a/b'), 'a-b.lith');
  assert.equal(typedDocumentName('notes.'), 'notes..lith');
  assert.equal(typedDocumentName('CON'), 'CON.lith');
  assert.equal(typedDocumentName('notes.html'), 'notes.html');
  assert.notEqual(normalizeDocumentName('notes.html'), typedDocumentName('notes.html'), 'a monolith name becomes a Lith name');
  assert.notEqual(normalizeDocumentName('a'.repeat(400)), typedDocumentName('a'.repeat(400)), 'a name past the component limit is announced');
  // An empty field has nothing to announce: the dialog opens with the notice absent rather than
  // claiming the next document will be called `untitled.lith`.
  assert.equal(typedDocumentName(''), '');
  assert.equal(typedDocumentName('   '), '');
});

test('two names that merge are only ambiguous once one of them exists', () => {
  // The reason the notice exists at all: a sanitiser always merges, and the person who typed the
  // path is the one who has to know which name they are about to get.
  assert.equal(normalizeDocumentName('a/b'), normalizeDocumentName('a-b'), 'the two typed names converge');
  assert.notEqual(typedDocumentName('a/b'), typedDocumentName('a-b'), '...and are distinguishable before the rewrite');
  assert.equal(normalizeDocumentName('CON'), normalizeDocumentName('_CON'), 'a device name and its escape converge too');
});

test('a name is cut to what one path component may hold', () => {
  const long = 'a'.repeat(400);
  assert.equal(normalizeDocumentName(long), `${'a'.repeat(250)}.lith`);
  assert.equal(normalizeDocumentName(long, 'html'), `${'a'.repeat(250)}.html`);
  // A cut between the two halves of an emoji drops the pair rather than shipping half a
  // character, which would arrive as a replacement glyph.
  const capped = normalizeDocumentName(`${'a'.repeat(249)}${'🔥'.repeat(4)}`);
  assert.equal(capped, `${'a'.repeat(249)}.lith`);
  assert.equal(capped.length, 254);
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
