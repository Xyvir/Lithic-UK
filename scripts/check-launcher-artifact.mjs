#!/usr/bin/env node
/**
 * Launcher artifact gate: is this push carrying a local build, and does the committed artifact
 * match the sources in the tree?
 *
 * `src/launcher.html` is GENERATED (`scripts/build-launcher.mjs`) and COMMITTED, because
 * `deploy/autoupdate.sh` pulls it on a timer, `deploy/Dockerfile` copies it, the server image
 * and the Tauri bundle ship it. It is also CI's to write: `build-wiki.yml` rebuilds it on every
 * release and commits the result on the release branch, so a locally built copy is a test and
 * never a delivery (agents.md, GENERATED ARTIFACTS ARE CI-ONLY). The bytes on `main` ARE the
 * bytes self-host runs, which is why nothing about this is bookkeeping.
 *
 * This gate used to answer the opposite question. It rebuilt the published path in place and,
 * when the committed bytes differed, printed `git add src/launcher.html && git commit` — the
 * one instruction that policy forbids, from the one file a person runs before pushing, and
 * deliberately leaving a local build sitting at the path that ships. It was followed on
 * 2026-10-27: a launcher change went in carrying a locally built artifact, and because
 * `src/launcher.html` is one of the four paths `publish-release.yml` triggers on, that push was
 * read as a hand-pushed release and cut a dated tag, its desktop installers and its APK from a
 * commit nobody had reviewed. The build is no longer left in the tree for the same reason.
 *
 * So it now asks the two questions it can actually answer, and neither answer is "commit it":
 *
 *   1. WOULD THIS PUSH CARRY THE ARTIFACT? Staged here, or in the commits ahead of the branch
 *      this one would push to. That is the act the policy forbids, it is visible in the index
 *      and the log, and it FAILS: the file belongs to CI, and a commit that carries it is a
 *      release trigger by path alone, whatever the bytes are.
 *   2. DOES THE COMMITTED ARTIFACT MATCH A BUILD OF THESE SOURCES? A mismatch is the NORMAL
 *      state between a launcher change and the release that push starts, since CI can only
 *      regenerate the artifact once the source is on `main`. It warns and passes, naming both
 *      ways out: the release regenerates it, or the committed copy is simply behind a pull.
 *
 * The build lands in a scratch file outside the repository (`LAUNCHER_OUT`, the same scratch
 * path `scripts/build-launcher.mjs` documents), so a check never writes `src/launcher.html`.
 *
 * The comparison is over CONTENT, with every CR dropped, and that is not laziness: this
 * repository runs `core.autocrlf=true`, so a fresh clone or worktree hands the build CRLF
 * sources which the Vite template carries straight into the artifact (measured 2026-10-27: a
 * fresh worktree built 930063 bytes against the committed 930046, the difference being the
 * template's newlines plus one lone CR). A build that differs only in its line endings says so
 * and passes, because the bytes that ship are LF: CI builds on Linux and commits those.
 *
 * Nothing here calls `process.exit`, and that is a rule worth keeping: the status is set on
 * `process.exitCode` so Node flushes the report before it goes, where an exit taken in the
 * middle of one truncates whatever a pipe has not carried yet and reports a pass with no reason
 * attached.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const relative = 'src/launcher.html';
const artifact = path.join(repoRoot, 'src', 'launcher.html');

/** Where the check's build lands. Never the published path: a check must not write it. */
const scratch = path.join(os.tmpdir(), `lithic-launcher-gate-${process.pid}.html`);

/** One git question, answered or not. `null` is "could not tell", never "no". */
function git(args) {
  const result = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return (result.stdout ?? '').trim();
}

/**
 * The branch this one would push to, so "the commits ahead of it" means what it says.
 *
 * A branch with no upstream (a fresh clone's checkout, a detached worktree) answers `null`, and
 * the staged half of question 1 is then the only half that can be asked. Guessing a base would
 * be worse than not asking: it would fail a push over a difference this branch did not make.
 */
function pushTarget() {
  const tracked = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (tracked) return tracked;
  for (const candidate of ['origin/main', 'origin/master']) {
    if (git(['rev-parse', '--verify', '--quiet', candidate])) return candidate;
  }
  return null;
}

/** Whether a `git diff --name-only` listing contains the artifact. */
function lists(listing) {
  return listing !== null && listing.split('\n').includes(relative);
}

function check() {
  const base = pushTarget();
  const carriers = [];
  if (lists(git(['diff', '--cached', '--name-only', '--', relative]))) {
    carriers.push('staged here');
  }
  if (base) {
    const common = git(['merge-base', base, 'HEAD']);
    const mineChangesIt =
      common !== null && lists(git(['diff', '--name-only', `${common}..HEAD`, '--', relative]));
    // ...and the branch would actually change those bytes upstream. A local copy of a commit
    // that is already published changes nothing, which is the state a checkout is in between
    // somebody else's push and its own pull, and failing that would fail the pull itself.
    const changesUpstream = lists(git(['diff', '--name-only', base, 'HEAD', '--', relative]));
    if (mineChangesIt && changesUpstream) {
      carriers.push(`in a commit ahead of ${base}`);
    }
  }

  if (carriers.length > 0) {
    console.error(`FAIL — ${relative} is part of the change this branch would push (${carriers.join(', ')}).`);
    console.error("  It is CI's to write. `build-wiki.yml` rebuilds it on every release and commits it on the");
    console.error('  release branch, and `publish-release.yml` reads a push that carries it as a hand-pushed');
    console.error('  release, which tags and publishes a build nobody reviewed. Take it out of the push rather');
    console.error('  than rebuilding it:');
    console.error(`    git checkout ${base ?? 'origin/main'} -- ${relative}`);
    console.error(`    git add ${relative} && git commit --amend --no-edit   # or recommit without it`);
    console.error('  A local build belongs at a scratch path: npm run build:launcher -- <path>');
    return 1;
  }

  let committed;
  try {
    committed = readFileSync(artifact);
  } catch {
    console.error(`FAIL — ${relative} is missing.`);
    console.error('  It is committed, so this is a checkout problem rather than a build to run:');
    console.error(`    git checkout ${relative}`);
    return 1;
  }

  const build = spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'build-launcher.mjs')], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    env: { ...process.env, LAUNCHER_OUT: scratch }
  });

  try {
    if (build.status !== 0) {
      const tail = `${build.stdout ?? ''}${build.stderr ?? ''}`.trim().split('\n').slice(-8).join('\n  ');
      console.error('FAIL — the launcher build itself failed:');
      console.error('  ' + tail);
      return 1;
    }

    let fresh;
    try {
      fresh = readFileSync(scratch);
    } catch {
      console.error(`FAIL — the launcher build wrote nothing to ${scratch}.`);
      console.error('  `scripts/build-launcher.mjs` takes its destination from `LAUNCHER_OUT`, so an older');
      console.error('  copy of that script is the thing to look at.');
      return 1;
    }

    // Line endings belong to the checkout rather than to the build: `core.autocrlf=true` hands a
    // fresh clone CRLF sources, Vite's template carries those newlines (and one lone CR) into
    // the artifact, and this working tree's sources are LF. Every CR is therefore dropped before
    // the comparison, which leaves exactly the content the question is about.
    const withoutCr = (buffer) => buffer.toString('utf8').split('\r').join('');

    if (fresh.equals(committed)) {
      console.log(`OK — committed ${relative} matches a fresh build.`);
      return 0;
    }
    if (withoutCr(fresh) === withoutCr(committed)) {
      console.log(`OK — committed ${relative} matches a fresh build.`);
      console.log('  (Line endings aside: this checkout hands the build CRLF sources, so its bytes are not');
      console.log('   the committed ones verbatim. CI builds on Linux, and those LF bytes are what ships.)');
      return 0;
    }

    console.warn(`warn — the committed ${relative} does not match a build of the sources in this tree.`);
    console.warn('  That is the normal state between a launcher change and the release it starts: CI rebuilds');
    console.warn('  the artifact from those sources and commits it on the release branch. Do not build one here');
    console.warn('  and commit it. The bytes arrive by pull when that release lands:');
    console.warn(`    git pull    # or: git checkout ${relative}`);
    console.warn('  If nothing launcher-shaped changed in this tree, the committed copy is simply behind, and');
    console.warn('  pulling it is the same answer.');
    return 0;
  } finally {
    rmSync(scratch, { force: true });
  }
}

process.exitCode = check();
