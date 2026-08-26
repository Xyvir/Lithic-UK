#!/usr/bin/env python3
"""Headless validation of the whiteboard reopen fix via the implicit fallback.

Boots the built monolith (src/lithic.html), injects a test script, and
verifies the FIXED behavior with state tiddlers NOT persisted:

1. The default SaverFilter / BrowserStorage SaveFilter exclude
   `$:/state/Whiteboard/PageLayout/tiddler` -- i.e. state tiddlers are not
   saved; the active-board state lives only for the session.
2. The WhiteBoard layout's default-branch filter, patched to
   `!sort[modified]` (descending), picks the NEWEST board deterministically,
   whereas the old ascending `sort[modified]` picks the shadow
   `$:/DefaultCanvas` first (blank template) and flips to a different board
   whenever the displayed board's `modified` is bumped -- i.e. it is unstable
   and "cycles" as the whiteboard widget saves each board it renders.
3. Reopen resolution is implicit: with the state tiddler empty (nothing was
   saved), the layout's `currentBoard` else-chain falls back to the newest
   modified board, which is the one the whiteboard widget last saved.
"""
import os
import re
import subprocess
import sys

SRC = "src/lithic.html"
OUT = "scripts/_test_whiteboard.html"
CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"

TEST_JS = r"""
<script>
(function() {
    var results = [];
    function check(name, ok, detail) {
        results.push((ok ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : ""));
    }
    function finish() {
        var out = document.getElementById("out");
        if (!out) {
            out = document.createElement("pre");
            out.id = "out";
            document.body.appendChild(out);
        }
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
        if (!window.$tw || !$tw.wiki || !$tw.rootWidget) {
            if (tries > 300) { results.push("FAIL | boot timeout"); finish(); clearInterval(iv); }
            return;
        }
        clearInterval(iv);
        try {
            run();
        } catch (e) {
            results.push("FAIL | exception: " + (e && e.stack ? e.stack : e));
        }
        finish();
    }, 50);

    function run() {
        var wiki = $tw.wiki;
        var probe = wiki.getTiddler("$:/plugins/sq/streams");
        check("boot", !!probe, "streams plugin present: " + !!probe);

        // ---- 1. State tiddlers are NOT saved (default filters, no patches) ----
        var saverSet = wiki.filterTiddlers(wiki.getTiddlerText("$:/config/SaverFilter", ""));
        var bsSet = wiki.filterTiddlers(wiki.getTiddlerText("$:/config/BrowserStorage/SaveFilter", ""));
        check("state-board-not-in-saver",
              saverSet.indexOf("$:/state/Whiteboard/PageLayout/tiddler") === -1,
              "active board state NOT persisted");
        check("state-board-not-in-browserstorage",
              bsSet.indexOf("$:/state/Whiteboard/PageLayout/tiddler") === -1,
              "active board state NOT in BrowserStorage filter");

        // ---- 2. Create three boards with distinct modified timestamps ----
        function boardJson(name) {
            return '{"document":{"id":"doc","name":"' + name + '","version":15.5,' +
                '"pages":{"page":{"id":"page","name":"Page 1","childIndex":1,"shapes":{},"bindings":{}}},' +
                '"pageStates":{"page":{"id":"page","selectedIds":[],"camera":{"point":[0,0],"zoom":1}}},' +
                '"assets":{}},"updatedCount":1}';
        }
        function createBoard(title, when) {
            wiki.addTiddler(new $tw.Tiddler({
                title: title, type: "application/tldr",
                text: boardJson(title),
                modified: new Date(when)
            }));
        }
        createBoard("AAA Oldest Board", Date.UTC(2026, 6, 26, 10, 0, 0));
        createBoard("BBB Middle Board", Date.UTC(2026, 6, 26, 11, 0, 0));
        createBoard("CCC Newest Board", Date.UTC(2026, 6, 26, 12, 0, 0));

        var base = "[all[shadows+tiddlers]field:type[application/tldr]!prefix[$:/temp]";

        // ---- 3. sort[modified] direction + DefaultCanvas interference ----
        var ascFirst = wiki.filterTiddlers(base + "sort[modified]first[]]")[0];
        var descFirst = wiki.filterTiddlers(base + "!sort[modified]first[]]")[0];
        var descAll = wiki.filterTiddlers(base + "!sort[modified]]");
        results.push("INFO | descending order: " + descAll.join(" > "));
        check("ascending-picks-blank-defaultcanvas", ascFirst === "$:/DefaultCanvas",
              "old reopen default = " + ascFirst + " (blank template, not user's board)");
        check("descending-picks-newest", descFirst === "CCC Newest Board", "got: " + descFirst);

        // ---- 4. Cycling: bump the displayed board's modified, re-evaluate ----
        // The whiteboard widget saves the displayed board via onSave, bumping its
        // `modified`. With ascending sort the saved board sorts LAST, so first[]
        // jumps to a different board. With descending sort it stays first.
        wiki.addTiddler(new $tw.Tiddler(wiki.getTiddler("CCC Newest Board"),
            {modified: $tw.utils.stringifyDate(new Date())}));
        var afterSaveAsc = wiki.filterTiddlers(base + "sort[modified]first[]]")[0];
        check("ascending-flips-after-save", afterSaveAsc !== "CCC Newest Board",
              "after saving displayed board, old default flipped to: " + afterSaveAsc);

        var descAll2 = wiki.filterTiddlers(base + "!sort[modified]]");
        results.push("INFO | after-save descending order: " + descAll2.join(" > "));
        var afterSaveDesc = wiki.filterTiddlers(base + "!sort[modified]first[]]")[0];
        check("descending-stable-after-save", afterSaveDesc === "CCC Newest Board",
              "displayed board stayed: " + afterSaveDesc);

        // ---- 5. Reopen: state tiddler was NOT saved, so it's empty on reload ----
        // The layout's currentBoard is a `~` else-chain: with no saved state it
        // falls back to the newest board (the one the widget last saved).
        var stateBoard = wiki.getTiddlerText("$:/state/Whiteboard/PageLayout/tiddler");
        check("state-empty-on-reload", !stateBoard, "state text: " + JSON.stringify(stateBoard));
        var currentBoard = wiki.filterTiddlers(
            "[[$:/state/Whiteboard/PageLayout/tiddler]get[text]] ~[all[shadows+tiddlers]field:type[application/tldr]!prefix[$:/temp]!sort[modified]first[]]")[0];
        check("reopen-falls-back-to-newest", currentBoard === "CCC Newest Board",
              "reopen shows the newest board, got: " + currentBoard);
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
    html = html.replace("</body>", TEST_JS, 1)
    with open(OUT, "wb") as f:
        f.write(html.encode("utf-8"))
    abs_out = os.path.abspath(OUT).replace("\\", "/")
    cmd = [
        CHROME, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--virtual-time-budget=60000", "--dump-dom", "file:///" + abs_out,
    ]
    proc = subprocess.run(cmd, capture_output=True, timeout=180)
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
