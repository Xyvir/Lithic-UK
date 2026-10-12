#!/usr/bin/env node
/**
 * Generate, or check, the copies of the GitHub-sync contract.
 *
 *   node scripts/sync-contract.mjs            write the copies
 *   node scripts/sync-contract.mjs --check    fail when a copy has drifted
 *
 * `launcher-ui/src/git-sync-contract.ts` is the source of truth. This script emits the Rust
 * contract modules and the launcher's `HealthState` union. It also checks the shell and stub
 * clamps, whose local enforcement must remain at the trust boundary that receives the request.
 *
 * Keep policy in the TypeScript data, not in this generator: the ordered HTTP classifier and
 * every sync-wide literal are rendered from that data. `--check` is part of `check:push`, so
 * stale generated copies cannot reach a push.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import process from 'node:process';
import {
  SYNC_CONSTANTS,
  SYNC_STATUS_FALLBACK,
  SYNC_STATUS_RULES,
  SYNC_VERDICTS
} from '../launcher-ui/src/git-sync-contract.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const check = process.argv.includes('--check');
const HEALTH = 'launcher-ui/src/git-sync-health.ts';
const RUST_FILES = [
  { file: 'src-tauri/src/git_sync_contract.rs', sibling: 'src-tauri/src/lib.rs' },
  { file: 'shim/src/git_sync_contract.rs', sibling: 'shim/src/github.rs' }
];
const MARK_START = '// >>> sync-contract: HealthState';
const MARK_END = '// <<< sync-contract: HealthState';
const failures = [];

function lit(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function eolFor(file, sibling) {
  if (existsSync(file)) return readFileSync(file, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  if (sibling && existsSync(sibling)) return readFileSync(sibling, 'utf8').includes('\r\n') ? '\r\n' : '\n';
  return '\r\n';
}

/** Validate the declarative table before emitting code that must compile in both crates. */
function validateContract() {
  const states = new Set(SYNC_VERDICTS.map(({ state }) => state));
  const fallbackVerdicts = SYNC_VERDICTS.filter(({ fallback }) => fallback === true);
  if (fallbackVerdicts.length !== 1 || fallbackVerdicts[0].state !== SYNC_STATUS_FALLBACK) {
    failures.push('the status fallback must name exactly one matching fallback verdict');
  }
  if (SYNC_VERDICTS.filter(({ empty }) => empty !== undefined).length !== 1) {
    failures.push('exactly one verdict must declare the HTTP 409 empty-repository sentence');
  }
  const covered = new Set();
  for (const rule of SYNC_STATUS_RULES) {
    for (const state of [rule.state, rule.pushDenied, rule.rateLimited].filter(Boolean)) {
      if (!states.has(state)) failures.push(`status rule refers to undeclared verdict ${state}`);
    }
    if (!Array.isArray(rule.statuses) || rule.statuses.length === 0) {
      failures.push(`status rule for ${rule.state} has no status ranges`);
      continue;
    }
    for (const [start, end] of rule.statuses) {
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 100 || end > 599 || start > end) {
        failures.push(`invalid HTTP status range ${start}..${end}`);
        continue;
      }
      for (let status = start; status <= end; status += 1) {
        if (covered.has(status)) failures.push(`HTTP status ${status} appears in overlapping rules`);
        covered.add(status);
      }
    }
  }
  if (!Number.isInteger(SYNC_CONSTANTS.trailLimit) || SYNC_CONSTANTS.trailLimit < 1) {
    failures.push('trailLimit must be a positive integer');
  }
  if (!Number.isInteger(SYNC_CONSTANTS.trailLimitMax) || SYNC_CONSTANTS.trailLimitMax < SYNC_CONSTANTS.trailLimit) {
    failures.push('trailLimitMax must be an integer at least trailLimit');
  }
  if (!Number.isInteger(SYNC_CONSTANTS.firstSyncFileCap) || SYNC_CONSTANTS.firstSyncFileCap < 1) {
    failures.push('firstSyncFileCap must be a positive integer');
  }
}

function statusPattern(rule) {
  return rule.statuses.map(([start, end]) => start === end ? String(start) : `${start}..=${end}`).join(' | ');
}

function statusOutcome(rule) {
  let outcome = lit(rule.state);
  if (rule.rateLimited) outcome = `if rate_limited { ${lit(rule.rateLimited)} } else { ${outcome} }`;
  if (rule.pushDenied) outcome = `if push_allowed == Some(false) { ${lit(rule.pushDenied)} } else { ${outcome} }`;
  return outcome;
}

function rustModule() {
  const fallback = SYNC_STATUS_FALLBACK;
  const fallbackVerdict = SYNC_VERDICTS.find((verdict) => verdict.state === fallback);
  const withEmpty = SYNC_VERDICTS.find((verdict) => verdict.empty !== undefined);
  const verdicts = SYNC_VERDICTS.filter((verdict) => verdict.state !== fallback);
  const detailArms = verdicts.map((verdict) => `            ${lit(verdict.state)} => ${lit(verdict.detail)},`);
  const statusArms = SYNC_STATUS_RULES.map((rule) => `        ${statusPattern(rule)} => ${statusOutcome(rule)},`);
  const constants = [
    ['TRAIL_LIMIT', SYNC_CONSTANTS.trailLimit, 'usize'],
    ['TRAIL_LIMIT_MAX', SYNC_CONSTANTS.trailLimitMax, 'usize'],
    ['FIRST_SYNC_FILE_CAP', SYNC_CONSTANTS.firstSyncFileCap, 'usize'],
    ['MAIN', SYNC_CONSTANTS.mainRef, '&str'],
    ['REMOTE_MAIN', SYNC_CONSTANTS.remoteMainRef, '&str'],
    ['ORIGIN_FETCH_SPEC', SYNC_CONSTANTS.originFetchSpec, '&str'],
    ['PRE_REVERT_MESSAGE', SYNC_CONSTANTS.preRevertMessage, '&str'],
    ['REVERT_MESSAGE_PREFIX', SYNC_CONSTANTS.revertMessagePrefix, '&str'],
    ['MANAGED_MARKER', SYNC_CONSTANTS.managedMarker, '&str']
  ].map(([name, value, type]) => `pub const ${name}: ${type} = ${type === 'usize' ? value : lit(value)};`);

  const lines = [
    '//! The GitHub-sync contract generated from `launcher-ui/src/git-sync-contract.ts`.',
    '//! Do not edit by hand; `npm run contract` writes this file and `check:push` checks it.',
    '',
    ...constants,
    '',
    '/// Classify one GitHub repository response using the ordered rules in the sync contract.',
    'pub fn classify(status: u16, push_allowed: Option<bool>, rate_limited: bool) -> &\'static str {',
    '    match status {',
    ...statusArms,
    `        _ => ${lit(fallback)},`,
    '    }',
    '}',
    '',
    '/// The backend sentence for a verdict, replacing `{repo}` with `owner/name`.',
    'pub fn detail(state: &str, repo: &str, empty: bool) -> String {',
    `    let template = if state == ${lit(withEmpty.state)} && empty {`,
    `        ${lit(withEmpty.empty)}`,
    '    } else {',
    '        match state {',
    ...detailArms,
    `            _ => ${lit(fallbackVerdict.detail)},`,
    '        }',
    '    };',
    '    template.replace("{repo}", repo)',
    '}',
    ''
  ];
  return lines.join('\n');
}

function healthBlock() {
  const pipes = SYNC_VERDICTS.map(
    (verdict, index) => `  | '${verdict.state}'${index === SYNC_VERDICTS.length - 1 ? ';' : ''}`
  ).join('\n');
  return [MARK_START, '/** Verdicts `git_sync_heartbeat` can return. */', 'export type HealthState =', pipes, MARK_END].join('\n');
}

function clampChecks() {
  const shell = 'deploy/github-sync.sh';
  const stub = 'scripts/self-host-stub.mjs';
  return [
    { file: shell, needle: `if [ -z "$LIMIT" ]; then LIMIT=${SYNC_CONSTANTS.trailLimit}; fi`, label: 'default' },
    { file: shell, needle: `if [ "$LIMIT" -gt ${SYNC_CONSTANTS.trailLimitMax} ] 2>/dev/null; then LIMIT=${SYNC_CONSTANTS.trailLimitMax}; fi`, label: 'ceiling' },
    { file: stub, needle: `Math.min(${SYNC_CONSTANTS.trailLimitMax}, Math.floor(asked)) : ${SYNC_CONSTANTS.trailLimit}`, label: 'clamp' }
  ];
}

function emit(file, nextBody, sibling) {
  const fullPath = path.join(root, file);
  const eol = eolFor(fullPath, sibling ? path.join(root, sibling) : null);
  const next = nextBody.split('\n').join(eol);
  const onDisk = existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : null;
  if (onDisk !== null && onDisk.replace(/\r\n/g, '\n') === nextBody) {
    console.log(`OK  ${file}`);
    return;
  }
  if (check) {
    failures.push(file);
    return;
  }
  writeFileSync(fullPath, next);
  console.log(`Wrote ${file}`);
}

function emitRegion(file) {
  const fullPath = path.join(root, file);
  const full = readFileSync(fullPath, 'utf8');
  const eol = full.includes('\r\n') ? '\r\n' : '\n';
  const lines = full.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === MARK_START);
  const end = lines.findIndex((line) => line.trim() === MARK_END);
  if (start === -1 || end < start) {
    failures.push(`${file} carries no ${MARK_START} region`);
    return;
  }
  const nextLines = [...lines.slice(0, start), ...healthBlock().split('\n'), ...lines.slice(end + 1)];
  if (nextLines.join('\n') === lines.join('\n')) {
    console.log(`OK  ${file}`);
    return;
  }
  if (check) {
    failures.push(file);
    return;
  }
  writeFileSync(fullPath, nextLines.join(eol));
  console.log(`Wrote ${file}`);
}

validateContract();
const rust = rustModule();
for (const { file, sibling } of RUST_FILES) emit(file, rust, sibling);
emitRegion(HEALTH);
for (const { file, needle, label } of clampChecks()) {
  const text = existsSync(path.join(root, file)) ? readFileSync(path.join(root, file), 'utf8') : '';
  if (!text.includes(needle)) failures.push(`${file} does not carry the ${label} clamp as declared:\n    ${needle}`);
}

if (failures.length) {
  console.error(check ? '\nFAIL — sync contract copies or declarations are invalid:' : '\nFAIL:');
  for (const failure of failures) console.error(`  - ${failure}`);
  if (check) console.error('\nRun `npm run contract` after fixing the source.');
  process.exit(1);
}
console.log(check ? 'OK — every copy matches the contract.' : 'The contract is written.');
