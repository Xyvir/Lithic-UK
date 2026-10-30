# Restoring the Whole Instance

Every backup keeps its own history. The sync dialog shows the newest ten commits: the short id, the message git stored with it, and the date. Pressing the revert mark on a row puts the whole instance back as it was at that commit, not just one file.

* **A revert is a new commit, never a rewrite.** The old tree is committed on top of the current branch, so the commits it goes back over stay in the history. To undo a revert, revert to the commit it replaced. A revert is pushed like a save. If you revert offline, it still happens locally, and the dialog says the backup did not upload.
* **Uncommitted work is saved first.** Anything git has not recorded yet is committed as `Save before revert`. Files git does not track are left where they are.
* **The trail is re-read after a revert.** The list reloads from the repository, so the new row you see is the commit that was actually made.
* **It works wherever there is a history.** The desktop app and the shim read the folder's git object store. A self-hosted instance runs `git log` on `/data`, so an instance kept in local git, with no GitHub account, still has a trail. A folder that is not a repository has no trail, and the dialog shows no section for it.
* **This is not per-wiki version history.** The clock icon in the launcher lists saved versions of one wiki and only downloads them. See [restoring an earlier version](restoring-versions.md). The trail here is the instance-wide history the backup makes.

See also [GitHub sync](github-sync.md) and [storage modes](storage-modes.md).
