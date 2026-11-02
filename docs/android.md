# Android: Universal APK

An Android release carries one file, `Lithic_<stamp>.apk`. It holds every phone ABI, so the same download works on any phone.

The APK is built with `--debug` and signed with a debug key that Gradle generates per build. Its version name is the release stamp's date, and its version code is minutes since the epoch, so each build orders after the one before it.

**To install it**, download the APK on the phone and open it. The browser will ask you to allow installs from that app, and the phone's installer takes it from there. Over `adb` it is one command:

```bash
adb install -r Lithic_<stamp>.apk
```

## What is here

The launcher and the whole wiki engine are inside the APK. This is the app itself, not a wrapper for a website. Bookmarked instances, instance storage, your wikis and the launcher's phone layouts all ship in the package.

State lives in the app's own storage folder. An Android executable lives inside the installed package, which each update replaces, so the app cannot keep state beside the program. The portable folder of liths with `recents.txt` beside the program is the one thing Android cannot offer.

## What is not here

The folder-based GitHub backup is not built into the Android target, and the launcher does not offer it. `git2` needs OpenSSL on every unix, so carrying the sync would mean cross-compiling OpenSSL for each phone ABI. The sync also backs up a folder that a program writes files into, and Android does not hand apps such a folder. See [GitHub Sync](github-sync.md) for what the desktop builds do. There is no Install offer and no "open with" registration either. On a phone the installed package is the install, and file associations come from the package's own manifest.

## Saving on the phone

A `.lith` is a real document here, in a folder the user picked, and it stays writable after a restart. Android hands an app a document reference rather than a path. The app asks the platform picker for one (`ACTION_OPEN_DOCUMENT`, `ACTION_CREATE_DOCUMENT`) and keeps the grant with `takePersistableUriPermission`. Reading and writing go through the platform's ContentResolver, which `tauri-plugin-fs` reaches from Rust. Tauri's dialog plugin cannot do this, because its picker grant lasts for one read, so a Lith opened through it could never be saved. The picker is the project's own Kotlin in `src-tauri/android/LithicBridge.kt`, installed into the generated project by `npm run patch:android`.

## Bookmarks and logins on the phone

A bookmarked instance opens in the phone's own browser rather than in the app's window. The Android webview implements no `onReceivedHttpAuthRequest`, so an instance behind a login would challenge the window and then land on an error page. The phone's browser keeps the password it remembers and can keep the instance as an app of its own. For that reason the credential vault is not offered on Android, and the platform capability `instance_auth` says so.

## What is not here yet

There is no folder picker on the phone, so a Lith lands wherever the platform's chooser puts it, not in a library folder the app maintains. Nothing here has been run on a phone. The repository's gates run on a Windows desktop, so the Kotlin bridge, the picker grants and the ContentResolver read and write are reasoned about but not exercised at runtime.

## Building the APK yourself

You need the Android SDK and NDK (`ANDROID_HOME` and `NDK_HOME`), a JDK 17, Rust (stable) with the two phone targets, and Node 22 or newer:

```bash
rustup target add aarch64-linux-android armv7-linux-androideabi
npm ci
npm --prefix launcher-ui ci
node scripts/build-launcher.mjs
npm run tauri icon src/app-icon.json
npm run tauri android init -- --ci
npm run patch:android
LITHIC_BUILD_TAG=v2026.01.01-0000 npm run tauri android build -- --debug --apk --ci --target aarch64 armv7
```

`android init` writes the Gradle project into `src-tauri/gen/android/`, which is gitignored and regenerated on each run. `npm run patch:android` then fixes three things in that tree, in this order because init rewrites it: the launcher icon, the activity (so the header is not drawn under the system bars), and the document bridge. The tracked sources are `src-tauri/icons/android/`, `src-tauri/android/MainActivity.kt` and `src-tauri/android/LithicBridge.kt`. The script verifies what it wrote. `npm run patch:android -- --self-test` runs the patch against a synthetic project with no Android toolchain.

The APK lands in `src-tauri/gen/android/app/build/outputs/apk/`. `--target aarch64 armv7` builds the two phone architectures only. The emulator's x86 builds are not needed for a phone, so an emulator cannot install this APK. `LITHIC_BUILD_TAG` works as on the other platforms: unset, the app offers no update notice. The release job is [.github/workflows/android-release.yml](../.github/workflows/android-release.yml).
