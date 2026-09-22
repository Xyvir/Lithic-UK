#!/usr/bin/env node
/**
 * Local pre-push gate. Everything CI would catch is verified here before
 * pushing:
 *
 *   1. launcher-ui unit tests (node --test)
 *   2. svelte-check (svelte + TS types)
 *   3. workflow YAML sanity (js-yaml parse of every .github/workflows file)
 *   4. the light distribution guard (variants/lithic-light.html against
 *      src/lithic.html: same core, same plugin versions, still flash-sized)
 *   5. cargo check (Rust type/borrow check — catches the recent E07xx class
 *      of release-workflow failures)
 *   6. cargo clippy (Rust lint pass, warnings are failures)
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

process.stdout.write('> workflow YAML sanity           ');
const yamlProblems = checkWorkflowYaml();
if (yamlProblems === null) {
  console.log('OK');
} else {
  failed = true;
  console.log('FAILED');
  console.log('  ' + yamlProblems);
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
