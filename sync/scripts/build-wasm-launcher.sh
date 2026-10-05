#!/usr/bin/env bash
#
# Build the browser engine the launcher loads, and place both halves where the
# launcher resolves them.
#
#   src/launcher.wasm                     the engine itself, beside src/launcher.html
#   launcher-ui/src/lithic-sync/          the wasm-bindgen glue the bundle imports
#
# The binary is fetched lazily, only when device sync is actually used, so it is
# not part of the single-file launcher; the glue is a normal module import and
# ends up bundled into it (see `launcher-ui/src/device-sync.ts`).
#
# Run from the repository root or from `sync/`:
#
#   sync/scripts/build-wasm-launcher.sh
#
# Requires: a Rust target for wasm32-unknown-unknown, the wasm-bindgen CLI whose
# version matches the one in sync/Cargo.lock (cargo install wasm-bindgen-cli
# --version <that>), and a C compiler that can target wasm32 for ring. Any of the
# three can be pointed at by hand — on a machine with no system clang but a
# userspace one:
#
#   CC_wasm32_unknown_unknown=/tmp/clang/root/usr/bin/clang-14 \
#   LD_LIBRARY_PATH=/tmp/clang/root/usr/lib/x86_64-linux-gnu \
#   WASM_BINDGEN=/tmp/wasm-bindgen-cli/.../wasm-bindgen \
#   LLVM_STRIP=/tmp/clang/root/usr/bin/llvm-strip-14 \
#   sync/scripts/build-wasm-launcher.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate="$(dirname "$here")"
root="$(dirname "$crate")"

WASM_BINDGEN="${WASM_BINDGEN:-wasm-bindgen}"
LLVM_STRIP="${LLVM_STRIP:-llvm-strip}"

out="$crate/target/wasm-web"
wasm="$crate/target/wasm32-unknown-unknown/release/lithic_sync.wasm"
grep_dir="$root/launcher-ui/src/lithic-sync"
artifact="$root/src/launcher.wasm"

command -v cargo >/dev/null || { echo "cargo is not on PATH" >&2; exit 1; }
command -v "$WASM_BINDGEN" >/dev/null || { echo "wasm-bindgen not found: $WASM_BINDGEN" >&2; exit 1; }
command -v "$LLVM_STRIP" >/dev/null || { echo "llvm-strip not found: $LLVM_STRIP" >&2; exit 1; }

echo "> cargo build --release (wasm32-unknown-unknown, wasm feature)"
# The literal build the browser gets: no default features (the native store and
# the filesystem drop out), the wasm surface instead.
cargo build \
  --manifest-path "$crate/Cargo.toml" \
  --release \
  --target wasm32-unknown-unknown \
  --no-default-features \
  --features wasm

# Debug info is what makes the raw cdylib tens of megabytes; the artifact ships
# stripped, and llvm-strip is used rather than cargo's `strip` so the same step
# works whichever rustc produced the file.
# Stripped in place: it is cargo's own output, and wasm-bindgen names the files it
# emits after that name, so a copy under a different stem would rename the artifact
# the glue looks for.
"$LLVM_STRIP" --strip-debug "$wasm"

echo "> wasm-bindgen --target web"
rm -rf "$out"
"$WASM_BINDGEN" --target web --out-dir "$out" "$wasm"

# The generated glue resolves its wasm relative to its own module URL, and it is the
# one reference the bundler (and everything downstream that reads a `new URL`) must
# not try to resolve at build time: the binary is not an asset of the bundle, it is a
# file the launcher fetches at runtime, named `launcher.wasm` because it sits beside
# `launcher.html` in every deployment. The driver passes that path in as well, so this
# line is the fallback rather than the mechanism, and the pattern is tolerant of the
# name bindgen derives from its input.
glue_wasm="$(sed -nE "s|.*new URL\('([^']*)', import\.meta\.url\).*|\1|p" "$out/lithic_sync.js" | head -1)"
[ -n "$glue_wasm" ] && [ -f "$out/$glue_wasm" ] || {
  echo "the generated glue no longer names its wasm the way this script rewrites; update the sed below" >&2
  exit 1
}
sed -i "s|new URL('$glue_wasm', import.meta.url)|new URL('launcher.wasm', document.baseURI)|" "$out/lithic_sync.js"
grep -q "document.baseURI" "$out/lithic_sync.js" || {
  echo "the generated glue no longer names its wasm the way this script rewrites; update the sed above" >&2
  exit 1
}

mkdir -p "$grep_dir"
rm -f "$grep_dir"/*
cp "$out/lithic_sync.js" "$grep_dir/lithic_sync.js"
cp "$out/lithic_sync.d.ts" "$grep_dir/lithic_sync.d.ts"
cp "$out/lithic_sync_bg.wasm.d.ts" "$grep_dir/lithic_sync_bg.wasm.d.ts"
cp "$out/$glue_wasm" "$artifact"

echo "> wrote"
ls -l "$artifact"
ls -l "$grep_dir"
