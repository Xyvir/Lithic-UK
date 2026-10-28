/**
 * The probe half of the swallowed-globals audit: what the page's own functions actually are once
 * the app's plugins have had their say.
 *
 * A webview plugin can replace a standard global with a stand-in, and the stand-in can be shaped
 * so wrongly that every caller fails silently: `tauri-plugin-dialog` makes `window.confirm` an
 * *async* IPC call, so TiddlyWiki's `$action-confirm` (Streams wraps it around every split and
 * merge) tests a Promise, which is always truthy, and the action runs without asking. Nothing in
 * a browser test can see this, because the browser has no such plugin; the only place the
 * question can be answered is the running app.
 *
 * `native_dialogs.rs` restores the functions and holds the list (`REPLACED`). This script reads
 * that same list out of the source and checks, in the running window:
 *
 *   - each named global is the engine's own function (`[native code]`, not a script's);
 *   - `confirm` still blocks the page and answers with a boolean (`true` on OK, `false` on
 *     Cancel), which is the contract `$action-confirm` reads;
 *   - the same holds after the launcher replaces its document with the engine's, which is where
 *     the wiki asks its questions;
 *   - and, for the audit rather than for a verdict, every window function that is NOT native is
 *     printed, so a plugin that starts replacing a name nobody listed is visible.
 *
 * **A local instrument, never a gate.** It needs a Windows build, a live WebView2 window and a
 * DevTools port, none of which a CI runner has. The rule is the one `monkey-launcher.mjs` is
 * held to: what this finds gets promoted into a committed test, and the gate stays elsewhere.
 *
 *   node scripts/probe-webview-globals.mjs                 (dev build, port 9334)
 *   node scripts/probe-webview-globals.mjs --list          (print what would be checked)
 *   node scripts/probe-webview-globals.mjs --exe path.exe --port 9400 --notes-out notes.md
 *
 * The DevTools port is opened through `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, so the app's own
 * configuration is never edited for a probe, and the run gets a user data folder of its own: a
 * WebView2 browser process serves one data folder, so a window opened while the app is already
 * running joins that process and the port argument, read once when it started, never arrives.
 * The first version of this probe failed exactly that way with two instances open, and the
 * separate folder also keeps a probe from touching the person's own launcher state.
 */
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MODULE = join(ROOT, 'src-tauri', 'src', 'native_dialogs.rs');

const argOf = (name, fallback) => {
  const found = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
};

const LIST_ONLY = process.argv.includes('--list');
const PORT = Number(argOf('port', '9334'));
const EXE = resolve(argOf('exe', join(ROOT, 'src-tauri', 'target', 'debug', process.platform === 'win32' ? 'lithic.exe' : 'lithic')));
const NOTES_OUT = argOf('notes-out', '');

/**
 * The audited names, read from the Rust module rather than repeated here.
 *
 * Two copies of this list would drift, and the drift would look exactly like a passing probe: a
 * plugin starts replacing a third global, the Rust restores it, and this script never asks.
 */
function auditedNames() {
  const source = readFileSync(MODULE, 'utf8');
  const table = /const REPLACED: &\[&str\] = &\[([^\]]*)\]/.exec(source);
  if (!table) throw new Error(`no REPLACED table in ${MODULE}`);
  const names = [...table[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  if (names.length === 0) throw new Error(`the REPLACED table in ${MODULE} is empty`);
  return names;
}

const names = auditedNames();

if (LIST_ONLY) {
  console.log(`Audited globals (from ${MODULE}):`);
  for (const name of names) console.log(`  window.${name}`);
  console.log('\nThe run also checks that confirm blocks and answers with a boolean, before and');
  console.log('after the mount, and prints every window function that is not native.');
  process.exit(0);
}

if (process.platform !== 'win32') {
  console.log('This probe needs the Windows build: the DevTools port it drives is WebView2\'s.');
  console.log('The script it checks is injected on every platform, so the gap itself is not');
  console.log('Windows-only; only this way of looking into the running window is.');
  process.exit(0);
}

/* --- the app, with a DevTools port ---------------------------------------- */

function get(url) {
  return new Promise((resolvePromise, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolvePromise(JSON.parse(body)));
    });
    request.on('error', reject);
    request.setTimeout(2000, () => request.destroy(new Error('timed out')));
  });
}

const wait = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

async function firstPage() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const pages = await get(`http://127.0.0.1:${PORT}/json/list`);
      const page = pages.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl);
      if (page) return page;
    } catch {
      // Not listening yet: the window is still being created.
    }
    await wait(250);
  }
  return null;
}

const dataFolder = mkdtempSync(join(tmpdir(), 'lithic-globals-probe-'));

const app = spawn(EXE, [], {
  detached: false,
  stdio: 'ignore',
  env: {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}`,
    WEBVIEW2_USER_DATA_FOLDER: dataFolder
  }
});

let socket;

async function stop() {
  try {
    socket?.close();
  } catch {
    // The window may already be gone.
  }
  try {
    execFileSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already closed.
  }
  try {
    rmSync(dataFolder, { recursive: true, force: true });
  } catch {
    // A WebView2 process may still hold a file in it; a temp folder is not worth failing over.
  }
}

/* --- one connection to the running page ----------------------------------- */

function connect(url) {
  return new Promise((resolvePromise, reject) => {
    const opened = new WebSocket(url);
    let nextId = 0;
    const pending = new Map();
    const events = [];
    opened.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.method) events.push(message);
      if (pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    };
    opened.onerror = () => reject(new Error('the DevTools socket refused the connection'));
    opened.onopen = () =>
      resolvePromise({
        events,
        send: (method, params) =>
          new Promise((done) => {
            const id = ++nextId;
            // A window that dies mid-run must fail a check rather than lose the report: an
            // unanswered command is resolved as a timeout, which the readings below cannot
            // mistake for a pass. The first run of this probe hung on exactly this.
            const timer = setTimeout(() => {
              pending.delete(id);
              done({ timedOut: true });
            }, 10000);
            pending.set(id, (message) => {
              clearTimeout(timer);
              done(message);
            });
            opened.send(JSON.stringify({ id, method, params }));
          })
      });
  });
}

const value = (answer) => answer.result?.result?.value ?? null;

/** What the window holds under the audited names, and every function that is not native. */
const READ_GLOBALS = `(() => {
  const audited = ${JSON.stringify(names)};
  const windows = {};
  for (const name of audited) {
    const held = window[name];
    const source = typeof held === 'function' ? Function.prototype.toString.call(held) : '';
    windows[name] = { type: typeof held, native: source.includes('[native code]'), source: source.slice(0, 80) };
  }
  const suspicious = [];
  for (const key of Object.getOwnPropertyNames(window)) {
    let held;
    try { held = window[key]; } catch { continue; }
    if (typeof held !== 'function') continue;
    const source = Function.prototype.toString.call(held);
    if (!source.includes('[native code]')) suspicious.push({ name: key, source: source.slice(0, 60) });
  }
  return JSON.stringify({ windows, suspicious });
})()`;

/**
 * Call the named function and see whether the page waits for an answer.
 *
 * The evaluate is deliberately not awaited: a synchronous dialog blocks the page, so the call
 * only comes back once the dialog is answered, which is the property being tested. The event
 * stream says whether a dialog was raised at all, and `accept` answers it.
 */
async function askConfirmation(session, accept) {
  session.events.length = 0;
  // One call, and its answer kept: a second `confirm` in the same expression would raise a
  // second dialog that nothing is waiting to answer.
  const blocked = session.send('Runtime.evaluate', {
    expression: '(function () { var answer = confirm("lithic probe"); return typeof answer + ":" + answer; })()',
    returnByValue: true
  });
  await wait(1200);
  const opened = session.events.find((event) => event.method === 'Page.javascriptDialogOpening');
  if (!opened) {
    await session.send('Page.handleJavaScriptDialog', { accept }).catch(() => {});
    const settled = await Promise.race([blocked.then(() => 'answered'), wait(800).then(() => 'still blocked')]);
    return { dialog: null, settled, answered: null };
  }
  await session.send('Page.handleJavaScriptDialog', { accept });
  const finished = await blocked;
  return { dialog: opened.params, settled: 'blocked until answered', answered: value(finished) };
}

const report = [];
const record = (ok, sentence) => {
  report.push({ ok, sentence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${sentence}`);
};

try {
  const page = await firstPage();
  if (!page) throw new Error(`no page on 127.0.0.1:${PORT}: is ${EXE} a build made after the dialog fix, and is nothing else holding that port?`);
  socket = await connect(page.webSocketDebuggerUrl);
  await socket.send('Runtime.enable', {});
  await socket.send('Page.enable', {});

  // The port answers as soon as the window exists, which is before the launcher has loaded:
  // reading it then would check `about:blank`'s globals and call that a pass.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const href = value(await socket.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }));
    if (typeof href === 'string' && href.includes('launcher.html')) break;
    await wait(250);
  }
  const href = value(await socket.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }));
  if (typeof href !== 'string' || !href.includes('launcher.html')) throw new Error(`the window never reached the launcher: ${href}`);

  console.log(`Window: ${href}`);
  console.log(`Audited: ${names.map((name) => `window.${name}`).join(', ')}\n`);

  const launcher = JSON.parse(value(await socket.send('Runtime.evaluate', { expression: READ_GLOBALS, returnByValue: true })));
  for (const name of names) {
    const held = launcher.windows[name];
    record(
      held.type === 'function' && held.native === true,
      `window.${name} in the launcher document is the engine's own: ${held.native ? 'native' : held.source || `a ${held.type}`}`
    );
  }
  if (launcher.suspicious.length > 0) {
    console.log('\nWindow functions that are not native (reported, not asserted):');
    for (const entry of launcher.suspicious) console.log(`  window.${entry.name}  ${entry.source}`);
    console.log('');
  } else {
    console.log('\nNo window function is a script of any kind: the plugins added new names, not stand-ins.\n');
  }

  if (names.includes('confirm')) {
    const accepted = await askConfirmation(socket, true);
    record(Boolean(accepted.dialog), `confirm raised a real dialog: ${accepted.dialog?.message ?? 'none'}`);
    record(accepted.settled === 'blocked until answered', `confirm blocked the page while it was up: ${accepted.settled}`);
    record(accepted.answered === 'boolean:true', `confirm answered with a boolean the widget can read: ${accepted.answered}`);
  }

  // The mount: the launcher replaces its own document with the engine's, and the wiki asks its
  // questions in that document. This is the state the report came from.
  await socket.send('Runtime.evaluate', {
    expression: `document.open(); document.write('<html><body><p id="probe">mounted</p></body></html>'); document.close();`,
    returnByValue: true
  });
  await wait(1200);
  const mounted = JSON.parse(value(await socket.send('Runtime.evaluate', { expression: READ_GLOBALS, returnByValue: true })));
  for (const name of names) {
    const held = mounted.windows[name];
    record(
      held.type === 'function' && held.native === true,
      `window.${name} in the mounted document is the engine's own: ${held.native ? 'native' : held.source || `a ${held.type}`}`
    );
  }
  if (names.includes('confirm')) {
    const answered = await askConfirmation(socket, false);
    record(answered.answered === 'boolean:false', `confirm in the mounted document answers Cancel as false: ${answered.answered}`);
  }

  // The self-test, and the reason this probe is worth having: a check that cannot see a
  // stand-in passes on a window where every one of them is still installed. So one is put back
  // on purpose, and the pass is the reading seeing it.
  await socket.send('Runtime.evaluate', {
    expression: 'window.confirm = async function () { return true; };',
    returnByValue: true
  });
  const broken = JSON.parse(value(await socket.send('Runtime.evaluate', { expression: READ_GLOBALS, returnByValue: true })));
  const seen = names.includes('confirm') && broken.windows.confirm.native === false;
  record(seen, `the reading sees a stand-in when one is installed: ${seen ? 'yes' : 'NO, so the checks above prove nothing'}`);
} catch (error) {
  record(false, `the probe could not finish: ${error.message}`);
} finally {
  await stop();
}

const failed = report.filter((entry) => !entry.ok);
console.log(`\n${report.length - failed.length} of ${report.length} checks hold.`);

if (NOTES_OUT) {
  const lines = ['# Webview globals probe', '', ...report.map((entry) => `- ${entry.ok ? 'PASS' : 'FAIL'} ${entry.sentence}`), ''];
  writeFileSync(resolve(NOTES_OUT), lines.join('\n'));
}

process.exit(failed.length === 0 ? 0 : 1);
