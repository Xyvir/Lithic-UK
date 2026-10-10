/**
 * Tiling a gallery sheet, and the font its panes are named with.
 *
 * Its own module because this is the one part of a gallery run that depends on
 * something a machine may simply not have, and because it failed on a runner exactly
 * that way: `ubuntu-24.04` carries only `fonts-noto-color-emoji`, and the ImageMagick
 * AppImage ships neither a font nor a fontconfig of its own, so `magick montage` died
 * with `UnableToReadFont` — after every pane of the sheet had already been
 * photographed, which is a whole run spent to learn that one machine had no text.
 *
 * Two things about that are worth spelling out, because both are surprising:
 *
 * 1. **montage needs a font even with no label.** It asks freetype for the metrics of
 *    its (empty) label before it lays anything out, so a font-less box fails the tile
 *    outright rather than writing an unlabelled sheet. Dropping `-label` is therefore
 *    not a fallback at all — that was the bug: the old retry took the labels off and
 *    hit the same font error, so the run ended with no sheets instead of silent ones.
 * 2. **A path, not a family name.** Naming a family sends ImageMagick back through
 *    fontconfig, which is the lookup that just failed. `-font /usr/share/fonts/…ttf`
 *    loads the file through freetype directly, and works on a box whose fontconfig
 *    knows of no fonts at all (measured: 7.1.2-32 with an empty `fonts.conf` renders
 *    a labelled sheet in one).
 *
 * So the sheet is labelled with a font this file has found by path, or tiled without
 * any text at all by `grid()` — `+append` and `-append` lay images out arithmetically,
 * so neither ever calls freetype and a font-less runner still produces a reviewable
 * deck. `scripts/install-imagemagick7.sh` is what puts a font in `SHEET_FONT`'s list
 * on a runner; the paths here are the ones a dev machine already has.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** What a sheet is drawn on, in the launcher's own dark neutral. */
const BACKGROUND = '#121212';
/** The label ink, the same warm grey the contact page's body text uses. */
const INK = '#cfc7bb';

/**
 * The first font that exists, by path — the first of which an operator can force with
 * `GALLERY_FONT`, which is also how the module is tested against a font-less machine:
 * point it at a file, or leave it out and take the path list as written.
 *
 * Exported because it is worth a line in the run's log: a deck with no names is worth
 * looking at, but it should never be a mystery why the names are missing.
 */
export const SHEET_FONT = [
  process.env.GALLERY_FONT,
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/truetype/ubuntu/Ubuntu-R.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  'C:/Windows/Fonts/arial.ttf'
].find((candidate) => candidate && existsSync(candidate));

/**
 * Tile one sheet's panes into `out`, each under its own name.
 *
 * The label attempt is kept even though `grid()` cannot fail on a font: the labels are
 * the reading order of a sheet, and the sheet is only worth pressing into one picture
 * because its states are comparable side by side. `grid()` is the guarantee that a
 * machine without one still gets the pictures.
 */
export async function tileSheet(sheet, files, out) {
  const base = ['montage', '-background', BACKGROUND, '-tile', sheet.tile, '-geometry', '+14+14'];
  const labels = ['-label', '%t', '-pointsize', '15', '-fill', INK];
  const font = SHEET_FONT ? ['-font', SHEET_FONT] : [];
  try {
    await run('magick', [...base, ...font, ...labels, ...files, out], { maxBuffer: 1 << 28 });
  } catch (error) {
    console.warn(`  ! could not label this sheet (${error.message.split('\n')[0]}); tiling it without text`);
    await grid(sheet, files, out);
  }
  return out;
}

/**
 * The same tiling, with no text anywhere in it.
 *
 * Rows of `sheet.tile` panes, stacked. `-border` is what stands in for montage's
 * `-geometry +14+14`: seven pixels down each side is the same gap between neighbours,
 * and the whole is bordered too so the sheet matches the labelled one's margins.
 */
async function grid(sheet, files, out) {
  const border = ['-bordercolor', BACKGROUND, '-border', '7'];
  const columns = Number.parseInt(String(sheet.tile), 10) || files.length;
  const rows = [];
  for (let at = 0; at < files.length; at += columns) {
    rows.push(['(', ...files.slice(at, at + columns), '+append', ...border, ')']);
  }
  await run('magick', [...rows.flat(), '-append', ...border, out], { maxBuffer: 1 << 28 });
}
