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
    activity: join(root, 'src-tauri', 'android', 'MainActivity.kt')
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
    fail(`no generated icon set at ${paths.icons}. Run \`npm run tauri icon src/app-icon.png\` first.`);
  }
  if (!existsSync(paths.activity)) {
    fail(`no tracked activity at ${paths.activity}.`);
  }

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

  // The template's round adaptive icon points at the template's own drawables, and our generated
  // set has no `ic_launcher_round.xml`, so leaving it in place would make the round icon a mixed
  // pair: our PNG on the densities with one and the placeholder's vector behind the definition.
  // Removing the definition lets the round icon resolve to our PNG everywhere.
  let removedRound = 0;
  const templateRound = join(res, 'mipmap-anydpi-v26', 'ic_launcher_round.xml');
  if (existsSync(templateRound) && !existsSync(join(paths.icons, 'mipmap-anydpi-v26', 'ic_launcher_round.xml'))) {
    rmSync(templateRound);
    removedRound = 1;
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
  const sameText = (a, b) => a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
  const replaced = !sameText(current, wanted);
  if (replaced) {
    writeFileSync(activityFile, wanted);
    if (readFileSync(activityFile, 'utf8') !== wanted) fail(`the activity at ${activityFile} did not survive the copy`);
  }

  return { icons, bytes, removedRound, activity: relative(root, activityFile), replaced };
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

  const seed = () => {
    rmSync(base, { recursive: true, force: true });
    const templateActivity = 'package com.lithic.app\n\nimport android.os.Bundle\nimport androidx.activity.enableEdgeToEdge\n\nclass MainActivity : TauriActivity() {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    enableEdgeToEdge()\n    super.onCreate(savedInstanceState)\n  }\n}\n';
    write(join(base, 'src-tauri/icons/android/mipmap-mdpi/ic_launcher.png'), 'ours-mdpi');
    write(join(base, 'src-tauri/icons/android/mipmap-anydpi-v26/ic_launcher.xml'), '<adaptive-icon/>');
    write(join(base, 'src-tauri/icons/android/values/ic_launcher_background.xml'), '<resources/>');
    write(join(base, 'src-tauri/gen/android/app/src/main/res/mipmap-mdpi/ic_launcher.png'), 'template-placeholder');
    write(join(base, 'src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml'), '<adaptive-icon/>');
    write(join(base, 'src-tauri/gen/android/app/src/main/java/com/lithic/app/MainActivity.kt'), templateActivity);
    write(join(base, 'src-tauri/android/MainActivity.kt'), readFileSync(join(REPO, 'src-tauri/android/MainActivity.kt'), 'utf8'));
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
  check('drops the template round definition so the round icon resolves to ours', first.removedRound === 1 && !existsSync(join(base, 'src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml')));
  check('installs the tracked activity', readFileSync(join(base, 'src-tauri/gen/android/app/src/main/java/com/lithic/app/MainActivity.kt'), 'utf8').includes('setOnApplyWindowInsetsListener'));
  check('reports replacing the activity', first.replaced === true);

  const second = patchAndroid(base);
  check('is idempotent for the activity', second.replaced === false);
  check('is idempotent for the round definition', second.removedRound === 0);

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
        `activity ${done.replaced ? 'replaced' : 'already current'}` +
        (done.removedRound ? ', template round icon dropped' : '')
    );
    return 0;
  } catch (error) {
    console.error(`Android patch failed: ${error.message}`);
    return 1;
  }
}

process.exit(main());
