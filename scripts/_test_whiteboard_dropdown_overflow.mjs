#!/usr/bin/env node
/**
 * Regression test for the whiteboard page-select dropdown overflowing the
 * bottom of the viewport when a board has many pages.
 *
 * Upstream bug: tldraw's menu panel is hardcoded to max-height: 100vh and is
 * anchored below the trigger, so on the full-screen whiteboard layout its
 * bottom ~44px is permanently off-screen - the internal scrollbar can never
 * bring the last item ("Create page") above the fold, making it unclickable.
 * The patch ($:/Lithic/Patches/Whiteboard/PageMenuOverflow) overrides the
 * panel's max-height with radix's own --radix-dropdown-menu-content-
 * available-height, which is exactly the viewport space below the trigger.
 *
 * This test boots the built monolith (src/lithic.html) with the patch
 * tiddler injected into the store, mounts a 30-page board, opens the real
 * page dropdown, scrolls it to the bottom, and verifies with a REAL mouse
 * click that "Create page" is visible, hittable, and actually creates a page.
 *
 * Run:  node scripts/_test_whiteboard_dropdown_overflow.mjs
 *       HEADED=1 node scripts/_test_whiteboard_dropdown_overflow.mjs
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
    "$__Lithic_Patches_Whiteboard_PageMenuOverflow.css.tid"
  )
];
const OUT = path.join(ROOT, "scratch", "_test_whiteboard-dropdown-overflow.html");

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

// A board with 30 pages - enough to overflow the menu panel in a 900px viewport.
const PAGES = {};
const STATES = {};
for (let i = 1; i <= 30; i++) {
  PAGES["page" + i] = { id: "page" + i, name: "Page " + i, childIndex: i, shapes: {}, bindings: {} };
  STATES["page" + i] = { id: "page" + i, selectedIds: [], camera: { point: [0, 0], zoom: 1 } };
}
const MANY_JSON = JSON.stringify({
  document: { id: "doc-many", name: "Many Board", version: 15.5, pages: PAGES, pageStates: STATES, assets: {} },
  updatedCount: 0
});

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
        if (!out) { out = document.createElement("pre"); out.id = "out"; document.body.appendChild(out); }
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
    var STYLE = "$:/Lithic/Patches/Whiteboard/PageMenuOverflow";

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
        check("style-loaded", !!wiki.getTiddler(STYLE), "PageMenuOverflow present in store");

        wiki.addTiddler(new $tw.Tiddler({title: "Many Board", type: "application/tldr", text: ${JSON.stringify(MANY_JSON)}}));
        wiki.setText(STATE, undefined, undefined, "Many Board");
        wiki.setText("$:/layout", undefined, undefined, LAYOUT);

        var trigger = await waitFor(function() {
            return document.querySelector(".tw-whiteboard-tldraw-container #TD-Page");
        }, 60000, "page dropdown");
        check("board-mounted", !!trigger, trigger ? "label=" + trigger.textContent.trim() : "");
        if (!trigger) { finish(); return; }

        // Open the page dropdown with a real pointer interaction.
        var rect = trigger.getBoundingClientRect();
        trigger.dispatchEvent(new PointerEvent("pointerdown", {
            bubbles: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2
        }));
        await sleep(50);
        trigger.click();
        await sleep(600);

        var menu = document.querySelector('[role="menu"]') || document.querySelector('[data-radix-menu-content]');
        check("menu-open", !!menu);
        if (!menu) { finish(); return; }

        // The patch must have constrained the panel to the viewport:
        // bottom <= innerHeight (upstream it sits ~44px past the fold).
        var mrect = menu.getBoundingClientRect();
        check("menu-bottom-within-viewport",
            mrect.bottom <= window.innerHeight + 1,
            "menu bottom=" + mrect.bottom.toFixed(1) + " vh=" + window.innerHeight);
        check("menu-scrollable", menu.scrollHeight > menu.clientHeight,
            "scrollH=" + menu.scrollHeight + " clientH=" + menu.clientHeight);

        // Find the "Create page" item at the very bottom of the menu.
        var newPageItem = null;
        var items = menu.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="radio"]');
        for (var i = 0; i < items.length; i++) {
            if (/new page|create page/i.test(items[i].textContent)) { newPageItem = items[i]; break; }
        }
        check("new-page-item-found", !!newPageItem, newPageItem ? "text=" + newPageItem.textContent.trim().slice(0, 30) : "");
        if (!newPageItem) { finish(); return; }

        // Scroll the panel to the bottom like a user would.
        menu.scrollTop = menu.scrollHeight;
        await sleep(250);
        var nr = newPageItem.getBoundingClientRect();
        check("new-page-in-viewport-after-scroll",
            nr.top >= 0 && nr.bottom <= window.innerHeight,
            "top=" + nr.top.toFixed(1) + " bottom=" + nr.bottom.toFixed(1) + " vh=" + window.innerHeight);

        // Real browser hit-testing at the item's center.
        var cx = nr.left + nr.width / 2, cy = nr.top + nr.height / 2;
        var hit = document.elementFromPoint(cx, cy);
        var hitIsItem = !!hit && (hit === newPageItem || newPageItem.contains(hit));
        check("new-page-hittable", hitIsItem, hitIsItem ? "" : "hit=" + (hit ? hit.tagName : "null"));

        // Hand the coordinates to the Node side for a REAL mouse click.
        window.__pagenav = {
            cx: cx,
            cy: cy,
            beforeCount: Object.keys(JSON.parse(wiki.getTiddler("Many Board").fields.text).document.pages).length,
            vh: window.innerHeight,
            vw: window.innerWidth
        };
        info("ready-for-real-click cx=" + cx.toFixed(1) + " cy=" + cy.toFixed(1));
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
      tags: fields.tags,
      text: body,
      created: ts,
      modified: ts
    });
  }
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
    await page.waitForFunction("window.__pagenav !== undefined", { timeout: 180000 });

    // REAL mouse click on "Create page" at its on-screen coordinates.
    const coords = await page.evaluate(() => window.__pagenav);
    if (coords.cy > coords.vh || coords.cx < 0 || coords.cx > coords.vw) {
      console.log("FAIL | new-page-real-click | target outside viewport (unreachable)");
    } else {
      await page.mouse.click(coords.cx, coords.cy);
      await new Promise(r => setTimeout(r, 1200));
      const after = await page.evaluate(() =>
        Object.keys(JSON.parse($tw.wiki.getTiddler("Many Board").fields.text).document.pages).length
      );
      const ok = after === coords.beforeCount + 1;
      console.log((ok ? "PASS" : "FAIL") + " | new-page-real-click | before=" + coords.beforeCount + " after=" + after);
    }

    // The same overflow fix must apply to tldraw's right-click CONTEXT menu
    // (opened at the cursor, uses the --radix-context-menu-* var).
    await page.mouse.click(700, 450, { button: "right" });
    await new Promise(r => setTimeout(r, 700));
    const ctx = await page.evaluate(() => {
      const el = document.getElementById("TD-ContextMenu");
      if (!el) return { open: false };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        open: true,
        maxHeight: cs.maxHeight,
        availVar: cs.getPropertyValue("--radix-context-menu-content-available-height"),
        bottom: +r.bottom.toFixed(1),
        vh: window.innerHeight
      };
    });
    if (ctx.open) {
      const notStock = ctx.maxHeight !== ctx.vh + "px";
      const inView = ctx.bottom <= ctx.vh + 1;
      console.log((notStock && inView ? "PASS" : "FAIL") +
        " | context-menu-constrained | maxHeight=" + ctx.maxHeight +
        " avail=" + ctx.availVar + " bottom=" + ctx.bottom + " vh=" + ctx.vh);
    } else {
      console.log("FAIL | context-menu-constrained | context menu did not open");
    }

    await page.waitForSelector("#out", { timeout: 30000 });
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