# Bring Your Own Sync

Lithic does not ship a sync engine, by design. The launcher writes ordinary `.lith` files into an ordinary folder, so any tool that syncs folders already syncs your wikis. An engine inside the artifact would carry a transport stack and a relay into a file that is meant to open with no network at all.

Pick a syncer for the folder your wikis live in. Two are worth naming.

## Syncthing

The default recommendation. It is MPL-2.0, runs as one executable per device, needs no account and no central server. Point it at your wiki folder and the folder converges between devices within seconds of a save.

* **Ignore `/.git`.** If the folder is also a GitHub backup, it is a git repository. Two devices syncing one repository fight over `refs/`, `index` and `packed-refs`, and a `.sync-conflict-*` file inside `.git` can corrupt it. Put `/.git` in `.stignore`. Each device then keeps its own history and the syncer carries only the `.lith` files.
* **A conflict is a file, not a lost edit.** When two devices change the same wiki while apart, Syncthing keeps both. It writes the later one beside the original as `notes.sync-conflict-<date>-<time>-<id>.lith`. Open both and merge by hand.
* **The syncer moves wikis, not history.** Version history and the search cache live in each device's app storage, so they do not travel.
* **A synced folder is not a backup.** Deletions and overwrites propagate, so an emptied file arrives empty on every device. Keep the GitHub backup, version history and downloaded copies for that.
* **Back up from one device.** If you also use [GitHub sync](github-sync.md), let the syncer carry files and let one device do the pushing. Two devices pushing one repository from separate histories end with one refused and its icon red.

## Appa

[Appa](https://tangled.org/aly.codes/appa) does the same job on [iroh](https://iroh.computer/). A per-user daemon and CLI sync a folder in place between devices that find each other by public key. They hole-punch where they can and fall back to an encrypted relay where they cannot. There is no server and no account. It is MIT-licensed, written in Rust, and installs as a service (systemd on Linux, launchd on macOS).

* `appa folder add ~/liths` on one device, `appa folder invite ~/liths` there, and `appa folder join ~/liths` on the other.
* Both sides of a conflicting edit are kept, with about ten local revisions. `appa folder conflicts` lists them.
* `.appaignore` takes gitignore syntax, so put `/.git` there as well.
* It is early. It has one author, a small install base, and no Windows documentation yet. Run it beside a syncer you trust, and expect to read its log.

Most other iroh projects, such as `sendme` and Dropwire, are one-shot file transfers rather than folder syncers. Appa is the only in-place folder syncer worth pointing at today.

## Which One

Use Syncthing if you want it to work and to stop thinking about it. Use Appa if you want connections addressed by key, and can accept a young tool. Neither needs anything from Lithic, so switching later touches your filesystem and never your wikis.
