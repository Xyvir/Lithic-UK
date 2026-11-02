# macOS: A Disk Image, a Tarball, and a Cask

A macOS release carries two files. Both hold the same **universal** bundle, which runs natively on Apple Silicon and Intel.

**`Lithic_<stamp>.dmg` is the ordinary install.** Open it and drag `Lithic.app` to `/Applications`. The bundle is not signed or notarized, because a Developer ID and notarization are a paid membership. A disk image that arrived through a browser is quarantined, so macOS refuses the first launch until you clear it: **System Settings → Privacy & Security → Open Anyway**. Or, for a download you trust, run `xattr -dr com.apple.quarantine /Applications/Lithic.app`.

**`Lithic_<stamp>_universal.app.tar.gz` is the same bundle as one file, for carrying.** Unpack it wherever you want the app to live. Nothing fetched by `curl` carries the quarantine attribute, so there is no Gatekeeper step:

```bash
curl -LO https://github.com/Xyvir/Lithic-UK/releases/latest/download/Lithic_<stamp>_universal.app.tar.gz
tar -xzf Lithic_<stamp>_universal.app.tar.gz
open Lithic.app
```

A copy unpacked into a folder of its own (a USB stick, a projects folder) keeps its state beside the bundle, as the Windows and Linux builds keep `recents.txt` beside the program.

**Or let Homebrew do it:**

```bash
brew install --cask xyvir/tap/lithic
```

The cask lives in [Xyvir/homebrew-tap](https://github.com/Xyvir/homebrew-tap), because an unsigned build cannot go in the official cask repository. Homebrew fetches with `curl`, so the app opens on the first try with no Gatekeeper step. From then on `brew` is the updater (`brew upgrade --cask lithic`). `brew uninstall --cask --zap lithic` removes the app and its state together.

## What macOS does not have, and why

There is no Install button in the launcher and no self-updating copy. Dragging the bundle into place is the install. File types come from the bundle's `Info.plist`. A Mac app placed by a package manager is that manager's business, which is why a Mac copy is offered no by-hand update while `brew` stays its updater.

State follows the platform's rule. A bundle in an `Applications` folder keeps its state in `~/Library/Application Support/Lithic`, because writing inside a bundle would be writing into the program. A bundle kept anywhere else is a copy being carried, and keeps `recents.txt`, the picked backup folder and the vault beside itself.

## Building the macOS bundle yourself

On a Mac, with Xcode's command line tools, Rust (stable) and Node 22 or newer. Add both Apple targets for a universal build:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
npm --prefix launcher-ui ci
node scripts/build-launcher.mjs
LITHIC_BUILD_TAG=v2026.01.01-0000 npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

The first build compiles OpenSSL once. This is expected: `git2`'s `https` feature asks for it, and the crate vendors it for this target instead of linking a Homebrew dylib into a distributed app. The bundle lands in `src-tauri/target/universal-apple-darwin/release/bundle/macos/`, and the disk image in the `dmg` folder beside it. Leave off `--target universal-apple-darwin` to build for this Mac alone, which is faster. `LITHIC_BUILD_TAG` works as it does on Linux: unset, the app offers no update notice. Nothing signs or notarizes the result. The linker's ad-hoc signature is the minimum Apple Silicon needs to run any binary.
