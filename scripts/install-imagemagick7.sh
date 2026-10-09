#!/usr/bin/env bash
#
# ImageMagick 7, for the runner the gallery tiles its sheets on.
#
# `ui-gallery.mjs` invokes the unified CLI (`magick montage ...`) and draws the
# pane name under each picture with it. `ubuntu-24.04` host runners carry no
# ImageMagick at all — the image was deliberately slimmed — and `apt install
# imagemagick` installs version 6, whose commands are `convert` and `montage`
# with no `magick` entry point anywhere. So the CLI comes from the project's own
# releases, which publish a per-version AppImage beside the sha256 of it: pinned
# here, verified after download (a tarball that arrived wrong would otherwise
# produce sheets that look fine and are the wrong build), and extracted rather
# than mounted because a hosted runner has no FUSE.
#
# Extraction is also why this is a script and not four lines of workflow: the
# AppImage's entry point is either its `AppRun` or the `magick` inside it
# depending on how it was assembled, and which one works is a question the
# download can answer for itself. Both are tried, the version is checked rather
# than assumed, and nothing is put on PATH that has not run.
#
# Only Linux: the developer's own machine has ImageMagick 7 already, and this is
# for the runner.
set -euo pipefail

VERSION="7.1.2-32"
SHA256="d456cab221b5fc1c396768a026d0a33ee8665f7119c7fea7151b960c69058b21"
ASSET="ImageMagick-${VERSION}-gcc-x86_64.AppImage"
ROOT="${IMAGEMAGICK7_HOME:-$HOME/.imagemagick7}"

if [ "$(uname -s)" != "Linux" ]; then
  echo "ImageMagick 7: not Linux ($(uname -s)); nothing to do."
  exit 0
fi

# Already there and already the right major version: leave it alone.
if command -v magick >/dev/null 2>&1 && magick -version 2>/dev/null | grep -q 'ImageMagick 7'; then
  echo "ImageMagick 7: already on PATH ($(command -v magick))"
  exit 0
fi

mkdir -p "$ROOT/bin"

if [ ! -d "$ROOT/root" ]; then
  echo "ImageMagick 7: fetching $ASSET"
  curl -fsSL -o "$ROOT/$ASSET" \
    "https://github.com/ImageMagick/ImageMagick/releases/download/${VERSION}/${ASSET}"
  echo "$SHA256  $ROOT/$ASSET" | sha256sum -c -
  chmod +x "$ROOT/$ASSET"
  # A hosted runner has no FUSE, so the mount path is unavailable and this is the
  # way in. It writes squashfs-root/ beside the AppImage.
  (cd "$ROOT" && ./"$ASSET" --appimage-extract >/dev/null)
  rm -f "$ROOT/$ASSET"
fi

APP=""
for candidate in "$ROOT/squashfs-root/usr/bin/magick" "$ROOT/squashfs-root/AppRun"; do
  if [ -x "$candidate" ] && "$candidate" -version 2>/dev/null | grep -q 'ImageMagick 7'; then
    APP="$candidate"
    break
  fi
done

if [ -z "$APP" ]; then
  echo "FAILED: the extracted ImageMagick does not run as magick. Tried:" >&2
  ls -la "$ROOT/squashfs-root" >&2 || true
  exit 1
fi

# A wrapper rather than a symlink: an AppImage entry point can look for its own
# payload relative to its directory, and APPDIR is how it is told where that is.
cat > "$ROOT/bin/magick" <<WRAPPER
#!/usr/bin/env bash
APPDIR="$ROOT/squashfs-root" exec "$APP" "\$@"
WRAPPER
chmod +x "$ROOT/bin/magick"

# Verified through the wrapper and by absolute path, because GITHUB_PATH is only
# read by the NEXT step: a check that trusted PATH here would pass on a broken
# install and fail in the step that needed it.
"$ROOT/bin/magick" -version | head -1
echo "ImageMagick 7: installed at $ROOT/bin"

if [ -n "${GITHUB_PATH:-}" ]; then
  echo "$ROOT/bin" >> "$GITHUB_PATH"
else
  echo "ImageMagick 7: GITHUB_PATH unset, so put $ROOT/bin on PATH yourself."
fi
