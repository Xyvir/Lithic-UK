/**
 * Unsaved edits, as the app is told about them before it closes a window.
 *
 * Pressing the window's × destroys the webview without running the page's unload path, so
 * the prompt that guards a return to the launcher (TiddlyWiki's own `beforeunload` task)
 * never appears and a Lith's edits go with the window. The app cannot ask by itself: only
 * the document knows what its saver filter still counts as an edit. So the page says, and
 * the app asks on the strength of the answer.
 *
 * The direction matters and it is the reason this is small. The page *reports* rather than
 * answering a question at close time, so nothing has to be timed against the event loop,
 * and every failure of the channel costs a question rather than a close: the app's own
 * default is "nothing unsaved", which is the behaviour it had before this existed.
 *
 * The *question* is the browser's own all the same, and the app does not draw it: a close
 * that would drop an edit is handed back to the page, which navigates, which is the one
 * thing that runs TiddlyWiki's unload task and raises the same prompt a return to the
 * launcher already goes through. That navigation is also the answer, and the marker below
 * is how the page that boots afterwards knows the prompt was answered rather than refused.
 *
 * Three documents never report anything, each for its own reason: the launcher (nothing on
 * it is unsaved; see launcher-stage.ts), a monolith (a page keeps its own edits, and the
 * launcher deliberately does not interpose on them), and any page opened without the app
 * behind it. The mounted engine is the fourth, and it is the one that matters.
 */
import { tauriInvoke } from './file-bridge.ts';

/**
 * The command the page reports to.
 *
 * Named once and interpolated into the injected guard rather than written twice, so the two
 * halves of one answer cannot drift apart: a guard reporting to a name the app does not
 * listen on would be silent in exactly the case it exists for.
 */
export const CLOSE_GUARD_REPORT = 'close_guard_report';

/**
 * Where a close interrupted by that prompt is written down, so the page that boots in place of
 * the one it interrupted can finish it.
 *
 * `sessionStorage` because it is the only thing that survives the navigation: a window
 * property dies with the document, and the launcher that replaces it has to read this.
 */
export const CLOSE_PENDING_KEY = 'lithic-close-pending';

/**
 * How long the document that raised the prompt waits before deciding nobody answered it.
 *
 * The timer it arms is meaningless in the navigation case, where this document is gone before
 * it can fire, and is exactly the answer in the other one: a timer that runs at all proves the
 * page is still here, which is what "Stay" means. Long enough not to be raced by the prompt,
 * short enough that a person who chose to stay is not still carrying a pending close when they
 * close the window by hand a second later.
 */
export const CLOSE_PENDING_SETTLE_MS = 250;

/**
 * How old a marker may be and still be a close worth finishing.
 *
 * The marker is cleared by the document that raised it whenever that document survives, so a
 * stale one means the app died with the prompt on screen. Honouring that minutes later would
 * close a window somebody had gone back to using, so it is only believed while it could still
 * be the same press.
 */
export const CLOSE_PENDING_MS = 60_000;

/** What a document is, as far as this question is concerned. */
type SaverHost = { $tw?: { saverHandler?: { isDirty?: () => boolean } } };

/**
 * Whether the document on screen holds edits no save has written yet.
 *
 * TiddlyWiki's own answer (`saverHandler.isDirty()`, the count of changes the saver filter
 * still counts), which is the same predicate that arms its unload task and pulses the save
 * indicator. Read rather than re-derived: a second definition of what an edit is would be a
 * second thing to keep in step, and the first one to disagree would be the one deciding
 * whether an edit is asked about at all.
 *
 * A document with no wiki behind it answers false, which is what a monolith should answer:
 * it may well hold edits, and they are its own to keep, which is the same reason the
 * launcher records no unsaved-edit recovery for one.
 */
export function unsavedEditsNow(root: SaverHost = globalThis as SaverHost): boolean {
  const handler = root.$tw?.saverHandler;
  return typeof handler?.isDirty === 'function' && handler.isDirty() === true;
}

/**
 * Tell the app whether the document on screen has unsaved edits.
 *
 * Best effort, and deliberately not awaited: outside the desktop app there is no guard to
 * tell, an older build has no command to answer, and neither is a reason for a caller to
 * wait. A report that does not arrive costs a needless question at the next close, never a
 * close that should have been questioned.
 */
export function reportUnsavedEdits(
  dirty: boolean,
  invoke: (command: string, args: Record<string, unknown>) => Promise<unknown> = tauriInvoke
): Promise<void> {
  return invoke(CLOSE_GUARD_REPORT, { dirty })
    .then(() => undefined)
    .catch(() => {
      /* no app behind this page: the browser's own unload guard is the one in force */
    });
}

/** The one method of the Web Storage API that matters here. */
export type PendingStore = Pick<Storage, 'getItem' | 'removeItem'>;

/**
 * Whether the page that just booted is the answer to a close somebody already confirmed, in
 * which case that close is this page's to finish.
 *
 * Reads and clears in one step, because the marker is one press and one answer: a launcher that
 * booted, read it and did nothing (a failure on the way to quitting, say) must not quit the next
 * time it is looked at.
 */
export function takePendingClose(store: PendingStore, now: number = Date.now()): boolean {
  try {
    const raw = store.getItem(CLOSE_PENDING_KEY);
    if (raw === null) return false;
    store.removeItem(CLOSE_PENDING_KEY);
    const stamp = Number(raw);
    return Number.isFinite(stamp) && now - stamp <= CLOSE_PENDING_MS;
  } catch {
    // Storage that refuses to answer is not a reason to close somebody's window.
    return false;
  }
}
