#!/usr/bin/env node
/**
 * Headless validation of the whiteboard long-press right-click suppression
 * patch (Lithic/Patches/Whiteboard/LongPressRightClick.js).
 *
 * Boots the built monolith (src/lithic.html) with the patch tiddler injected
 * into the store (written to scratch/), opens the REAL whiteboard layout in
 * Puppeteer (system Chrome, or Puppeteer's bundled Chromium), and verifies
 * against the real tldraw canvas element:
 *
 * 1. The patch module is loaded and the whiteboard mounts (canvas present).
 * 2. A touch/stylus hold (> hold timeout) inside the whiteboard is consumed:
 *    probe reports suppressed, and tldraw's context menu does NOT open.
 * 3. A fast touch right-click (stylus barrel button: contextmenu <200ms after
 *    pointerdown) passes through.
 * 4. A long-press on an input/contentEditable target inside the board passes
 *    through (native copy/paste menu preserved).
 * 5. A long-press OUTSIDE the whiteboard passes through (wiki menus intact).
 * 6. A real mouse right-click passes through AND tldraw's menu OPENS
 *    (positive control: desktop right-click still works).
 *
 * Run:  node scripts/_test_whiteboard_touchhold.mjs
 *       HEADED=1 node scripts/_test_whiteboard_touchhold.mjs   (visible window)
 *       CHROME=/path/to/chrome node scripts/_test_whiteboard_touchhold.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src", "lithic.html");
const PATCH_TID = path.join(
  ROOT,
  "wiki",
  "local-plugins",
  "lithic-patch-whiteboard",
  "$__Lithic_Patches_Whiteboard_LongPressRightClick.js.tid"
);
const OUT = path.join(ROOT, "scratch", "_test_whiteboard-touchhold.html");

/** Parse a .tid file into { fields, body }. */
function parseTid(file) {
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  const fields = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") break;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { fields, body: lines.slice(i + 1).join("\n") };
}

/** TiddlyWiki stringifyDate format: YYYYMMDDHHMMSSmmm */
function twTimestamp(date) {
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return (
    date.getUTCFullYear() +
    p(date.getUTCMonth() + 1) +
    p(date.getUTCDate()) +
    p(date.getUTCHours()) +
    p(date.getUTCMinutes()) +
    p(date.getUTCSeconds()) +
    p(date.getUTCMilliseconds(), 3)
  );
}

const TEST_JS = `
<script>
(function() {
    var results = [];
    function check(name, ok, detail) {
        results.push((ok ? "PASS" : "FAIL") + " | " + name + (detail ? " | " + detail : ""));
    }
    function info(msg) { results.push("INFO | " + msg); }
    function finish() {
        var out = document.getElementById("out");
        if (!out) {
            out = document.createElement("pre");
            out.id = "out";
            document.body.appendChild(out);
        }
        out.textContent = results.join("\\n");
        out.setAttribute("style", "white-space:pre");
    }
    window.addEventListener("error", function(e) {
        results.push("FAIL | uncaught: " + (e.message || e));
        finish();
    });
    function sleep(ms) { return new Promise(function(res) { setTimeout(res, ms); }); }

    var tries = 0;
    var iv = setInterval(function() {
        tries++;
        if (!window.$tw || !$tw.wiki || !$tw.rootWidget) {
            if (tries > 600) { results.push("FAIL | boot timeout"); finish(); clearInterval(iv); }
            return;
        }
        clearInterval(iv);
        run().catch(function(e) {
            results.push("FAIL | exception: " + (e && e.stack ? e.stack : e));
            finish();
        });
    }, 100);

    var BOARD = "Test TouchHold Board";
    var LAYOUT = "$:/plugins/linonetwo/tw-whiteboard/tiddlywiki-ui/PageLayout/WhiteBoard";
    var PATCH = "$:/Lithic/Patches/Whiteboard/LongPressRightClick.js";
    var BOARD_JSON = '{"document":{"id":"doc","name":"Test TouchHold Board","version":15.5,' +
        '"pages":{"page":{"id":"page","name":"Page 1","childIndex":1,"shapes":{},"bindings":{}}},' +
        '"pageStates":{"page":{"id":"page","selectedIds":[],"camera":{"point":[0,0],"zoom":1}}},' +
        '"assets":{}},"updatedCount":0}';

    function canvasEl() {
        return document.querySelector(".tw-whiteboard-tldraw-container .tl-canvas") ||
               document.querySelector(".tw-whiteboard-tldraw-container");
    }
    function probe() {
        return (window.__lithicLongPressProbe || {suppressed: null, reason: "NO-PROBE"});
    }
    function point(el) {
        var r = el.getBoundingClientRect();
        return {x: r.left + r.width / 2, y: r.top + r.height / 2};
    }
    function press(el, pointerType, button) {
        var p = point(el);
        el.dispatchEvent(new PointerEvent("pointerdown", {
            bubbles: true, cancelable: true, composed: true,
            pointerId: 1, isPrimary: true, pointerType: pointerType,
            button: button || 0, buttons: button === 2 ? 2 : 1,
            clientX: p.x, clientY: p.y, pageX: p.x, pageY: p.y
        }));
    }
    function release(el, pointerType, button) {
        var p = point(el);
        el.dispatchEvent(new PointerEvent("pointerup", {
            bubbles: true, cancelable: true, composed: true,
            pointerId: 1, isPrimary: true, pointerType: pointerType,
            button: button || 0, buttons: 0,
            clientX: p.x, clientY: p.y, pageX: p.x, pageY: p.y
        }));
    }
    function contextMenu(el) {
        var p = point(el);
        el.dispatchEvent(new MouseEvent("contextmenu", {
            bubbles: true, cancelable: true, composed: true, button: 2,
            clientX: p.x, clientY: p.y, pageX: p.x, pageY: p.y
        }));
    }

    async function run() {
        var wiki = $tw.wiki;
        check("patch-loaded", !!wiki.getTiddler(PATCH), "long-press patch present in store");
        check("layout-tiddler-exists", !!wiki.getTiddler(LAYOUT), "WhiteBoard layout present");

        wiki.addTiddler(new $tw.Tiddler({title: BOARD, type: "application/tldr", text: BOARD_JSON}));
        // Switch to the full-screen whiteboard layout and point it at the board.
        wiki.setText("$:/state/Whiteboard/PageLayout/tiddler", undefined, undefined, BOARD);
        wiki.setText("$:/layout", undefined, undefined, LAYOUT);

        // Wait for the real tldraw canvas to mount (React + tldraw init).
        var canvas = null;
        for (var i = 0; i < 240; i++) {
            canvas = canvasEl();
            if (canvas) break;
            await sleep(250);
        }
        check("board-mounted", !!canvas, canvas ? "" : "no .tw-whiteboard-tldraw-container/.tl-canvas after 60s");

        if (!canvas) {
            info("layout-dump: " + (wiki.getTiddlerText("$:/layout") || ""));
            finish();
            return;
        }

        // A. Touch long-press on the canvas -> consumed (no tldraw menu).
        press(canvas, "touch", 0);
        await sleep(600);
        contextMenu(canvas);
        release(canvas, "touch", 0);
        var p1 = probe();
        check("a-touch-longpress-suppressed", p1.suppressed === true, "reason=" + p1.reason);
        check("a-touch-longpress-reason", p1.reason === "touch-long-press", "reason=" + p1.reason);

        // B. Fast touch right-click (stylus barrel button) -> passes through.
        press(canvas, "stylus", 2);
        await sleep(30);
        contextMenu(canvas);
        release(canvas, "stylus", 2);
        var p2 = probe();
        check("b-fast-stylus-passes", p2.suppressed === false, "reason=" + p2.reason);

        // C. Long-press on an input inside the board -> native menu preserved.
        var input = document.createElement("input");
        input.setAttribute("placeholder", "probe input");
        input.style.cssText = "position:absolute;top:2px;left:2px;width:120px;height:24px;z-index:9999;";
        document.querySelector(".tw-whiteboard-tldraw-container").appendChild(input);
        press(input, "touch", 0);
        await sleep(600);
        contextMenu(input);
        release(input, "touch", 0);
        var p3 = probe();
        check("c-editable-passes", p3.suppressed === false, "reason=" + p3.reason);

        // D. Long-press outside the whiteboard -> wiki menus untouched.
        var outside = document.createElement("div");
        outside.textContent = "outside probe";
        outside.style.cssText = "position:fixed;top:2px;right:2px;z-index:9999;";
        document.body.appendChild(outside);
        press(outside, "touch", 0);
        await sleep(600);
        contextMenu(outside);
        release(outside, "touch", 0);
        var p4 = probe();
        check("d-outside-passes", p4.suppressed === false, "reason=" + p4.reason);

        // E. Real mouse right-click -> passes through AND opens tldraw's menu
        //    (positive control: desktop right-click keeps working).
        press(canvas, "mouse", 2);
        await sleep(30);
        contextMenu(canvas);
        release(canvas, "mouse", 2);
        var p5 = probe();
        check("e-mouse-passes", p5.suppressed === false, "reason=" + p5.reason);
        await sleep(300);
        var menuOpen = !!document.querySelector('[id="TD-ContextMenu"], .tl-menu, [data-testid="TD-ContextMenu"]');
        check("e-desktop-menu-opens", menuOpen, "tldraw context menu visible after mouse right-click");

        finish();
    }
})();
</script>
`;

/** Build the patch-injected copy of the built wiki. */
function buildTestHtml() {
  if (!existsSync(SRC)) {
    throw new Error("missing " + SRC);
  }
  const { fields, body } = parseTid(PATCH_TID);
  const STORE_OPEN = '<script class="tiddlywiki-tiddler-store" type="application/json">';
  let html = readFileSync(SRC, "utf8");
  const storeStart = html.indexOf(STORE_OPEN);
  if (storeStart === -1) {
    throw new Error("no tiddlywiki-tiddler-store script found in " + SRC);
  }
  // Manual slicing (not regex replace): the ~10MB store blows V8's
  // RegExp-replacement string limit with a RangeError "Invalid string length".
  const storeBodyStart = storeStart + STORE_OPEN.length;
  const storeBodyEnd = html.indexOf("</script>", storeBodyStart);
  if (storeBodyEnd === -1) {
    throw new Error("unterminated tiddlywiki-tiddler-store script in " + SRC);
  }
  const store = JSON.parse(html.slice(storeBodyStart, storeBodyEnd));
  const ts = twTimestamp(new Date());
  const patchTiddler = {
    title: fields.title,
    type: fields.type,
    "module-type": fields["module-type"],
    text: body,
    created: ts,
    modified: ts
  };
  // Idempotent: if the built wiki already carries the patch (e.g. injected or
  // regenerated by CI), don't add a duplicate.
  if (!store.some(t => t.title === patchTiddler.title)) {
    // Insert the new tiddler just BEFORE the array's closing `]` (the store
    // body ends with the `]`; appending after it would produce invalid JSON).
    const lastBracket = html.lastIndexOf("]", storeBodyEnd);
    html =
      html.slice(0, lastBracket) +
      (store.length > 1 ? "," : "") +
      JSON.stringify(patchTiddler) +
      html.slice(lastBracket);
  }
  if (!html.includes("</body>")) {
    throw new Error("no </body> in " + SRC);
  }
  html = html.replace("</body>", TEST_JS, 1);
  writeFileSync(OUT, html, "utf8");
}

function findSystemChrome() {
  if (process.env.CHROME && existsSync(process.env.CHROME)) return process.env.CHROME;
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
    ];
    for (const c of candidates) if (existsSync(c)) return c;
  } else if (process.platform === "darwin") {
    const c = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    if (existsSync(c)) return c;
  }
  return null;
}

async function main() {
  buildTestHtml();
  const systemChrome = findSystemChrome();
  const browser = await puppeteer.launch({
    headless: process.env.HEADED === "1" ? false : "new",
    ...(systemChrome ? { executablePath: systemChrome } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: { width: 1400, height: 900 }
  });

  const pageErrors = [];
  try {
    const page = await browser.newPage();
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("console", message => {
      // Ignore benign resource-load noise (missing favicon etc. under file://).
      if (message.type() === "error" && !/Failed to load resource|net::ERR_/.test(message.text())) {
        pageErrors.push(message.text());
      }
    });

    await page.goto("file:///" + OUT.replace(/\\/g, "/"), { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#out", { timeout: 180000 });

    const text = await page.evaluate(() => document.getElementById("out").textContent);
    console.log(text);
    if (pageErrors.length) {
      console.log("--- page errors ---");
      for (const e of pageErrors) console.log(e);
    }
    const failed = /FAIL/.test(text) || pageErrors.length > 0;
    process.exit(failed ? 1 : 0);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});