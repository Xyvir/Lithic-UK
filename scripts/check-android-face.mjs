/**
 * Does the crate compile with the git face the phone gets?
 *
 * `lib.rs` chooses which module `gitcore` means: the libgit2 one on a desktop, and
 * `gitcore_unsupported` (a drop-in that refuses every question, because a phone has no
 * git in it) on Android. That choice is a `cfg(target_os = "android")`, so no gate on a
 * developer's machine resolves a single `gitcore::` reference against the stub — which
 * is how a build-breaking surface drift shipped: the sync contract's constants moved,
 * `gitcore.rs` followed them, the stub did not, and the Android job was the first thing
 * to notice.
 *
 * This gate compiles the crate with that predicate forced true, on the host, with no
 * SDK and no NDK. Every `cfg(target_os = "android")` in the crate's own sources and in
 * `shared/` is rewritten to `all()` (which is true) in a throwaway copy, which is the
 * whole of what a target switch does for this crate: the stub becomes the git face, and
 * the libgit2 module and the git half of `shared/sync_core.rs` are pruned the way the
 * phone prunes them.
 *
 * What this does NOT reproduce, deliberately, and each is stated where it is decided:
 * `cfg(windows)` stays true on a Windows host, because forcing it false would prune a
 * module the host build needs, so the copy is a superset of the phone's files — the safe
 * direction, since extra code cannot hide an error in the phone's own face; and the
 * phone's document answers in `platform/android.rs` are left untransformed, because they
 * call Tauri APIs that exist only in a Tauri-for-Android build, so the APK job stays
 * their gate (see MOBILE_BODIES_ARE_CI_ONLY below). Everything else — including the
 * libgit2 face, the stub as the git face, and the shared module's own Android pruning —
 * is the phone's arrangement rather than the host's.
 *
 * The rewrite is asserted rather than trusted (see the agreement checks below): if the
 * crate's predicate is ever spelled differently, this gate says so and stops instead of
 * quietly compiling the desktop's arrangement and passing.
 *
 * Usage: node scripts/check-android-face.mjs [--keep]
 *   --keep  leave the copy on disk, whether it passed or failed
 */
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crateDir = path.join(repoRoot, 'src-tauri');
const keep = process.argv.includes('--keep');

const ANDROID = 'target_os = "android"';
const TRUE = 'all()'; // `cfg(all())` is true, so `not(all())` is false: the phone's answers.

// The one file this gate leaves exactly as the host sees it, and the file says why in its
// own header: the phone's document answers call `PluginApi::register_android_plugin` and
// `PluginHandle::run_mobile_plugin`, which Tauri exposes only in a build where Tauri
// itself is compiled for Android or iOS. Forcing this crate's predicate true on a host
// makes the call appear and the callee absent, so those bodies keep the phone's pruning
// here and the Android job stays their gate. Their signatures and routing arms are
// uncompiled on no platform, which is the part a desktop gate was always able to check.
const MOBILE_BODIES_ARE_CI_ONLY = ['platform/android.rs'];

// The files the crate's own compilation is made of. `tauri.conf.json`, `capabilities/` and
// `icons/` come along because the build script reads them; `src/` at the repository root is
// the `frontendDist` those settings name, which the copy finds at the same relative depth.
const CRATE_ENTRIES = ['src', 'Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json', 'capabilities', 'icons'];

const work = mkdtempSync(path.join(tmpdir(), 'lithic-android-face-'));
const crateCopy = path.join(work, 'crate');

function copy(entry, from) {
  cpSync(from, path.join(work, entry), { recursive: true });
}

for (const entry of CRATE_ENTRIES) copy(path.join('crate', entry), path.join(crateDir, entry));
copy('shared', path.join(repoRoot, 'shared'));
copy('src', path.join(repoRoot, 'src'));

/** Every .rs file under a directory, the copied ones this gate rewrites. */
function rustFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return rustFiles(full);
    return entry.name.endsWith('.rs') ? [full] : [];
  });
}

let rewritten = 0;
let leftAlone = [];
for (const file of [...rustFiles(path.join(crateCopy, 'src')), ...rustFiles(path.join(work, 'shared'))]) {
  if (MOBILE_BODIES_ARE_CI_ONLY.includes(path.relative(path.join(crateCopy, 'src'), file).split(path.sep).join('/'))) {
    leftAlone.push(path.relative(work, file).split(path.sep).join('/'));
    continue;
  }
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/(?<=\n)/);
  let touched = 0;
  const next = lines.map((line) => {
    // Comments explain the predicate and are left alone; only a real cfg position counts.
    if (line.trimStart().startsWith('//') || !line.includes(ANDROID)) return line;
    if (!/(#\[cfg\(|cfg!\(|cfg_attr\()/.test(line)) return line;
    touched += line.split(ANDROID).length - 1;
    return line.split(ANDROID).join(TRUE);
  });
  if (touched) {
    writeFileSync(file, next.join(''));
    rewritten += touched;
  }
}

/** The copy, with line endings normalized, for the agreement checks. */
const readCopy = (relative) => readFileSync(path.join(work, relative), 'utf8').replace(/\r\n/g, '\n');

const lib = readCopy('crate/src/lib.rs');
const stub = readCopy('crate/src/gitcore_unsupported.rs');
const sharedCore = readCopy('shared/sync_core.rs');

const agreements = [
  ['the libgit2 face is pruned', lib.includes('#[cfg(not(all()))]\nmod gitcore;')],
  ['the stub is compiled', lib.includes('#[cfg(any(all(), test))]\nmod gitcore_unsupported;')],
  ['the stub is the git face', lib.includes('#[cfg(all())]\nuse gitcore_unsupported as gitcore;')],
  ['the shared git half is pruned the way the phone prunes it', (sharedCore.match(/#\[cfg\(not\(all\(\)\)\)\]/g) || []).length >= 10],
  ['the mobile bodies keep the phone\'s pruning (they are the Android job\'s gate)',
    readCopy('crate/src/platform/android.rs').includes(`#[cfg(${ANDROID})]`)]
];
const broken = agreements.filter(([, ok]) => !ok).map(([what]) => what);

if (broken.length) {
  console.error(
    `\nFAIL: this gate's rewrite no longer arranges the phone's build.\n  * ${broken.join('\n  * ')}\n` +
      `It rewrites every \`${ANDROID}\` in src-tauri/src and shared/ to \`${TRUE}\`; a predicate spelled\n` +
      `some other way means it would compile the desktop's arrangement and pass, which is worse than\n` +
      `not running at all. Fix scripts/check-android-face.mjs with the crate's new spelling.\nCopy kept at ${work}\n`
  );
  process.exit(1);
}

console.log(`android face: ${rewritten} android predicates forced true, compiling the crate the way the phone does`);
if (leftAlone.length) console.log(`android face: left as the host sees it, on purpose: ${leftAlone.join(', ')}`);

const cargo = spawnSync('cargo', ['check', '--lib', '--message-format=json'], {
  cwd: crateCopy,
  // The crate's own target directory, so the dependencies the sibling cargo steps already
  // built are reused instead of compiled twice.
  env: { ...process.env, CARGO_TARGET_DIR: path.join(crateDir, 'target') },
  encoding: 'utf8',
  maxBuffer: 256 * 1024 * 1024
});
if (cargo.error) {
  console.log(`android face: SKIPPED — cargo not found (${cargo.error.code}); Rust is still gated by the Rust Check workflow`);
  rmSync(work, { recursive: true, force: true });
  process.exit(0);
}

// Only messages about the copy count: a dependency's warning is not this gate's subject.
// `src_path` sits on the JSON line itself, beside `message` rather than inside it, so this
// takes the whole line. Reading it off `parsed.message` is what an earlier version did, and
// cargo's silence there made every message a stranger's: the gate reported a pass over a
// build that failed with five errors. The negative control in this gate's rounds entry is
// what caught it, and the evidence line below is what makes the same mistake visible.
// `src_path` can also arrive relative to the package being compiled, so an absolute one is
// used as it stands and a relative one resolves against the copy.
const ours = (parsed) => {
  const src = parsed.target?.src_path || '';
  if (!src) return false;
  const absolute = path.isAbsolute(src) ? src : path.resolve(crateCopy, src);
  return absolute.startsWith(work + path.sep) || absolute === work;
};
const messages = cargo.stdout
  .split('\n')
  .filter((line) => line.startsWith('{'))
  .flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed.reason === 'compiler-message' && ours(parsed) ? [parsed.message] : [];
    } catch {
      return [];
    }
  });

// What cargo actually decided, because a verdict is only worth the evidence under it: an
// up-to-date unit compiles nothing, and a pass from a build that never ran is the failure
// this gate exists to prevent. `fresh` is cargo's own word for "reused its fingerprint".
const units = cargo.stdout
  .split('\n')
  .filter((line) => line.startsWith('{'))
  .flatMap((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed.reason === 'compiler-artifact' && /\blithic\b/.test(parsed.package_id || '') ? [parsed] : [];
    } catch {
      return [];
    }
  });
const evidence = `cargo exited ${cargo.status}, ${units.length} unit(s) for this crate (${units.filter((u) => u.fresh).length} fresh), ${messages.length} message(s)`;
const errors = messages.filter((message) => message.level === 'error');
const warnings = messages.filter((message) => message.level === 'warning');

const show = (message) => {
  const text = (message.rendered || message.message || '').trimEnd();
  const again = text.startsWith('error') || text.startsWith('warning') ? text.split('\n').slice(1).join('\n').trim() : text;
  console.log(`  ${message.level}: ${message.message}`);
  if (again) console.log(`    ${again.replace(/\n/g, '\n    ')}`);
};

if (errors.length || warnings.length) {
  console.error(`\nFAIL: the crate does not compile cleanly with the phone's git face — ${errors.length} error(s), ${warnings.length} warning(s) (${evidence}).`);
  for (const message of [...errors, ...warnings]) show(message);
  if (!messages.length) {
    console.error(`  cargo exited ${cargo.status} without a compiler message about this crate; its output ends:\n`);
    console.error((cargo.stderr || cargo.stdout || '').split('\n').slice(-15).join('\n'));
  }
  console.error(
    `\nThe host gates resolve every \`gitcore::…\` reference against the libgit2 module; here they resolve\n` +
      `against gitcore_unsupported.rs, which is what Android does. Copy kept at ${work}\n` +
      `(rerun it with: cd ${crateCopy} && cargo check --lib)\n`
  );
  process.exit(1);
}

// A pass has to be a compile, not a shrug: every unit for this crate up to date means cargo
// reused a fingerprint and resolved no `gitcore::` reference at all.
const compiled = units.some((unit) => !unit.fresh);
if (!compiled) {
  console.error(
    `\nFAIL: cargo compiled nothing for this crate, so this gate proved nothing (${evidence}).\n` +
      `The copy is a fresh directory and its target directory is the crate's own, which cargo treats as\n` +
      `a fingerprint it can reuse. Run \`cargo clean -p lithic\` and try again; if that is what it takes,\n` +
      `this gate needs to stop sharing a target directory with the crate it is checking.\nCopy kept at ${work}\n`
  );
  process.exit(1);
}

console.log(`PASS: the crate compiles cleanly with the phone's git face (${rewritten} predicates forced true, ${evidence})`);
if (keep) {
  console.log(`android face: the copy is at ${work}`);
} else {
  rmSync(work, { recursive: true, force: true });
}
