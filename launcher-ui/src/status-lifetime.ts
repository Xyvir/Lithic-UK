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
 * THE ANSWER. A deadline per line, so a sentence nobody retires still leaves on its own. This is
 * deliberately a catch-all rather than a fix per writer: every writer that forgets is a new bug,
 * and there are dozens of them, whereas one deadline is one place to be right.
 *
 * TWO MOMENTS, because the halves fail differently. The dots are a claim that something is
 * happening; past the settle time that claim is false whether or not the sentence is still true,
 * so the movement stops first and the sentence stays, where a user can still read it. The
 * sentence is information, so it is given longer before it goes.
 *
 * THE COST, named because it is real. A line that used to stand until the next action now goes
 * on a clock, including the ones worth reading twice: an error naming a file the user needs to
 * act on disappears after the clear time. That is the trade taken on purpose here. A message
 * that matters should be carried by something durable (the row's own pill, a dialog), not by a
 * transient line, and `reportAndRetire` remains the way for a writer that knows its sentence is
 * worth keeping to hold it longer.
 *
 * THE THRESHOLDS ARE THE CONTRACT, which is why they are exported and asserted in the test
 * beside this file: a status is transient by definition, and a minute is the outside of that.
 * Both are measured from the moment the line was written, not from when its animation stopped.
 *
 * The rule itself is stated in `agents.md` under "Launcher Status Line: Every Line Has a
 * Deadline", and the round that measured it is in `docs/rounds/2026-10.md`. Read one of those
 * before changing a number here: the tested floor and ceiling are the argument, not a taste.
 */
export const STATUS_SETTLE_MS = 15_000;
export const STATUS_CLEAR_MS = 45_000;

/** Where a line stands, from its age alone. */
export type StatusPhase = 'fresh' | 'settled' | 'expired';

/** Which phase a line of the given age is in. The boundaries belong to the later phase. */
export function statusPhase(ageMs: number): StatusPhase {
  if (ageMs >= STATUS_CLEAR_MS) return 'expired';
  if (ageMs >= STATUS_SETTLE_MS) return 'settled';
  return 'fresh';
}

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

/** What to do when each deadline arrives. */
export interface StatusDeadlines {
  /** The line is still there, but it is no longer claiming to be busy. */
  settle(): void;
  /** The line goes away. */
  clear(): void;
}

/**
 * Arm both deadlines for one line, and return the function that cancels them.
 *
 * Cancelling is the caller's job and it is not optional: a newer line replaces an older one, and
 * the older line's deadlines must not outlive it, or a stale clear would take away the newer
 * sentence that replaced it. The caller guards its own clear for the same reason, because a
 * deadline can fire in the instant between a new line arriving and this being called.
 */
export function armStatusDeadlines(on: StatusDeadlines, timers: StatusTimers = systemTimers): () => void {
  const settleId = timers.after(on.settle, STATUS_SETTLE_MS);
  const clearId = timers.after(on.clear, STATUS_CLEAR_MS);
  return () => {
    timers.cancel(settleId);
    timers.cancel(clearId);
  };
}
