/**
 * This window's own beat, and the only thing that tells the other copies of Lithic on this
 * machine that it is here.
 *
 * The app is one program in a folder, and the newest release is a second copy of that program
 * somewhere else on the same machine. Update Install copies the newer file over the older one,
 * and the operating system will not let that happen while the older one is running: Windows
 * answers a sharing violation, Unix answers `ETXTBSY`. So an install has to know which windows
 * are holding it, and the only side that can say what a window is showing is the window.
 *
 * Hence the beat. The launcher tells the app where it is every couple of seconds, and the app
 * writes that down where the other copies read it (`instances` in `src-tauri/src`). Two states
 * matter and they are the whole of it:
 *
 *   * `launcher`: the window is showing this launcher, which is the one state an install may
 *     close. Nothing here is unsaved by design: the search box and the dialogs hold typed text
 *     and the offer holds a status line, and every one of them is a keystroke to restore.
 *   * `wiki`: a Lith has taken the document over. An install must never close this window, and
 *     it never does: it names the Lith that is being held instead, so the user closes it when
 *     they are ready rather than losing the page under their cursor.
 *
 * The beat has to survive the engine taking the document over, and it does: a mount replaces
 * the *document* with `document.open`/`write`/`close` and leaves the window, its globals and
 * its timers alone. That is why this is a page-side beat rather than something the app could
 * keep on its own, and it is also why a window showing somebody else's instance cannot beat at
 * all: the app refuses IPC from a document outside its own origin, so that window's record goes
 * stale within a few seconds and it is never asked to close.
 *
 * Nothing here decides what a close means. `onClose` is where the caller answers the request,
 * which is what keeps this module testable without an app behind it.
 */
import { tauriInvoke } from './file-bridge.ts';

/** Which of the two states a window can be in, as the app records it. */
export type StageKind = 'launcher' | 'wiki';

/** What one beat hears back. */
export interface StageAnswer {
  /** Whether an install has asked this window to close. */
  close?: boolean;
  /**
   * How long to wait before the next beat, worked out by the app.
   *
   * Served back rather than written here, because the two numbers are one decision: this beat
   * is how an install tells a window is still there, and how long the app believes a window's
   * word is the other half of it. A page that chose its own interval could drift below that and
   * make a window look gone while it was only slow.
   */
  beat_ms?: number;
}

/**
 * What the app says about the windows an install is walking into.
 *
 * Read before the copy, never after: `blocked` is a refusal to attempt an update the operating
 * system would fail anyway, and it is the sentence the user acts on rather than a sharing
 * violation they cannot.
 */
export interface InstallPreflight {
  /** How many other windows were asked to close. */
  asked: number;
  /** Whether the installed copy is still held, which is what makes the copy fail. */
  blocked: boolean;
  /** The Lith the window holding it has open, when a live one can say. */
  holder: string | null;
}

/** The cadence a beat falls back to when the app does not name one. */
export const FALLBACK_BEAT_MS = 2000;

/**
 * The floor under a cadence the app names, so a zero cannot turn the beat into a spin. Not a
 * cadence of its own: the app's own beat is an order of magnitude above this.
 */
export const MIN_BEAT_MS = 250;

/** How many beats may fail in a row before the beat gives up. */
export const MAX_FAILURES = 3;

export interface StageBeat {
  /** Say where this window is now, and go on saying it. */
  start(): Promise<void>;
  /** Where the window is now: a Lith has taken the document over, or the launcher is back. */
  stage(kind: StageKind, wiki?: string | null): void;
  /** Stop beating. The app times the entry out on its own, so nothing is left behind. */
  stop(): void;
}

/**
 * A beat, over one invocation per cadence.
 *
 * The timers are injectable so the whole lifecycle is testable without waiting on a real
 * interval, which is the same shape the presence-lock heartbeat uses.
 */
export function createStageBeat(options: {
  invoke?: (command: string, args: Record<string, unknown>) => Promise<StageAnswer>;
  /** What to do when the app says an install has asked this window to close. */
  onClose: () => void;
  kind?: StageKind;
  wiki?: string | null;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): StageBeat {
  const invoke = options.invoke ?? ((command, args) => tauriInvoke<StageAnswer>(command, args));
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let kind: StageKind = options.kind ?? 'launcher';
  let wiki: string | null = options.wiki ?? null;
  let timer: unknown = null;
  let running = false;
  let beating = false;
  let failures = 0;

  const schedule = (ms: number) => {
    if (!running) return;
    timer = setTimer(() => {
      timer = null;
      void beat();
    }, Math.max(MIN_BEAT_MS, ms));
  };

  const beat = async (): Promise<void> => {
    if (!running || beating) return;
    beating = true;
    try {
      let answer: StageAnswer | null = null;
      try {
        answer = await invoke('launcher_stage', { stage: kind, wiki });
        failures = 0;
      } catch {
        // A beat that did not arrive is not a reason to stop: the only way to mislead another
        // window is to go quiet, and a page that gave up after one failure would look like a
        // window that had gone. A few in a row is a different thing, and that is a launcher
        // with nothing behind it, which answers nothing however often it is asked.
        failures += 1;
        if (failures >= MAX_FAILURES) {
          running = false;
          return;
        }
      }
      if (!running) return;
      if (answer?.close) {
        // Answered once and no further: the window is on its way out, and a beat that repeated
        // the request would only be a second close for a window that is already closing.
        running = false;
        timer = null;
        options.onClose();
        return;
      }
      schedule(answer?.beat_ms ?? FALLBACK_BEAT_MS);
    } finally {
      beating = false;
    }
  };

  return {
    async start() {
      if (running) return;
      running = true;
      failures = 0;
      await beat();
    },
    stage(next, nextWiki = null) {
      if (kind === next && wiki === nextWiki) return;
      kind = next;
      wiki = nextWiki;
      // Said now rather than at the next cadence, because this is the transition that matters:
      // a window that has just handed its document to a Lith must stop looking like an idle
      // launcher immediately, or an install pressed in the same second would close the Lith its
      // user just opened. Only when no beat is in flight, which the `beating` guard makes safe
      // to bet on.
      if (running && timer !== null) {
        clearTimer(timer);
        timer = null;
        void beat();
      }
    },
    stop() {
      running = false;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
    }
  };
}
