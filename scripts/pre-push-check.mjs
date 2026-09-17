#!/usr/bin/env node
/**
 * Fast local pre-push gate. This machine has no MSVC toolchain, so Rust
 * cannot be compiled here — `cargo check` is handled by the Rust Check
 * workflow (.github/workflows/rust-check.yml), which runs on every push to
 * main that touches src-tauri/**. Everything else that CI would catch is
 * verified here, fast, before pushing:
 *
 *   1. launcher-ui unit tests (node --test)
 *   2. svelte-check (svelte + TS types)
 *   3. workflow YAML sanity (js-yaml parse of every .github/workflows file)
 *
 * Usage: npm run check:push   (or: node scripts/pre-push-check.mjs)
 * Exit 0 = safe to push; nonzero = fix before pushing.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import process from 'node:process';
import { load as loadYaml } from 'js-yaml';

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

console.log('');
if (failed) {
  console.error('check:push FAILED — fix the above before pushing.');
  process.exit(1);
}
console.log('check:push OK — safe to push.');
console.log('Note: Rust is type-checked by CI (Rust Check workflow) — watch for it after pushing src-tauri changes.');
process.exit(0);
