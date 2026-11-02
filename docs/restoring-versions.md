# Restoring Earlier Versions

Lithic keeps two kinds of history. Each serves a different kind of mistake.

## Per-wiki version history

The launcher keeps a version history for every wiki you open, so a bad edit is recoverable. It lives on the device, not on a server and not in GitHub.

- **The clock icon lists saved versions.** An entry is marked `full` (a complete copy from that save), `step` (the edits since the previous save), or `sync` (a save that arrived from outside this device). Downloading any entry writes a complete `<name>_recover_<timestamp>.lith`, whichever kind it is.
- **Downloads never change your wiki.** There is no revert button. To go back, download the version and replace the wiki with it. Save the download over the original file in the desktop app, or upload it under the same name on a self-hosted instance.
- **History is pruned, not permanent.** When a device's storage crosses roughly 80% of its quota, the oldest-modified wikis lose their caches and history first, and never the last one. Keep a downloaded copy of anything you cannot lose.
- **A cached copy can outlive its file.** If a wiki is moved, renamed, or left on an unmounted drive, or is no longer in the store it was cached from on an instance, the launcher still lists it, marked as having no file on disk. Rebuilding Recents deletes those entries and their history, and offers to download them first.

## Whole-instance trail

Every backup keeps a history of its own. The sync dialog shows the newest ten commits: the short id, the message git stored with it, and the date. Pressing the revert mark on a row puts the whole instance back as it was at that commit.

- **A revert is a new commit, never a rewrite.** The old tree is committed on top of the current branch. The commits it went back over stay in the history, so the way back is reverting to the commit it replaced. It is pushed like a save. A revert made offline still reverts, and the dialog says the backup did not upload.
- **Uncommitted work goes in first.** Whatever the repository has not recorded yet is committed under `Save before revert`, so a change git was never given cannot be lost. Files git does not track are left where they are.
- **The list is read again after a revert,** so the row you see is the commit that was actually made.
- **It is there wherever there is a history.** The desktop app and the shim read the folder's git object store. A self-hosted instance runs `git log` on `/data`, so an instance kept in local git, with no GitHub account, still has a trail. A folder that is not a repository has no trail, and the dialog shows no section for it.
- **It is not the per-wiki history.** The clock icon lists saved versions of one wiki and is download-only. The trail is the instance-wide history the backup makes.

## Related

- [GitHub sync](github-sync.md)
- [Storage modes](storage-modes.md)
