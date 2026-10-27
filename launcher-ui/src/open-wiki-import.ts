/**
 * The Lith that has taken this window over, and the one way to put something in it.
 *
 * A mount and the wiki it boots are one window. The engine replaces the *document*
 * (`document.open`/`write`/`close` in `legacy-launcher-runtime.ts`) and leaves the window, its
 * globals and its timers alone, and that is the whole reason this is possible at all: the
 * launcher's own code is still running while a Lith is on screen, and the Lith's `$tw` is on the
 * same window that code can reach. This module reads exactly that, so a share that arrives while
 * a Lith is open lands in the Lith instead of in a panel that is behind it.
 *
 * The payload still comes from the launcher (`sharedPayload`), which is the point: what a share
 * becomes does not depend on whether a Lith happened to be open. Only the destination does.
 *
 * `tm-import-tiddlers` is the message TiddlyWiki's own import sends: the drop zone and the browse
 * widget both dispatch it with the tiddler fields as JSON in `param`
 * (`$:/core/modules/widgets/dropzone.js`), core's navigator builds `$:/Import` from them and
 * opens it in the story river, and the person presses Import. So a share arrives in an open Lith
 * with the listing, the preview and the same-title handling that a dropped file gets. Nothing
 * here re-implements any of that, and nothing here writes tiddlers: it asks for the import and
 * lets the wiki draw it.
 *
 * **Why the message is handed to a widget rather than sent from here.** A TiddlyWiki message
 * travels from the widget that dispatches it *upwards*, to its ancestors (`dispatchEvent` in
 * `$:/core/modules/widgets/widget.js` walks `parentWidget`), which is why core's own senders are
 * all inside the page: the drop zone is a descendant of the navigator, so its message reaches it.
 * `$tw.rootWidget` is the tree's *root*, added as every page's parent precisely so that handlers
 * can be attached to it, and it carries the handlers the startup modules register on it
 * (`tm-notify`, `tm-modal`, `tm-save-wiki`...). It does not carry `tm-import-tiddlers`, and
 * dispatching that on it does nothing at all: nothing above the root would handle it. So the
 * importer is *found*, by the handler it answers the message with, and the message is dispatched
 * on the widget that has it. Verified against the built engine: the same call renders TiddlyWiki's
 * own import view in the story river with all four shared nodes listed, and pressing Import lands
 * them with their tags and text.
 */

/**
 * The fields of one payload tiddler, as the launcher's serializers produce them.
 *
 * Imported rather than restated so this module cannot drift from the payload it is handed.
 */
import type { PendingTiddler } from './pending-imports.ts';

/**
 * How the page's importer is recognised.
 *
 * The method core's navigator answers `tm-import-tiddlers` with, which is the capability being
 * asked for rather than a position in the tree: a Lithic patch may wrap the page template, and a
 * future one may put the navigator somewhere else, and this still finds it.
 */
const IMPORTER_HANDLER = 'handleImportTiddlersEvent';

/**
 * How deep the search will go before it gives up.
 *
 * The importer is within a couple of levels of the root in every page TiddlyWiki renders, so this
 * is a backstop against a tree that is not a tree, not a limit anything reaches.
 */
const MAX_DEPTH = 32;

/** A widget, as much of one as this needs. */
interface Widget {
  children?: Widget[];
  handleImportTiddlersEvent?: unknown;
  dispatchEvent?: (event: Record<string, unknown>) => unknown;
}

/** The page's own importer, at any depth below `widget`, or null when there is none. */
function findImporter(widget: unknown, depth = 0): Widget | null {
  if (!widget || typeof widget !== 'object' || depth > MAX_DEPTH) return null;
  const node = widget as Widget;
  if (typeof node.handleImportTiddlersEvent === 'function') return node;
  for (const child of node.children ?? []) {
    const found = findImporter(child, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Hand a payload to the Lith showing in this window, and answer whether it took it.
 *
 * False means there is no Lith to hand it to: the launcher's own page, a window between the mount
 * and the wiki's own boot, or a mount that failed and left no `$tw` behind. The caller then puts
 * the payload where it has always gone, the pending imports panel, which a window showing only the
 * launcher is exactly the surface able to display.
 *
 * A payload of nothing is not an import: core would build a listing of no tiddlers and open it,
 * which is a page about nothing rather than a note.
 *
 * `tw` is the wiki's own global, passed in rather than looked up here so both halves of the
 * decision (is there a Lith, and does it take the payload) are testable without a browser.
 */
export function importIntoOpenWiki(tiddlers: PendingTiddler[], tw: unknown): boolean {
  if (tiddlers.length === 0) return false;
  const rootWidget = (tw as { rootWidget?: unknown } | null | undefined)?.rootWidget;
  const importer = findImporter(rootWidget);
  if (!importer || typeof importer.dispatchEvent !== 'function') return false;
  try {
    importer.dispatchEvent.call(importer, { type: 'tm-import-tiddlers', param: JSON.stringify(tiddlers) });
  } catch {
    // A wiki that refuses the message keeps the payload rather than losing it: the caller queues
    // it, so the note is still somewhere the person can find it. Nothing is dispatched twice,
    // because a throw means core never built the import.
    return false;
  }
  return true;
}
