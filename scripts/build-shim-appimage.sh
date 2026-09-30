#!/usr/bin/env bash
#
# Assemble the Lithic shim AppImage: the small download that serves the launcher
# and the wiki engine to the browser the machine already has.
#
# Why this is a script rather than more steps in the workflow. What it builds is
# the artifact: one binary, one directory of files, and the desktop entry that
# starts them. That directory is the same tree the server's `public/` becomes
# (build-server.yml), so the shim is a second packaging of files that already
# ship rather than a second set of them, and the payload list has one owner. Run
# with --skip-appimage on any machine with cargo to inspect the result.
#
# What it deliberately does not do: call `tauri build --bundles appimage`. That
# path runs linuxdeploy with its GTK plugin, which copies WebKitGTK and
# JavaScriptCore into the bundle (about 43.5 MB of an 82 MB download) because
# Tauri has to ship the engine it links. The shim links nothing, so the AppDir
# here holds only the payload, and no linuxdeploy, no patchelf, no FUSE and no
# system webkit packages are involved.
#
# USAGE: bash scripts/build-shim-appimage.sh --name Lithic_09.30.26-1816.AppImage

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"

name=""
output_dir="dist"
payload="$repo_root"
work="${RUNNER_TEMP:-$repo_root/tmp}/lithic-shim-appimage"
arch="x86_64"
skip_appimage="0"

usage() {
  cat <<'USAGE'
USAGE: bash scripts/build-shim-appimage.sh --name NAME [options]

  --name NAME        the AppImage file name to write (required)
  --output-dir DIR   where to write it (default: dist)
  --payload DIR      the directory holding the launcher and the engine
                     (default: the repository root)
  --work DIR         scratch directory (default: $RUNNER_TEMP/lithic-shim-appimage)
  --arch ARCH        the AppImage's architecture (default: x86_64)
  --skip-appimage    stop after assembling the AppDir and print where it is
  --help             print this text
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="${2:-}"; shift 2 ;;
    --output-dir) output_dir="${2:-}"; shift 2 ;;
    --payload) payload="${2:-}"; shift 2 ;;
    --work) work="${2:-}"; shift 2 ;;
    --arch) arch="${2:-}"; shift 2 ;;
    --skip-appimage) skip_appimage="1"; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ -z "$name" ]; then
  echo "--name is required: the AppImage is named for the release it joins." >&2
  usage >&2
  exit 2
fi
if ! command -v cargo >/dev/null 2>&1; then
  echo "cargo is not on PATH, and the shim binary is built here." >&2
  exit 1
fi
if [ ! -d "$payload" ]; then
  echo "the payload directory $payload does not exist." >&2
  exit 1
fi

# The files without which the AppDir is not a launcher. The shim checks these
# again before it binds a port, so a build that gets past this line cannot ship
# an artifact that fails at start-up. A service worker is deliberately absent,
# since the shim has no offline mode and a cached launcher is what an old worker
# would answer a navigation with; the launcher skips that registration on a page
# the shim served.
required=(
  index.html
  manifest.json
  src/launcher.html
  src/lithic.html
)

# Files that dress the page: the icons the launcher's head references, the small
# extras the server publishes beside it. A missing one is a 404 in a console
# nobody reads, so they are copied when present and noted when not.
optional=(
  favicon.ico
  favicon-16x16.png
  favicon-32x32.png
  apple-touch-icon.png
  android-chrome-192x192.png
  android-chrome-512x512.png
  mstile-150x150.png
  mstile-310x310.png
  site.webmanifest
  intro.html
  intro.lith
  404.html
  src/app-icon.png
  src/mstile-150x150.png
)

missing=()
for relative in "${required[@]}"; do
  [ -f "$payload/$relative" ] || missing+=("$relative")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "the payload at $payload is incomplete:" >&2
  for relative in "${missing[@]}"; do
    echo "  missing: $relative" >&2
  done
  echo "Build the wiki and the launcher first (see .github/workflows/build-wiki.yml)." >&2
  exit 1
fi

echo "Building the shim binary"
cargo build --release --manifest-path "$repo_root/shim/Cargo.toml"

binary="$repo_root/shim/target/release/lithic-shim"
# The `.exe` branch is not for the AppImage (that is built on Linux, where cargo
# writes no suffix). It is what lets this script be run with --skip-appimage on a
# Windows checkout to inspect the assembled directory.
[ -f "$binary" ] || binary="$binary.exe"
if [ ! -f "$binary" ]; then
  echo "cargo did not produce a binary at $repo_root/shim/target/release/lithic-shim." >&2
  exit 1
fi

appdir="$work/Lithic.AppDir"
rm -rf "$appdir"
mkdir -p "$appdir/usr/bin" "$appdir/usr/share/lithic/src"
binary_name="lithic-shim"
case "$binary" in
  *.exe) binary_name="lithic-shim.exe" ;;
esac
install -m 755 "$binary" "$appdir/usr/bin/$binary_name"
# AppRun is the entry point the AppImage runtime executes. It points at the
# binary rather than copying it, so the executable's own directory resolution
# (`../share/lithic`, which is where the payload goes) stays the same whether
# the AppImage is mounted or extracted.
ln -sf "usr/bin/$binary_name" "$appdir/AppRun"

copied=0
for relative in "${required[@]}" "${optional[@]}"; do
  source="$payload/$relative"
  if [ -f "$source" ]; then
    mkdir -p "$appdir/usr/share/lithic/$(dirname "$relative")"
    cp -f "$source" "$appdir/usr/share/lithic/$relative"
    copied=$((copied + 1))
  else
    echo "  note: $relative is not in the payload, so the shim will not serve it"
  fi
done
echo "Copied $copied payload files into usr/share/lithic"

# The assembled directory is judged by the shim itself rather than by this
# script's own list, so the files a build copies and the files a shim refuses to
# start without cannot drift apart. A missing icon is printed, not fatal.
LITHIC_SHIM_ROOT="$appdir/usr/share/lithic" "$appdir/usr/bin/$binary_name" --check

# One icon for the desktop entry, the AppImage's own icon and the file manager.
# 256x256, which is the size an AppImage icon is expected to be.
icon=""
for candidate in src-tauri/icons/128x128@2x.png src/app-icon.png; do
  if [ -f "$payload/$candidate" ]; then
    icon="$payload/$candidate"
    break
  fi
done
if [ -z "$icon" ]; then
  echo "no icon found: expected src-tauri/icons/128x128@2x.png or src/app-icon.png." >&2
  exit 1
fi
cp -f "$icon" "$appdir/lithic.png"
# `.DirIcon` is the name the AppImage runtime and file managers look for beside
# the AppRun, so the icon is the same file under both names rather than one copy
# the tools have to agree about.
ln -sf lithic.png "$appdir/.DirIcon"

# Terminal=false: the shim opens a browser and keeps serving behind it, so a
# desktop launcher should not leave a console window in front of the page. The
# Exec name is the AppDir's own binary, which is what appimagetool validates.
# StartupWMClass names the window class a Chromium app window advertises
# (`--class=Lithic` in `shim/src/lib.rs`), so the dock shows Lithic's own icon and
# groups that window with this entry rather than with the browser's. The shim opens
# no window itself, so without it the page's window belongs to the browser entirely.
cat > "$appdir/lithic.desktop" <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Lithic
Comment=Open the Lithic launcher in your browser
Exec=lithic-shim
Icon=lithic
Terminal=false
Categories=Utility;Office;
Keywords=wiki;notes;tiddlywiki;
StartupWMClass=Lithic
DESKTOP

if [ "$skip_appimage" = "1" ]; then
  echo "AppDir ready at $appdir"
  du -sh "$appdir"
  exit 0
fi

# appimagetool itself is an AppImage, so on a runner without FUSE (and without
# the libfuse2 the runtime would mount through) it has to extract and run. It is
# also the only AppImage machinery this build touches: no linuxdeploy, because
# there are no shared libraries to bundle.
tool="$work/appimagetool-$arch.AppImage"
if [ ! -x "$tool" ]; then
  mkdir -p "$work"
  for url in \
    "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$arch.AppImage" \
    "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-$arch.AppImage"
  do
    echo "Downloading $url"
    if command -v curl >/dev/null 2>&1; then
      curl -fsSL --retry 3 -o "$tool" "$url" && break
    else
      wget -q -O "$tool" "$url" && break
    fi
    rm -f "$tool"
  done
  if [ ! -s "$tool" ]; then
    echo "appimagetool could not be downloaded." >&2
    exit 1
  fi
  chmod +x "$tool"
fi

echo "Assembling $name"
ARCH="$arch" APPIMAGE_EXTRACT_AND_RUN=1 "$tool" --no-appstream "$appdir" "$work/$name"

mkdir -p "$output_dir"
mv -f "$work/$name" "$output_dir/$name"
chmod +x "$output_dir/$name"

appdir_bytes=$(du -sb "$appdir" | cut -f1)
artifact_bytes=$(stat -c%s "$output_dir/$name")
awk -v dir="$appdir_bytes" -v file="$artifact_bytes" 'BEGIN {
  printf "AppDir %.2f MB, AppImage %.2f MB (%d%% of the AppDir)\n", dir / 1048576, file / 1048576, (file * 100) / dir
}'
echo "Wrote $output_dir/$name"
