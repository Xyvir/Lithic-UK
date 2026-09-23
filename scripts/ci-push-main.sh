#!/usr/bin/env bash
#
# Push the pipeline's own commit to main, surviving a main that moved under it.
#
# Every workflow that publishes artifacts ends in a `git push` of a commit that
# exists ONLY on the runner. If main has moved while the build ran — a human
# push, another dispatch — the push is rejected, and the rejection takes the
# rebuilt artifacts, the tag, the GitHub Release and the dependent Tauri/server
# jobs with it. Measured 2026-09-23: a prod release died exactly this way,
# because an unrelated commit landed mid-build.
#
# So retry onto the new tip rather than dying on the first rejection. A rebase
# conflict is a real failure and exits non-zero on purpose: stopping loudly beats
# pushing a mangled artifact over somebody else's commit.
#
# `--unshallow` matters because actions/checkout defaults to depth 1 and rebasing
# inside a shallow clone can fail for want of a merge base. It is attempted only
# on the retry path, so the common first-try case pays nothing for it.
#
# The `concurrency: group: main-writers` blocks in build-wiki.yml and
# bump-pwa-version.yml serialize the workflows themselves; this covers what a
# concurrency group cannot — a person pushing while a build is in flight.
set -uo pipefail

ATTEMPTS="${CI_PUSH_ATTEMPTS:-5}"

for attempt in $(seq 1 "$ATTEMPTS"); do
  if git push; then
    exit 0
  fi
  echo "Push rejected (attempt $attempt of $ATTEMPTS) — main moved; rebasing onto its new tip."
  git fetch --unshallow origin main 2>/dev/null || git fetch origin main || exit 1
  git rebase origin/main || {
    echo "FAILED: rebasing onto origin/main conflicts. Not retrying — this needs a human."
    exit 1
  }
  sleep $((attempt * 5))
done

echo "FAILED: could not push to main after $ATTEMPTS attempts."
exit 1
