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
 * A launcher-typed name, normalized to the document the build writes.
 *
 * The extension of whatever was typed is dropped first, so a name is never doubled up, and an
 * empty result becomes `untitled` rather than a bare extension.
 */
export function normalizeDocumentName(name: string, format: DocumentFormat = DOCUMENT_FORMAT): string {
  const base = name.replace(/\.(?:html?|lith|json)$/i, '');
  const stem = base || 'untitled';
  return `${stem}.${documentExtension(format).slice(1)}`;
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
