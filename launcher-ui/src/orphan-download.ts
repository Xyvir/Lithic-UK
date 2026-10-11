/**
 * What an orphan row's download may claim.
 *
 * The distinction is the point of the feature: a green check has to mean the
 * copy is on this device, not that a download was started. Two of the three save
 * paths can prove it (Rust writes the bytes before its command resolves, and
 * the Chromium file picker resolves after `close()`) and the `<a download>`
 * fallback provably cannot, because the browser never reports whether a download
 * finished. So there are two successful states, and only one of them is allowed
 * to look like a green check.
 */

import { copy } from './copy.ts';

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
      return { ...copy.orphan.saving, tone: 'unverified' };
    case 'saved':
      return { ...copy.orphan.saved, tone: 'saved' };
    case 'unverified':
      return { ...copy.orphan.unverified, tone: 'unverified' };
    case 'failed':
      return { ...copy.orphan.failed, tone: 'unverified' };
    default:
      return null;
  }
}

/**
 * One line telling the user how far the saves got, and (when every row is
 * confirmed on disk) that pressing Proceed is safe.
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
    return saved === 1 ? copy.orphan.noteOneSaved : copy.orphan.noteOneUnconfirmed;
  }
  if (saved === total) return copy.orphan.noteAllSaved(total);
  if (done === total) {
    return copy.orphan.noteAllUnconfirmed(total, unverified);
  }
  return copy.orphan.notePartial(done, total);
}

/**
 * Whether a row's copy has left the browser, which is a different question from whether it landed
 * on disk.
 *
 * `saved` is proof and `unverified` is a claim the browser cannot check, and a gate counts both.
 * Waiting for proof would make Reset unreachable on the one platform the gate exists for: Safari
 * and Firefox have no `showSaveFilePicker`, so every download there reports `unverified` and the
 * green check would never arrive.
 */
export function downloadAttained(state: OrphanDownloadState | undefined): boolean {
  return state === 'saved' || state === 'unverified';
}

/** How far a destructive Reset's gate has got, and whether it is open. */
export interface BackupGate {
  open: boolean;
  attained: number;
  total: number;
  remaining: number;
}

/**
 * The gate on Reset: a download per row, or one full backup, and then the button unlocks.
 *
 * @param states one entry per row the gate watches, in list order.
 * @param fullBackupTaken whether the whole instance has already been written out, which is the
 * one download that covers every row at once and so opens the gate on its own.
 */
export function backupGate(states: readonly OrphanDownloadState[], fullBackupTaken: boolean): BackupGate {
  const total = states.length;
  const attained = states.filter(downloadAttained).length;
  return {
    open: fullBackupTaken || (total > 0 && attained === total),
    attained,
    total,
    remaining: total - attained
  };
}
