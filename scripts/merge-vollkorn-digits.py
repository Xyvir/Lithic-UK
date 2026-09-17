#!/usr/bin/env python3
"""
merge-vollkorn-digits.py -- build "Vollkorn with CM digits".

Takes the Vollkorn Regular subset embedded in $:/lithic/fonts/vollkorn and
splices the digit glyphs (U+0030-0039) from KaTeX_Main-Regular.woff2 (the
Computer Modern descendant the embedded KaTeX plugin uses) into it, so the
whole wiki renders numerals with the LaTeX look while every letter stays
Vollkorn. Both fonts are SIL OFL 1.1 (modification permitted); the merged
font uses a fresh internal family name ("Lithic Serif") because KaTeX
reserves its name and conservative hygiene around "Vollkorn". The CSS
@font-face keeps serving it under the existing "Vollkorn" family handle,
so no downstream CSS/JS needs to change.

Rewrites wiki/local-plugins/lithic-core/$__lithic_fonts_vollkorn.css.tid
in place with the merged woff2 as a SINGLE-LINE base64 data URI (a wrapped
blob makes browsers reject the @font-face silently).
"""
import base64
import copy
import re
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
VOLLKORN_WOFF2 = ROOT / 'assets' / 'fonts' / 'vollkorn-pre-merge.woff2'  # pre-merge subset, extracted from the current tiddler (durable copy under assets/)
KATEX_WOFF2 = ROOT / 'node_modules' / 'tiddlywiki' / 'plugins' / 'tiddlywiki' / 'katex' / 'files' / 'fonts' / 'KaTeX_Main-Regular.woff2'
TIDDLER = ROOT / 'wiki' / 'local-plugins' / 'lithic-core' / '$__lithic_fonts_vollkorn.css.tid'

DIGITS = list(range(0x30, 0x3A))
NEW_FAMILY = 'Lithic Serif'
NEW_PSNAME = 'LithicSerif-Regular'

ATTRIBUTION = (
    'Derived work: Vollkorn (c) Friedrich Althausen, SIL OFL 1.1 '
    '(http://scripts.sil.org/OFL), with digit glyphs (U+0030-0039) taken from '
    'KaTeX fonts (c) Design Science / Khan Academy / Kungliga Tekniska hogskolan, '
    'SIL OFL 1.1 (http://scripts.sil.org/OFL). Modified version - renamed '
    'per OFL requirements.'
)


def main():
    v = TTFont(str(VOLLKORN_WOFF2))
    k = TTFont(str(KATEX_WOFF2))

    assert 'glyf' in v and 'glyf' in k, 'both fonts must be TrueType-glyf'
    assert v['head'].unitsPerEm == k['head'].unitsPerEm == 1000, 'UPM mismatch'

    v_glyf, k_glyf = v['glyf'], k['glyf']
    v_cmap_best = v.getBestCmap()
    k_cmap_best = k.getBestCmap()

    glyph_order = v.getGlyphOrder()
    taken = set(glyph_order)
    hmtx = v['hmtx']

    swapped = []
    for cp in DIGITS:
        src_name = k_cmap_best.get(cp)
        assert src_name, f'KaTeX missing U+{cp:04X}'
        # map old vollkorn digit glyph -> new cm glyph for every cmap subtable
        dst_name = src_name + '.cm'
        if dst_name in taken:  # idempotent re-run
            continue
        g = copy.deepcopy(k_glyf[src_name])
        if g.isComposite():
            raise SystemExit(f'{src_name} is composite -- unsupported by this script')
        v_glyf.glyphs[dst_name] = g
        glyph_order.append(dst_name)
        taken.add(dst_name)
        hmtx[dst_name] = hmtx[src_name] = tuple(k['hmtx'][src_name])
        swapped.append((cp, src_name, dst_name))

    # re-point every cmap subtable at the new glyphs
    for table in v['cmap'].tables:
        for cp in DIGITS:
            if cp in table.cmap:
                table.cmap[cp] = table.cmap[cp]  # keep structure warm
        for cp, _src, dst in swapped:
            if cp in table.cmap:
                table.cmap[cp] = dst

    v.setGlyphOrder(glyph_order)
    v['maxp'].numGlyphs = len(glyph_order)

    # fresh identity: new family/PS name + attribution (OFL rename hygiene)
    name = v['name']
    for platform in list(name.names):
        pass
    name.setName(NEW_FAMILY, 1, 3, 1, 0x409)
    name.setName('Regular', 2, 3, 1, 0x409)
    name.setName(f'{NEW_FAMILY} Regular', 4, 3, 1, 0x409)
    name.setName(NEW_PSNAME, 6, 3, 1, 0x409)
    name.setName(NEW_FAMILY, 16, 3, 1, 0x409)
    name.setName(NEW_FAMILY, 1, 1, 0, 0)      # mac roman
    name.setName(f'{NEW_FAMILY} Regular', 4, 1, 0, 0)
    name.setName(NEW_PSNAME, 6, 1, 0, 0)
    name.setName(ATTRIBUTION, 13, 3, 1, 0x409)
    name.setName('http://scripts.sil.org/OFL', 14, 3, 1, 0x409)
    name.setName(ATTRIBUTION, 10, 3, 1, 0x409)

    out = ROOT / 'tmp' / 'fonts' / 'vollkorn-cm.woff2'
    v.flavor = 'woff2'
    v.save(str(out))

    # verify round-trip
    m = TTFont(str(out))
    mc = m.getBestCmap()
    for cp in DIGITS:
        assert mc[cp].endswith('.cm'), f'U+{cp:04X} not remapped'
        assert m['hmtx'][mc[cp]] == tuple(k['hmtx'][k_cmap_best[cp]]), f'advance wrong for U+{cp:04X}'
    letters = {cp: mc[cp] for cp in (0x52, 0x59, 0x6B, 0x73)}  # R Y k s
    for cp, gname in letters.items():
        assert not gname.endswith('.cm'), f'letter U+{cp:04X} got swapped!'

    # rewrite the tiddler: swap the single base64 blob, keep it one line
    b64 = base64.b64encode(out.read_bytes()).decode('ascii')
    assert '\n' not in b64
    tid = TIDDLER.read_text(encoding='utf-8')
    tid2, n = re.subn(r'base64,[A-Za-z0-9+/=]+\)', 'base64,' + b64 + ')', tid, count=1)
    assert n == 1, 'vollkorn tiddler: blob not found/replaced'
    TIDDLER.write_text(tid2, encoding='utf-8', newline='')

    raw_len = out.stat().st_size
    print(f'merged font written: {out} ({raw_len} bytes, {len(glyph_order)} glyphs)')
    print('digit glyphs swapped:', ', '.join(f'U+{cp:04X}:{src}->{dst}' for cp, src, dst in swapped))
    print(f'tiddler rewritten: {TIDDLER.name} (blob {len(b64)} b64 chars, single line)')


if __name__ == '__main__':
    sys.exit(main())
