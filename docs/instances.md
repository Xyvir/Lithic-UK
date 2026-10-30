# Instances

An instance is a Lithic launcher served by a self-hosted server (see [self-host.md](../self-host.md)). A bookmark is how the launcher keeps a list of instances beside each other.

## Bookmarks

* **The bookmark list is a desktop app feature.** The published web app hides it on desktop and Android, where you are pointed at the native build. It is kept in the app and in the published launcher on an iPhone or iPad, where it is the only way to keep one instance beside another. See [iPhone and iPad](iphone-ipad.md).
* **Removing a bookmark also drops its cached copy.** An instance's page, scripts and icons live under that instance's own origin, so the app keeps a copy of them. Removing a bookmark deletes that copy, and the next open fetches what the instance serves now. The instance's cached wikis and saved login stay where they are. This applies to the desktop app on Windows. In a browser or PWA launcher, removing a bookmark only removes the bookmark.
* **Search reaches bookmarked instances on the desktop app.** The app reads cached wikis from the profile it already keeps for each origin it has visited. Results come back as one hit per instance, and the panel opens that instance with the same search. It reads only storage the app wrote, and no request leaves the machine. This is on Windows for now.

## Instance Backups

The **Download Full Backup** action writes one file, `lithic-instance-backup-<stamp>.json`. It holds the recent list, each wiki's current text, its version history, any unsaved edit, and the saved instances with their icons. The stamp is to the second, so two backups from one device have different names.

* **Dropping the file back merges it.** A dropped `.json` is read as an instance backup first. If it is not one, it falls through to the ordinary tiddler import.
* **A name clash refuses the whole file.** If a name already exists on this device, the file is refused and the clashing names are listed. Names are compared without case. Rename or remove them, then drop the file again.
* **Saved instances are added, never removed.** An address already on this device keeps its entry and icon. Others are appended, so restoring a backup can add instances but cannot remove one.

On the browser fallback, **Backup & Reset Recents** is the foot control. Reset is enabled once each wiki has been downloaded or the full backup has been taken. A browser that cannot confirm a download counts it as done, because Safari and Firefox have no file picker to confirm with.

## Icons

An instance's icon is its own. The mark beside the title is the instance's `/mstile-150x150.png`, read from the address that served the page. An instance that has not published a set, or a page with no instance behind it, shows the shipped mark.

The emoji in the heading is saved in the instance's store, so anyone opening that instance, in any browser, gets the same favicon and mark. It is included in the GitHub backup, and restoring the shipped icon removes it from the backup. An instance that cannot be reached still shows the icon this browser last saw.

Clicking the mark opens **Instance Management**. It holds the icon picker (where there is an instance), **View Docs on GitHub**, and **Download Full Backup**.

## The Self-Host Launcher

* **The list shows the server's store.** Its file action is **Upload a Lith**. A name already on the server is replaced only after you confirm, because the server keeps no local copy. Files on this device belong to the web app and the desktop app, so they are not drawn here.
* **Each row shows the file size.** Every file in a store was written recently, so the size is the more useful figure.
* **Each row has a × that deletes the file from the server.** It asks first, because on an instance no second copy exists.
* **Rebuild Recents indexes the store.** Search reads that index for wikis this browser has never opened. Matching store rows are included, and clicking one opens the Lith from the server with the matching note pinned to the top.
* **Reset is not offered.** The list belongs to the instance. When the instance cannot be reached, the panel shows this device's saved copies instead, with **Backup Recents** as the foot control.
* **The cloud button connects the server's backup.** It uses the same device flow and repository picker as the desktop app, pointed at the server. The repository belongs to the server, so the launcher asks which repository it is on and when it last synced. Disconnecting deletes the server's token, which stops its watcher pushing. The repository and wikis stay where they are.

## Updates

The desktop app's **Update Install** closes other launcher windows on the machine that block the new copy, then closes its own window after the new copy is on disk. A window with a Lith open is never closed. The update is refused and names the Lith, and you close that window yourself. A Mac bundle never offers an update (see [macOS](desktop-macos.md)), and the Linux shim serves a browser, so its launcher stays up to say where the file went.

See also [storage modes](storage-modes.md) and [restoring the whole instance](restoring-the-instance.md).
