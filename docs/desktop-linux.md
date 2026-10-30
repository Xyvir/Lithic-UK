# Linux: Two AppImages, and Which One You Want

A Linux release carries two AppImages. Each name says what is inside it.

**`Lithic_<stamp>.AppImage`, about 3 MB, is the shim.** It is the supported Linux distribution. It carries no web engine. It serves the launcher and the wiki to the browser the machine already has. Press **Install** in the launcher and it copies itself to `~/Documents/Lithic/Lithic.AppImage`, then registers the file types it can open with the desktop. Those are the documents it edits (`.lith`, `.md`, `.txt`, `.tid`, `.json`, `.ipynb`, `.html`), and the two kinds it imports rather than edits: `.pdf` (as pages) and `.png`, `.jpg`, `.jpeg`, `.bmp`, `.webp` (as a picture). Both open as a whiteboard with a Lith written beside the source file. So a `.lith` opens with a double click, like any other document. The install also names the copy in that folder's own `.gitignore`, because that folder is where a first backup proposes to live. The program never becomes part of the backup it sits beside.

**`Lithic-webgtk_<stamp>.AppImage`, about 82 MB, brings its own engine.** It is the Tauri app, bundling WebKitGTK and JavaScriptCore. It opens a window of its own and needs no browser. Take it if the machine has no Chromium-family browser, or if you prefer an app window to a tab. It is also the build the [AppImage catalogue](https://appimage.github.io/) can carry, since that catalogue needs an AppImage that draws its own window.

## Building the WebKitGTK AppImage yourself

The release publishes this build, so most people never need to build it. Build by hand for a build of your own, or for a commit with no release yet. Build on the oldest base system you need to support. An AppImage links the glibc of the machine that built it, so building on Ubuntu 24.04 raises the floor to glibc 2.39, and the result will not open on Ubuntu 22.04 or Debian 12. Ubuntu 22.04, or a 22.04 container, is the baseline. You need Rust (stable) and Node 22 or newer.

Install the system dependencies:

```bash
sudo apt-get install -y \
  libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libssl-dev libxdo-dev \
  patchelf file wget build-essential libfuse2
```

Then, from the repository root:

```bash
npm ci
npm --prefix launcher-ui ci
node scripts/build-launcher.mjs
LITHIC_BUILD_TAG=v2026.01.01-0000 npm run tauri build -- --bundles appimage
```

`LITHIC_BUILD_TAG` is the release stamp the build belongs to. It is compiled in, and the launcher compares it with the newest GitHub release to decide whether to offer an update. Leave it unset for a local build, which then offers no update notice. If the machine has no FUSE, prefix the build with `APPIMAGE_EXTRACT_AND_RUN=1`. The finished file lands in `src-tauri/target/release/bundle/appimage/`.
