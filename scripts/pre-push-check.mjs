#!/usr/bin/env node
/**
 * Local pre-push gate. Everything CI would catch is verified here before
 * pushing:
 *
 *   1. launcher-ui unit tests (node --test)
 *   2. svelte-check (svelte + TS types)
 *   3. lockfile sync (every dep in package.json is the spec the lock records,
 *      so `npm ci` cannot fail with EUSAGE in CI)
 *   4. workflow YAML sanity (js-yaml parse of every .github/workflows file)
 *   5. the shim's build tag (the release workflow's shim job sets
 *      LITHIC_BUILD_TAG, which is the only thing that can turn the shim's update
 *      notice on: a build without it serves no tag and offers nothing)
 *   6. the release trigger (every path the release commits is excluded from the
 *      push trigger that starts it — otherwise a run's own commit starts
 *      another run, forever)
 *   7. the light distribution guard (variants/lithic-light.html against
 *      src/lithic.html: same core, same plugin versions, still flash-sized)
 *   8. cargo check (Rust type/borrow check — catches the recent E07xx class
 *      of release-workflow failures)
 *   9. cargo clippy (Rust lint pass, warnings are failures)
 *  10. the shim's own cargo check, clippy and unit tests (shim/Cargo.toml: a
 *      crate of its own beside src-tauri, so nothing above compiles it, and it
 *      is what the small Linux AppImage carries)
 *
 * Usage: npm run check:push   (or: node scripts/pre-push-check.mjs)
 * Exit 0 = safe to push; nonzero = fix before pushing.
 *
 * Requires: node, launcher-ui deps, VS Build Tools (MSVC) on PATH-adjacent
 * standard locations for cargo. First run compiles all Rust deps (~2-3 min);
 * afterwards cargo steps are seconds, warm.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { load as loadYaml } from 'js-yaml';

const repoRoot = process.cwd();

/** Returns null when every workflow file parses, else a failure message. */
function checkWorkflowYaml() {
  const problems = [];
  for (const file of fs.readdirSync('.github/workflows')) {
    if (!/\.ya?ml$/.test(file)) continue;
    try {
      loadYaml(fs.readFileSync(`.github/workflows/${file}`, 'utf8'));
    } catch (error) {
      problems.push(`${file}: ${String(error.message).split('\n')[0]}`);
    }
  }
  return problems.length === 0 ? null : problems.join('\n  ');
}

/**
 * The shim's update notice is decided by a tag the release build compiles in, and
 * nothing inside the shim can notice that the workflow stopped setting it: the binary
 * would simply serve no tag, and a release would go out unable to say a newer one
 * exists. The two halves of that are in files that cannot see each other, so the
 * workflow side is pinned here: the shim job's build step sets LITHIC_BUILD_TAG from
 * the same tag step the Windows job reads, which is also what makes the downloads
 * of one release carry one tag. The shim is the only Linux artifact the release
 * publishes now; the WebKitGTK build still lives in `src-tauri` and builds by hand
 * (see `README.md`), so its absence from the workflow is no longer an error.
 *
 * Returns null when the shim build is tagged, else a failure message.
 */
function checkShimBuildTag() {
  const file = '.github/workflows/desktop-release.yaml';
  let doc;
  try {
    doc = loadYaml(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return `${file}: ${String(error.message).split(/\r?\n/)[0]}`;
  }
  const job = (doc.jobs || {})['build-shim-appimage'];
  if (!job) {
    return `${file}: the build-shim-appimage job is gone — point this check at whatever replaced it`;
  }
  const build = (job.steps || []).find((step) => /Build Shim AppImage/.test(step.name || ''));
  if (!build) {
    return `${file}: the shim job has no "Build Shim AppImage" step — point this check at whatever replaced it`;
  }
  const tag = (build.env || {}).LITHIC_BUILD_TAG;
  if (!tag) {
    return `${file}: the shim build does not set LITHIC_BUILD_TAG, so a released shim could never offer a newer one`;
  }
  if (!/steps\.tag\.outputs\.date/.test(String(tag))) {
    return `${file}: the shim's LITHIC_BUILD_TAG is ${tag}, which is not the tag step's date output — the tag the launcher compares is that same output`;
  }
  return null;
}

/**
 * Each project CI installs with `npm ci`. A dependency range edited in
 * package.json but never written back to the lock makes `npm ci` abort with
 * "can only install packages when your package.json and package-lock.json are
 * in sync" — and nothing else local notices, because every gate runs against
 * the already-installed tree. The lock records the spec it resolved from in its
 * root entry (`packages['']`), so comparing the specs catches the drift
 * exactly, with no registry access and no semver arithmetic. Which versions npm
 * would then resolve is a separate question from whether it will even try.
 */
/**
 * A push to main runs the build (.github/workflows/build-wiki.yml, `on.push`).
 * What that run then does with what it built is what this guards, and that
 * changed on 2026-10-09: a PROD release stages its commit on a `release/<stamp>`
 * branch and opens a review pull request, so it does not touch main at all and
 * cannot loop, while a non-prod variant built by dispatch still commits straight
 * to main. A run whose own commit starts another run commits the same files
 * again, forever, so any path a pushing step stages has to be excluded from the
 * trigger that started it.
 *
 * The trigger is a blacklist over `**`, so a path is live unless it is named in
 * `on.push.paths` — adding one line to a `git add` is all it takes to start the
 * loop. That is what this checks, from the three sides that matter: every staged
 * path is excluded (by name or by `dir/**`, with a path built from a variable
 * allowed only when the directory before the variable is excluded wholesale), the
 * filter still has a positive pattern (GitHub runs nothing for a filter of
 * exclusions only, so the build would silently never fire on push at all), and
 * the prod release still stages a branch rather than pushing to main, which is
 * what review-before-publish rests on.
 *
 * Returns null when the trigger is safe, else the failure message.
 */
function checkReleaseTrigger() {
  const file = '.github/workflows/build-wiki.yml';
  let doc;
  try {
    doc = loadYaml(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return `${file}: ${String(error.message).split(/\r?\n/)[0]}`;
  }
  // js-yaml reads a bare `on:` as the YAML 1.1 boolean true.
  const on = (doc && (doc.on || doc[true])) || {};
  const paths = on.push && on.push.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    return `${file}: no on.push.paths — a push to main would not start a release`;
  }
  if (!paths.some((entry) => !String(entry).startsWith('!'))) {
    return `${file}: on.push.paths is exclusions only — GitHub will not run the workflow for a filter without a positive pattern`;
  }
  const steps = (doc.jobs && doc.jobs.build && doc.jobs.build.steps) || [];
  const excluded = paths
    .filter((entry) => String(entry).startsWith('!'))
    .map((entry) => String(entry).slice(1));
  /**
   * Is this staged path kept out of the trigger? A path built from a variable
   * (`variants/$BUILD_CONFIG.html`) cannot be compared literally, so it counts as safe
   * only when the directory before the variable is excluded wholesale — which it is, and
   * which is the only reason that path is allowed to be dynamic at all.
   */
  const covered = (entry) => {
    if (entry.includes('$')) {
      const prefix = entry.slice(0, entry.indexOf('$'));
      return excluded.some((pattern) => pattern.endsWith('/**') && prefix.startsWith(pattern.slice(0, -2)));
    }
    return excluded.some(
      (pattern) => pattern === entry || (pattern.endsWith('/**') && entry.startsWith(pattern.slice(0, -2))),
    );
  };

  // This deliberately does not look for a step by NAME. It used to look for "Commit Built
  // Wiki and Bump PWA", and when a prod release stopped pushing to main and started staging
  // a review branch, that name changed and the check failed on a rename rather than on a
  // loop. What it follows is the push: `git push`, and `ci-push-main.sh`, which pushes
  // without saying so. A prod release stages src/lithic.html, src/launcher.html, the
  // variants, manifest.json and the service worker on a branch; the non-prod variant
  // committed by dispatch is the one that still reaches main, and its staged path is what
  // this is really guarding.
  /**
   * A step's shell with its comments removed. A comment that names a command is not that
   * command, and this check would otherwise read its own explanation as evidence: the step
   * that stages a review branch explains in one of its comments why it no longer calls
   * `ci-push-main.sh`, and a check that counted that sentence would report the script as
   * being called by the very step that stopped calling it.
   */
  const shell = (step) =>
    String(step.run || '')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
  const pushers = steps.filter((step) => /\bgit\s+push\b|ci-push-main\.sh/.test(shell(step)));
  if (pushers.length === 0) {
    return `${file}: no step pushes anything — point this check at whatever replaced the release commit`;
  }
  const staged = pushers.flatMap((step) =>
    shell(step)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('git add '))
      .flatMap((line) => line.slice('git add '.length).trim().split(/\s+/)),
  );
  if (staged.length === 0) {
    return `${file}: the steps that push stage nothing with \`git add\` — point this check at whatever replaced them`;
  }
  const uncovered = staged.filter((entry) => !covered(entry));
  if (uncovered.length > 0) {
    return `${file}: the release commits ${uncovered.join(', ')}, which on.push.paths does not exclude — the run's own commit would start another run, forever`;
  }

  // The other half of the guard, and the newer half: a prod release must not reach main at
  // all. If it ever does, review-before-publish is gone and every artifact it stages becomes
  // a path the trigger has to exclude, which is the arrangement this check exists to keep
  // honest.
  const prodStage = steps.find((step) => /Stage the release on a branch/.test(step.name || ''));
  if (!prodStage) {
    return `${file}: the prod release step ("Stage the release on a branch") is gone — point this check at whatever replaced it`;
  }
  if (/ci-push-main\.sh/.test(shell(prodStage))) {
    return `${file}: the prod release pushes to main again — it must stage a review branch, so that nothing publishes before it is merged`;
  }
  return null;
}

const lockProjects = [
  { dir: '.', label: 'package.json' },
  { dir: 'launcher-ui', label: 'launcher-ui/package.json' },
];
const lockDepFields = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/** Returns null when every lock agrees with its package.json, else a message. */
function checkLockfileSync() {
  const problems = [];
  for (const { dir, label } of lockProjects) {
    const pkgPath = path.join(dir, 'package.json');
    const lockPath = path.join(dir, 'package-lock.json');
    if (!fs.existsSync(lockPath)) {
      // npm-shrinkwrap.json would be the lock instead; only a problem if
      // there is a package.json that CI installs.
      if (fs.existsSync(pkgPath) && !fs.existsSync(path.join(dir, 'npm-shrinkwrap.json'))) {
        problems.push(`${label}: no lockfile beside it — CI's \`npm ci\` cannot run`);
      }
      continue;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const root = (lock.packages ?? {})[''] ?? {};
    for (const field of lockDepFields) {
      const declared = pkg[field] ?? {};
      const recorded = root[field] ?? {};
      for (const name of new Set([...Object.keys(declared), ...Object.keys(recorded)])) {
        if (declared[name] === recorded[name]) continue;
        const from = declared[name] ?? '(absent)';
        const to = recorded[name] ?? '(absent)';
        problems.push(
          `${label} ${field} ${name}: package.json says ${from}, lock says ${to}` +
            (declared[name] === undefined
              ? ' — remove it from the lock with `npm install`'
              : ' — run `npm install` to update the lock'),
        );
      }
      // A declared dep must also actually resolve in the lock; a spec that
      // matches but has no entry would still fail `npm ci`.
      for (const name of Object.keys(declared)) {
        if (recorded[name] !== declared[name]) continue;
        if ((lock.packages ?? {})[`node_modules/${name}`] === undefined) {
          problems.push(`${label} ${field} ${name}: declared but has no resolved entry in the lock`);
        }
      }
    }
  }
  return problems.length === 0 ? null : problems.join('\n  ');
}

/**
 * Locate the MSVC linker environment. cargo finds MSVC itself via vswhere,
 * but only when its registry/COM discovery runs outside Git Bash quirks —
 * normally plain `cargo` just works once Build Tools are installed.
 */
function checkCargoAvailable() {
  const probe = spawnSync('cargo', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' });
  return probe.status === 0;
}

const spawned = [
  {
    name: 'launcher-ui unit tests',
    cmd: 'node',
    args: ['--experimental-strip-types', '--test', 'src/*.test.ts'],
    cwd: 'launcher-ui',
  },
  {
    name: 'svelte-check',
    cmd: 'npx',
    args: ['svelte-check', '--tsconfig', './tsconfig.json'],
    cwd: 'launcher-ui',
  },
  {
    name: 'light artifact guard',
    cmd: 'node',
    args: ['scripts/check-light-artifact.mjs'],
  },
];

let failed = false;

for (const step of spawned) {
  const label = step.name.padEnd(28, ' ');
  process.stdout.write(`> ${label}`);
  const res = spawnSync(step.cmd, step.args, {
    cwd: step.cwd,
    shell: process.platform === 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  });
  const out = (res.stdout ?? '') + (res.stderr ?? '');
  const tail = out.trim().split('\n').slice(-3).join('\n  ');
  if (res.status === 0) {
    console.log('OK');
    if (tail) console.log('  ' + tail);
  } else {
    failed = true;
    console.log('FAILED');
    console.log('  ' + tail);
  }
}

process.stdout.write('> lockfile sync                  ');
const lockProblems = checkLockfileSync();
if (lockProblems === null) {
  console.log('OK');
} else {
  failed = true;
  console.log('FAILED');
  console.log('  ' + lockProblems);
}

process.stdout.write('> workflow YAML sanity           ');
const yamlProblems = checkWorkflowYaml();
if (yamlProblems === null) {
  console.log('OK');
} else {
  failed = true;
  console.log('FAILED');
  console.log('  ' + yamlProblems);
}

process.stdout.write('> shim build tag                 ');
const tagProblem = checkShimBuildTag();
if (tagProblem === null) {
  console.log('OK');
} else {
  failed = true;
  console.log('FAILED');
  console.log('  ' + tagProblem);
}

process.stdout.write('> release trigger                ');
const triggerProblem = checkReleaseTrigger();
if (triggerProblem === null) {
  console.log('OK');
} else {
  failed = true;
  console.log('FAILED');
  console.log('  ' + triggerProblem);
}

if (checkCargoAvailable()) {
  const rustSteps = [
    { name: 'cargo check (rust types)', args: ['check', '--quiet'] },
    { name: 'cargo clippy (rust lints)', args: ['clippy', '--quiet', '--', '-D', 'warnings'] },
    // Rust unit tests (the GitHub-sync merge policy). CI type-checks them via
    // `cargo check --all-targets`, which does not run them, so they are
    // enforced here. Skipped when cargo is unavailable, like the steps above.
    { name: 'cargo test (rust units)', args: ['test', '--quiet'] },
    // The shim, which no step above reaches: `shim/` is a package of its own
    // rather than a member of the Tauri workspace, so `cargo check` in src-tauri
    // never sees it. It is a small crate, but it is the whole small download, so
    // it gets the same three gates as the app.
    { name: 'cargo check (shim)', args: ['check', '--manifest-path', 'shim/Cargo.toml', '--quiet'], cwd: repoRoot },
    {
      name: 'cargo clippy (shim lints)',
      args: ['clippy', '--manifest-path', 'shim/Cargo.toml', '--all-targets', '--quiet', '--', '-D', 'warnings'],
      cwd: repoRoot,
    },
    { name: 'cargo test (shim units)', args: ['test', '--manifest-path', 'shim/Cargo.toml', '--quiet'], cwd: repoRoot },
  ];
  for (const step of rustSteps) {
    process.stdout.write(`> ${step.name.padEnd(28, ' ')}`);
    const res = spawnSync('cargo', step.args, {
      cwd: step.cwd ?? path.join(repoRoot, 'src-tauri'),
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const out = (res.stdout ?? '') + (res.stderr ?? '');
    const tail = out.trim().split('\n').slice(-4).join('\n  ');
    if (res.status === 0) {
      console.log('OK');
    } else {
      failed = true;
      console.log('FAILED');
      console.log('  ' + tail);
    }
  }
} else {
  console.log('> cargo (rust checks)           SKIPPED — cargo not found; Rust is still gated by CI (Rust Check workflow)');
}

console.log('');
if (failed) {
  console.error('check:push FAILED — fix the above before pushing.');
  process.exit(1);
}
console.log('check:push OK — safe to push.');
process.exit(0);
