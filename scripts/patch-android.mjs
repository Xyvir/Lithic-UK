#!/usr/bin/env node
/*
 * The Android project `tauri android init` writes is Tauri's template, and four things in it are
 * wrong for this project. Each was measured on a published APK rather than assumed:
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
 *   3. Nothing in the manifest claims the `lithic://` scheme, so a board's sign-in window cannot
 *      hand its page to this app and every phone falls through to the browser instead; nothing
 *      claims the share sheet either, so no other app can share a link or a paragraph into it;
 *      and nothing claims a single file type, so a file manager's "Open with Lithic" is never
 *      offered and a document another app hands over can never arrive. All four filters are
 *      added to the activity that hosts the webview; see `DEEP_LINK_FILTER`, `SHARE_FILTER`,
 *      `documentFilters` and `addActivityFilters`.
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
    bridge: join(root, 'src-tauri', 'android', 'LithicBridge.kt'),
    associations: join(root, 'src-tauri', 'src', 'platform', 'associations.json')
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

/**
 * The intent filter that lets a board's sign-in window hand its page to this app.
 *
 * A WebView cannot open a file chooser, so the launcher in a board's captive portal window hands
 * the window to an `intent://` address that names this app first and a browser second. Without a
 * filter here nothing in the app matches that address, and every phone falls through to the
 * browser, which is why this is a manifest fact rather than something the Kotlin can add at run
 * time. The scheme is the only thing the filter claims: it names no host, so a board at any
 * address can reach this app, and the activity decides what to do with the address it is given.
 */
const DEEP_LINK_FILTER = [
  '<intent-filter>',
  '  <action android:name="android.intent.action.VIEW" />',
  '  <category android:name="android.intent.category.DEFAULT" />',
  '  <category android:name="android.intent.category.BROWSABLE" />',
  '  <data android:scheme="lithic" />',
  '</intent-filter>'
];

/**
 * The intent filter that puts Lithic in the platform's own share sheet.
 *
 * `ACTION_SEND` with `text/plain` is what "Share to..." means for a link, a selected paragraph or a
 * note out of another app: the content rides in `EXTRA_TEXT` and the sender's own title in
 * `EXTRA_TITLE` or `EXTRA_SUBJECT`. Claiming the type is the whole of what the manifest has to say,
 * because a share target is an intent filter and nothing else; `MainActivity.rememberShare` is what
 * reads what arrives, and the launcher decides what a share becomes.
 *
 * `text/plain` alone, and deliberately. It is the type every app that shares a link or a paragraph
 * sends, so it is the one that covers "arbitrary content" as a person means it. A share of an
 * image or a file is a different feature with a different destination (bytes rather than text), and
 * claiming those types here would list Lithic on share sheets for content it would then have to
 * refuse.
 *
 * `DEFAULT` is required for the system to consider the filter at all, and `BROWSABLE` is absent on
 * purpose: it belongs to addresses a browser may hand over, not to content another app sends.
 */
const SHARE_FILTER = [
  '<intent-filter>',
  '  <action android:name="android.intent.action.SEND" />',
  '  <category android:name="android.intent.category.DEFAULT" />',
  '  <data android:mimeType="text/plain" />',
  '</intent-filter>'
];

/**
 * The filters that put this app in a file manager's "Open with" list, from the shared table.
 *
 * Android has no extension association at all: it offers an app for a file's *MIME type*, which is
 * the vocabulary a desktop's registry and a freedesktop entry are both a spelling of. So the table
 * in `src-tauri/src/platform/associations.json` (the one the Windows and Linux registrations read,
 * see `src-tauri/src/platform/associations.rs`) is the source here too, and a type added there is
 * offered on the phone with no second edit.
 *
 * Two filters, because a phone can name a file either way and they fail in opposite directions.
 *
 *   * The MIME filter is the reliable half: a provider that knows a `.txt` says `text/plain`, and
 *     the intent carries that type. It is what covers the standard types.
 *   * The extension filter is for the one type nobody knows. No phone ships a definition of
 *     `application/x-lith`, so a `.lith` off a file manager arrives as `application/octet-stream`
 *     (or as nothing), and a MIME filter for it would never match. `pathPattern` is matched
 *     against the URI's path, which for the storage provider behind every phone's own Files app
 *     is the real path (`primary:Download/book.lith`), so this is what finds a Lith. A cloud
 *     provider with an opaque document id has no extension in its path and is not covered, which
 *     is a limit of the platform rather than of this filter: the type cannot save it either.
 *
 * Every row is claimed, including the `imported` ones (`pdf`, an `epub`, the images), and the two
 * kinds differ only in what opens. A document this app edits opens where it says. A file it
 * converts opens in a new Lith with no file behind it, named the way its sibling would have been,
 * because a `content://` reference has no folder beside it for the import to be written into: the
 * launcher hands the file's bytes to the engine, and the first save is the platform's own save
 * picker, so the person chooses the home a desktop sibling rule would have chosen silently. That
 * is why the phone can offer a type it cannot convert beside the source, and it is deliberately
 * not the share's shape, where notes wait in the pending panel for a destination.
 *
 * One more absence worth stating: `CATEGORY_BROWSABLE` is not claimed here either. These filters
 * are for content another app hands over, and a browser has no business routing an address to
 * them.
 */
function documentFilters(table) {
  const offered = table.types;
  if (offered.length === 0) {
    fail('associations.json has no type this app can open on a phone');
  }
  if (!offered.some((type) => type.ext === 'lith')) {
    fail('associations.json has no .lith row, so nothing would claim this app\'s own format');
  }
  const mimes = [...new Set(offered.map((type) => type.mime))];
  const byType = [
    '<intent-filter>',
    '  <action android:name="android.intent.action.VIEW" />',
    '  <category android:name="android.intent.category.DEFAULT" />',
    ...mimes.map((mime) => `  <data android:mimeType="${mime}" />`),
    '</intent-filter>'
  ];
  // One data element per scheme and extension, because a data element is an AND and the filters
  // themselves are the OR: `content` and `file` are the two schemes a file manager hands over.
  const byExtension = [
    '<intent-filter>',
    '  <action android:name="android.intent.action.VIEW" />',
    '  <category android:name="android.intent.category.DEFAULT" />',
    ...['content', 'file'].flatMap((scheme) =>
      offered.map(
        (type) => `  <data android:scheme="${scheme}" android:pathPattern=".*\\.${type.ext}" />`
      )
    ),
    '</intent-filter>'
  ];
  return [
    {
      name: 'document type filter',
      lines: byType,
      present: /android:mimeType\s*=\s*"application\/x-lith"/,
      complaint: 'nothing can open a document handed over by another app'
    },
    {
      name: 'document extension filter',
      lines: byExtension,
      present: /android:pathPattern\s*=\s*"\.\*\\\.lith"/,
      complaint: 'nothing can open a .lith handed over by another app'
    }
  ];
}

/**
 * Every filter this patch adds, each with the evidence it is already there and the sentence a
 * manifest with nothing to attach it to fails with.
 *
 * All of them are found by what they claim rather than by a marker comment, so a manifest that
 * already has one (a future `init` that ships one, or a second run of this script) is recognised
 * rather than rewritten, and none can be added twice.
 */
function activityFilters(table) {
  return [
    {
      name: 'hand-off filter',
      lines: DEEP_LINK_FILTER,
      present: /android:scheme\s*=\s*"lithic"/,
      complaint: 'nothing can claim the lithic scheme'
    },
    {
      name: 'share filter',
      lines: SHARE_FILTER,
      present: /android\.intent\.action\.SEND/,
      complaint: 'nothing can be shared into this app'
    },
    ...documentFilters(table)
  ];
}

/**
 * Add every filter to the activity that owns the webview, once each.
 *
 * The manifest is the template's and the template is rewritten on every `init`, so the edit is
 * made here and read back: a manifest that already claims what a filter claims is left alone, and
 * one with no activity to attach the missing filters to is a failure rather than an APK that
 * silently cannot be reached, shared into, or handed a file.
 *
 * All of them are appended together in one write, because they go in the same place and a second
 * pass over the activity block would have to find it again after the first one moved it.
 *
 * Answers which of them it wrote, by name.
 */
function addActivityFilters(manifestPath, filters) {
  if (!existsSync(manifestPath)) fail(`no AndroidManifest.xml at ${manifestPath}`);
  const before = readFileSync(manifestPath, 'utf8');
  const missing = filters.filter((filter) => !filter.present.test(before));
  if (missing.length === 0) return [];
  // The activity block, found by the class it hosts rather than by a line number: the template's
  // attributes vary between Tauri versions and the class it launches does not.
  const block = /<activity\b[\s\S]*?MainActivity[\s\S]*?<\/activity>/.exec(before);
  if (!block) {
    fail(`${manifestPath} has no <activity> element hosting MainActivity, so ${missing[0].complaint}`);
  }
  const lines = block[0].split(/\r?\n/);
  const closing = lines.pop();
  const indent = (/^\s*/.exec(lines[0]) ?? [''])[0];
  const inner = `${indent}  `;
  const added = missing.map((filter) => filter.lines.map((line) => `${inner}${line}`).join('\n')).join('\n');
  const patched = [...lines, added, closing].join('\n');
  const start = before.indexOf(block[0]);
  writeFileSync(manifestPath, before.slice(0, start) + patched + before.slice(start + block[0].length));
  const after = readFileSync(manifestPath, 'utf8');
  for (const filter of filters) {
    if (!filter.present.test(after)) fail(`the ${filter.name} did not survive the write to ${manifestPath}`);
  }
  return missing.map((filter) => filter.name);
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
  if (!existsSync(paths.associations)) {
    fail(`no association table at ${paths.associations}, so there are no file types to claim.`);
  }
  // The table is the source of truth for what this app opens, shared with the Windows and Linux
  // registrations (`src-tauri/src/platform/associations.rs`). Read and checked rather than
  // assumed: a row the manifest needs and the table no longer has is an APK that quietly stops
  // offering a type.
  const table = JSON.parse(readFileSync(paths.associations, 'utf8'));
  if (!Array.isArray(table.types)) {
    fail(`${paths.associations} has no \`types\` array`);
  }
  for (const type of table.types) {
    if (!type.ext || !type.mime) {
      fail(`${paths.associations} has a row with no extension or no mime type: ${JSON.stringify(type)}`);
    }
  }
  const filters = activityFilters(table);

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

  // 4. The intents the app answers. A board's sign-in window reaches it through the scheme the
  // first filter claims, any other app reaches it through the share sheet the second claims, and
  // a file manager reaches it through the two document filters, which are generated from the
  // association table above. What receives any of them does nothing with it until the page asks
  // (see `MainActivity`, `LithicBridge.takeDeepLink`, `takeSharedText` and `takeOpenDocument`).
  const manifest = join(mainDir(activityFile), 'AndroidManifest.xml');
  const written = addActivityFilters(manifest, filters);

  // 5. Release signing config. Ensure release build type uses the debug signing config
  // (cycling debug keystore) so release builds produced without `--debug` are signed.
  const gradlePath = join(paths.generated, 'app', 'build.gradle.kts');
  const releaseSigning = configureReleaseSigning(gradlePath);

  return {
    icons,
    bytes,
    roundIcon,
    activity: relative(root, activityFile),
    replaced,
    bridge: relative(root, bridgeFile),
    bridgeReplaced,
    written,
    releaseSigning
  };
}

/**
 * Ensure the release build type in `app/build.gradle.kts` uses the debug signing config
 * (cycling debug keystore), so release builds without `--debug` are signed and installable.
 */
function configureReleaseSigning(gradlePath) {
  if (!existsSync(gradlePath)) fail(`no build.gradle.kts at ${gradlePath}`);
  let text = readFileSync(gradlePath, 'utf8');
  if (text.includes('signingConfig = signingConfigs.getByName("debug")')) return false;

  const releaseMatch = /getByName\("release"\)\s*\{/;
  if (!releaseMatch.test(text)) {
    fail(`${gradlePath} has no getByName("release") block`);
  }
  text = text.replace(releaseMatch, (match) => `${match}\n            signingConfig = signingConfigs.getByName("debug")`);
  writeFileSync(gradlePath, text);
  if (!readFileSync(gradlePath, 'utf8').includes('signingConfig = signingConfigs.getByName("debug")')) {
    fail(`release signing config did not survive the write to ${gradlePath}`);
  }
  return true;
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

  // The template's Gradle, close enough to the real one for the only question this test asks of
  // it: does the signing block land, and does it land once.
  const TEMPLATE_GRADLE =
    'import java.util.Properties\n' +
    '\n' +
    'android {\n' +
    '    buildTypes {\n' +
    '        getByName("release") {\n' +
    '            optimization {\n' +
    '               enable = true\n' +
    '            }\n' +
    '        }\n' +
    '    }\n' +
    '}\n' +
    '\n' +
    'apply(from = file("tauri.build.gradle.kts"))\n';

  const seed = () => {
    rmSync(base, { recursive: true, force: true });
    const templateActivity = 'package com.lithic.app\n\nimport android.os.Bundle\nimport androidx.activity.enableEdgeToEdge\n\nclass MainActivity : TauriActivity() {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    enableEdgeToEdge()\n    super.onCreate(savedInstanceState)\n  }\n}\n';
    write(join(base, 'src-tauri/icons/android/mipmap-mdpi/ic_launcher.png'), 'ours-mdpi');
    write(join(base, 'src-tauri/icons/android/mipmap-anydpi-v26/ic_launcher.xml'), ADAPTIVE_ICON);
    write(join(base, 'src-tauri/icons/android/values/ic_launcher_background.xml'), '<resources/>');
    write(join(base, 'src-tauri/gen/android/app/src/main/res/mipmap-mdpi/ic_launcher.png'), 'template-placeholder');
    write(join(base, 'src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml'), TEMPLATE_ROUND);
    // The manifest as `init` writes it: no hand-off filter, and the activity's own launcher filter
    // beside the block the patch has to add to.
    const templateManifest =
      '<?xml version="1.0" encoding="utf-8"?>\n' +
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n' +
      '  <application android:label="@string/app_name">\n' +
      '    <activity android:name=".MainActivity" android:exported="true">\n' +
      '      <intent-filter>\n' +
      '        <action android:name="android.intent.action.MAIN" />\n' +
      '        <category android:name="android.intent.category.LAUNCHER" />\n' +
      '      </intent-filter>\n' +
      '    </activity>\n' +
      '  </application>\n' +
      '</manifest>\n';
    write(join(base, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'), templateManifest);
    write(join(base, 'src-tauri/gen/android/app/build.gradle.kts'), TEMPLATE_GRADLE);
    write(join(base, 'src-tauri/gen/android/app/src/main/java/com/lithic/app/MainActivity.kt'), templateActivity);
    write(join(base, 'src-tauri/android/MainActivity.kt'), readFileSync(join(REPO, 'src-tauri/android/MainActivity.kt'), 'utf8'));
    write(join(base, 'src-tauri/android/LithicBridge.kt'), readFileSync(join(REPO, 'src-tauri/android/LithicBridge.kt'), 'utf8'));
    // The association table is read off the project the way the two Kotlin files are, so a test
    // can replace it and ask what the manifest does with a table that changed.
    write(
      join(base, 'src-tauri/src/platform/associations.json'),
      readFileSync(join(REPO, 'src-tauri/src/platform/associations.json'), 'utf8')
    );
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

  const manifestPath = join(base, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml');
  const patchedManifest = readFileSync(manifestPath, 'utf8');
  check(
    'claims the lithic scheme inside the activity that hosts the page',
    first.written.includes('hand-off filter') &&
      patchedManifest.includes('<data android:scheme="lithic" />') &&
      patchedManifest.indexOf('android:scheme="lithic"') < patchedManifest.indexOf('</activity>'),
    first.written.includes('hand-off filter') ? '' : 'the filter was not written'
  );
  // The share sheet, which is what puts the app beside every other share target on the phone. The
  // mime type is the whole claim, and it has to be inside the activity so the extras arrive there.
  check(
    'claims the share sheet inside the same activity',
    first.written.includes('share filter') &&
      patchedManifest.includes('<action android:name="android.intent.action.SEND" />') &&
      patchedManifest.includes('<data android:mimeType="text/plain" />') &&
      patchedManifest.indexOf('android.intent.action.SEND') < patchedManifest.indexOf('</activity>'),
    first.written.includes('share filter') ? '' : 'the share filter was not written'
  );

  // The document types, which are the association table reaching the phone. The claim is the type
  // rather than the extension, because that is the only vocabulary Android offers, and the whole
  // filter has to sit inside the activity so the reference arrives there.
  check(
    'claims the association table\'s types inside the same activity',
    first.written.includes('document type filter') &&
      patchedManifest.includes('<data android:mimeType="application/x-lith" />') &&
      patchedManifest.includes('<data android:mimeType="text/markdown" />') &&
      patchedManifest.includes('<data android:mimeType="text/html" />') &&
      patchedManifest.lastIndexOf('android:mimeType=') < patchedManifest.indexOf('</activity>'),
    first.written.includes('document type filter') ? '' : 'the type filter was not written'
  );
  // The types this app converts rather than edits are claimed too, because a handed one opens in
  // a new Lith named after it rather than being refused: the phone has no folder beside the source
  // to write the sibling into, which is a fact about the save rather than about the offer.
  check(
    'claims the imported types as well, since a handed file opens in a Lith of its own',
    patchedManifest.includes('<data android:mimeType="application/pdf" />') &&
      patchedManifest.includes('<data android:mimeType="application/epub+zip" />') &&
      patchedManifest.includes('<data android:mimeType="image/png" />') &&
      patchedManifest.includes('<data android:mimeType="image/jpeg" />') &&
      patchedManifest.includes('<data android:scheme="content" android:pathPattern=".*\\.pdf" />')
  );
  // The extension half, which is the only way a provider that knows nothing about `.lith` can
  // offer the app: the path of the URI is what it has, and the storage provider's path is the
  // real one.
  check(
    'claims the extensions by path for both schemes a file manager hands over',
    first.written.includes('document extension filter') &&
      patchedManifest.includes('<data android:scheme="content" android:pathPattern=".*\\.lith" />') &&
      patchedManifest.includes('<data android:scheme="file" android:pathPattern=".*\\.lith" />') &&
      patchedManifest.lastIndexOf('android:pathPattern=') < patchedManifest.indexOf('</activity>'),
    first.written.includes('document extension filter') ? '' : 'the extension filter was not written'
  );
  check(
    'keeps every new filter Browsable-free, which belongs to addresses and not to content',
    (patchedManifest.match(/BROWSABLE/g) ?? []).length === 1
  );
  check(
    'keeps the template launch filter beside the new ones',
    patchedManifest.includes('android.intent.category.LAUNCHER') &&
      patchedManifest.includes('android.intent.category.BROWSABLE')
  );

  check(
    'configures release build type to sign with debug key',
    first.releaseSigning === true &&
      readFileSync(join(base, 'src-tauri/gen/android/app/build.gradle.kts'), 'utf8').includes(
        'signingConfig = signingConfigs.getByName("debug")'
      )
  );

  const second = patchAndroid(base);
  check('is idempotent for the activity', second.replaced === false);
  check(
    'is idempotent for the hand-off filter',
    !second.written.includes('hand-off filter') &&
      (readFileSync(manifestPath, 'utf8').match(/android:scheme="lithic"/g) ?? []).length === 1
  );
  check(
    'is idempotent for the share filter',
    !second.written.includes('share filter') &&
      (readFileSync(manifestPath, 'utf8').match(/android.intent.action.SEND/g) ?? []).length === 1
  );
  check(
    'is idempotent for the two document filters',
    second.written.length === 0 &&
      (readFileSync(manifestPath, 'utf8').match(/android:mimeType="application\/x-lith"/g) ?? []).length === 1
  );
  check('is idempotent for the round definition', second.roundIcon === false);
  check('is idempotent for the bridge', second.bridgeReplaced === false);
  check('is idempotent for release signing config', second.releaseSigning === false);

  // Half-claimed is the state a manifest written by a newer template could be in, and the two
  // filters are decided separately: the one already claimed must not be added twice, and the one
  // missing must still arrive.
  seed();
  const halfManifest = readFileSync(join(base, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'), 'utf8').replace(
    '</activity>',
    '  <intent-filter>\n        <action android:name="android.intent.action.VIEW" />\n        <data android:scheme="lithic" />\n      </intent-filter>\n    </activity>'
  );
  write(join(base, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'), halfManifest);
  const half = patchAndroid(base);
  const halfWritten = readFileSync(join(base, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'), 'utf8');
  check(
    'adds only the filter a manifest is missing',
    !half.written.includes('hand-off filter') &&
      half.written.includes('share filter') &&
      half.written.includes('document type filter') &&
      (halfWritten.match(/android:scheme="lithic"/g) ?? []).length === 1
  );

  // Half-claimed the other way round, for the document filters: a manifest that already offers the
  // types must still gain the extension filter, because the two fail in opposite directions.
  seed();
  const typesOnly = readFileSync(join(base, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'), 'utf8').replace(
    '</activity>',
    '  <intent-filter>\n        <action android:name="android.intent.action.VIEW" />\n        <data android:mimeType="application/x-lith" />\n      </intent-filter>\n    </activity>'
  );
  write(join(base, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'), typesOnly);
  const typed = patchAndroid(base);
  check(
    'adds the extension filter to a manifest that already offers the types',
    !typed.written.includes('document type filter') &&
      typed.written.includes('document extension filter') &&
      (readFileSync(join(base, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'), 'utf8').match(
        /android:mimeType="application\/x-lith"/g
      ) ?? []).length === 1
  );

  // A table with no Lith in it would build an APK that cannot open this app's own format, which
  // is the one row the manifest cannot be generated without. The complaint has to name the file.
  seed();
  write(
    join(base, 'src-tauri/src/platform/associations.json'),
    JSON.stringify({ types: [{ ext: 'txt', label: 'Lithic Text', mime: 'text/plain' }] })
  );
  const noLith = throws(() => patchAndroid(base));
  check(
    'refuses a table with no .lith row',
    noLith !== null && noLith.includes('no .lith row'),
    noLith ?? ''
  );

  seed();
  rmSync(join(base, 'src-tauri/src/platform/associations.json'), { force: true });
  const noTable = throws(() => patchAndroid(base));
  check(
    'refuses a project with no association table',
    noTable !== null && noTable.includes('no association table'),
    noTable ?? ''
  );

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

  // A manifest with no activity hosting the page has nothing to claim the scheme, and an APK with
  // no filter is one a board's hand-off can only ever miss.
  seed();
  write(
    join(base, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'),
    '<manifest xmlns:android="http://schemas.android.com/apk/res/android">\n  <application />\n</manifest>\n'
  );
  const noActivity = throws(() => patchAndroid(base));
  check(
    'refuses a manifest with no activity to attach the hand-off to',
    noActivity !== null && noActivity.includes('nothing can claim the lithic scheme'),
    noActivity ?? ''
  );

  seed();
  rmSync(join(base, 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'), { force: true });
  const noManifest = throws(() => patchAndroid(base));
  check('refuses a project with no manifest', noManifest !== null && noManifest.includes('no AndroidManifest.xml'), noManifest ?? '');

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
        (done.roundIcon ? ', round adaptive icon written' : '') +
        (done.written.length > 0 ? `, filters claimed: ${done.written.join(', ')}` : ', every filter already claimed')
    );
    return 0;
  } catch (error) {
    console.error(`Android patch failed: ${error.message}`);
    return 1;
  }
}

process.exit(main());
