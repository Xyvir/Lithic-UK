/**
 * How far apart two saved versions are, in the one unit the trail names.
 *
 * The history trail draws this between two rows: `4 minutes later`, `1.5 hours later`. A gap
 * is read rather than measured, so exactly one unit is named, the greatest one that fits, and
 * hours and days are rounded to the nearest half. Seconds and minutes stay whole because
 * nobody reads `1.35 minutes`, and a half step is enough for hours and days because they are
 * already coarse: `1.5 hours later` says more, to somebody scanning a list, than the same gap
 * spelled out in minutes.
 *
 * `null` means there is nothing to draw: two versions stamped in the same millisecond, or a
 * clock that ran backwards between them. Those rows are still joined by the chevron, which is
 * what says which of the two was written from the other.
 *
 * The answer is a number and a unit, not a sentence. Which word follows the number, and
 * whether it is a plural, belongs to the deck (`dialogs.history.later`); the decimal mark
 * belongs to the locale and is `gapCount`'s job, since every date the launcher draws already
 * follows `LOCALE_TAG`.
 */

/** The one unit a gap is stated in. Ordered by size, which is how one is chosen. */
export type GapUnit = 'seconds' | 'minutes' | 'hours' | 'days';

export interface VersionGap {
  unit: GapUnit;
  /** Whole for seconds and minutes, a half step for hours and days. */
  value: number;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The one unit that states this gap, rounded as far as that unit goes.
 *
 * The unit is chosen from the raw gap and the rounding is then checked against the unit above
 * it, so 59.5 minutes reads as `1 hour later` rather than `60 minutes later` and 23.9 hours as
 * `1 day later` rather than `24 hours later`. Rounding first and choosing the unit after would
 * name a unit the number no longer fits, and a trail of hand-kept versions lands on those
 * boundaries more often than a random sample would.
 */
export function versionGap(laterMs: number): VersionGap | null {
  if (!Number.isFinite(laterMs) || laterMs <= 0) return null;
  if (laterMs < MINUTE) return { unit: 'seconds', value: Math.max(1, Math.round(laterMs / SECOND)) };
  if (laterMs < HOUR) {
    const minutes = Math.round(laterMs / MINUTE);
    if (minutes < 60) return { unit: 'minutes', value: minutes };
  }
  if (laterMs < DAY) {
    const hours = Math.round((laterMs / HOUR) * 2) / 2;
    if (hours < 24) return { unit: 'hours', value: hours };
  }
  return { unit: 'days', value: Math.max(1, Math.round((laterMs / DAY) * 2) / 2) };
}

/**
 * The value as this locale writes a number: `1.5` in English, `1,5` in Spanish, French and
 * German. One fraction digit at most, which is all a half step ever produces.
 */
export function gapCount(gap: VersionGap, localeTag: string): string {
  return new Intl.NumberFormat(localeTag, { maximumFractionDigits: 1 }).format(gap.value);
}
