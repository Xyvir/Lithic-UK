#!/usr/bin/env node
/**
 * Headless validation of the whiteboard prev/next page navigation buttons
 * (Lithic/Patches/Whiteboard/PageNav.js + PageNavStyle).
 *
 * Boots the built monolith (src/lithic.html) with the two page-nav tiddlers
 * injected into the store (written to scratch/), opens the REAL whiteboard
 * layout in Puppeteer (system Chrome, or Puppeteer's bundled Chromium), and
 * verifies against the real mounted boards:
 *
 * 1. Both tiddlers are loaded and the whiteboard mounts (canvas present).
 * 2. Prev/next buttons appear as siblings to the RIGHT of the page dropdown.
 * 3. On a two-page board: prev disabled / next enabled on page 1; clicking
 *    next lands on page 2 (label changes, states flip); clicking prev returns
 *    to page 1; clicking prev at the first page does nothing.
 * 4. The dropdown menu never opens as a side effect of clicking the buttons.
 * 5. Spam-clicking next across a 4-page board iterates every page (no drops).
 * 6. Switching to a single-page board disables both buttons.
 *
 * Run:  node scripts/_test_whiteboard_pagenav.mjs
 *       HEADED=1 node scripts/_test_whiteboard_pagenav.mjs   (visible window)
 *       CHROME=/path/to/chrome node scripts/_test_whiteboard_pagenav.mjs
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src", "lithic.html");
const TIDS = [
  path.join(
    ROOT,
    "wiki",
    "local-plugins",
    "lithic-patch-whiteboard",
    "$__Lithic_Patches_Whiteboard_PageNav.js.tid"
  ),
  path.join(
    ROOT,
    "wiki",
    "local-plugins",
    "lithic-patch-whiteboard",
    "$__Lithic_Patches_Whiteboard_PageNavStyle.css.tid"
  )
];
const OUT = path.join(ROOT, "scratch", "_test_whiteboard-pagenav.html");

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

const TWO_PAGE_JSON =
  '{"document":{"id":"doc-nav","name":"Nav Board","version":15.5,' +
  '"pages":{"page":{"id":"page","name":"Page 1","childIndex":1,"shapes":{},"bindings":{}},' +
  '"page2":{"id":"page2","name":"Page 2","childIndex":2,"shapes":{},"bindings":{}}},' +
  '"pageStates":{"page":{"id":"page","selectedIds":[],"camera":{"point":[0,0],"zoom":1}},' +
  '"page2":{"id":"page2","selectedIds":[],"camera":{"point":[0,0],"zoom":1}}},' +
  '"assets":{}},"updatedCount":0}';

const SINGLE_PAGE_JSON =
  '{"document":{"id":"doc-solo","name":"Solo Board","version":15.5,' +
  '"pages":{"page":{"id":"page","name":"Solo Page","childIndex":1,"shapes":{},"bindings":{}}},' +
  '"pageStates":{"page":{"id":"page","selectedIds":[],"camera":{"point":[0,0],"zoom":1}}},' +
  '"assets":{}},"updatedCount":0}';

const QUAD_PAGE_JSON =
  '{"document":{"id":"doc-quad","name":"Quad Board","version":15.5,' +
  '"pages":{"page":{"id":"page","name":"Page 1","childIndex":1,"shapes":{},"bindings":{}},' +
  '"page2":{"id":"page2","name":"Page 2","childIndex":2,"shapes":{},"bindings":{}},' +
  '"page3":{"id":"page3","name":"Page 3","childIndex":3,"shapes":{},"bindings":{}},' +
  '"page4":{"id":"page4","name":"Page 4","childIndex":4,"shapes":{},"bindings":{}}},' +
  '"pageStates":{"page":{"id":"page","selectedIds":[],"camera":{"point":[0,0],"zoom":1}},' +
  '"page2":{"id":"page2","selectedIds":[],"camera":{"point":[0,0],"zoom":1}},' +
  '"page3":{"id":"page3","selectedIds":[],"camera":{"point":[0,0],"zoom":1}},' +
  '"page4":{"id":"page4","selectedIds":[],"camera":{"point":[0,0],"zoom":1}}},' +
  '"assets":{}},"updatedCount":0}';

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

    var LAYOUT = "$:/plugins/linonetwo/tw-whiteboard/tiddlywiki-ui/PageLayout/WhiteBoard";
    var STATE = "$:/state/Whiteboard/PageLayout/tiddler";
    var MODULE = "$:/Lithic/Patches/Whiteboard/PageNav.js";
    var STYLE = "$:/Lithic/Patches/Whiteboard/PageNavStyle";

    function canvasEl() {
        return document.querySelector(".tw-whiteboard-tldraw-container .tl-canvas") ||
               document.querySelector(".tw-whiteboard-tldraw-container");
    }
    function triggerEl() {
        return document.querySelector(".tw-whiteboard-tldraw-container #TD-Page");
    }
    function prevBtn()  { return document.querySelector(".tw-whiteboard-tldraw-container .lithic-wb-page-prev"); }
    function nextBtn()  { return document.querySelector(".tw-whiteboard-tldraw-container .lithic-wb-page-next"); }
    function pageLabel() { var t = triggerEl(); return t ? t.textContent.trim() : null; }
    function menuOpen() { return !!document.querySelector('[role="menu"], [data-state="open"][role="menu"]'); }
    async function waitFor(fn, ms, what) {
        var deadline = Date.now() + ms;
        while (Date.now() < deadline) {
            var v = fn();
            if (v) return v;
            await sleep(100);
        }
        if (what) info("timeout waiting for " + what);
        return null;
    }

    async function run() {
        var wiki = $tw.wiki;
        check("module-loaded", !!wiki.getTiddler(MODULE), "PageNav.js present in store");
        check("style-loaded", !!wiki.getTiddler(STYLE), "PageNavStyle present in store");
        check("layout-tiddler-exists", !!wiki.getTiddler(LAYOUT), "WhiteBoard layout present");

        wiki.addTiddler(new $tw.Tiddler({title: "Nav Board", type: "application/tldr", text: ${JSON.stringify(TWO_PAGE_JSON)}}));
        wiki.setText(STATE, undefined, undefined, "Nav Board");
        wiki.setText("$:/layout", undefined, undefined, LAYOUT);

        var canvas = await waitFor(canvasEl, 60000, "canvas mount");
        check("board-mounted", !!canvas, canvas ? "" : "no tldraw container after 60s");
        if (!canvas) { finish(); return; }

        var trigger = await waitFor(triggerEl, 10000, "page dropdown");
        check("page-dropdown-present", !!trigger, trigger ? "label=" + pageLabel() : "");
        if (!trigger) { finish(); return; }

        var prev = await waitFor(prevBtn, 10000, "prev button insertion");
        var next = await waitFor(nextBtn, 5000, "next button insertion");
        check("prev-button-inserted", !!prev);
        check("next-button-inserted", !!next);
        if (!prev || !next) { finish(); return; }

        // The buttons must sit to the RIGHT of the page select dropdown.
        var afterTrigger = trigger.nextElementSibling;
        var orderOk =
            afterTrigger === prev &&
            prev.nextElementSibling === next &&
            prev.classList.contains("lithic-wb-page-prev") &&
            next.classList.contains("lithic-wb-page-next");
        check("buttons-right-of-dropdown", orderOk);

        // Both glyphs are always in the DOM; the visible one is chosen by CSS
        // (:disabled). Report which is actually shown via computed display.
        function glyphOf(btn) {
            if (!btn) return null;
            var chev = btn.querySelector(".lithic-wb-glyph-chevron");
            var dot = btn.querySelector(".lithic-wb-glyph-dot");
            var dotShown = dot ? getComputedStyle(dot).display !== "none" : false;
            if (dotShown) return "dot";
            var poly = chev ? chev.querySelector("polyline") : null;
            if (poly) return poly.getAttribute("points");
            return "none";
        }
        check("initial-prev-dot", glyphOf(prev) === "dot", "prev glyph=" + glyphOf(prev));
        check("initial-next-chevron", glyphOf(next) === "9 18 15 12 9 6", "next glyph=" + glyphOf(next));
        check("prev-button-width",
            prev.getBoundingClientRect().width >= 34,
            "width=" + prev.getBoundingClientRect().width.toFixed(1));

        // Buttons must be vertically centred on the dropdown trigger.
        var trigC = trigger.getBoundingClientRect().top + trigger.getBoundingClientRect().height / 2;
        var prevC = prev.getBoundingClientRect().top + prev.getBoundingClientRect().height / 2;
        var nextC = next.getBoundingClientRect().top + next.getBoundingClientRect().height / 2;
        check("buttons-centered-with-dropdown",
            Math.abs(prevC - trigC) <= 2 && Math.abs(nextC - trigC) <= 2,
            "triggerC=" + trigC.toFixed(1) + " prevC=" + prevC.toFixed(1) + " nextC=" + nextC.toFixed(1));

        // Initial state on a two-page board: page 1 -> prev off, next on.
        check("initial-page-1", pageLabel() === "Page 1", "label=" + pageLabel());
        check("initial-prev-disabled", prev.disabled === true, "prev.disabled=" + prev.disabled);
        check("initial-next-enabled", next.disabled === false, "next.disabled=" + next.disabled);

        // Next: jump to page 2.
        next.click();
        var label2 = await waitFor(function() { return pageLabel() === "Page 2" ? pageLabel() : null; }, 5000, "page 2 label");
        check("next-navigates", label2 === "Page 2", "label=" + pageLabel());
        // Give the MutationObserver a beat to refresh disabled state.
        var flips = await waitFor(function() {
            var p = prevBtn(), n = nextBtn();
            if (!p || !n) return null;
            return (p.disabled === false && n.disabled === true) ? true : null;
        }, 5000, "disabled-state flip after next");
        check("after-next-prev-enabled", !!flips, "prev=" + prevBtn().disabled + " next=" + nextBtn().disabled);
        check("after-next-prev-chevron", glyphOf(prevBtn()) === "15 18 9 12 15 6", "prev glyph=" + glyphOf(prevBtn()));
        check("after-next-next-dot", glyphOf(nextBtn()) === "dot", "next glyph=" + glyphOf(nextBtn()));

        // Prev: back to page 1.
        prev.click();
        var label1 = await waitFor(function() { return pageLabel() === "Page 1" ? pageLabel() : null; }, 5000, "page 1 label");
        check("prev-navigates", label1 === "Page 1", "label=" + pageLabel());
        var flipsBack = await waitFor(function() {
            var p = prevBtn(), n = nextBtn();
            if (!p || !n) return null;
            return (p.disabled === true && n.disabled === false) ? true : null;
        }, 5000, "disabled-state flip after prev");
        check("after-prev-next-enabled", !!flipsBack, "prev=" + prevBtn().disabled + " next=" + nextBtn().disabled);
        check("after-prev-prev-dot", glyphOf(prevBtn()) === "dot", "prev glyph=" + glyphOf(prevBtn()));
        check("after-prev-next-chevron", glyphOf(nextBtn()) === "9 18 15 12 9 6", "next glyph=" + glyphOf(nextBtn()));

        // Prev at the first page is a no-op.
        prev.click();
        await sleep(600);
        check("prev-at-first-noop", pageLabel() === "Page 1", "label=" + pageLabel());

        // The dropdown must never open as a side effect of our clicks.
        check("dropdown-not-opened", !menuOpen(), menuOpen() ? "a menu appeared" : "");

        // Spam-clicking next must iterate every page with no dropped clicks:
        // 6 rapid clicks on a 4-page board must land on page 4 (then no-op).
        wiki.addTiddler(new $tw.Tiddler({title: "Quad Board", type: "application/tldr", text: ${JSON.stringify(QUAD_PAGE_JSON)}}));
        var preQuadTrig = triggerEl();
        wiki.setText(STATE, undefined, undefined, "Quad Board");
        // Board switches remount the whiteboard (new trigger node); both the
        // old and new boards read "Page 1", so wait for the remount itself.
        var quadReady = await waitFor(function() {
            var t = triggerEl();
            if (!t || t === preQuadTrig) return null;
            return t.textContent.trim() === "Page 1" ? t : null;
        }, 8000, "quad board remount");
        check("quad-board-loaded", !!quadReady, "label=" + pageLabel());
        for (var s = 0; s < 6; s++) {
            var b = nextBtn();
            if (b && !b.disabled) b.click();
        }
        var quadEnd = await waitFor(function() { return pageLabel() === "Page 4" ? pageLabel() : null; }, 5000, "quad board end");
        check("rapid-clicks-iterate-all-pages", quadEnd === "Page 4", "label=" + pageLabel());
        var quadNext = nextBtn();
        check("rapid-clicks-end-disabled", !!quadNext && quadNext.disabled === true,
            "next.disabled=" + (quadNext ? quadNext.disabled : "gone"));
        check("rapid-clicks-end-dot", glyphOf(nextBtn()) === "dot", "next glyph=" + glyphOf(nextBtn()));

        // Switch to a single-page board: both buttons disabled.
        wiki.addTiddler(new $tw.Tiddler({title: "Solo Board", type: "application/tldr", text: ${JSON.stringify(SINGLE_PAGE_JSON)}}));
        wiki.setText(STATE, undefined, undefined, "Solo Board");
        var soloLabel = await waitFor(function() { return pageLabel() === "Solo Page" ? pageLabel() : null; }, 8000, "solo board load");
        check("solo-board-loaded", soloLabel === "Solo Page", "label=" + pageLabel());
        var bothOff = await waitFor(function() {
            var p = prevBtn(), n = nextBtn();
            if (!p || !n) return null;
            return (p.disabled === true && n.disabled === true) ? true : null;
        }, 5000, "both disabled on single-page board");
        check("single-page-both-disabled", !!bothOff,
            "prev=" + (prevBtn() ? prevBtn().disabled : "gone") + " next=" + (nextBtn() ? nextBtn().disabled : "gone"));

        finish();
    }
})();
</script>
`;

/** Build the tiddler-injected copy of the built wiki. */
function buildTestHtml() {
  if (!existsSync(SRC)) {
    throw new Error("missing " + SRC);
  }
  const STORE_OPEN = '<script class="tiddlywiki-tiddler-store" type="application/json">';
  let html = readFileSync(SRC, "utf8");
  const storeStart = html.indexOf(STORE_OPEN);
  if (storeStart === -1) {
    throw new Error("no tiddlywiki-tiddler-store script found in " + SRC);
  }
  const storeBodyStart = storeStart + STORE_OPEN.length;
  const storeBodyEnd = html.indexOf("</script>", storeBodyStart);
  if (storeBodyEnd === -1) {
    throw new Error("unterminated tiddlywiki-tiddler-store script in " + SRC);
  }
  const store = JSON.parse(html.slice(storeBodyStart, storeBodyEnd));
  const ts = twTimestamp(new Date());
  const additions = [];
  for (const tid of TIDS) {
    const { fields, body } = parseTid(tid);
    additions.push({
      title: fields.title,
      type: fields.type,
      "module-type": fields["module-type"],
      tags: fields.tags,
      text: body,
      created: ts,
      modified: ts
    });
  }
  // Idempotent: never duplicate a tiddler that is already in the store.
  const newOnes = additions.filter(
    (t) => !store.some((existing) => existing.title === t.title)
  );
  if (newOnes.length) {
    const lastBracket = html.lastIndexOf("]", storeBodyEnd);
    const insert =
      (store.length > 1 ? "," : "") +
      newOnes.map((t) => JSON.stringify(t)).join(",");
    html =
      html.slice(0, lastBracket) +
      insert +
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