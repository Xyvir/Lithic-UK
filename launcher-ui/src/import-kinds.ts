/**
 * What the launcher calls the files it imports rather than edits.
 *
 * Names only: nothing here reads a file or writes one. The converter that turns the bytes into
 * tiddlers lives in the wiki, so the launcher's half is deciding what a file is, which window
 * property carries it, and what the Lith it becomes is called.
 */

/**
 * The kinds of associated file this app imports rather than edits.
 *
 * A PDF is rendered into pages, an EPUB is split into a chapter per spine document, a Word
 * document becomes its words with the pictures on a board, and an image is drawn on a board.
 * None is a document body, so each has to be told apart before anything reads it as text, and
 * the four share everything after that: a Lith is written beside the file, the bytes travel to
 * the engine, and the importer's own converter does the work there, so a double-click and a
 * drop produce the same tiddlers.
 *
 * `jpg` is the same format as `jpeg` under the extension most cameras write, and both are
 * registered, so both have to arrive here.
 */
export type ImportKind = 'pdf' | 'epub' | 'docx' | 'image';

export function importKindOf(path: string): ImportKind | null {
  if (/\.pdf$/i.test(path)) return 'pdf';
  if (/\.epub$/i.test(path)) return 'epub';
  if (/\.docx$/i.test(path)) return 'docx';
  if (/\.(png|jpe?g|bmp|webp)$/i.test(path)) return 'image';
  return null;
}

/**
 * The Lith a file becomes when it is imported, named the way its sibling would have been.
 *
 * `<stem>_<extension>.lith`, which is `lith_sibling_of` in `lib.rs` spelled here: the extension
 * stays in the name because the sibling of a PDF and the sibling of a picture are different
 * documents, so a folder holding `foobar.pdf` beside `foobar.png` must not hand the second file
 * the first file's board. The extension is carried through as the file writes it rather than
 * folded, and a name with no extension is named for itself rather than trailing an underscore.
 *
 * The one difference is that no folder is involved: on a phone there is no beside to put it in,
 * which is why this returns a name and not a path.
 */
export function importLithName(sourceName: string): string {
  const name = sourceName.trim() || 'document';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return `${name}.lith`;
  return `${name.slice(0, dot)}_${name.slice(dot + 1)}.lith`;
}

/**
 * The window property each converter is handed on, one per kind.
 *
 * A window property rather than a tiddler, because the payload is a whole file and the store is
 * not a place to carry one, and a separate key per kind because the engine reads one and never
 * the others: one gesture is one file, and a startup that had to sniff the bytes would be
 * guessing (see `pdf-open-request.js`, which takes each of these).
 */
export const IMPORT_REQUEST: Record<ImportKind, string> = {
  pdf: '__LITHIC_PDF_IMPORT__',
  epub: '__LITHIC_EPUB_IMPORT__',
  docx: '__LITHIC_DOCX_IMPORT__',
  image: '__LITHIC_IMAGE_IMPORT__'
};

/** The name each kind falls back to when a path carries none of its own. */
export const IMPORT_FALLBACK_NAME: Record<ImportKind, string> = {
  pdf: 'document.pdf',
  epub: 'book.epub',
  docx: 'document.docx',
  image: 'image.png'
};

/**
 * The container the import names after the file: its name without the extension.
 *
 * The importer derives its own titles from the file the same way (`paper.pdf` becomes a
 * container `paper` holding `paper-text` and `paper-whiteboard`, and `photo.png` becomes
 * `photo` holding `photo-whiteboard`), so this is that name and not a second rule. It travels
 * with the mount so the engine can open the board under it when that file is what a person
 * opened (see `openBoardFor`).
 */
export function importContainerTitle(path: string): string {
  const name = path.split(/[\\/]/).pop() || '';
  return name.replace(/\.(?:pdf|epub|docx|png|jpe?g|bmp|webp)$/i, '');
}
