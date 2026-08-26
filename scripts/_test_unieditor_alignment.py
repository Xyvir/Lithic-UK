#!/usr/bin/env python3
"""Headless validation of uniEditor canvas/textarea wrap alignment.

Boots the live build (src/lithic.html), injects a script that builds a real
`.unieditor` DOM (pre + textarea) so the plugin's embedded CSS applies, fills
it with markdown containing **bold**, *italic* and ## headers, and compares
how the plain-text textarea wraps vs the highlighted canvas <pre>.

The canvas layer must wrap at EXACTLY the same points as the invisible
textarea or the caret desyncs from the visible text. Anything that changes
glyph advance widths in the canvas (real font-weight: bold / font-style:
italic on the md-* spans) shifts wrap points and breaks alignment -- but only
when the resolved font's bold/italic faces actually change glyph widths
(monospace faces like Consolas usually keep them; proportional or fallback
fonts often do not).

Checks:
  1. Diagnostics: fonts/geometry of each layer, that bold spans exist.
  2. Line-count sweep at several widths (shipped styles vs fake bold).
  3. Full-text alignment: compare line-box rects of a textarea style-mirror
     against the canvas -- the definitive caret-vs-visible-text check.
  4. Proportional-font scenario with bold-heavy content: real bold diverges,
     fake bold (text-stroke) restores identical wrapping.
"""
import os
import re
import subprocess
import sys

SRC = "src/lithic.html"
OUT = "scripts/_test_unieditor.html"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

# Faithful copy of the plugin's md-highlight.js renderer (self-contained).
MD_HIGHLIGHT = r"""
function htmlEscape(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function m(text) { return '<span class="md-marker">' + text + '</span>'; }
function parseInline(text) {
    var codeSpans = [];
    text = text.replace(/`([^`\n]+)`/g, function(_m, content) {
        var idx = codeSpans.length;
        codeSpans.push('<span class="md-code">' + m('`') + content + m('`') + '</span>');
        return '\uE000' + idx + '\uE001';
    });
    text = text.replace(/(\${1,2})([^$\n]+?)\1/g, function(_m, delim, content) {
        return '<span class="md-katex">' + m(delim) + content + m(delim) + '</span>';
    });
    text = text.replace(/(\{{2,3})([^{}]+?)(\}{2,3})/g, function(_m, open, content, close) {
        return '<span class="md-tw-embed">' + m(open) + content + m(close) + '</span>';
    });
    text = text.replace(/&lt;&lt;(.+?)&gt;&gt;/g,
        '<span class="md-tw-macro">' + m('&lt;&lt;') + '$1' + m('&gt;&gt;') + '</span>');
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g,
        '<span class="md-image">' + m('![') + '$1' + m('](') + '<span class="md-url">$2</span>' + m(')') + '</span>');
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
        '<span class="md-link">' + m('[') + '$1' + m('](') + '<span class="md-url">$2</span>' + m(')') + '</span>');
    text = text.replace(/\[\[([^\]]+)\]\]/g,
        '<span class="md-tw-link">' + m('[[') + '$1' + m(']]') + '</span>');
    text = text.replace(/(^|[\s(])#([a-zA-Z][a-zA-Z0-9_\-/]*)/g,
        '$1<span class="md-tw-hashtag">' + m('#') + '$2</span>');
    text = text.replace(/\*\*(.+?)\*\*/g,
        '<span class="md-strong">' + m('**') + '$1' + m('**') + '</span>');
    text = text.replace(/__(.+?)__/g,
        '<span class="md-strong">' + m('__') + '$1' + m('__') + '</span>');
    text = text.replace(/~~(.+?)~~/g,
        '<span class="md-del">' + m('~~') + '$1' + m('~~') + '</span>');
    text = text.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g,
        '$1<span class="md-em">' + m('*') + '$2' + m('*') + '</span>');
    text = text.replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g,
        '$1<span class="md-em">' + m('_') + '$2' + m('_') + '</span>');
    for (var i = 0; i < codeSpans.length; i++) {
        text = text.replace('\uE000' + i + '\uE001', codeSpans[i]);
    }
    return text;
}
function highlight(code) {
    var lines = code.split('\n');
    var result = [];
    var inCodeBlock = false, codeBlockFence = '', codeBlockLang = '', codeBlockBuffer = [];
    var inKatexBlock = false;
    for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        var escaped = htmlEscape(line);
        if (/^\$\$/.test(line.trim())) { inKatexBlock = !inKatexBlock; result.push('<span class="md-katex-fence">' + escaped + '</span>'); continue; }
        if (inKatexBlock) { result.push('<span class="md-katex-block">' + escaped + '</span>'); continue; }
        if (!inCodeBlock) {
            var fenceMatch = line.match(/^(`{3,})(\w*)/);
            if (fenceMatch) {
                inCodeBlock = true; codeBlockFence = fenceMatch[1]; codeBlockLang = fenceMatch[2];
                if (codeBlockLang === 'jspython') codeBlockLang = 'python';
                result.push('<span class="md-code-fence">' + escaped + '</span>');
                codeBlockBuffer = [];
                continue;
            }
        } else {
            if (line.startsWith(codeBlockFence)) {
                if (codeBlockBuffer.length > 0) { result.push('<span class="md-code-block hljs">' + htmlEscape(codeBlockBuffer.join('\n')) + '</span>'); }
                inCodeBlock = false;
                result.push('<span class="md-code-fence">' + escaped + '</span>');
                continue;
            } else { codeBlockBuffer.push(line); continue; }
        }
        if (/^\\[a-zA-Z]/.test(line)) { result.push('<span class="md-tw-pragma">' + escaped + '</span>'); continue; }
        var headerMatch = line.match(/^(#{1,6})\s/);
        if (headerMatch) {
            var level = headerMatch[1].length;
            var markerLen = headerMatch[0].length;
            result.push('<span class="md-h md-h' + level + '">' + m(escaped.substring(0, markerLen)) + parseInline(escaped.substring(markerLen)) + '</span>');
            continue;
        }
        if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { result.push('<span class="md-hr">' + escaped + '</span>'); continue; }
        var taskMatch = line.match(/^(\s*[-*+]\s\[[ xX]\]\s)/);
        if (taskMatch) {
            var mLen = taskMatch[0].length;
            result.push('<span class="md-list-marker">' + escaped.substring(0, mLen) + '</span>' + parseInline(escaped.substring(mLen)));
            continue;
        }
        var bulletMatch = line.match(/^(\s*[-*+])\s/);
        if (bulletMatch) {
            var mLen = bulletMatch[0].length;
            result.push('<span class="md-list-marker">' + escaped.substring(0, mLen) + '</span>' + parseInline(escaped.substring(mLen)));
            continue;
        }
        var numMatch = line.match(/^(\s*\d+\.)\s/);
        if (numMatch) {
            var mLen = numMatch[0].length;
            result.push('<span class="md-list-marker">' + escaped.substring(0, mLen) + '</span>' + parseInline(escaped.substring(mLen)));
            continue;
        }
        result.push(parseInline(escaped));
    }
    if (inCodeBlock && codeBlockBuffer.length > 0) { result.push('<span class="md-code-block hljs">' + htmlEscape(codeBlockBuffer.join('\n')) + '</span>'); }
    return result.join('\n');
}
"""

TEST_JS = r"""
<script>
(function() {
    var results = [];
    function check(name, ok, detail) {
        results.push((ok ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : ""));
    }
    function finish() {
        var out = document.getElementById("out");
        if (!out) { out = document.createElement("pre"); out.id = "out"; document.body.appendChild(out); }
        out.textContent = results.join("\n");
        out.setAttribute("style", "white-space:pre");
    }
    window.addEventListener("error", function(e) {
        results.push("FAIL | uncaught: " + (e.message || e));
        finish();
    });
    var tries = 0;
    var iv = setInterval(function() {
        tries++;
        if (!window.$tw || !$tw.wiki) {
            if (tries > 300) { results.push("FAIL | boot timeout"); finish(); clearInterval(iv); }
            return;
        }
        clearInterval(iv);
        try { run(); } catch (e) { results.push("FAIL | exception: " + (e && e.stack ? e.stack : e)); }
        finish();
    }, 50);

    function run() {
        var wiki = $tw.wiki;
        check("boot", !!wiki, "wiki present");

        __MD_HIGHLIGHT__

        var code = [
            "## Project Notes and **bold** heading words",
            "The quick brown **fox jumps** over the lazy dog and keeps running " +
            "through the *deep green* forest while the sun sets behind the hills. ",
            "Another paragraph with **important** terms and *emphasised* phrases " +
            "scattered throughout so that wrapping happens near the bold and italic " +
            "segments at various widths.",
            "A final line with a `code span` and a [link text](https://example.com) " +
            "and a [[wiki link]] plus some #hashtags to exercise every span type."
        ].join("\n");
        var highlighted = highlight(code);

        // Override styles injected on top of the plugin's shipped CSS.
        // "fixed" mirrors the proposed md-styles.css / ui-tweaks.css changes:
        // fake bold via -webkit-text-stroke (italic left as real italic -- the
        // monospace editor font keeps italic advance widths).
        var variants = {
            "real": "",
            "fixed": (
                ".unieditor.fixed .md-strong, .unieditor.fixed .md-h, " +
                ".unieditor.fixed .md-tw-pragma {" +
                "  font-weight: normal !important;" +
                "  -webkit-text-stroke: 0.5px currentColor;" +
                "}" +
                ".unieditor.fixed .hljs-keyword, .unieditor.fixed .hljs-selector-tag, " +
                ".unieditor.fixed .hljs-addition, .unieditor.fixed .hljs-title, " +
                ".unieditor.fixed .hljs-section, .unieditor.fixed .hljs-name, " +
                ".unieditor.fixed .hljs-selector-id, .unieditor.fixed .hljs-selector-class, " +
                ".unieditor.fixed .hljs-strong {" +
                "  font-weight: normal !important;" +
                "  -webkit-text-stroke: 0.5px currentColor;" +
                "}"
            )
        };
        var styleEl = document.createElement("style");
        styleEl.id = "variant-styles";
        document.head.appendChild(styleEl);
        var fontOverrideEl = document.createElement("style");
        fontOverrideEl.id = "font-override-styles";
        fontOverrideEl.textContent = (
            ".unieditor[data-font-override=\"1\"] > * {" +
            "  font-family: \"Segoe UI\", \"Arial\", sans-serif !important;" +
            "}"
        );
        document.head.appendChild(fontOverrideEl);

        var host = document.createElement("div");
        document.body.appendChild(host);

        function build(container, variant, width, fontOverride) {
            var ed = document.createElement("div");
            ed.className = "unieditor " + variant;
            ed.style.width = width + "px";
            ed.style.height = "400px";
            if (fontOverride) {
                ed.style.fontFamily = fontOverride;
                ed.setAttribute("data-font-override", "1");
            }
            var pre = document.createElement("pre");
            pre.className = "unieditor__pre unieditor_controlwrap overflowy";
            pre.innerHTML = highlighted;
            ed.appendChild(pre);
            var ta = document.createElement("textarea");
            ta.className = "unieditor__textarea unieditor_controlwrap overflowy";
            ta.value = code;
            ta.setAttribute("spellcheck", "false");
            ed.appendChild(ta);
            container.appendChild(ed);
            return { ed: ed, pre: pre, ta: ta };
        }

        function linesOf(el, isTextarea) {
            var lh = parseFloat(getComputedStyle(el).lineHeight);
            if (isTextarea) {
                var oldH = el.style.height;
                el.style.height = "1px";
                var sh = el.scrollHeight;
                el.style.height = oldH;
                return { lines: sh / lh, px: sh, lh: lh };
            }
            return { lines: el.scrollHeight / lh, px: el.scrollHeight, lh: lh };
        }

        // ---- 0. Diagnostics: fonts + geometry actually used by each layer ----
        var diag = build(host, "real", 480);
        var strongEl = diag.pre.querySelector(".md-strong");
        var taFont = getComputedStyle(diag.ta).fontFamily;
        var preFont = getComputedStyle(diag.pre).fontFamily;
        var strongWeight = strongEl ? getComputedStyle(strongEl).fontWeight : "NO SPAN FOUND";
        results.push("INFO | textarea font: " + taFont);
        results.push("INFO | canvas font:   " + preFont);
        results.push("INFO | md-strong spans: " + diag.pre.querySelectorAll(".md-strong").length +
            " | computed font-weight: " + strongWeight);
        results.push("INFO | fonts identical: " + (taFont === preFont));
        var taCS = getComputedStyle(diag.ta), preCS = getComputedStyle(diag.pre);
        results.push("INFO | textarea: clientWidth=" + diag.ta.clientWidth + " clientHeight=" + diag.ta.clientHeight +
            " fontSize=" + taCS.fontSize + " padL/R=" + taCS.paddingLeft + "/" + taCS.paddingRight +
            " overflowY=" + taCS.overflowY + " scrollbarWidth=" + taCS.scrollbarWidth);
        results.push("INFO | canvas:   clientWidth=" + diag.pre.clientWidth + " clientHeight=" + diag.pre.clientHeight +
            " fontSize=" + preCS.fontSize + " padL/R=" + preCS.paddingLeft + "/" + preCS.paddingRight +
            " overflowY=" + preCS.overflowY + " scrollbarWidth=" + preCS.scrollbarWidth);

        // ---- 1. Line-count sweep, shipped styles (real) vs the fixed styles ----
        var widths = [380, 480, 580, 617.33, 900];
        for (var vi = 0; vi < Object.keys(variants).length; vi++) {
            var variant = Object.keys(variants)[vi];
            styleEl.textContent = variants[variant];
            for (var wi = 0; wi < widths.length; wi++) {
                var w = widths[wi];
                var built = build(host, variant, w);
                var taL = linesOf(built.ta, true);
                var preL = linesOf(built.pre, false);
                var delta = Math.round((preL.lines - taL.lines) * 100) / 100;
                results.push("INFO | " + variant + " @ " + w + "px | delta " + delta + " lines" +
                    (delta === 0 ? "" : "  <-- DIVERGES"));
            }
        }

        // ---- 2. Full-text alignment: per-character y-position, textarea mirror vs canvas ----
        // (real shipped styles first, then the fixed styles)
        // The mirror copies the textarea's computed styles (including its exact
        // content width via clientWidth), so its wrapping is exactly the
        // textarea's. Comparing the y-position of every character in the mirror
        // against the canvas tells us whether the caret's text and the visible
        // text sit on the same lines.
        function mirrorOf(ta) {
            var cs = getComputedStyle(ta);
            var m = document.createElement('div');
            var props = ['fontFamily','fontSize','fontWeight','fontStyle','fontVariant','fontStretch',
                'lineHeight','letterSpacing','wordSpacing','textAlign','textIndent','textTransform',
                'whiteSpace','wordBreak','overflowWrap','wordWrap','tabSize','boxSizing',
                'paddingTop','paddingRight','paddingBottom','paddingLeft'];
            for (var i = 0; i < props.length; i++) m.style[props[i]] = cs[props[i]];
            m.style.width = ta.clientWidth + 'px';
            m.style.position = 'absolute';
            m.style.visibility = 'hidden';
            m.style.left = '-9999px';
            m.style.top = '0';
            m.textContent = ta.value;
            document.body.appendChild(m);
            return m;
        }
        // y offset (relative to the element) of each character, in order.
        // Uses the LAST fragment of getClientRects() so multi-line ranges
        // report the line containing the range end, not the first line.
        function charTops(el) {
            var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            var nodes = [];
            var node;
            while ((node = walker.nextNode())) nodes.push(node);
            var top = el.getBoundingClientRect().top;
            var tops = [];
            for (var n = 0; n < nodes.length; n++) {
                var tn = nodes[n];
                var text = tn.textContent;
                for (var i = 1; i <= text.length; i++) {
                    var r = document.createRange();
                    r.setStart(tn, 0);
                    r.setEnd(tn, i);
                    var rects = r.getClientRects();
                    var rect = rects[rects.length - 1];
                    tops.push(Math.round((rect.top - top) * 10) / 10);
                }
            }
            return tops;
        }
        var rectWidths = [380, 480, 617.33, 900];
        for (var ri = 0; ri < 2; ri++) {
            var rectVariant = ri === 0 ? "real" : "fixed";
            styleEl.textContent = variants[rectVariant];
            for (var rwi = 0; rwi < rectWidths.length; rwi++) {
                var rw = rectWidths[rwi];
                var rb = build(host, rectVariant, rw);
                var mirror = mirrorOf(rb.ta);
                var mTops = charTops(mirror);
                var pTops = charTops(rb.pre);
                var ok = mTops.length === pTops.length;
                var mismatches = 0, firstDiff = "";
                if (ok) {
                    for (var rk = 0; rk < mTops.length; rk++) {
                        if (Math.abs(mTops[rk] - pTops[rk]) > 0.6) {
                            mismatches++;
                            if (!firstDiff) firstDiff = "char " + rk + " (" + JSON.stringify(code.charAt(rk)) + "): mirror y=" + mTops[rk] + "px canvas y=" + pTops[rk] + "px";
                        }
                    }
                    ok = mismatches === 0;
                } else {
                    firstDiff = "char count mirror=" + mTops.length + " canvas=" + pTops.length;
                }
                results.push("INFO | full-text [" + rectVariant + "] @ " + rw + "px: chars=" + mTops.length +
                    (ok ? " | ALIGNED (every char on the same line)" : " | mismatched chars: " + mismatches + " first: " + firstDiff));
                check("fulltext-align-" + rectVariant + "-" + String(rw).replace(".", "-"), ok,
                    ok ? "caret text and visible text align at every character" : firstDiff);
            }
        }

        // ---- 3. Advance-width proof: real bold vs fake bold (text-stroke) ----
        // Measure the rendered width of the same string under regular weight,
        // real bold, and fake bold. If real bold widens the text (proportional
        // fonts) or keeps it identical (monospace), and text-stroke always
        // keeps the regular advance widths, the canvas can be made to wrap
        // exactly like the textarea regardless of the installed font.
        function measureWidth(text, fontFamily, weight, stroke) {
            var d = document.createElement('div');
            d.style.position = 'absolute';
            d.style.visibility = 'hidden';
            d.style.left = '-9999px';
            d.style.top = '0';
            d.style.fontFamily = fontFamily;
            d.style.fontSize = '14px';
            d.style.whiteSpace = 'nowrap';
            if (weight) d.style.fontWeight = weight;
            if (stroke) d.style.webkitTextStroke = stroke;
            d.textContent = text;
            document.body.appendChild(d);
            var w = d.getBoundingClientRect().width;
            d.remove();
            return Math.round(w * 100) / 100;
        }
        function measureWidth2(text, fontFamily, weight, style) {
            var d = document.createElement('div');
            d.style.position = 'absolute';
            d.style.visibility = 'hidden';
            d.style.left = '-9999px';
            d.style.top = '0';
            d.style.fontFamily = fontFamily;
            d.style.fontSize = '14px';
            d.style.whiteSpace = 'nowrap';
            if (weight) d.style.fontWeight = weight;
            if (style) d.style.fontStyle = style;
            d.textContent = text;
            document.body.appendChild(d);
            var w = d.getBoundingClientRect().width;
            d.remove();
            return Math.round(w * 100) / 100;
        }
        var sample = "BOLDWORD bold text with several glyphs";
        ["Consolas, Monaco, monospace", '"Segoe UI", Arial, sans-serif'].forEach(function(fam) {
            var reg = measureWidth(sample, fam, "400", null);
            var bold = measureWidth(sample, fam, "700", null);
            var stroke = measureWidth(sample, fam, "400", "0.5px currentColor");
            var ital = measureWidth2(sample, fam, "400", "italic");
            var oblique = measureWidth2(sample, fam, "400", "oblique");
            var obliqueAngled = measureWidth2(sample, fam, "400", "oblique 14deg");
            results.push("INFO | " + fam + " | regular=" + reg + "px bold=" + bold +
                "px (delta " + Math.round((bold - reg) * 100) / 100 + "px) stroke=" +
                stroke + "px (delta " + Math.round((stroke - reg) * 100) / 100 + "px) italic=" +
                ital + "px (delta " + Math.round((ital - reg) * 100) / 100 + "px) oblique=" +
                oblique + "px (delta " + Math.round((oblique - reg) * 100) / 100 + "px) oblique14=" +
                obliqueAngled + "px (delta " + Math.round((obliqueAngled - reg) * 100) / 100 + "px)");
        });

        // ---- 3b. Proportional font, bold-heavy content: real bold diverges, fake bold aligns ----
        var boldHeavy = [];
        for (var wi2 = 0; wi2 < 8; wi2++) {
            boldHeavy.push("words words words words words words words words **BOLDWORD** words words");
        }
        var boldCode = boldHeavy.join("\n");
        var boldHighlighted = highlight(boldCode);
        var propFont = '"Segoe UI", "Arial", sans-serif';

        function buildWithCode(container, variant, width, codeText, htmlText, fontOverride) {
            var ed = document.createElement("div");
            ed.className = "unieditor " + variant;
            ed.style.width = width + "px";
            ed.style.height = "400px";
            if (fontOverride) {
                ed.style.fontFamily = fontOverride;
                ed.setAttribute("data-font-override", "1");
            }
            var pre = document.createElement("pre");
            pre.className = "unieditor__pre unieditor_controlwrap overflowy";
            pre.innerHTML = htmlText;
            ed.appendChild(pre);
            var ta = document.createElement("textarea");
            ta.className = "unieditor__textarea unieditor_controlwrap overflowy";
            ta.value = codeText;
            ta.setAttribute("spellcheck", "false");
            ed.appendChild(ta);
            container.appendChild(ed);
            return { ed: ed, pre: pre, ta: ta };
        }

        styleEl.textContent = variants["real"];
        var pr = buildWithCode(host, "real", 480, boldCode, boldHighlighted, propFont);
        var appliedFont = getComputedStyle(pr.ta).fontFamily;
        results.push("INFO | proportional computed font: " + appliedFont);
        check("font-override-applies", appliedFont.indexOf("Segoe UI") !== -1,
            appliedFont.indexOf("Segoe UI") !== -1 ? "editor resolved to the proportional font" : "override failed: " + appliedFont);
        var pl = linesOf(pr.pre, false);
        var tl = linesOf(pr.ta, true);
        var propRealDelta = Math.round((pl.lines - tl.lines) * 100) / 100;
        results.push("INFO | proportional font, real bold: textarea " + tl.px + "px vs canvas " +
            pl.px + "px | delta " + propRealDelta + " lines");
        styleEl.textContent = variants["fixed"];
        var pf = buildWithCode(host, "fixed", 480, boldCode, boldHighlighted, propFont);
        var pfl = linesOf(pf.pre, false);
        var tfl = linesOf(pf.ta, true);
        var propFakeDelta = Math.round((pfl.lines - tfl.lines) * 100) / 100;
        results.push("INFO | proportional font, fake bold: textarea " + tfl.px + "px vs canvas " +
            pfl.px + "px | delta " + propFakeDelta + " lines");
        check("proportional-fake-bold-aligns", propFakeDelta === 0,
            propFakeDelta === 0 ? "fake bold preserves wrap points" : "still diverges: " + propFakeDelta);
    }
})();
</script>
</body>
"""


def main():
    with open(SRC, "rb") as f:
        html = f.read().decode("utf-8")
    if "</body>" not in html:
        print("ERROR: no </body> in %s" % SRC)
        sys.exit(1)
    test_js = TEST_JS.replace("__MD_HIGHLIGHT__", MD_HIGHLIGHT)
    html = html.replace("</body>", test_js, 1)
    with open(OUT, "wb") as f:
        f.write(html.encode("utf-8"))
    abs_out = os.path.abspath(OUT).replace("\\", "/")
    cmd = [
        CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--virtual-time-budget=60000", "--dump-dom", "file:///" + abs_out,
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=240)
    dom = proc.stdout.decode("utf-8", errors="replace")
    m = re.search(r'<pre id="out"[^>]*>(.*?)</pre>', dom, re.S)
    if not m:
        print("ERROR: no <pre id=out> found in DOM output")
        print("dom tail:", dom[-2500:])
        sys.exit(1)
    text = re.sub(r"<[^>]+>", "", m.group(1))
    print(text)


if __name__ == "__main__":
    main()
