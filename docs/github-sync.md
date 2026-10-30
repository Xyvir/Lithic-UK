# GitHub Sync

Lithic can back up your wikis to a GitHub repository. Your folder stays the source of truth, and GitHub is a restore-only mirror. The backup works the same way on the desktop app and on a self-hosted instance, with different mechanics.

## Desktop app

The GitHub button in the launcher links the folder holding your wikis to a repository. Every save of a file in that folder is committed and pushed to `main`, so the repository is a backup you can restore from.

- **Your folder is the source of truth.** GitHub is only read when the folder does not have a file yet. When a wiki exists in both places with different content, the copy in your folder is published and the remote copy stays where it is, in the repository's commit history.
- **You choose the folder.** The folder line in the dialog is a button. Pick any folder on this machine, or use `Use the automatic folder` to hand the choice back to Lithic. Without a choice, Lithic uses the Lith you have open, else the newest recent one, else the folder your wikis live in. The choice is kept beside the program, so a bundle on a thumb drive keeps backing up its own folder when the drive is plugged into another PC. On a fresh install with nothing to go on, the line reads `No folder yet`. Lithic only proposes a folder of its own when that folder already holds your wikis.
- **First connect merges both ways.** Wikis that exist only on GitHub are downloaded into the folder, and everything in the folder is pushed up.
- **Deletions do not propagate.** Removing a wiki from the folder leaves it on GitHub, and removing it on GitHub does not delete your local copy.

### Status colours

The button reports what the backup is doing. Green is the only state that means *verified*.

- **Grey:** this folder is not synced.
- **Amber:** Lithic does not have an answer yet. It is reading the folder, or checking that GitHub still accepts it.
- **Green:** the repository answers and the saved token can push to it.
- **Pulsing purple:** a save is being committed and pushed. This includes the moment you return to the launcher from a wiki while that wiki's save is still being pushed.
- **Red:** the backup is not landing. The tooltip names the reason. **Reconnect** in the dialog refreshes the saved credential without re-uploading or moving anything.

Green needs an answer from GitHub because some failures leave nothing behind locally. A revoked token, a deleted repository, and a token that can read but not write all keep the sync configuration intact. A save that fails to upload also turns the icon red until a later save lands.

## Self-hosted instance

A self-hosted launcher can turn the server's backup on. The cloud button in the heading is the desktop app's GitHub dialog pointed at the instance: the same device flow, the same repository picker, and a token form for a server whose OAuth app is blocked.

The repository belongs to the server. Its `/data` is the git tree, and its saves and watcher passes do the committing and pushing. The launcher asks the server which repository it is on and when it last synced. Disconnecting deletes the server's token, which stops its watcher pushing. The remote and the wikis stay where they are.

See [self-host.md](../self-host.md) for setup.

## Related

- [Storage modes](storage-modes.md): what owns your data in each mode.
- [Restoring earlier versions](restoring-versions.md): using the commit history to roll back.
