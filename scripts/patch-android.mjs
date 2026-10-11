#!/usr/bin/env node
/*
 * The Android project `tauri android init` writes is Tauri's template, and two things in it are
 * wrong for this project. Both were measured on the published APK rather than assumed:
 *
 *   1. The launcher icon is the template's placeholder. The APK carried
 *      `res/mipmap-xxxhdpi-v4/ic_launcher.png` at 16,751 bytes where `tauri icon` produces
 *      5,756 for the same density, and it carried `drawable/ic_launcher_background.xml` with no
 *      `mipmap-anydpi-v26/ic_launcher.xml` and no `values/ic_launcher_background.xml` at all,
 *      which is the template's set and not ours. `android init` does not copy
 *      `src-tauri/icons/android/` into the project, whatever the workflow's icon step believed.
 *      `tauri icon` writes no `ic_launcher_round.xml` either, so the round definition is written
 *      here as a copy of ours: see the round block below for why deleting the template's is not
 *      the answer.
 *
 *   2. The activity draws the page under the system bars with nothing reserving their space
 *      (`src-tauri/android/MainActivity.kt` carries the reasoning and the fix).
 *
 * `init` rewrites this tree on every run, so the patch cannot be an edit of the generated files:
 * it is this script, run after `init` and before the build, in the release workflow and in the
 * README's local recipe alike. It verifies what it wrote and exits non-zero with a specific
 * message when it cannot, because a silent failure here is an APK with the wrong icon or a page
 * under the clock, which is exactly what shipped twice.
 *
 * Usage: node scripts/patch-android.mjs [--root <dir>] [--self-test]
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');

/**
 * The two directories this patch is given, resolved from one root so a test can supply its own.
 *
 * Where the generated project keeps its activity and its resources is deliberately *not* named
 * here. Both are found from the file `init` wrote (see `generatedActivity` and `mainDir`), so a
 * template whose package path or Gradle source set differs from the one this project saw is
 * still patched rather than failing a release over a path somebody guessed.
 */
function layout(root) {
  return {
    generated: join(root, 'src-tauri', 'gen', 'android'),
    icons: join(root, 'src-tauri', 'icons', 'android'),
    activity: join(root, 'src-tauri', 'android', 'MainActivity.kt'),
    bridge: join(root, 'src-tauri', 'android', 'LithicBridge.kt')
  };
}

function fail(message) {
  throw new Error(message);
}

/** Directories a search skips, so a project that has been built once is still walked cheaply. */
const SKIPPED = new Set(['build', '.gradle', '.cxx', 'node_modules']);

/** Every file under a directory, as paths relative to it. */
function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIPPED.has(entry)) continue;
      out.push(...walk(full, base));
    } else out.push(relative(base, full));
  }
  return out;
}

/** The `package x.y` line of a Kotlin file, or null when it declares none. */
function kotlinPackage(text) {
  const match = /^\s*package\s+([A-Za-z0-9_.]+)\s*$/m.exec(text);
  return match ? match[1] : null;
}

/** The one generated activity, wherever `init` put it for this identifier. */
function generatedActivity(generated) {
  // The app module's sources first, and the whole project only as a fallback: `init` writes
  // `app/src`, and a search of the project root would be walking Gradle's own files for a
  // file that is not there.
  const app = join(generated, 'app', 'src');
  const root = existsSync(app) ? app : generated;
  const activities = walk(root)
    .filter((name) => basename(name) === 'MainActivity.kt')
    .map((name) => join(root, name));
  if (activities.length !== 1) {
    fail(`expected exactly one generated MainActivity.kt under ${root}, found ${activities.length}`);
  }
  return activities[0];
}

/**
 * The `src/main` directory the activity sits under, found from the activity itself.
 *
 * This is what lets the resource tree be addressed without knowing the package path: Gradle
 * requires that everything a build compiles from lives under a `main` source set, whatever
 * the packages beneath it are called.
 */
function mainDir(activityFile) {
  let dir = dirname(activityFile);
  while (basename(dir) !== 'main') {
    const parent = dirname(dir);
    if (parent === dir) fail(`${activityFile} is not under a src/main directory`);
    dir = parent;
  }
  return dir;
}

/**
 * Copy the generated icon set over the template's, then install the tracked activity.
 *
 * Both halves verify themselves by reading back what they wrote, so a copy that silently did
 * nothing cannot pass as a patch. Answers what it changed, so the caller can print it and a
 * test can assert it.
 */
export function patchAndroid(root = REPO) {
  const paths = layout(root);
  if (!existsSync(paths.generated)) {
    fail(`no generated Android project at ${paths.generated}. Run \`npm run tauri android init -- --ci\` first.`);
  }
  if (!existsSync(paths.icons)) {
    fail(`no generated icon set at ${paths.icons}. Run \`npm run tauri icon src/app-icon.json\` first.`);
  }
  if (!existsSync(paths.activity)) {
    fail(`no tracked activity at ${paths.activity}.`);
  }
  if (!existsSync(paths.bridge)) {
    fail(`no tracked document bridge at ${paths.bridge}.`);
  }

  // Line endings are folded before any text comparison in this file, because the tracked files
  // are CRLF and a template's may be LF: the comparison is about content, and a "change" that is
  // one line ending is not a change.
  const sameText = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');

  // The two things about the generated project this patch has to know are read off the project
  // rather than assumed: the activity init wrote (which fixes the package), and the resource
  // directory beside it, which is where the icons go.
  const activityFile = generatedActivity(paths.generated);
  const res = join(mainDir(activityFile), 'res');
  if (!existsSync(res)) {
    fail(`the generated activity at ${activityFile} has no res directory beside it (${res})`);
  }

  // 1. Icons. Ours are the same file names as the template's in `mipmap-*`, so copying replaces
  // them; `mipmap-anydpi-v26/ic_launcher.xml` and `values/ic_launcher_background.xml` are files
  // the template does not have at all, which is why the launcher icon was generic.
  let icons = 0;
  let bytes = 0;
  for (const name of walk(paths.icons)) {
    const from = join(paths.icons, name);
    const to = join(res, name);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to);
    const source = readFileSync(from);
    const written = readFileSync(to);
    if (!source.equals(written)) fail(`icon ${name} did not survive the copy`);
    icons += 1;
    bytes += source.length;
  }
  if (icons === 0) fail(`${paths.icons} holds no icons to copy`);

  // The round definition, which the generated set does not carry.
  //
  // Tauri writes `mipmap-anydpi-v26/ic_launcher.xml` and no `ic_launcher_round.xml`, while the
  // template's own round definition points at the template's drawables: left in place it is a
  // mixed pair, our foreground behind the placeholder's file. Deleting it (what this did first)
  // is worse than it looks, because the manifest's `android:roundIcon` then resolves to the
  // LEGACY `mipmap-*/ic_launcher_round.png` on every launcher that asks for a round icon: a
  // circle holding the uncropped artwork, which is the masked-and-cut icon this project kept
  // shipping. So the round path gets its own copy of the adaptive definition, read from ours
  // rather than spelled out here so the two cannot drift apart.
  const launcherXml = join(res, 'mipmap-anydpi-v26', 'ic_launcher.xml');
  if (!existsSync(launcherXml)) {
    fail(`the icon set has no ${launcherXml}, so there is no adaptive definition to copy.`);
  }
  const roundXml = join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml');
  const adaptive = readFileSync(launcherXml, 'utf8');
  const roundIcon = !existsSync(roundXml) || !sameText(readFileSync(roundXml, 'utf8'), adaptive);
  if (roundIcon) {
    writeFileSync(roundXml, adaptive);
    if (!sameText(readFileSync(roundXml, 'utf8'), adaptive)) {
      fail(`the round definition at ${roundXml} did not survive the write`);
    }
  }

  // 2. The activity. The tracked file is the authority; the generated one is only checked for the
  // package it was written for, so an identifier change fails here rather than at Gradle with a
  // message about a file that will be regenerated anyway.
  const wanted = readFileSync(paths.activity, 'utf8');
  const current = readFileSync(activityFile, 'utf8');
  const wantedPackage = kotlinPackage(wanted);
  if (wantedPackage === null) fail(`${paths.activity} declares no package`);
  if (kotlinPackage(current) !== wantedPackage) {
    fail(
      `the generated activity is package ${kotlinPackage(current)} and ${paths.activity} is ${wantedPackage}. ` +
        `The app identifier changed: update src-tauri/android/MainActivity.kt to match.`
    );
  }
  // "Already patched" means the generated file IS the tracked file, compared as text: the
  // template's own file never matches, and neither would a future template that grew insets of
  // its own, which is the right answer either way because this project's file is the authority.
  const replaced = !sameText(current, wanted);
  if (replaced) {
    writeFileSync(activityFile, wanted);
    if (readFileSync(activityFile, 'utf8') !== wanted) fail(`the activity at ${activityFile} did not survive the copy`);
  }

  // 3. The document bridge. Its package has to be the one the Rust side names when it registers
  // the plugin (`platform::android` holds the same two constants), so the file is installed
  // beside the activity -- whatever package path `init` chose -- with that package rewritten to
  // the generated one. Writing it next to the activity is what makes the two packages the same
  // file's fact rather than two places that must agree.
  const wantedBridge = readFileSync(paths.bridge, 'utf8');
  const bridgePackage = kotlinPackage(wantedBridge);
  if (bridgePackage === null) fail(`${paths.bridge} declares no package`);
  if (bridgePackage !== wantedPackage) {
    fail(
      `${paths.bridge} is package ${bridgePackage} and the app is ${wantedPackage}. ` +
        `The app identifier changed: update src-tauri/android/LithicBridge.kt to match.`
    );
  }
  const bridgeFile = join(dirname(activityFile), 'LithicBridge.kt');
  const bridgeReplaced = !existsSync(bridgeFile) || !sameText(readFileSync(bridgeFile, 'utf8'), wantedBridge);
  if (bridgeReplaced) {
    writeFileSync(bridgeFile, wantedBridge);
    if (!sameText(readFileSync(bridgeFile, 'utf8'), wantedBridge)) {
      fail(`the bridge at ${bridgeFile} did not survive the copy`);
    }
  }

  return { icons, bytes, roundIcon, activity: relative(root, activityFile), replaced, bridge: relative(root, bridgeFile), bridgeReplaced };
}

/**
 * Run the whole patch against a synthetic project and assert what it did, so the parts that need
 * no Android toolchain are covered on the machine that edits this file. The three failure paths
 * are driven too: a missing icon set, a missing generated tree, and an identifier that no longer
 * matches the tracked activity.
 */
function selfTest() {
  const base = join(REPO, 'tmp', 'patch-android-test');
  rmSync(base, { recursive: true, force: true });
  mkdirSync(base, { recursive: true });
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push(ok);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };

  // The two definitions, distinct on purpose so "was the round one overwritten" is answerable:
  // ours is what the icon set carries, the template's is the shape `android init` writes.
  const ADAPTIVE_ICON =
    '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>\n  <background android:drawable="@color/ic_launcher_background"/>\n</adaptive-icon>';
  const TEMPLATE_ROUND =
    '<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n  <background android:drawable="@drawable/ic_launcher_background"/>\n  <foreground android:drawable="@drawable/ic_launcher_foreground"/>\n</adaptive-icon>';

  const seed = () => {
    rmSync(base, { recursive: true, force: true });
    const templateActivity = 'package com.lithic.app\n\nimport android.os.Bundle\nimport androidx.activity.enableEdgeToEdge\n\nclass MainActivity : TauriActivity() {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    enableEdgeToEdge()\n    super.onCreate(savedInstanceState)\n  }\n}\n';
    write(join(base, 'src-tauri/icons/android/mipmap-mdpi/ic_launcher.png'), 'ours-mdpi');
    write(join(base, 'src-tauri/icons/android/mipmap-anydpi-v26/ic_launcher.xml'), ADAPTIVE_ICON);
    write(join(base, 'src-tauri/icons/android/values/ic_launcher_background.xml'), '<resources/>');
    write(join(base, 'src-tauri/gen/android/app/src/main/res/mipmap-mdpi/ic_launcher.png'), 'template-placeholder');
    write(join(base, 'src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml'), TEMPLATE_ROUND);
    write(join(base, 'src-tauri/gen/android/app/src/main/java/com/lithic/app/MainActivity.kt'), templateActivity);
    write(join(base, 'src-tauri/android/MainActivity.kt'), readFileSync(join(REPO, 'src-tauri/android/MainActivity.kt'), 'utf8'));
    write(join(base, 'src-tauri/android/LithicBridge.kt'), readFileSync(join(REPO, 'src-tauri/android/LithicBridge.kt'), 'utf8'));
  };
  const write = (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };
  const throws = (fn) => {
    try {
      fn();
      return null;
    } catch (error) {
      return error.message;
    }
  };

  seed();
  const first = patchAndroid(base);
  check('copies the icon set over the template', readFileSync(join(base, 'src-tauri/gen/android/app/src/main/res/mipmap-mdpi/ic_launcher.png'), 'utf8') === 'ours-mdpi');
  check('brings the files the template does not have', existsSync(join(base, 'src-tauri/gen/android/app/src/main/res/values/ic_launcher_background.xml')));
  check(
    'gives the round path our adaptive definition instead of the template placeholder',
    first.roundIcon === true &&
      readFileSync(join(base, 'src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml'), 'utf8') ===
        ADAPTIVE_ICON
  );
  check('installs the tracked activity', readFileSync(join(base, 'src-tauri/gen/android/app/src/main/java/com/lithic/app/MainActivity.kt'), 'utf8').includes('setOnApplyWindowInsetsListener'));
  check('reports replacing the activity', first.replaced === true);
  check(
    'installs the document bridge beside the activity',
    first.bridgeReplaced === true &&
      readFileSync(join(base, 'src-tauri/gen/android/app/src/main/java/com/lithic/app/LithicBridge.kt'), 'utf8').includes(
        'pickDocuments'
      )
  );

  const second = patchAndroid(base);
  check('is idempotent for the activity', second.replaced === false);
  check('is idempotent for the round definition', second.roundIcon === false);
  check('is idempotent for the bridge', second.bridgeReplaced === false);

  // The layout this patch must not assume: a project whose packages and source set differ from
  // the one this file was written against still gets its icons and its activity, because both
  // paths are read off the project rather than hardcoded.
  seed();
  rmSync(join(base, 'src-tauri/gen/android/app/src/main/java'), { recursive: true, force: true });
  write(
    join(base, 'src-tauri/gen/android/app/src/main/kotlin/com/lithic/app/deep/MainActivity.kt'),
    readFileSync(join(REPO, 'src-tauri/android/MainActivity.kt'), 'utf8')
  );
  const moved = patchAndroid(base);
  check(
    'finds the resources from the activity, wherever the package path puts them',
    moved.replaced === false &&
      existsSync(join(base, 'src-tauri/gen/android/app/src/main/res/values/ic_launcher_background.xml')),
    moved.activity
  );

  seed();
  rmSync(join(base, 'src-tauri/gen/android/app/src/main/res'), { recursive: true, force: true });
  const noRes = throws(() => patchAndroid(base));
  check('refuses a project with no resource tree beside the activity', noRes !== null && noRes.includes('no res directory'), noRes ?? '');

  seed();
  write(join(base, 'src-tauri/android/MainActivity.kt'), 'package com.other.app\n\nclass MainActivity : TauriActivity()\n');
  const mismatch = throws(() => patchAndroid(base));
  check('refuses an identifier that no longer matches', mismatch !== null && mismatch.includes('com.lithic.app'), mismatch ?? '');

  // The bridge's package and the app's are one fact, checked rather than assumed: the Rust side
  // registers the plugin by a package it holds as a constant, so a bridge left in the old
  // package after an identifier change would be a class nothing can find.
  seed();
  write(join(base, 'src-tauri/android/LithicBridge.kt'), 'package com.other.app\n\nclass LithicBridge\n');
  const bridgeMismatch = throws(() => patchAndroid(base));
  check(
    'refuses a bridge in a package the app is not in',
    bridgeMismatch !== null && bridgeMismatch.includes('LithicBridge.kt'),
    bridgeMismatch ?? ''
  );

  seed();
  rmSync(join(base, 'src-tauri/android/LithicBridge.kt'), { force: true });
  const noBridge = throws(() => patchAndroid(base));
  check('refuses a run with no tracked bridge', noBridge !== null && noBridge.includes('document bridge'), noBridge ?? '');

  seed();
  rmSync(join(base, 'src-tauri/icons'), { recursive: true, force: true });
  const noIcons = throws(() => patchAndroid(base));
  check('refuses a run with no generated icon set', noIcons !== null && noIcons.includes('tauri icon'), noIcons ?? '');

  seed();
  rmSync(join(base, 'src-tauri/gen'), { recursive: true, force: true });
  const noTree = throws(() => patchAndroid(base));
  check('refuses a run with no generated project', noTree !== null && noTree.includes('android init'), noTree ?? '');

  rmSync(base, { recursive: true, force: true });
  const failed = results.filter((ok) => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  return failed === 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest() ? 0 : 1;
  const rootIndex = argv.indexOf('--root');
  const root = rootIndex === -1 ? REPO : argv[rootIndex + 1];
  if (!root) {
    console.error('--root needs a directory');
    return 1;
  }
  try {
    const done = patchAndroid(root);
    console.log(
      `Android project patched: ${done.icons} icon files (${done.bytes} bytes), ` +
        `activity ${done.replaced ? 'replaced' : 'already current'}, ` +
        `bridge ${done.bridgeReplaced ? 'installed' : 'already current'}` +
        (done.roundIcon ? ', round adaptive icon written' : '')
    );
    return 0;
  } catch (error) {
    console.error(`Android patch failed: ${error.message}`);
    return 1;
  }
}

process.exit(main());
