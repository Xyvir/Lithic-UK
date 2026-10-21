# Lithic UK
## Unary Knowledge 

**A Portability-First Outliner Knowledgebase**

<p align="center">
  <img src="mstile-150x150.png" alt="Lithic Icon" width="150"/>
</p>

[**Try it here: lithic.uk**](https://lithic.uk)

Lithic is a bespoke Personal Knowledge Management System (PKMS) built on the powerful **TiddlyWiki** engine, re-engineered for a modern academic and engineering workflow. It bridges the gap between the database flexibility of TiddlyWiki and the rapid, outlining experience of **Logseq**.

### The Core Philosophy

* **Logseq-Inspired, Markdown Native:**
    Lithic abandons traditional wikitext in favor of standard **Markdown**. This ensures a frictionless writing experience familiar to Logseq users, keeping your data portable and compatible with industry-standard editors.

* **Smart Inferences:**
  * **Frictionless Time Tracking:** Log your work via interstitial journaling and let Lithic implicitly calculate the time spent. (Includes manual overrides for when you inevitably walk away from your keyboard and forget to log off).
  * **Contextual Implicit Tagging:** Lithic understands your outline's hierarchy. When a parent node references a specific note or context, its nested children automatically inherit that relationship without tedious, redundant tagging.
  * **Declarative Scheduling:** Manage your time purely by dropping journal date references onto to-do items. The integrated calendar also doubles as a date-picker, allowing you to right-click any date to copy the exact pointer needed to link tasks to your timeline.

* **Sane, Print-Ready PDFs:**
    Web-based knowledge bases often fail when physical media is required. Lithic prioritizes "paper-first" CSS, ensuring that your digital notes convert into clean, professional, and sane PDFs for homework submissions, lab reports, and archiving.

* **True Portability:**
    A single-file application that works **100% offline**. It lives on your local machine or thumb drive—no cloud dependency required.

---
*An extension of [TiddlyStudy](https://github.com/postkevone/tiddlystudy) based on [TiddlyWiki](https://tiddlywiki.com/).*

## Storage Modes at a Glance — What Owns Your Data

Lithic always saves somewhere; the mode decides how much a mistake, a dead disk or a cleared cache can cost you. **Backup here is durability-informed and in depth.** Every mode layers the same tiers — version history, a working copy, and, where the platform allows it, a remote mirror — and each tier exists to survive a *different* failure: a mistake, a dead disk, a destroyed server. When tiers disagree about a file, the more durable one wins. That single rule is why the same GitHub control reads "your folder wins" on your own disk and "the remote wins" on a disposable server; both are the same answer to the question *which of these can you afford to lose?*

**The launcher detects the mode from the platform it is running on — there is no setting to choose, and no account to create.** The last column is the only copy that is genuinely yours.

| How you run Lithic | Just works (no setup) | Implicit (happens without being asked) | Source of truth |
| --- | --- | --- | --- |
| **PWA — Chrome/Edge, desktop** | Open a `.lith`, edit, save. A recent entry returns to the same file, so saves keep landing in it | Saves go back to the file you already picked instead of asking for it again; version history and the search cache stay on this device | **The `.lith` file you picked** |
| **PWA — Safari on macOS/iOS** (Firefox and Android Chrome behave the same way) | Open, edit, save — but the browser's storage *is* the document. No file is ever opened or written, because these engines have no File System Access API; opening a local `.lith` reads a copy in, and the original is never written back | New wikis and saves become IndexedDB entries, permanently marked amber **⚠** with the volatility warning as its tooltip. Clicking it opens version history, the only way to a hard copy (it downloads `<name>_recover_<stamp>.lith`). Recents **Rebuild** is hidden here, since nothing on disk can be re-listed; the foot control is **Backup & Reset Recents** instead, which hands you each wiki, or the whole instance, as a file before it will reset anything | **This browser's storage on this device** — volatile: cache eviction, "clear site data" or an uninstall takes it |
| **Desktop app (Tauri)** | Open, edit, save to real files; Recents rebuild by reindexing the folders you point it at | Rust writes the save straight to the path you already own; history and caches stay device-local; nothing talks to a server | **The `.lith` file on your disk** |
| **Desktop app + GitHub backup** | Real files plus an off-device copy: connect a folder to a repository once, then every save is committed and pushed to `main` | Your folder always wins — GitHub is read only for files the folder does not have, a document that differs on both sides keeps its local copy, nothing on your side is overwritten, and deletions never propagate. The icon turns green only after GitHub confirms it accepts a push | **Your folder** — GitHub is a restore-only mirror, and every remote copy it replaces survives in the commit history |
| **Self-host (Docker / LXC / Railway)** | Any browser reaches your wikis by URL; nothing is installed on the client | Saves arrive as diffs the server applies and commits into `/data`; WebDAV, the sync watcher, `cp -r /data` backups and the rollback UI all read that one tree | **The server's `/data`** — your server and your disk, but not your laptop |
| **Self-host + GitHub backup** | The server folder plus an off-server copy in a repository you own | `/data` becomes a git repository: wikis only the remote has are brought down on connect, then the server's state is published. Saves and watcher passes commit and push, and a failed push restarts the backup | **The server's `/data`**, with git holding history and rollback. If the remote has diverged, its files are applied over the server's tree and the server's version is kept in history |

* **Version history is device-local in every mode.** It is not a server or GitHub feature: the clock icon lists `full`, `step` and `sync` entries for the wikis opened on this device, and the oldest are pruned first when storage runs low. Keep a downloaded copy of anything you cannot lose.
* **The Mac/iOS fallback is detected, not chosen.** A browser without the File System Access API lands in browser-storage mode on its own; append `?storage=file` or `?storage=index-db` to the launcher URL to force either one while testing.
* **The launcher asks the browser not to evict its storage.** `navigator.storage.persist()` is requested at the moment a Lith is written, once per session, and the answer is used silently: the amber claim on a browser-only row already says the copy is volatile, so nothing new is announced. Chromium decides from its own heuristics, Firefox asks the person, and Safari implements the call while keeping its own deletion policy, which is why a phone's durable answer is a Home Screen web app rather than this request. See **iPhone and iPad** below.
* **The Mac/iOS fallback can hand you everything it holds, and asks before it forgets.** In browser-storage mode the store *is* the document, so that mode's foot control is **Backup & Reset Recents** rather than the plain reset the other modes draw. It opens the same guardrail shape the rebuild warning uses: a row per recent wiki with a download control and a mark beside each one, plus **Download Full Backup** for the whole thing at once. **Reset Recents** is disabled until every row has been downloaded or the single full backup has been taken, and downloading the rows one at a time unlocks it just as well. A browser that cannot confirm a download counts as done, deliberately: Safari and Firefox have no file picker to confirm with, so a gate that waited for proof would be a button nobody could ever press. The file is one JSON document, `lithic-instance-backup-<stamp>.json`, holding the recent list, each wiki's current text, its version history as the store's own records, any unsaved edit, and the saved instances with their cached icons. The `<stamp>` is the moment the file was taken, to the second, so two backups from one device are told apart by their names alone.
* **Dropping that file back merges it, unless a name is in the way.** A dropped `.json` is read as an instance backup first, and falls through to the ordinary tiddler-payload import when it is not one. A name this device already holds refuses the whole file and lists the names to settle, compared without case, because a name cannot say whether it is the same Lith or a different one wearing it; importing the rest and leaving the clashes behind would make one drop mean two things. Rename or remove those, then drop the file again. The saved instances are the one part that arrives additively rather than whole: an address this device already holds keeps the entry and the icon it has, and the rest are appended, so restoring somebody else's backup can add instances but can never take one away.
* **The self-host launcher lists the server's store and nothing else.** Its file action is **Upload a Lith**: the `.lith` you pick is sent to the store and opened from there, and a name already on the server is replaced only after you confirm it, because this mode keeps no local copy to fall back on. Files on this device belong to the modes that own the device — the PWA and the desktop app — so no recents, caches or bookmarks are drawn on a server's list. Each row shows the size the server reports for the file rather than the date it last wrote it: everything in a store has been written this week, and the size is the one thing a name cannot say. Each row also carries a × that deletes the file from the server, and it asks first: on an instance there is no second copy, so the file every other reader opens is the one being removed. The one Recents control this list keeps is **Rebuild Recents**, which reads the store again and indexes each Lith in it here — that index is what search reads for a wiki this browser never opened. The store's own rows are searched against it too, by name or by what the Lith holds, so a word that appears only inside one of them still lists that row; the same panel a local match draws appears beside it, and clicking it opens the Lith from the server with the matched note pinned to the top. **Reset** is not offered: the list is not this device's to clear. When the instance cannot be reached the panel lists this device's saved copies instead, and the foot control becomes **Backup Recents**: the same per-row downloads and **Download Full Backup**, and no reset at all, because the shelves are the instance's and the copies on this device are the only thing at risk. Nothing in the heading re-lists the server: reloading the page is how that list is asked for again.
* **An instance's icon belongs to the instance.** The mark beside a self-hosted launcher's title is the instance's own file — `/mstile-150x150.png`, the largest render in the set it publishes — read from the address that served the page, so an instance draws the icon its owner uploaded rather than the launcher's own. An instance that has never published a set, and a page with no instance behind it at all, fall back to the shipped mark. The emoji in the heading is a setting for that address rather than for the browser that picked it: the choice is written into the store beside the icons rendered from it, so anyone opening the instance, in any browser, gets the same favicon and the same mark in the heading. Living in the store also puts it in the GitHub backup — a server that connects to a repository gets its icon back along with its wikis, and restoring the shipped icon takes it out of the backup rather than leaving the renders behind. An instance that cannot be asked (a proxy in the way, a bare WebDAV mount) still shows the icon this browser last saw. Clicking that mark opens **Instance Management**, which is one dialog in every mode with three jobs: the icon picker where there is an instance to set one, **View Docs on GitHub**, and **Download Full Backup**, which writes the recent list, every wiki's current text, its version history, any unsaved edit and the saved instances as a single file. The docs link, a small link at the end of the dialog's action row, is not a duplicate of the footer's Github button: the desktop app draws no footer link, so there it is the only way out to the repository, while the browser modes keep both.
* **A self-hosted launcher can turn the server's backup on.** The cloud button in the heading is the desktop app's GitHub dialog pointed at the instance instead of a folder: the same device flow, the same repository picker, and a token form for a server whose OAuth app is blocked. The repository belongs to the *server* — its `/data` is the git tree, and its saves and watcher passes do the committing and pushing — so what the launcher asks it is which repository it is on and when it last synced. Disconnecting deletes the server's token, which is what stops its watcher pushing; the remote and the wikis stay where they are.
* **The × on a bookmarked instance also drops the copy the app downloaded of it.** A bookmark is the launcher's own storage, but an instance's page, scripts and icons live under that instance's own origin, where only the app can reach them — which is why an instance that redeployed could go on serving its old launcher however many times the bookmark was removed and added back. Removing a bookmark now drops that one origin's cached copy as well, so the next open fetches what the instance is actually serving. An instance's cached wikis and its saved login are not part of a downloaded page and stay exactly where they are; forgetting a login stays the vault's own named action. This part is the desktop app's, on Windows for now — in a browser- or PWA-hosted launcher the bookmark is still the whole of what the × removes.
* **Update Install closes the windows that are in its way, and then closes itself.** An update writes over the copy of the app that is already installed, and the operating system refuses that while a program is still running out of it, so the launcher asks the other windows on this machine that are sitting on a launcher to close first. Once the new copy is on disk and its folder is open in front of you, the window you pressed the button in closes too, and you start the new copy when you are ready. A window with a Lith open is never closed: the update is refused and names the Lith, and you close that window yourself rather than losing what is under your cursor. This is the desktop app's behavior on Windows and on the WebKitGTK AppImage. A Mac bundle installs by being dragged out of a disk image and never offers an update at all, and the Linux shim serves a browser rather than a window of its own, so there the launcher's own line stays up to say where the file went.
* **Search reaches the bookmarked instances on the desktop app.** A wiki an instance cached belongs to that instance's own origin, which a page can only read for itself, so the app's Rust side reads it out of the same profile it already keeps for every origin the app has visited. What comes back is one hit per instance — that search is for orientation, and the instance's own launcher is where the rest of the matches are — and the panel beside the row opens that instance already searching for the same words. It covers what this device saved while inside that instance, on Windows for now, and it reads only storage the app itself wrote: no request leaves the machine and no instance is loaded to answer it.

## Linux: Two AppImages, and Which One You Want

A Linux release carries two AppImages, and each name says what is inside it.

**`Lithic_<stamp>.AppImage`, about 3 MB, is the shim**, and it is the supported Linux distribution. It carries no web engine: it serves the launcher and the wiki to the browser the machine already has. Press **Install** in the launcher and it copies itself to `~/Documents/Lithic/Lithic.AppImage` and registers the file types it edits (`.lith`, `.md`, `.txt`, `.tid`, `.json`, `.ipynb`, `.html`) with the desktop, so a `.lith` opens with a double click like any other document. It also names the copy in that folder's own `.gitignore`, because that folder is where a first backup proposes to live: the program never becomes part of the backup it sits beside.

**`Lithic-webgtk_<stamp>.AppImage`, about 82 MB, brings its own engine.** It is the Tauri app, bundling WebKitGTK and JavaScriptCore — about 43.5 MB of that size — so it opens a window of its own and needs no browser. Take it if the machine has no Chromium-family browser, or if you would rather have an app window than a tab. It is also the build the [AppImage catalogue](https://appimage.github.io/) can carry: that catalogue opens one AppImage from a repository's newest release and needs it to draw its own window, which the shim deliberately does not do.

### Building the WebKitGTK AppImage yourself

The release publishes this build, so most people never need to. Build one by hand if you want a build of your own, or one from a commit with no release yet. Build it on the oldest base system you need to support. An AppImage links the glibc of the machine that built it, so building on Ubuntu 24.04 raises the floor to glibc 2.39 and the result will not open on Ubuntu 22.04 or Debian 12. Ubuntu 22.04, or a 22.04 container, is the baseline. You need Rust (stable) and Node 22 or newer.

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

`LITHIC_BUILD_TAG` is the release stamp this build belongs to: it is compiled in and served to the launcher, which compares it against the newest release on GitHub to decide whether to offer an update. Leave it unset to build an app that offers no update notice, which is what a local build does. If the machine has no FUSE, prefix the build with `APPIMAGE_EXTRACT_AND_RUN=1`, which runs the bundler's own AppImage tooling without mounting it, and that is how the release job builds this artifact. The finished file lands in `src-tauri/target/release/bundle/appimage/`.

## macOS: A Disk Image, a Tarball, and a Cask

A macOS release carries two files, and both hold the same **universal** bundle: Apple Silicon and Intel in one build, so the download is the same whichever Mac fetches it.

**`Lithic_<stamp>.dmg` is the ordinary install.** Open it and drag `Lithic.app` to `/Applications`. The bundle is not signed or notarized — a Developer ID, and the notarization it enables, are a paid annual membership — so a disk image that arrived through a browser is quarantined and macOS will refuse the first launch until it is cleared: **System Settings → Privacy & Security → Open Anyway** (macOS Sequoia removed the right-click → Open shortcut that used to do this), or, for a download you have decided to trust, `xattr -dr com.apple.quarantine /Applications/Lithic.app`.

**`Lithic_<stamp>_universal.app.tar.gz` is the same bundle as one file, for carrying.** Unpack it wherever you want the app to live and open it from there: nothing fetched by `curl` carries the quarantine attribute a browser adds, so there is no Gatekeeper step between unpacking and running. A copy unpacked into a folder of its own — a USB stick, an `Applications` folder in your home, a projects folder — keeps its state beside the bundle, the way the Windows and Linux builds keep `recents.txt` beside the program:

```bash
curl -LO https://github.com/Xyvir/Lithic-UK/releases/latest/download/Lithic_<stamp>_universal.app.tar.gz
tar -xzf Lithic_<stamp>_universal.app.tar.gz
open Lithic.app
```

**Or let Homebrew do it:**

```bash
brew install --cask xyvir/tap/lithic
```

The cask lives in [Xyvir/homebrew-tap](https://github.com/Xyvir/homebrew-tap) rather than in homebrew-cask, because an unsigned build cannot go in the official cask repository. It is also the install with no Gatekeeper step at all: Homebrew fetches with `curl`, so the app arrives unquarantined and opens on the first try. From then on `brew` is the updater (`brew upgrade --cask lithic`), and `brew uninstall --cask --zap lithic` removes the app and its state together.

**What macOS does not have, and why.** There is no Install button in the launcher and no copy that updates itself: dragging the bundle into place *is* the install, the file types are the bundle's own `Info.plist`, and a Mac app that a package manager placed is the platform's own business rather than the app's to duplicate — which is also why a Mac copy is offered no by-hand update while `brew` stays its updater. State follows the same rule as the rest of the distribution, with the one concession macOS packaging forces: a bundle sitting in an `Applications` folder keeps its state in `~/Library/Application Support/Lithic`, because writing inside a bundle would be writing into the program — replaced by the next install, and not something a signed bundle permits. A bundle kept anywhere else is a copy being carried, and keeps `recents.txt`, the picked backup folder and the vault beside itself.

### Building the macOS bundle yourself

On a Mac, with Xcode's command line tools, Rust (stable) and Node 22 or newer. Both Apple targets, because the release is universal:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm ci
npm --prefix launcher-ui ci
node scripts/build-launcher.mjs
LITHIC_BUILD_TAG=v2026.01.01-0000 npm run tauri build -- --target universal-apple-darwin --bundles app,dmg
```

The first build compiles OpenSSL once, and that is expected rather than something to fix: `git2`'s `https` feature asks for it on every unix, macOS's libgit2 uses the system's SecureTransport instead and never references it, and the crate vendors it for this target rather than looking for one on the machine or linking a Homebrew dylib into a distributed app. The bundle lands in `src-tauri/target/universal-apple-darwin/release/bundle/macos/` and the disk image in the `dmg` folder beside it. Leave off `--target universal-apple-darwin` to build for this Mac alone, which is faster and is what `cargo run` does while you work. `LITHIC_BUILD_TAG` is the release stamp the build belongs to, the same as on Linux: unset, the app offers no update notice. Nothing signs or notarizes the result — the Mach-O is ad-hoc signed by the linker, which is the minimum Apple Silicon requires for any binary to run at all.

## Android: One Debug-Signed APK

An Android release carries one file, `Lithic_<stamp>_debug.apk`, and it holds every phone ABI, so the download is the same whichever phone fetches it.

**It is signed with the debug key, and that is the whole of the signing story rather than an oversight.** Android refuses an unsigned package outright and refuses one whose signature does not match the copy already installed, so there are two honest options and no third: a keystore generated once and kept, or the debug key a debug build brings with it. A keystore cannot live in the repository and none has been put in the release secrets yet, and a key generated fresh on each build would be worse than none, because every release would then refuse to install over the last one with a signature mismatch the user has to work out for themselves. So the name says `_debug` instead of hiding it, and a release-signed APK, or an `.aab` for the Play Store, is a follow-up that needs those secrets and nothing else. What it costs today is a debug Rust profile, which is slower than a release one; what it buys is a file that installs today.

**To install it**, download it on the phone and open it. The browser will ask you to allow installs from that app, and the phone's own installer takes it from there. Over `adb` it is one command:

```bash
adb install -r Lithic_<stamp>_debug.apk
```

**What is here.** The launcher and the whole wiki engine are inside the APK, so this is the app rather than a wrapper for a website: instances you have bookmarked, instance storage, your wikis, and the launcher's phone layouts, all shipped in the package. State lives in the app's own storage folder rather than beside the program, because there is no beside: an Android executable lives inside the installed package, which the next update replaces and the app may not write in. The portable neighbourhood the other builds keep, a folder of liths with `recents.txt` next to the program, is the one thing Android cannot have.

**What is not here.** The folder-based GitHub backup is not built into the Android target at all, and the launcher does not offer it, because the platform says so. The reason is a dependency before it is a design decision: `git2` asks for OpenSSL on every unix, so carrying the sync would mean cross-compiling OpenSSL once per phone ABI, and what the sync backs up, a folder of your own that a program writes files into, is not a folder Android hands an app. See [GitHub Sync (Desktop App)](#github-sync-desktop-app) for what the desktop builds do. There is also no Install offer and no "open with" registration, for a simpler reason: on a phone the installed package *is* the install and the file associations are the package's own manifest.

**Saving on the phone.** A `.lith` is a real document here, in a folder the user picked, and it stays writable after a restart. Android hands an app a document *reference* rather than a path, so the app asks the platform's own picker for one (`ACTION_OPEN_DOCUMENT`, `ACTION_CREATE_DOCUMENT`) and asks it to keep the grant (`takePersistableUriPermission`); reading and writing that reference goes through the platform's ContentResolver, which `tauri-plugin-fs` is what reaches from Rust. Tauri's own dialog plugin cannot do this: it picks with `ACTION_GET_CONTENT`, whose grant lasts for the one read, so a Lith opened through it could never be saved. The picker is this project's own Kotlin (`src-tauri/android/LithicBridge.kt`), installed into the generated project by `npm run patch:android`.

**Bookmarks and logins on the phone.** A bookmarked instance opens in the phone's own browser rather than in the app's window. The Android webview implements no `onReceivedHttpAuthRequest`, so an instance behind a login answers the app's window with a challenge it cancels, and the window lands on a browser error page with the launcher already gone; the phone's browser has the password it remembers and can keep the instance as an app of its own. The credential vault is therefore not offered on Android (there is no window here for it to answer for), and the platform capability `instance_auth` is what says so.

**What is not here yet.** There is no folder picker on the phone, so a Lith lands wherever the platform's own chooser puts it rather than in a library folder the app maintains. Nothing here has been run on a phone: this repository's gates are a Windows desktop, so the Kotlin bridge, the picker's grants and the ContentResolver read and write are typed and reasoned about but not exercised at runtime.

### Building the APK yourself

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

`android init` writes the Gradle project into `src-tauri/gen/android/`, which is gitignored and regenerated rather than committed, so it is generated here the same way the release does it. `npm run patch:android` then puts three things right in what init wrote, in this order because init rewrites that tree on every run: the launcher icon (init never copies the set `tauri icon` generated, so the APK was carrying Tauri's placeholder, and the round adaptive definition is written beside it because the generated set has no round file at all), the activity (Tauri's template draws the page under the system bars, so the launcher's own header sat behind the clock), and the document bridge (`src-tauri/android/LithicBridge.kt`, the Kotlin the platform capability calls for the phone's picker). All three are tracked sources, `src-tauri/icons/android/`, `src-tauri/android/MainActivity.kt` and `src-tauri/android/LithicBridge.kt`, and the script verifies what it wrote rather than assuming. Its own `--self-test` runs the whole patch against a synthetic project with no Android toolchain, which is the only part of this that can be checked on a Windows machine. The APK lands in `src-tauri/gen/android/app/build/outputs/apk/`. `--target aarch64 armv7` builds the two phone architectures and no others: the universal flavor would otherwise package x86 and x86_64 for the emulator, which nothing sold as a phone runs, and that pair is most of the download (the release job carries the measurement). An emulator therefore cannot install this APK. `LITHIC_BUILD_TAG` is the release stamp this build belongs to, the same as on Linux and macOS: unset, the app offers no update notice. The release job that produces this artifact is [.github/workflows/android-release.yml](.github/workflows/android-release.yml), and it is chained from the same publish step as the four desktop installers.

## iPhone and iPad: The Web App, and No iOS Build

There is no iOS distribution and none is planned, and that is a decision about the platform rather than about the launcher.

**There is no iPhone file to download.** Android has a general switch for installing an app the store did not provide. iOS has nothing equivalent: outside the European Union, Brazil and Japan, where Apple authorizes specific alternative marketplaces and its own web distribution, an app reaches an iPhone through the App Store, and that needs the paid Apple Developer Program, a Mac running Xcode for the build, and App Review. The other routes are closed to a project rather than to a person. A free Apple ID installs your own build on your own device for seven days at a time, then expires. TestFlight is for invited betas and still needs the program and a Mac. The enterprise program is for organizations with at least 100 employees. The macOS story has no counterpart here: an unsigned disk image fetched through a browser costs one trip to System Settings, while an iPhone build that is not signed does not open at all. So there is no artifact this project can publish for iOS, and the effort would buy one person a phone rather than a distribution.

**The iPhone answer is the web app.** Open [lithic.uk](https://lithic.uk) in Safari and use **Share → Add to Home Screen**. It installs with its own icon, opens without browser chrome, and gets storage of its own. Nothing is fetched from a store, no account is created and no build is signed, which is the same minimum-friction path the published launcher exists to be.

**Why the installed form is the one that lasts.** Safari deletes a website's script-writable storage, which includes the IndexedDB holding your wikis and their version history, after seven days without interaction with the site. A Home Screen web app is exempt from that rule, so installing it is what makes a phone copy durable. The launcher also calls `navigator.storage.persist()` when a Lith is written, which is worth having and is not a substitute: Chromium decides silently, Firefox asks, and Safari keeps its own policy. Treat the Home Screen install as the protection and the request as a bonus.

**What a phone cannot do.** Safari has no File System Access API, so the browser's own storage *is* the document. Opening a local `.lith` reads a copy in and never writes the original back, and the amber **⚠** mark on a row is the honest report that no file holds it. The history dialog's download, `<name>_recover_<stamp>.lith`, is the way to a hard copy. This is the same fallback the storage table above lists for Safari on macOS, and the same one Firefox and Android Chrome land in.

**The one asymmetry: bookmarks stay here.** The bookmark list is the meta-launcher, instances kept side by side. It is a desktop app feature, and it is hidden in the published PWA everywhere else, so a desktop or Android visitor is pointed at the native build instead of being handed a second list to maintain and a first run stays a single action. The two pages that keep it are the app itself and the published launcher on an iPhone or iPad: with no native app to open an instance from, the bookmark list is the whole of how one instance is kept beside another.

A macOS browser sits in the same storage fallback as an iPhone and does not get the feature, which is worth stating plainly because it is the one place the launcher reads a platform name. Both Safari builds lack the File System Access API for unrelated reasons, and only one of them has a native build to install, so `isIosDevice` in `launcher-ui/src/browser-storage.ts` is what tells them apart. That is a deliberate exception to the rule that the launcher branches on capability rather than on an operating system, and it is confined to that one predicate: nothing else in the page asks what platform it is on.

## Companion Project: Ephemeral.exe

If you are interested in running codeblocks from Lithic or any other text-based PKMS, check out [**Ephemeral.exe**](https://github.com/Xyvir/Ephemeral.exe). It is a lightweight, daemonless utility that instantly executes code snippets directly from your clipboard inside isolated Podman containers. This allows you to run dozens of programming languages seamlessly from your notes without polluting your host system with local installations or complex dependencies.

# Self-Hosting/Remote Syncing

Self hosting instructions can be found in [self-host.md](https://github.com/Xyvir/Lithic/blob/main/self-host.md)

## GitHub Sync (Desktop App)

The GitHub button in the launcher links the folder holding your wikis to a repository. Every save of a file in that folder is committed and pushed to `main`, so the repository is a backup you can restore from.

* **Your folder is the source of truth.** GitHub is only read when the folder does not have a file yet. When a wiki exists in both places with different content, the copy in your folder is published and the remote copy stays where it is, in the repository's commit history.
* **You can choose which folder that is.** The folder line in the dialog is a button: pick any folder on this machine and that becomes the one saves are pushed from, with `Use the automatic folder` to hand it back. Lithic works the folder out for itself when nothing is chosen — the Lith you have open, else the newest recent one, else the folder your wikis live in. The choice is kept beside the program, so a bundle on a thumb drive keeps backing up its own folder when the drive is plugged into another PC. On a fresh install with nothing to go on, the line reads `No folder yet` and the button is how you answer it; Lithic only proposes a folder of its own when that folder already holds your wikis.
* **First connect merges both ways.** Wikis that exist only on GitHub are downloaded into the folder, and everything in the folder is pushed up.
* **Deletions do not propagate.** Removing a wiki from the folder leaves it on GitHub, and removing it on GitHub does not delete your local copy.

The button reports what the backup is doing, and green is the only state that means *verified*:

* **Grey** — this folder is not synced.
* **Amber** — Lithic does not have an answer yet: it is reading the folder, or checking that GitHub still accepts it.
* **Green** — the repository answers and the saved token can push to it.
* **Pulsing purple** — a save is being committed and pushed. This includes the moment you return to the launcher from a wiki, while that wiki's save is still being pushed.
* **Red** — the backup is not landing. The tooltip names the reason, and **Reconnect** in the dialog refreshes the saved credential without re-uploading or moving anything.

Green needs an answer from GitHub because the failures it hides leave nothing behind locally: a revoked token, a deleted repository and a token that can read but not write all keep the folder's sync configuration intact. A save that fails to upload also turns the icon red until a later save lands.

## Restoring an Earlier Version

The launcher keeps a version history for every wiki you open, so a bad edit is recoverable. It lives on the device, not on a server and not in GitHub.

* **The clock icon lists saved versions.** An entry is marked `full` (a complete copy from that save), `step` (the edits since the previous save) or `sync` (a save that arrived from outside this device). Downloading any entry writes a complete `<name>_recover_<timestamp>.lith`, whichever kind it is.
* **Downloads never change your wiki.** There is no revert button. To go back, download the version and replace the wiki with it: save the download over the original file in the desktop app, or upload it under the same name on a self-hosted instance.
* **History is pruned, not permanent.** When a device's storage crosses roughly 80% of its quota, the oldest-modified wikis lose their caches and history first, and never the last one. Keep a downloaded copy of anything you cannot lose.
* **A cached copy can outlive its file.** If a wiki is moved, renamed or left on an unmounted drive — or is no longer in the store it was cached from, on an instance — the launcher still lists it, marked as having no file on disk. Rebuilding Recents deletes those entries and their history, and offers to download them first.

## Restoring the Whole Instance

Every backup keeps a history of its own, and the sync dialog shows the newest ten commits of it: the short id, the sentence git stored with it, and the date. Pressing the revert mark on a row puts the instance back as it was at that commit, which is the whole wiki rather than one file.

* **A revert is a new commit, never a rewrite.** The old tree is committed on top of where the branch is, so the commits it went back over stay in the history and the way back is reverting to the commit it replaced. It is pushed like a save; a revert made offline still reverts, and the dialog says the backup did not upload.
* **Uncommitted work goes in first.** Whatever the repository has not recorded yet is committed under `Save before revert`, so a change git was never given cannot be lost. Files git does not track are left where they are.
* **A new commit is added, and it is the trail's newest row.** The list is read again from the repository after the revert, so the row you see is the one that was made rather than one this page guessed at.
* **It is there wherever there is a history.** The desktop app and the shim read the folder's own git object store; a self-hosted instance runs `git log` on `/data`, so an instance kept in local git with no GitHub account still has a trail to go back through, and the dialog offers it before the instance is connected. A folder that is not a repository has no trail at all, and the dialog shows no section rather than claiming an empty one.
* **This is not the per-wiki version history.** The clock icon lists saved versions of one wiki and is download-only (see above). The trail is the instance-wide history the backup itself makes.

## Language

The launcher reads in the language of the device it is opened on, in all three shapes of it: the published web app, the launcher a self-hosted instance serves, and the desktop app, which follows the machine. English, Spanish, French and German ship today, and a language the launcher cannot say falls back to English. Two things override that, for when a machine's language is not the one somebody wants to read.

* **`?lang=es` on the address** asks for one page in that language, whatever the device says. It is the review path: the gallery uses it to read a translation without building one, and it is the way out of a pinned deployment.
* **A build can be pinned**, which is how a deployment speaks one language to everybody. Set `VITE_LAUNCHER_LOCALE=es` for `npm run build:launcher`, or keep it in `launcher-ui/.env` so CI and the artifact freshness gate both see it, and the published site, the desktop bundle and the server tarball are all built Spanish. A self-hosted instance can also pin its own without rebuilding, with `LITHIC_LOCALE=es`; [self-host.md](https://github.com/Xyvir/Lithic/blob/main/self-host.md) has the detail and the two things that pin does not reach.

## Testing the Launcher by Hand

Two harnesses in `scripts/` cover a change to the launcher's own page, and they answer different questions.

* **`npm run test:puppeteer`** drives the committed artifact through the states it is meant to be in and asserts what each one does. It runs in CI, and a failure there is a real failure.
* **`npm run monkey:launcher`** does not know what the launcher is supposed to do. It presses every control the page draws, opens every entry box it can reach (a new Lith's name, the Recents search, a bookmark's address, the repository and token fields, the vault PIN, a saved login), fills each one with values nobody types, and reports what happened: a crash, a value that came back out as markup, a dialog that would not close, a keystroke sequence with no way back. It then opens documents instead of boxes: a dozen fixtures go through the Mount button, through a real file drop and through a `?json=` address, and each one has to end as the wiki or as the launcher, never blank, with a well-formed Lith always booting.

`npm run monkey:launcher:headed` watches it happen. `--rounds=8` fuzzes each box harder, `--seed=1234` repeats a run exactly, `--mode=webapp` looks at the browser build instead of the desktop one, `--mounts=all` opens every document fixture, `--no-drop` and `--no-payload-urls` leave the drop and address phases out, `--list` prints what would be fuzzed and stops, and `--strict` also fails on a guardrail it judges weak rather than on a crash. The values are the interesting half: line breaks and Windows device names for a filename, `javascript:` and unparseable ports for an address, emoji and fullwidth digits for a PIN, markup for all of them.

It writes a report to `scratch/monkey/report-<stamp>.md` (ignored by git) listing every value, what the field held afterwards, and what the name and address arithmetic made of it. It is deliberately not part of CI: a fuzz run is noisy, it takes a browser, and a red build on a random seed teaches people to press retry instead of fixing the crash. What it finds belongs in `test-puppeteer-launcher.mjs`, which is the harness CI runs; nothing in `.github/` may invoke it, and `npm run check:push` fails if a workflow ever does.


