/**
 * Every colour the launcher draws, in one place.
 *
 * The stylesheet used to carry its colours as literals: 271 hex values and 25 `rgb()`
 * washes, most of them written out more than once and none of them named. This module
 * is where they are declared now, in the same move the copy pass made for strings (see
 * `copy.ts`): one source of truth, generated into the sheet rather than restated in it.
 *
 * HOW A COLOUR REACHES THE PAGE. For the sheet, nothing here runs: `paletteCss()` renders
 * the `:root` block that `styles.css` carries between its `lithic-palette` markers, and
 * every rule refers to the properties by name. The block is generated, so the sheet holds
 * no value of its own and there is exactly one copy of each. One exception reads this
 * module at runtime, the canvas that paints an instance icon, because a canvas takes a
 * colour string rather than a custom property. Run
 *
 *   node scripts/write-launcher-palette.mjs
 *
 * after editing this file; `color-palette.test.ts` fails when the two drift apart, on a
 * colour literal anywhere in `launcher-ui/src`, on a variable the sheet reads and the
 * block does not define, and on two tokens holding the same colour.
 *
 * ONE RAMP PER JOB. The first pass over this file was a faithful naming of what the sheet
 * held, and what it held was 93 hex tones picked by eye at different times: twelve
 * secondary text greys between `#a0a0a0` and `#bcbcbc`, two ambers six units apart doing
 * the same job, five pale ambers all meaning "amber ink on an amber banner". This pass is
 * the consolidation, and its rule is the name of the section: a job gets one tone, and a
 * new tone has to be a job the palette does not already have. Where several tones did one
 * job, the winner is the member the sheet already used most, and it keeps the role name,
 * so `ink.muted` is the secondary text tone and not one of the eleven it absorbed.
 *
 * Nothing here is a redesign. Every survivor is one of the tones the sheet already drew,
 * the hues are untouched, and no shift is larger than 57/255 (a fifth of a channel step),
 * with three above 40 and the rest below 31:
 *
 *   `ok.base` takes the tick's `#4caf50`, so a green check is drawn in the launcher's own
 *   green rather than a second one (57). It is the one merge plainly visible on screen.
 *   `ok.rim` takes the badge border's `#5a9a78` (41), and `danger.soft` the salmon hover
 *   `#ff9d88` (39). Both are a border and a hover that had drifted from their own family.
 *
 * TWO FAMILIES STAY DISTINCT, AND ONE THING IS OUT OF SCOPE. `accent` and `sync` keep
 * their own hues because they mean different things (this is the thing, this is in
 * flight), and `danger.status` keeps a red of its own beside `danger.base` because prose
 * that reports a failure is not the same job as a control that removes something. The
 * shell's `theme-color` in `launcher-ui/index.html` is NOT part of this palette: the file
 * is not touched by a palette change, the guard does not read it, and a colour there is
 * a decision about browser chrome rather than about the launcher's own drawing.
 *
 * NAMING. Families are the sheet's vocabulary: `surface` for a panel or a field, `line`
 * for a border, outline, stroke or scrollbar thumb, `ink` for text and the tinted greys
 * the chrome writes in, and `accent`, `amber`, `ok`, `danger`, `sync` for the colours that
 * carry meaning. A tone named `base` is the family's own colour and loses the word, so
 * `accent.base` is `--lithic-accent`.
 *
 * A WASH IS DERIVED, NOT WRITTEN. `WASHES` names the colour a wash is made of and its
 * alpha, and the serializer computes the `rgb()` from the two, so recolouring `accent`
 * moves all three of its washes with it. The alphas are a ladder rather than a recording:
 * a tint behind text is 12 or 20 percent, a banner is 10 or 45, a shadow is 30, 50 or 72,
 * and a wash over chrome is 7.
 *
 * WHAT KEEPS IT SMALL. Two assertions in the test are the ratchet. No two tones in a
 * family may sit within 8/255 of each other, which is the distance the old sheet's
 * duplicates were apart: if a tone is close enough to be mistaken for one of these, it is
 * meant to be one of these, and the fix is to merge into the nearer tone. And the palette
 * as a whole is capped at 60 tokens, a ceiling with 53 under it today: needing another one
 * is a sign that an existing tone is being overlooked.
 */

/** One family of tones, keyed by tone name. */
export type PaletteFamily = Readonly<Record<string, string>>;

export const PALETTE = {
  /** Backgrounds, from the app shell down to a raised control. */
  surface: {
    app: '#181818',
    panel: '#252525',
    card: '#2c2c2c',
    control: '#333333',
    /** The hover step above `control`, and a row on a panel at rest. */
    raise: '#3d3d3d',
    /** The light tile an emoji icon is drawn on. */
    light: '#f4f4f4'
  },
  /** Borders, outlines, strokes and the scrollbar thumb. */
  line: {
    base: '#454545',
    /** A divider inside a panel, a step quieter than `base`. */
    faint: '#383838',
    /** A border that answers the pointer, one step up from `base`. */
    hover: '#5c5c5c',
    /** The scrollbar thumb, and every outline drawn in a neutral. */
    thumb: '#6b6b6b',
    /** The magnifier inside the search field. */
    search: '#929292'
  },
  /**
   * Text, and the tinted greys the chrome writes in.
   *
   * `strong` and `base` are the two the app reads most and the two that carry the plum
   * cast the launcher writes in. Below them the ramp is neutral: the old sheet had a
   * tinted and a plain tone doing each of these jobs, eight units apart.
   */
  ink: {
    strong: '#f4edf5',
    base: '#e7e1e9',
    /** Prose that is not a control: a modal paragraph, a disclosure summary. */
    soft: '#cccccc',
    /** Secondary text: a label, a count, an icon's ink, a status line. */
    muted: '#a5a5a5',
    /** A hint, a disabled label, a path, anything the user is not meant to read first. */
    faint: '#8a8a8a',
    /** The quietest readable step, at the edge of legibility on a panel. */
    ghost: '#777777',
    /** On a filled control, and the glyph on the alert dot. */
    inverse: '#ffffff'
  },
  /** Blacks, for shadows and the dim behind a modal. */
  shadow: {
    base: '#000000'
  },
  /** The install button's blue, and the app's "this is the thing" colour. */
  accent: {
    base: '#8ab4f8',
    light: '#a7c6fb',
    rim: '#5a7fbf',
    /** Ink on a filled accent control. */
    ink: '#121212'
  },
  /** The focus ring's amber, and everything the sheet flags rather than refuses. */
  amber: {
    base: '#ffb74d',
    /** The matched characters in a search panel, and a name the launcher will not accept. */
    mark: '#ff9800',
    /** Work in flight: a check running, a band that is only average, edits not saved. */
    progress: '#e0b341',
    /** Amber ink on an amber banner or pill. */
    soft: '#e2c07c',
    rim: '#a37b1f',
    /** The border of a full width banner, darker than `rim`. */
    rimDeep: '#6b5a2a'
  },
  /** A thing that worked. */
  ok: {
    base: '#7ba86f',
    light: '#9cc78f',
    rim: '#5d8a52',
    /** A saved orphan's ink, and the progress line under a repair. */
    pale: '#9ede94'
  },
  /** A thing that failed. */
  danger: {
    base: '#ff5555',
    hover: '#ff7777',
    /** Error prose, which is a message rather than a control. */
    status: '#ff8888',
    /** A refusal that is not a fault: a weak key, a row that could not be covered. */
    soft: '#e08a7a',
    /** A filled alert dot, and the border of an error. */
    deep: '#b3261e'
  },
  /** A sync in flight, which is neither a failure nor a success. */
  sync: {
    base: '#bb86fc',
    deep: '#8d5fd3'
  }
} as const satisfies Readonly<Record<string, PaletteFamily>>;

/**
 * The washes: a colour at an alpha, for a tint behind text or a dim behind a modal.
 *
 * `of` is a palette path (`accent`, or `amber.progress`). Alpha is a fraction, and the
 * serializer writes it back as the percentage the sheet used.
 */
export const WASHES = {
  'accent-wash-12': { of: 'accent', alpha: 0.12 },
  'accent-wash-20': { of: 'accent', alpha: 0.2 },
  'accent-wash-70': { of: 'accent', alpha: 0.7 },
  'amber-wash-10': { of: 'amber.progress', alpha: 0.1 },
  'amber-wash-16': { of: 'amber', alpha: 0.16 },
  'amber-wash-45': { of: 'amber.progress', alpha: 0.45 },
  'ok-wash-22': { of: 'ok', alpha: 0.22 },
  'danger-wash-12': { of: 'danger.soft', alpha: 0.12 },
  'danger-wash-20': { of: 'danger.soft', alpha: 0.2 },
  'shadow-wash-30': { of: 'shadow', alpha: 0.3 },
  'shadow-wash-50': { of: 'shadow', alpha: 0.5 },
  'shadow-wash-72': { of: 'shadow', alpha: 0.72 },
  'sheen-wash-7': { of: 'ink.inverse', alpha: 0.07 }
} as const satisfies Readonly<Record<string, { of: string; alpha: number }>>;

/** The line that opens the generated block in `styles.css`. */
export const PALETTE_BLOCK_START = '/* lithic-palette:start, generated from color-palette.ts */';

/** The line that closes it. Both markers are written by `paletteCss()`. */
export const PALETTE_BLOCK_END = '/* lithic-palette:end */';

/** The most tokens the palette may hold: a ratchet, not a target. */
export const PALETTE_TOKEN_CEILING = 60;

/** How close two tones in one family may come before they are really one tone. */
export const PALETTE_MIN_SEPARATION = 8;

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/;

function channels(value: string): [number, number, number] {
  const match = HEX.exec(value);
  if (!match) throw new Error(`color-palette: ${value} is not a #rrggbb colour`);
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

function kebab(tone: string): string {
  return tone.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** `accent` for a family's base tone, `amber-rim-deep` for any other. */
export function variableName(path: string): string {
  const [family, tone] = path.split('.');
  return tone === undefined || tone === 'base' ? `--lithic-${kebab(family)}` : `--lithic-${kebab(family)}-${kebab(tone)}`;
}

/** The colour a palette path names. */
export function paletteValue(path: string): string {
  const [family, tone] = path.split('.');
  const tones = (PALETTE as Readonly<Record<string, PaletteFamily>>)[family];
  if (!tones) throw new Error(`color-palette: no family ${family}`);
  const value = tone === undefined ? tones['base'] : tones[tone];
  if (!value) throw new Error(`color-palette: no tone ${path}`);
  return value;
}

/** Every custom property the block declares, in the order the sheet reads them. */
export function paletteTokens(): Array<{ name: string; value: string }> {
  const tokens: Array<{ name: string; value: string }> = [];
  for (const [family, tones] of Object.entries(PALETTE)) {
    for (const [tone, value] of Object.entries(tones)) {
      tokens.push({ name: variableName(`${family}.${tone}`), value });
    }
  }
  for (const [name, wash] of Object.entries(WASHES)) {
    const [red, green, blue] = channels(paletteValue(wash.of));
    const percent = Number((wash.alpha * 100).toFixed(4));
    tokens.push({ name: `--lithic-${name}`, value: `rgb(${red} ${green} ${blue} / ${percent}%)` });
  }
  return tokens;
}

/** The generated block, markers included, exactly as `styles.css` carries it. */
export function paletteCss(): string {
  const lines = paletteTokens().map((token) => `  ${token.name}: ${token.value};`);
  return [PALETTE_BLOCK_START, ':root {', ...lines, '}', PALETTE_BLOCK_END].join('\n');
}
