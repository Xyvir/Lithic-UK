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
| **PWA — Safari on macOS/iOS** (Firefox and Android Chrome behave the same way) | Open, edit, save — but the browser's storage *is* the document. No file is ever opened or written, because these engines have no File System Access API; opening a local `.lith` reads a copy in, and the original is never written back | New wikis and saves become IndexedDB entries, permanently marked amber **⚠** with the volatility warning as its tooltip. Clicking it opens version history, the only way to a hard copy (it downloads `<name>_recover_<stamp>.lith`). Recents **Reset** and **Rebuild** are hidden here: nothing on disk can be re-listed, and a reset would take every wiki with it | **This browser's storage on this device** — volatile: cache eviction, "clear site data" or an uninstall takes it |
| **Desktop app (Tauri)** | Open, edit, save to real files; Recents rebuild by reindexing the folders you point it at | Rust writes the save straight to the path you already own; history and caches stay device-local; nothing talks to a server | **The `.lith` file on your disk** |
| **Desktop app + GitHub backup** | Real files plus an off-device copy: connect a folder to a repository once, then every save is committed and pushed to `main` | Your folder always wins — GitHub is read only for files the folder does not have, a document that differs on both sides keeps its local copy, nothing on your side is overwritten, and deletions never propagate. The icon turns green only after GitHub confirms it accepts a push | **Your folder** — GitHub is a restore-only mirror, and every remote copy it replaces survives in the commit history |
| **Self-host (Docker / LXC / Railway)** | Any browser reaches your wikis by URL; nothing is installed on the client | Saves arrive as diffs the server applies and commits into `/data`; WebDAV, the sync watcher, `cp -r /data` backups and the rollback UI all read that one tree | **The server's `/data`** — your server and your disk, but not your laptop |
| **Self-host + GitHub backup** | The server folder plus an off-server copy in a repository you own | `/data` becomes a git repository: wikis only the remote has are brought down on connect, then the server's state is published. Saves and watcher passes commit and push, and a failed push restarts the backup | **The server's `/data`**, with git holding history and rollback. If the remote has diverged, its files are applied over the server's tree and the server's version is kept in history |

* **Version history is device-local in every mode.** It is not a server or GitHub feature: the clock icon lists `full`, `step` and `sync` entries for the wikis opened on this device, and the oldest are pruned first when storage runs low. Keep a downloaded copy of anything you cannot lose.
* **The Mac/iOS fallback is detected, not chosen.** A browser without the File System Access API lands in browser-storage mode on its own; append `?storage=file` or `?storage=index-db` to the launcher URL to force either one while testing.
* **The self-host launcher lists the server's store and nothing else.** Its file action is **Upload a Lith**: the `.lith` you pick is sent to the store and opened from there, and a name already on the server is replaced only after you confirm it, because this mode keeps no local copy to fall back on. Files on this device belong to the modes that own the device — the PWA and the desktop app — so no recents, caches or bookmarks are drawn on a server's list. Each row shows the size the server reports for the file rather than the date it last wrote it: everything in a store has been written this week, and the size is the one thing a name cannot say. Each row also carries a × that deletes the file from the server, and it asks first: on an instance there is no second copy, so the file every other reader opens is the one being removed. The one Recents control this list keeps is **Rebuild Recents**, which reads the store again and indexes each Lith in it here — that index is what search reads for a wiki this browser never opened. **Reset** is not offered: the list is not this device's to clear. Nothing in the heading re-lists the server: reloading the page is how that list is asked for again.
* **An instance's icon belongs to the instance.** The mark beside a self-hosted launcher's title is the instance's own file — `/mstile-150x150.png`, the largest render in the set it publishes — read from the address that served the page, so an instance draws the icon its owner uploaded rather than the launcher's own. An instance that has never published a set, and a page with no instance behind it at all, fall back to the shipped mark. The emoji in the heading is a setting for that address rather than for the browser that picked it: the choice is written into the store beside the icons rendered from it, so anyone opening the instance, in any browser, gets the same favicon and the same mark in the heading. Living in the store also puts it in the GitHub backup — a server that connects to a repository gets its icon back along with its wikis, and restoring the shipped icon takes it out of the backup rather than leaving the renders behind. An instance that cannot be asked (a proxy in the way, a bare WebDAV mount) still shows the icon this browser last saw.
* **A self-hosted launcher can turn the server's backup on.** The cloud button in the heading is the desktop app's GitHub dialog pointed at the instance instead of a folder: the same device flow, the same repository picker, and a token form for a server whose OAuth app is blocked. The repository belongs to the *server* — its `/data` is the git tree, and its saves and watcher passes do the committing and pushing — so what the launcher asks it is which repository it is on and when it last synced. Disconnecting deletes the server's token, which is what stops its watcher pushing; the remote and the wikis stay where they are.
* **The × on a bookmarked instance also drops the copy the app downloaded of it.** A bookmark is the launcher's own storage, but an instance's page, scripts and icons live under that instance's own origin, where only the app can reach them — which is why an instance that redeployed could go on serving its old launcher however many times the bookmark was removed and added back. Removing a bookmark now drops that one origin's cached copy as well, so the next open fetches what the instance is actually serving. An instance's cached wikis and its saved login are not part of a downloaded page and stay exactly where they are; forgetting a login stays the vault's own named action. This part is the desktop app's, on Windows for now — in a browser- or PWA-hosted launcher the bookmark is still the whole of what the × removes.
* **Search reaches the bookmarked instances on the desktop app.** A wiki an instance cached belongs to that instance's own origin, which a page can only read for itself, so the app's Rust side reads it out of the same profile it already keeps for every origin the app has visited. What comes back is one hit per instance — that search is for orientation, and the instance's own launcher is where the rest of the matches are — and the panel beside the row opens that instance already searching for the same words. It covers what this device saved while inside that instance, on Windows for now, and it reads only storage the app itself wrote: no request leaves the machine and no instance is loaded to answer it.

## Companion Project: Ephemeral.exe

If you are interested in running codeblocks from Lithic or any other text-based PKMS, check out [**Ephemeral.exe**](https://github.com/Xyvir/Ephemeral.exe). It is a lightweight, daemonless utility that instantly executes code snippets directly from your clipboard inside isolated Podman containers. This allows you to run dozens of programming languages seamlessly from your notes without polluting your host system with local installations or complex dependencies.

# Self-Hosting/Remote Syncing

Self hosting instructions can be found in [self-host.md](https://github.com/Xyvir/Lithic/blob/main/self-host.md)

## GitHub Sync (Desktop App)

The GitHub button in the launcher links the folder holding your wikis to a repository. Every save of a file in that folder is committed and pushed to `main`, so the repository is a backup you can restore from.

* **Your folder is the source of truth.** GitHub is only read when the folder does not have a file yet. When a wiki exists in both places with different content, the copy in your folder is published and the remote copy stays where it is, in the repository's commit history.
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

# Roadmap
1. Version 1 Released: 
- Lithic is packaged as a plugin
- Standardized Manual Build steps

Version 1.5 release: 
- includes overtype editor with syntax highlighting.
- Better mobile formatting.

Version 1.95 released:
- MAJOR Perfomance upgrade (default Tiddlystudy Backlink Pills were poorly optimized by using Regex)
- 'Anchors' plugin for stream templates.
- Calendar view & todo integration
- Bulkops Sidebar w/ savable filters (and a few smart defaults).
- "Time Spent" indicator.
- A few other cross-plugin teaks and improvments. 

Version 1.98 released:
- I stopped doing changelogs and official versioning around here. Bunch of stuff added.

TODO:

MODULARIZE LAUNCHER.HTML MONOLITH

- need to break it up into invidiual files to keep development sane; and then roll it up with CI/CD using either:
Vite + vite-plugin-singlefile OR esbuild
and minify

SELF-HOST IMPROVEMENTS:

**Public Sharing**
- Create mechanism for self-hosters to specify 'public' *.liths. (hook into existing external *.lith payload url injection?)
- Change self-hoster entrypoint to /login? (so public is default?)
  

MISC
- "Full-screen" long-from editor when clicking on bullet points.
- Simple UI Mode toggle. (Hide a lot of Tiddlywiki-specific UI, on by default.)
- Fully Expanded Slashcommands
- Replace overtype with omni-editor
- Rust Backend for Launcher apps
- Multiplatform Launcher apps
- native e2ec p2p syncing via Iroh Docs?
- Create a vs-code extension? or extend an existing extension for viewing, editing, and folding *.lith files.
With per-section syntax highlighting, section folding, etc.

  
