#!/usr/bin/env node
/**
 * Headless validation of the whiteboard write-behind buffer patch (strict mode).
 *
 * Boots the built monolith (src/lithic.html) with the write-behind patch
 * tiddler injected into the store (written to scratch/), drives it in
 * Puppeteer (system Chrome, or Puppeteer's bundled Chromium), and verifies:
 *
 * 1. The patch module is loaded.
 * 2. A text write to an application/tldr tiddler (simulating a stroke save)
 *    is buffered: the store text is unchanged and no change event fires.
 * 3. Non-whiteboard text writes still pass straight through.
 * 4. The `type` field write (the widget sets type on every save) passes through.
 * 5. STRICT MODE: after a 1.5s idle wait the store is still untouched
 *    (no idle flush — the store is only written on save/close).
 * 6. Dispatching tm-auto-save-wiki flushes the buffer BEFORE the save runs,
 *    so the serializer always sees the latest board state.
 * 7. After the flush the buffer is empty again (a further stroke re-buffers).
 *
 * Run:  node scripts/_test_whiteboard_writebehind.mjs
 *       HEADED=1 node scripts/_test_whiteboard_writebehind.mjs   (visible window)
 *       CHROME=/path/to/chrome node scripts/_test_whiteboard_writebehind.mjs
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
  "$__Lithic_Patches_Whiteboard_WriteBehind.js.tid"
);
const OUT = path.join(ROOT, "scratch", "_test_whiteboard-writebehind.html");

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
    var tries = 0;
    var iv = setInterval(function() {
        tries++;
        if (!window.$tw || !$tw.wiki || !$tw.rootWidget) {
            if (tries > 600) { results.push("FAIL | boot timeout"); finish(); clearInterval(iv); }
            return;
        }
        clearInterval(iv);
        try {
            run();
        } catch (e) {
            results.push("FAIL | exception: " + (e && e.stack ? e.stack : e));
            finish();
        }
    }, 100);

    var SHAPE1 = '{"s1":{"id":"s1","type":"draw","name":"Draw","parentId":"page","childIndex":2,"point":[0,0],"rotation":0,"text":""}}';
    var SHAPE2 = '{"s1":{"id":"s1","type":"draw","name":"Draw","parentId":"page","childIndex":2,"point":[10,10],"rotation":0,"text":"x"}}';
    var SHAPE3 = '{"s1":{"id":"s1","type":"draw","name":"Draw","parentId":"page","childIndex":2,"point":[20,20],"rotation":0,"text":"y"}}';
    function boardJson(name, updatedCount, shapesJson) {
        return '{"document":{"id":"doc","name":"' + name + '","version":15.5,' +
            '"pages":{"page":{"id":"page","name":"Page 1","childIndex":1,"shapes":' + (shapesJson || "{}") + ',"bindings":{}}},' +
            '"pageStates":{"page":{"id":"page","selectedIds":[],"camera":{"point":[0,0],"zoom":1}}},' +
            '"assets":{}},"updatedCount":' + updatedCount + '}';
    }

    function run() {
        var wiki = $tw.wiki;
        var PATCH = "$:/Lithic/Patches/Whiteboard/WriteBehind.js";
        check("patch-loaded", !!wiki.getTiddler(PATCH), "write-behind patch present in store");

        var autoSave = wiki.getTiddlerText("$:/config/AutoSave", "yes");
        info("autosave-config=" + autoSave + " (tm-auto-save-wiki writes the file only when 'yes'; the flush hook runs regardless)");

        var board = "Test WriteBehind Board";
        var plain = "Plain Note";
        var initial = boardJson("Test WriteBehind Board", 1, null);
        var stroke1 = boardJson("Test WriteBehind Board", 2, SHAPE1);
        var stroke2 = boardJson("Test WriteBehind Board", 3, SHAPE2);

        var changeEvents = 0;
        // Register BEFORE creating so we capture everything, then reset after the
        // async creation events drain (TW5 processes change events on a queue).
        wiki.addEventListener("change", function(changes) { if (changes[board]) changeEvents++; });
        wiki.addTiddler(new $tw.Tiddler({title: board, type: "application/tldr", text: initial}));
        wiki.addTiddler(new $tw.Tiddler({title: plain, text: "hello"}));

        setTimeout(function() {
            try {
                changeEvents = 0; // drop the async creation events

                // ---- A. Mid-stroke writes are buffered: store untouched, no change events ----
                wiki.setText(board, undefined, undefined, stroke1);
                check("midstroke1-buffered", wiki.getTiddlerText(board) === initial, "store still holds initial text");
                check("midstroke1-no-change-event", changeEvents === 0, "change events: " + changeEvents);
                wiki.setText(board, undefined, undefined, stroke2);
                check("midstroke2-buffered", wiki.getTiddlerText(board) === initial, "store still holds initial text");
                check("midstroke2-no-change-event", changeEvents === 0, "change events: " + changeEvents);

                // ---- B. Non-whiteboard writes pass straight through ----
                wiki.setText(plain, undefined, undefined, "world");
                check("plain-write-through", wiki.getTiddlerText(plain) === "world", "plain tiddler updated immediately");

                // ---- C. The type-field write passes through (widget sets type on every save) ----
                wiki.setText(board, "type", undefined, "application/tldr");
                check("type-write-passthrough", wiki.getTiddler(board).fields.type === "application/tldr", "type unchanged");
                check("type-write-no-event", changeEvents === 0, "same-value type write must not fire a change event");

                // ---- D. Strict mode: NO idle flush. After 1.5s the store must still be untouched ----
                setTimeout(function() {
                    try {
                        check("no-idle-flush", wiki.getTiddlerText(board) === initial,
                            "store still initial after idle; got latest? " + (wiki.getTiddlerText(board) === stroke2));
                        check("no-idle-change-event", changeEvents === 0, "change events: " + changeEvents);

                        // ---- E. Flush before save: tm-auto-save-wiki flushes the buffer first ----
                        $tw.rootWidget.dispatchEvent({type: "tm-auto-save-wiki"});
                        check("flush-on-save", wiki.getTiddlerText(board) === stroke2,
                            "latest stroke landed in store before save ran");

                        // ---- F. Buffer cleared after flush: a further stroke re-buffers ----
                        var stroke3 = boardJson("Test WriteBehind Board", 4, SHAPE3);
                        wiki.setText(board, undefined, undefined, stroke3);
                        check("postflush-buffered", wiki.getTiddlerText(board) === stroke2,
                            "store still at flushed state after new stroke");

                        // Let the queued change events drain, then verify exactly one fired (the flush).
                        setTimeout(function() {
                            check("flush-change-event", changeEvents === 1, "change events: " + changeEvents);
                            finish();
                        }, 100);
                    } catch (e) {
                        results.push("FAIL | exception: " + (e && e.stack ? e.stack : e));
                        finish();
                    }
                }, 1500);
            } catch (e) {
                results.push("FAIL | exception: " + (e && e.stack ? e.stack : e));
                finish();
            }
        }, 100);
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
    defaultViewport: { width: 1200, height: 800 }
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
