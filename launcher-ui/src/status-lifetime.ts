/**
 * How long the header's status line lives.
 *
 * THE PROBLEM THIS ANSWERS. The line holds the last thing the launcher said, and a later
 * sentence replaces an earlier one, which is right for a control's own answer: the click that
 * asked is the next thing to happen. What is not right is that nothing ends a sentence. Some
 * writers retire their own line after a moment (`reportAndRetire` in App.svelte, used by the
 * passes that run behind a dialog and by the install confirmation), but a great many set it to
 * something final and move on: a mount that succeeded, a file that had no path, an error that
 * was already explained. Those lines stood for the rest of the session, and the animated dots
 * beside them, which mean work in progress, went on waving after the work had finished. So the
 * launcher looks busy, and the line the user is waiting to see replaced never is.
 *
 * THE ANSWER. One deadline per line, so a sentence nobody retires still leaves on its own. This
 * is deliberately a catch-all rather than a fix per writer: every writer that forgets is a new
 * bug, and there are dozens of them, whereas one deadline is one place to be right.
 *
 * ONE MOMENT, not two. This file first had a settle at 15s and a clear at 45s, so the movement
 * stopped while the sentence stayed, and the argument for the pair was that a reader gets the
 * information for longer than a claim of activity could stay true. Run against the real
 * launcher the second stage read as a line that had half finished going away, so the developer
 * asked for it to disappear at the settle moment instead: a line is either saying something or
 * it is gone. What the movement still owes is kept. An ordinary line is cleared at the deadline,
 * so its dots never outlive it, and a line that has to stand (see below) has its dots stopped at
 * the same deadline, so a standing sentence never keeps claiming that work is happening.
 *
 * TWO CLASSES OF LINE, and the writer says which one it is rather than the text. An ordinary
 * status reports what the launcher just did, so it goes at the deadline. A line that names
 * something the person has to act on (an open that failed, a file with no path recorded, a
 * cached copy that is not there to download) is reported through `reportHeld` in App.svelte, and
 * that one keeps the deadline's other half alone: the movement stops there and the sentence then
 * stands until the next thing replaces it, exactly as the error lines beside it (`mountError`,
 * `remoteError`) have always done. The exemption is asked for at the writer, one site at a time,
 * so a new status is transient by default and cannot become a permanent line by accident.
 *
 * THE COST OF THE CATCH-ALL, named because it is real. The clear is a clock rather than a
 * judgement, so it also ends a sentence that reported a success and would have been worth
 * another read. That is the trade taken on purpose: one deadline is one place to be right, where
 * every writer that forgets is a new bug. `reportAndRetire` remains the way for a writer whose
 * sentence should go on its own schedule instead.
 *
 * THE THRESHOLD IS THE CONTRACT, which is why it is exported and asserted in the test beside
 * this file: a status is transient by definition, so it must not stand beyond a minute, and it
 * must not vanish before a reader can take it in. It is measured from the moment the line was
 * written.
 *
 * The rule itself is stated in `agents.md` under "Launcher Status Line: Every Line Has a
 * Deadline", and the rounds that measured it are in `docs/rounds/2026-10.md`. Read one of those
 * before changing a number here: the tested floor and ceiling are the argument, not a taste.
 */
export const STATUS_LIFETIME_MS = 15_000;

/**
 * The two timer calls this needs, named so a test can drive them instead of waiting.
 *
 * The browser's `setTimeout` returns a number, so the pair is typed that way rather than as
 * Node's `Timeout`; nothing here runs under Node at launch time.
 */
export interface StatusTimers {
  after(fn: () => void, ms: number): number;
  cancel(id: number): void;
}

export const systemTimers: StatusTimers = {
  after: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  cancel: (id) => clearTimeout(id)
};

/**
 * Arm the one deadline an ordinary line has, and return the function that cancels it.
 *
 * Cancelling is the caller's job and it is not optional: a newer line replaces an older one, and
 * the older line's deadline must not outlive it, or a stale clear would take away the newer
 * sentence that replaced it. The caller guards its own clear for the same reason, because a
 * deadline can fire in the instant between a new line arriving and this being called.
 */
export function armStatusClear(on: { clear(): void }, timers: StatusTimers = systemTimers): () => void {
  const clearId = timers.after(on.clear, STATUS_LIFETIME_MS);
  return () => timers.cancel(clearId);
}

/**
 * Arm the one deadline a held line has, and no other.
 *
 * A held line is one that names something the person has to act on, so the sentence stays where
 * it can be read until the next thing replaces it. What it does not keep is the claim that work
 * is happening: the movement stops at the same moment it stops for any other line. That is what
 * makes the exemption safe rather than a hole in the rule, and it is why a held line is not the
 * same thing as no deadline at all: an unending pulse reading "work in progress" is the bug this
 * file exists to prevent, and a standing sentence is not that.
 */
export function armStatusHold(on: { settle(): void }, timers: StatusTimers = systemTimers): () => void {
  const settleId = timers.after(on.settle, STATUS_LIFETIME_MS);
  return () => timers.cancel(settleId);
}
