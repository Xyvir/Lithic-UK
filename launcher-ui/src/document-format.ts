/**
 * Which document format this build writes and advertises.
 *
 * `.lith` is the launcher's own document format: a flat file holding many tiddlers, delimited
 * by the triple-asterism. It is a good format, and it is the default here, but it is not the
 * only shape a distribution can want. A white-labelled build shipped beside somebody else's
 * base may want to write that base's own HTML monolith instead, and this pin is how it says
 * so without the launcher ceasing to be one artifact.
 *
 * The pin is forced, not preferred, exactly like `sync-pin.ts`: a distribution's format is a
 * fact about the build (like the locale pin in `copy.ts`), so it belongs in
 * `launcher-ui/.env`, which CI and the artifact freshness gate both read. `--document-format=`
 * sets it for a scratch build.
 *
 * The one rule the pin cannot break: **it governs what the launcher produces, never what it
 * can open.** A `.lith` stays readable in every build, whatever the pin says, because a user's
 * existing files, a server offering a `.lith`, `intro.lith` and the sync chain all depend on
 * it. The opt-out is about writes and advertising; reading is not negotiable.
 */

import { copy } from './copy.ts';

/** What a build writes: its own documents, HTML monoliths, or both on offer. */
export type DocumentFormat = 'lith' | 'html' | 'both';

/** Every format, in the order the build flag's error message lists them. */
export const DOCUMENT_FORMATS: readonly DocumentFormat[] = ['lith', 'html', 'both'];

/** Whether a value names a format. */
export function isDocumentFormat(value: unknown): value is DocumentFormat {
  return typeof value === 'string' && (DOCUMENT_FORMATS as readonly string[]).includes(value);
}

/**
 * The format a build was asked for, with `lith` for anything that names none.
 *
 * A value that names nothing is the default rather than an error, because that is how CI and
 * the freshness gate call the build. A value that names something else is refused by
 * `build-launcher.mjs` before Vite ever runs, so a typo cannot quietly become a `lith` build.
 */
export function resolveDocumentFormat(value: string | null | undefined): DocumentFormat {
  const format = value?.trim();
  return isDocumentFormat(format) ? format : 'lith';
}

/**
 * The format this artifact was built with (`VITE_LITHIC_DOCUMENT_FORMAT`).
 *
 * Read the way `sync-pin.ts` reads its own pin, and for the same reason: Vite substitutes
 * `import.meta.env.VITE_LITHIC_DOCUMENT_FORMAT` only where it appears literally, and this
 * module is imported by unit tests that run in Node, where there is no `location`, no build,
 * and no `import.meta.env` at all. The guard is what keeps the default in one place, and the
 * checks below all take an explicit format so a test can exercise every one of them.
 */
export const DOCUMENT_FORMAT: DocumentFormat =
  typeof location === 'undefined' ? 'lith' : resolveDocumentFormat(import.meta.env.VITE_LITHIC_DOCUMENT_FORMAT);

/** Whether a save writes a `.lith` of its own. True for every format but `html`. */
export function writesLith(format: DocumentFormat = DOCUMENT_FORMAT): boolean {
  return format !== 'html';
}

/**
 * A document name with its extension removed, whatever extension it carries.
 *
 * Used where a name is displayed or derived rather than written: the site title of a new
 * document, for instance, which must not read `notes.html` just because the build writes
 * monoliths.
 */
export function documentStem(name: string): string {
  return name.replace(/\.(?:html?|lith|json)$/i, '');
}

/**
 * The extension a new document is given.
 *
 * `both` still names `.lith`: the launcher's own format stays the recipient of a name typed in
 * the launcher, and `both` exists to *offer* the other shape in a picker, not to rename it.
 */
export function documentExtension(format: DocumentFormat = DOCUMENT_FORMAT): '.lith' | '.html' {
  return format === 'html' ? '.html' : '.lith';
}

/**
 * What no name may carry: the C0 controls, and DEL.
 *
 * These arrive by accident rather than by intent. A pasted line break, a tab, an ESC left in a
 * string by something that read a terminal, a NUL where two values were joined with the wrong
 * byte: none of them is a request about what the document should be called, and none of them
 * can be honoured. No filesystem accepts one as part of a filename, a line-oriented list splits
 * on a break, and a control character in a row or a save dialog is not something a person can
 * read or correct. So they are removed and nothing is refused: the name that is left is the name
 * the person meant, and a name of nothing but them is still a document.
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

/**
 * What Windows refuses in a name, which is the baseline every other system is measured against.
 *
 * Windows is the most restrictive of the three this launcher ships to, so a name that satisfies
 * it opens everywhere the launcher runs, and a name that satisfies only POSIX or only macOS is
 * a file somebody cannot create on the machine beside them. The set is Microsoft's own: the
 * nine characters `< > : " / \ | ? *`, which include both separators.
 *
 * They are replaced rather than removed, and a run of them by one `-`. Removing `MP3/FLAC notes`
 * down to `MP3FLAC notes` invents a word nobody wrote, while a hyphen keeps the boundary the
 * person did write visible, and a rename the launcher performed should be legible as one. That
 * is also why a pasted path stops being a path: `../../etc/passwd` becomes `..-..-etc-passwd`,
 * a name in the folder the person is saving into rather than a walk out of it.
 */
const ILLEGAL_IN_NAME = /[<>:"/\\|?*]+/g;

/**
 * The device names Windows keeps for itself, whatever extension follows.
 *
 * `CON.lith` is not a file: it is the console with a suffix, which is why Windows refuses to
 * create it and why it cannot be the name of a document. The superscripts are the classic Win32
 * spellings of COM1 and friends, which Microsoft lists beside the plain ones.
 */
const RESERVED_STEM = /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/i;

/** What one path component may hold, before the extension is counted. */
const MAX_COMPONENT = 255;

/**
 * Take the endings off, the way Windows does.
 *
 * A trailing space or dot is dropped when Windows creates the file, so a name that keeps one is
 * a name a row shows and a disk never had. Leading dots are left alone: `.notes` is deliberate,
 * and legal on every one of these systems.
 */
function tidyEnds(value: string): string {
  // The trailing run is stripped as one, because a space after a dot (`notes. `) would otherwise
  // leave the dot behind and hand back `notes..lith`.
  return value.replace(/[.\s]+$/, '').replace(/^\s+/, '');
}

/** Cut to what a component may hold, without leaving half a character behind. */
function capLength(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit);
  // A cut between the two halves of a surrogate pair is not a character, and would reach the
  // filesystem as a replacement glyph rather than as the emoji somebody typed.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/**
 * A launcher-typed name, normalized to the document the build writes.
 *
 * Accidentals are taken out first (see above), then the characters Windows will not have, then
 * the extension of whatever was typed, so a name is never doubled up. What is left is made legal
 * in the three places Windows is stricter than the rest: the endings, the device names, and the
 * length. An empty result becomes `untitled` rather than a bare extension.
 */
export function normalizeDocumentName(name: string, format: DocumentFormat = DOCUMENT_FORMAT): string {
  const extension = documentExtension(format);
  const stem = tidyEnds(
    name
      .replace(CONTROL_CHARACTERS, '')
      .replace(ILLEGAL_IN_NAME, '-')
      .trim()
      .replace(/\.(?:html?|lith|json)$/i, '')
    // Tidied again because dropping the extension can expose a space or a dot: `notes .lith` is
    // a name whose accidental space sat between the stem and the extension.
  );
  // A device name is reserved in front of any extension, so escaping it moves the whole stem out
  // of the way rather than renaming its tail.
  const escaped = RESERVED_STEM.test(stem.split('.')[0]) ? `_${stem}` : stem;
  const capped = tidyEnds(capLength(escaped, MAX_COMPONENT - extension.length));
  return `${capped || 'untitled'}${extension}`;
}

/**
 * The name as the person typed it, wearing the extension this build writes.
 *
 * The counterpart of `normalizeDocumentName`, and deliberately the dumb one: it adds the
 * extension that is missing and trims the ends, and changes nothing else. Comparing the two
 * answers "did the launcher have to rename this?" without asking the rule to explain itself,
 * which is what lets a dialog show the answer before the document exists.
 *
 * It exists because every sanitiser merges: `a/b` and `a-b` both arrive as `a-b.lith`, and so do
 * `CON` and `_CON`. Merging is unavoidable once a name has to fit one system's rules, but it must
 * not be silent, or the person who typed the path learns about the rewrite only when a row shows
 * a name they do not remember choosing.
 */
export function typedDocumentName(name: string, format: DocumentFormat = DOCUMENT_FORMAT): string {
  const trimmed = name.trim();
  if (!trimmed) return '';
  return /\.(?:html?|lith|json)$/i.test(trimmed) ? trimmed : `${trimmed}${documentExtension(format)}`;
}

/**
 * The media type a produced document is labelled with.
 *
 * A blob and a download anchor both carry one, and it should agree with the extension: an
 * `.html` monolith labelled `application/x-lith` is a file the operating system will open in
 * the wrong thing.
 */
export function documentMimetype(format: DocumentFormat = DOCUMENT_FORMAT): string {
  return documentExtension(format) === '.html' ? 'text/html' : 'application/x-lith';
}

/**
 * A save picker's offered types.
 *
 * Under `lith` the picker offers the monolith beside a Jupyter notebook, which is what the
 * launcher has always done: a notebook is a document a mount can be, so the save dialog is
 * where the choice belongs. Under `html` the monolith is a page. Under `both` all three are
 * offered, monolith first, so the default stays the launcher's own format.
 */
export function documentPickerTypes(
  format: DocumentFormat = DOCUMENT_FORMAT
): Array<{ description: string; accept: Record<string, string[]> }> {
  const types: Array<{ description: string; accept: Record<string, string[]> }> = [];
  if (writesLith(format)) {
    types.push({ description: copy.fileTypes.monolith, accept: { 'application/x-lith': ['.lith'] } });
  }
  if (format === 'html' || format === 'both') {
    types.push({ description: copy.fileTypes.html, accept: { 'text/html': ['.html', '.htm'] } });
  }
  if (format !== 'html') {
    types.push({
      description: copy.fileTypes.notebookOne,
      accept: { 'application/x-ipynb+json': ['.ipynb'] }
    });
  }
  return types;
}

/**
 * Whether this page's file input is filtered by MIME type rather than by extension.
 *
 * Android is the platform this exists for, and the behaviour was read out of the WebView rather
 * than guessed: the file input's `accept` is turned into `EXTRA_MIME_TYPES` by mapping each
 * extension through the platform's MIME table (`getValidTypes` in wry's own
 * `RustWebChromeClient.kt`, and Chromium's equivalent), and an extension the table does not know
 * is *dropped*. `application/json`, `text/plain` and `text/html` are known and survive, so the
 * picker keeps them and greys out every `.lith` in the folder: this project's own document is
 * the one type a phone cannot be told about, because no phone ships a MIME type for it.
 *
 * (The wildcard that answers it is written in the code below rather than here: a star, a slash
 * and a star are the two characters that end a comment, so prose can only describe it.)
 *
 * Asked of the user agent because there is nothing else to ask. It is not this launcher's
 * platform (`platform-capabilities` is the answer to that question) but the *browser's* own
 * chooser, which is the platform's and is not reachable from a page.
 */
export function pickerFiltersByMimeType(
  userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
): boolean {
  return /Android/i.test(userAgent);
}

/**
 * The `accept` attribute for the classic file input.
 *
 * The extension list where the platform honours extensions, which is where it also gives the
 * user a useful filter; the any-type wildcard where it does not, because a filter that drops the
 * file the app exists to open is worse than no filter at all. Every other picker here offers
 * an "all files" rung beside the typed ones (the desktop dialog's own filter list), so a page
 * that reaches this rung is not a page that can pick something the launcher cannot read.
 */
export function inputAcceptTypes(filtersByMimeType = pickerFiltersByMimeType()): string {
  return filtersByMimeType
    ? '*/*'
    : '.lith,.html,.htm,.json,.md,.txt,.tid,.ipynb,text/plain,text/html';
}

/**
 * Whether a file name is a document this build advertises.
 *
 * This is the "advertise" half of the pin, and it is what a server listing is filtered
 * through. `.lith` is *readable* in every build, so a `lith` build listing only `.lith` is a
 * narrow advertisement rather than a restriction; an `html` build listing a `.lith` beside its
 * own monoliths would be advertising a format its users did not ask it to produce.
 */
export function advertisesDocument(name: string, format: DocumentFormat = DOCUMENT_FORMAT): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.lith')) return writesLith(format);
  return (lower.endsWith('.html') || lower.endsWith('.htm')) && (format === 'html' || format === 'both');
}

/**
 * The name an uploaded document lands under on a server.
 *
 * A name that is already a document this build writes is kept as typed; anything else takes
 * the build's extension, because uploads are how a Lith reaches a self-host instance and the
 * instance's listing (filtered by `advertisesDocument`) has to be able to find it again. A
 * `lith` build therefore renames a pushed `.html` rather than filing a document it does not
 * list, which is exactly what it did before this pin existed.
 */
export function serverDocumentName(name: string, format: DocumentFormat = DOCUMENT_FORMAT): string {
  const lower = name.toLowerCase();
  if (format === 'html') {
    return lower.endsWith('.html') || lower.endsWith('.htm') ? name : `${stemOf(name)}.html`;
  }
  if (lower.endsWith('.lith')) return name;
  if (format === 'both' && (lower.endsWith('.html') || lower.endsWith('.htm'))) return name;
  return `${stemOf(name)}.lith`;
}

function stemOf(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}
