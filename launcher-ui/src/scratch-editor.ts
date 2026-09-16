/**
 * Scratch editor support: the Tauri app (and local webapp) opens everyday
 * text files — .md / .txt / .tid / .json — as scratch wiki streams, turning
 * Lithic into a fancy text editor where the file stays in place on disk.
 *
 * Mount:  flat file -> scratchTiddlers -> streams node tiddlers (markdown)
 * Save:   $tw.wiki -> serializeScratchWiki -> original flat text -> original path
 *
 * Round-trip guarantees come from scratch-wiki.ts (byte-identical saves for
 * untouched files; edits re-serialize with tabs/gaps/newlines replayed).
 */

import { parseLithToJSON } from './lithic-format.ts';
import { parseScratchText, scratchTiddlers, parseTidFile } from './scratch-wiki.ts';

export type ScratchKind = 'text' | 'tid' | 'json';

export type ScratchPlan = {
  kind: ScratchKind;
  /** Base title for the document root / node tiddlers. */
  base: string;
};

/** File extensions that open as editable scratch wikis (fancy text editor). */
export const SCRATCH_EXTENSIONS = ['md', 'txt', 'tid', 'json'] as const;

/** True when this file name opens as an in-place scratch editor document. */
export function isScratchFileName(name: string): boolean {
  return resolveScratchKind(name) !== null;
}

/** Resolve the scratch kind for a file name; null when not editable as scratch. */
export function resolveScratchKind(name: string): ScratchKind | null {
  const ext = name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  if (ext === 'md' || ext === 'txt' || ext === 'markdown') return 'text';
  if (ext === 'tid') return 'tid';
  if (ext === 'json') return 'json';
  return null;
}

/**
 * Resolve the ScratchPlan for a handoff. Plain text payloads parse as
 * markdown-style scratch (the .md default — Lithic's streams are the
 * authoring format, so round-trips keep the source intact).
 */
export function resolveScratchPlan(name: string, base?: string): ScratchPlan | null {
  const kind = resolveScratchKind(name);
  if (!kind) return null;
  const stem = name.replace(/\.[^.]+$/, '').trim();
  return { kind, base: (base ?? stem).trim() || 'Scratch' };
}

/**
 * Parse flat scratch source into streams wiki payload tiddlers (the shape
 * pending-imports injects into the engine store). `.tid` files embed their
 * parsed header fields on the root tiddler; `.json` placeholders keep the
 * body verbatim in the root tiddler and re-serialize as-is on save.
 */
export function parseScratchSource(source: string, plan: ScratchPlan): Array<Record<string, string>> {
  if (plan.kind === 'json') {
    // JSON files are a placeholder: the body round-trips verbatim.
    return [{ title: plan.base, type: 'text/plain', 'lithic-json': 'yes', text: source }];
  }
  if (plan.kind === 'tid') {
    const tid = parseTidFile(source);
    const fields = Object.fromEntries(tid.fields.filter(([key]) => key !== 'title' && key !== 'text'));
    return [{ title: plan.base, type: 'text/markdown', 'lithic-tid': 'yes', ...fields, text: tid.text }];
  }
  const parsed = parseScratchText(source);
  const { root, nodes } = scratchTiddlers(plan.base, parsed);
  root['lithic-scratch'] = 'yes';
  return [root, ...nodes];
}

/**
 * Parse a handoff through scratch or lith, whichever the file name demands.
 * Returns the tiddlers to inject (empty for a blank lith).
 */
export function parseHandoffTiddlers(name: string, text: string, base?: string): Array<Record<string, string>> {
  if (text && isScratchFileName(name)) {
    const plan = resolveScratchPlan(name, base);
    if (plan) return parseScratchSource(text, plan);
  }
  // A lone bare-text payload (no ⁂ delimiters, no title field) also mounts
  // as scratch when the launcher asks for it by passing a scratch base.
  if (!isScratchFileName(name) && base) {
    const plan: ScratchPlan = { kind: 'text', base };
    return parseScratchSource(text, plan);
  }
  return text ? parseLithToJSON(text) : [];
}

export { parseTidFile, parseScratchText, scratchTiddlers };
