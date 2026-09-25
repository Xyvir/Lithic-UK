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
 *   5. the release trigger (every path the release commits is excluded from the
 *      push trigger that starts it — otherwise a run's own commit starts
 *      another run, forever)
 *   6. the light distribution guard (variants/lithic-light.html against
 *      src/lithic.html: same core, same plugin versions, still flash-sized)
 *   7. cargo check (Rust type/borrow check — catches the recent E07xx class
 *      of release-workflow failures)
 *   8. cargo clippy (Rust lint pass, warnings are failures)
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
 * A push to main runs the release now (.github/workflows/build-wiki.yml,
 * `on.push`). That run COMMITS the artifacts it just built, so any path it
 * stages has to be excluded from the trigger that started it: otherwise its own
 * commit starts another run, which commits the same files again, forever.
 *
 * The trigger is a blacklist over `**`, so a path is live unless it is named in
 * `on.push.paths` — adding one line to the release's `git add` is all it takes
 * to start the loop. That is what this checks, from the two sides that matter:
 * every staged path is excluded (by name or by `dir/**`), and the filter still
 * has a positive pattern (GitHub runs nothing for a filter of exclusions only,
 * so the release would silently never fire on push at all).
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
  const prodCommit = steps.find((step) => /Commit Built Wiki and Bump PWA/.test(step.name || ''));
  if (!prodCommit) {
    return `${file}: the prod commit step ("Commit Built Wiki and Bump PWA") is gone — point this check at whatever replaced it`;
  }
  const addLine = String(prodCommit.run || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith('git add '));
  if (!addLine) {
    return `${file}: no \`git add\` in the prod commit step — point this check at whatever replaced it`;
  }
  const staged = addLine.slice('git add '.length).trim().split(/\s+/);
  const unresolved = staged.filter((entry) => entry.includes('$'));
  if (unresolved.length > 0) {
    return `${file}: the prod commit stages ${unresolved.join(', ')}, which this check cannot resolve — keep that path list literal`;
  }
  const excluded = paths
    .filter((entry) => String(entry).startsWith('!'))
    .map((entry) => String(entry).slice(1));
  const uncovered = staged.filter(
    (entry) => !excluded.some((pattern) => pattern === entry || (pattern.endsWith('/**') && entry.startsWith(pattern.slice(0, -2)))),
  );
  if (uncovered.length > 0) {
    return `${file}: the release commits ${uncovered.join(', ')}, which on.push.paths does not exclude — the run's own commit would start another run, forever`;
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
  ];
  for (const step of rustSteps) {
    process.stdout.write(`> ${step.name.padEnd(28, ' ')}`);
    const res = spawnSync('cargo', step.args, {
      cwd: path.join(repoRoot, 'src-tauri'),
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
