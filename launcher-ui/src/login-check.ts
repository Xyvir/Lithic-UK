/**
 * Asking an instance whether a login works — either one already saved, or one that
 * has only been typed into a dialog.
 *
 * Kept out of the launcher component because the second case is a small state
 * machine rather than a click: the question has to wait for the typing to stop, the
 * answer has to be thrown away if the typing resumes, and nothing may be shown for
 * text the answer was not about. That part is worth pinning down in tests; a
 * component can only draw what this reports.
 *
 * It is also what replaced the "repeat the password" box on those dialogs. Two
 * identical typos agree with each other and are accepted by the field that exists to
 * catch them; the instance is the only thing that can say a password is wrong.
 */

import { tauriInvoke } from './file-bridge.ts';

/**
 * What a check of a login concluded.
 *
 * The names are the ones Rust sends, so the class on a row and the outcome the app
 * decided are the same word — including "no longer asks for a password", which is a
 * verdict of its own rather than a kind of success.
 */
export type LoginCheckState = 'busy' | 'accepted' | 'refused' | 'not-required' | 'unclear' | 'unreachable';

/** Short enough for a row, keeping the distinctions Rust made. */
export const LOGIN_CHECK_LABELS: Record<LoginCheckState, string> = {
  busy: 'Checking…',
  accepted: 'Signs in',
  refused: 'Refused',
  'not-required': 'Not asked',
  unclear: 'Unclear',
  unreachable: 'No answer'
};

/** A verdict, and the sentence that says why, for somewhere with room for it. */
export type LoginVerdict = { state: LoginCheckState; detail: string };

/**
 * What Rust said, as a state the launcher can class.
 *
 * A word this build has never heard of is `unclear` rather than a kind of success:
 * an outcome nobody can name is exactly the case that must not read as "fine".
 */
export function loginVerdict(outcome: string, detail: string): LoginVerdict {
  const state = (outcome in LOGIN_CHECK_LABELS ? outcome : 'unclear') as LoginCheckState;
  return { state, detail };
}

/**
 * A command that refused is an answer too: nothing was sent, so nothing was proved
 * either way — and least of all that the password is wrong.
 */
export function loginVerdictFromError(error: unknown): LoginVerdict {
  return { state: 'unreachable', detail: error instanceof Error ? error.message : String(error) };
}

/** The shape of the invoke lookup, so a test can stand in for it. */
export type LoginCheckInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** The question itself, separable for the same reason. */
export type LoginCheckAsk = (origin: string, user: string, password: string) => Promise<LoginVerdict>;

/**
 * Ask an instance whether a login would be accepted.
 *
 * The one place the launcher sends a password that is saved nowhere — to the
 * instance's own origin, which is where it is about to be sent anyway, and only
 * because the form it was typed into exists to sign in to that instance.
 */
export async function askInstanceAboutLogin(
  origin: string,
  user: string,
  password: string,
  invoke: LoginCheckInvoke = tauriInvoke
): Promise<LoginVerdict> {
  try {
    const check = (await invoke('check_login_for_instance', { origin, user, password })) as {
      outcome: string;
      detail: string;
    };
    return loginVerdict(check.outcome, check.detail);
  } catch (error) {
    return loginVerdictFromError(error);
  }
}

/**
 * How long the boxes hold still before a typed login is put to the instance. Long
 * enough that a password is not sent per keystroke, short enough that the answer is
 * there before the Save button is reached.
 */
export const LOGIN_CHECK_SETTLE_MS = 600;

/**
 * A debounced question about one dialog's fields, which throws its own answers away.
 *
 * It asks as soon as the three boxes hold something and the typing has stopped. A
 * login that is missing any of its three parts is not one the instance could answer
 * about, so a half-typed address never reaches the network and a password on its own
 * is never sent.
 *
 * What the settle does *not* cover is a pause in the middle of a password: that is
 * asked about like any other, and refused like any other, until the typing resumes
 * and clears it. Sending less would mean asking only when the password box is left,
 * which is the same design with one more input to wire and one more way for the
 * verdict to be about text nobody can see any more.
 *
 * Nothing it reports outlives a change to the boxes — `report(null)` runs on every
 * call — so a verdict on screen always describes the text in them right now. An
 * answer that arrives for text somebody has since edited is dropped (`issued`),
 * which is the case that would otherwise leave a sentence about a password nobody
 * has typed any more.
 */
export function typedLoginCheck(
  report: (verdict: LoginVerdict | null) => void,
  settleMs: number = LOGIN_CHECK_SETTLE_MS,
  ask: LoginCheckAsk = askInstanceAboutLogin
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let issued = 0;
  return function askAboutFields(origin: string, user: string, password: string): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    issued += 1;
    report(null);
    if (!origin || !user || !password) return;
    const seq = issued;
    timer = setTimeout(() => {
      timer = null;
      report({ state: 'busy', detail: LOGIN_CHECK_LABELS.busy });
      void ask(origin, user, password).then((verdict) => {
        if (seq === issued) report(verdict);
      });
    }, settleMs);
  };
}
