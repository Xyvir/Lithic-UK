#!/usr/bin/env python3
"""
build-launcher-font.py -- build the launcher's "Vollkorn with CM digits" faces.

The launcher used to load Vollkorn from fonts.googleapis.com, which meant the
desktop app needed the network for its own body text and never matched the
wiki's amalgam (Vollkorn letters, Computer Modern numerals). This builds the
same amalgam as a set of static faces the build inlines into launcher.html.

Source: Google's `latin` subset of Vollkorn v30, which is a VARIABLE font
(wght 400-900) over 231 codepoints -- so every weight the launcher declares
(400, 600, 700) gets a real instanced face instead of a synthesised one. The
launcher sets `font-synthesis: none`, so a missing weight is not faked; it
silently falls back to the nearest face, which is why all three are built.

Digits come from the KaTeX fonts (Main-Regular for 400, Main-Bold above it),
the Computer Modern descendant the embedded KaTeX plugin already uses. Both
sources are SIL OFL 1.1 (modification permitted); the output uses a fresh
internal family name ("Lithic Serif") because KaTeX reserves its own and out
of conservative hygiene around "Vollkorn". The CSS @font-face keeps serving
the family under the existing "Vollkorn" handle, so no rule in styles.css or
App.svelte has to change.

Inputs:
  assets/fonts/vollkorn-latin-vf.woff2                (durable source copy)
  node_modules/.../katex/files/fonts/KaTeX_Main-*.woff2

Outputs:
  launcher-ui/src/fonts/lithic-serif-<weight>.woff2   (consumed by the build)

Refresh the source with (needs the modern UA; Google serves woff2 only then):

  node -e "fetch('https://fonts.googleapis.com/css2?family=Vollkorn:wght@400;600&display=swap',{headers:{'User-Agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36'}}).then(r=>r.text()).then(console.log)"
  # then download the `latin` @font-face src= URL it prints

Run: python3 scripts/build-launcher-font.py
"""
import copy
import io
import sys
from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'assets' / 'fonts' / 'vollkorn-latin-vf.woff2'
OUT_DIR = ROOT / 'launcher-ui' / 'src' / 'fonts'
KATEX = ROOT / 'node_modules' / 'tiddlywiki' / 'plugins' / 'tiddlywiki' / 'katex' / 'files' / 'fonts'

# (weight, KaTeX digit source, subfamily) -- 400 exact, 600 semibold, 700 bold.
WEIGHTS = [
    (400, 'KaTeX_Main-Regular', 'Regular'),
    (600, 'KaTeX_Main-Bold', 'SemiBold'),
    (700, 'KaTeX_Main-Bold', 'Bold'),
]
DIGITS = list(range(0x30, 0x3A))
FAMILY = 'Lithic Serif'
ATTRIBUTION = (
    'Derived work: Vollkorn (c) Friedrich Althausen, SIL OFL 1.1 '
    '(http://scripts.sil.org/OFL), with digit glyphs (U+0030-0039) taken from '
    'KaTeX fonts (c) Design Science / Khan Academy / Kungliga Tekniska hogskolan, '
    'SIL OFL 1.1 (http://scripts.sil.org/OFL). Modified version - renamed '
    'per OFL requirements.'
)


def splice_digits(font: TTFont, katex_path: Path, weight: int) -> list:
    """Point U+0030-0039 at Computer Modern outlines; leave every letter alone."""
    katex = TTFont(str(katex_path))
    assert 'glyf' in font and 'glyf' in katex, 'both fonts must be TrueType-glyf'
    assert font['head'].unitsPerEm == katex['head'].unitsPerEm == 1000, 'UPM mismatch'

    glyf, katex_glyf = font['glyf'], katex['glyf']
    katex_cmap = katex.getBestCmap()
    glyph_order = font.getGlyphOrder()
    hmtx = font['hmtx']

    swapped = []
    for cp in DIGITS:
        src_name = katex_cmap.get(cp)
        assert src_name, f'{katex_path.name} missing U+{cp:04X}'
        dst_name = f'{src_name}.cm'
        if dst_name in glyph_order:  # defensive: rebuilds start from the source
            continue
        glyph = copy.deepcopy(katex_glyf[src_name])
        if glyph.isComposite():
            raise SystemExit(f'{src_name} is composite -- unsupported by this script')
        glyf.glyphs[dst_name] = glyph
        glyph_order.append(dst_name)
        # The CM advance is the point of the swap, so install it on both the new
        # glyph and the Vollkorn digit it replaces.
        hmtx[dst_name] = hmtx[src_name] = tuple(katex['hmtx'][src_name])
        swapped.append((cp, src_name, dst_name))

    for table in font['cmap'].tables:
        for cp in DIGITS:
            if cp in table.cmap:
                table.cmap[cp] = f'{katex_cmap[cp]}.cm'
    font.setGlyphOrder(glyph_order)
    font['maxp'].numGlyphs = len(glyph_order)
    return swapped


def rename(font: TTFont, weight: int, subfamily: str) -> None:
    """Fresh identity per OFL rename hygiene, plus a weight-correct style."""
    postscript = f'LithicSerif-{subfamily}'
    typographic = FAMILY if weight == 400 else f'{FAMILY} {subfamily}'
    name = font['name']
    for platform, encoding, language in ((3, 1, 0x409), (1, 0, 0)):
        try:
            name.setName(FAMILY, 1, platform, encoding, language)
            name.setName(subfamily, 2, platform, encoding, language)
            name.setName(f'{FAMILY} {subfamily}', 4, platform, encoding, language)
            name.setName(postscript, 6, platform, encoding, language)
            name.setName(typographic, 16, platform, encoding, language)
            name.setName(subfamily, 17, platform, encoding, language)
        except Exception:
            # The mac-roman records are cosmetic; the Windows ones are what count.
            pass
    name.setName(ATTRIBUTION, 13, 3, 1, 0x409)
    name.setName('http://scripts.sil.org/OFL', 14, 3, 1, 0x409)

    font['OS/2'].usWeightClass = weight
    if weight >= 700:
        # BOLD and REGULAR are mutually exclusive; the instanced source keeps
        # REGULAR set from the 400 default, so clear it or the face is invalid.
        font['OS/2'].fsSelection = (font['OS/2'].fsSelection | (1 << 5)) & ~(1 << 6)
        font['head'].macStyle |= 1
    else:
        font['OS/2'].fsSelection = (font['OS/2'].fsSelection & ~(1 << 5)) | (1 << 6)
        font['head'].macStyle &= ~1


def main() -> int:
    if not SOURCE.exists():
        raise SystemExit(f'missing source font: {SOURCE} (see this script\'s docstring)')
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    source_codepoints = len(TTFont(str(SOURCE)).getBestCmap())
    for weight, digit_source, subfamily in WEIGHTS:
        katex_path = KATEX / f'{digit_source}.woff2'
        assert katex_path.exists(), f'missing {katex_path} (run npm ci)'

        font = TTFont(str(SOURCE))
        font = instancer.instantiateVariableFont(font, {'wght': weight}, inplace=True)
        swapped = splice_digits(font, katex_path, weight)
        rename(font, weight, subfamily)

        output = OUT_DIR / f'lithic-serif-{weight}.woff2'
        buffer = io.BytesIO()
        font.flavor = 'woff2'
        font.save(buffer)
        output.write_bytes(buffer.getvalue())

        # Verify the swap landed on the rebuilt file, not just in memory.
        check = TTFont(str(output))
        cmap = check.getBestCmap()
        katex = TTFont(str(katex_path))
        katex_cmap = katex.getBestCmap()
        for cp in DIGITS:
            assert cmap[cp].endswith('.cm'), f'U+{cp:04X} not remapped'
            assert check['hmtx'][cmap[cp]] == tuple(katex['hmtx'][katex_cmap[cp]]), f'advance wrong for U+{cp:04X}'
        for cp in (0x52, 0x59, 0x6B, 0x73, 0x2026, 0x00D7):  # R Y k s ellipsis multiply
            assert not cmap[cp].endswith('.cm'), f'U+{cp:04X} got swapped!'
        assert len(cmap) == source_codepoints, 'coverage changed'
        assert check['OS/2'].usWeightClass == weight

        print(
            f'{subfamily:8} wght={weight}: {len(buffer.getvalue()):>6}B  '
            f'{check["maxp"].numGlyphs} glyphs  {len(cmap)} codepoints  '
            f'digits from {digit_source} ({len(swapped)} spliced) -> {output.relative_to(ROOT)}'
        )
    return 0


if __name__ == '__main__':
    sys.exit(main())
