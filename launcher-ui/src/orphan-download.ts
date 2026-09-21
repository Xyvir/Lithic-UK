/**
 * What an orphan row's download may claim.
 *
 * The distinction is the point of the feature: a green check has to mean the
 * copy is on this device, not that a download was started. Two of the three save
 * paths can prove it — Rust writes the bytes before its command resolves, and
 * the Chromium file picker resolves after `close()` — and the `<a download>`
 * fallback provably cannot, because the browser never reports whether a download
 * finished. So there are two successful states, and only one of them is allowed
 * to look like a green check.
 */

export type OrphanDownloadState = 'idle' | 'saving' | 'saved' | 'unverified' | 'failed';

export interface OrphanPill {
  label: string;
  /** `saved` is the only tone that claims the file is on this device. */
  tone: 'saved' | 'unverified';
  title: string;
}

/** The pill for a row's state, or null when the row has nothing to report. */
export function orphanPill(state: OrphanDownloadState): OrphanPill | null {
  switch (state) {
    case 'saving':
      return { label: 'saving…', tone: 'unverified', title: 'Saving a copy now.' };
    case 'saved':
      return {
        label: '✓ saved',
        tone: 'saved',
        title: 'The copy is on this device.'
      };
    case 'unverified':
      return {
        label: '✓ check downloads',
        tone: 'unverified',
        title: 'The browser cannot confirm downloads. Check your Downloads folder.'
      };
    case 'failed':
      return {
        label: 'failed',
        tone: 'unverified',
        title: 'This copy could not be saved.'
      };
    default:
      return null;
  }
}

/**
 * One line telling the user how far the saves got, and — when every row is
 * confirmed on disk — that pressing Proceed is safe.
 *
 * @param states one entry per orphan row, in list order.
 */
export function orphanDownloadNote(states: readonly OrphanDownloadState[]): string {
  const total = states.length;
  const saved = states.filter((state) => state === 'saved').length;
  const unverified = states.filter((state) => state === 'unverified').length;
  const done = saved + unverified;
  if (total === 0 || done === 0) return '';

  if (total === 1) {
    return saved === 1 ? 'Saved. Safe to proceed.' : 'Saved, but unconfirmed.';
  }
  if (saved === total) return `All ${total} saved. Safe to proceed.`;
  if (done === total) {
    return `All ${total} saved, but ${unverified} unconfirmed.`;
  }
  return `${done} of ${total} saved.`;
}
