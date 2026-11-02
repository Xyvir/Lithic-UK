# iPhone and iPad: The Web App, and No iOS Build

There is no iOS distribution, and none is planned. That is a decision about the platform rather than about the launcher.

## There is no iPhone file to download

Android has a switch for installing apps the store did not provide. iOS has no equivalent. Outside the EU, Brazil and Japan, an app reaches an iPhone through the App Store, which needs the paid Apple Developer Program, a Mac running Xcode, and App Review. A free Apple ID installs your own build for seven days at a time. TestFlight needs the paid program and invited testers. The enterprise program is for organizations. So this project cannot publish an iOS artifact. The effort would buy one person a phone rather than a distribution.

## The iPhone answer is the web app

Open [lithic.uk](https://lithic.uk) in Safari and use **Share → Add to Home Screen**. It installs with its own icon, opens without browser chrome, and gets storage of its own. Nothing is fetched from a store, and no account or signed build is needed.

## Why the installed form lasts

Safari deletes a website's script-writable storage, including the IndexedDB that holds your wikis and their version history, after seven days without interaction with the site. A Home Screen web app is exempt, so installing it is what makes a phone copy durable. The launcher also calls `navigator.storage.persist()` when a Lith is written. That is a bonus, not a substitute: Chromium decides silently, Firefox asks, and Safari keeps its own policy. Treat the Home Screen install as the protection.

## What a phone cannot do

Safari has no File System Access API, so the browser's own storage is the document. Opening a local `.lith` reads a copy in and never writes the original back. The amber warning mark on a row is the honest report that no file holds it. The history dialog's download, `<name>_recover_<stamp>.lith`, is the way to a hard copy. See [Storage Modes](storage-modes.md) for the same fallback on Safari for macOS, Firefox and Android Chrome.

## The one asymmetry: bookmarks stay here

The bookmark list keeps instances side by side. It is a desktop app feature. It is hidden in the published PWA everywhere except iPhone and iPad, where it is the only way to keep one instance beside another, since there is no native app to open an instance from. A desktop or Android visitor is pointed at the native build instead.

A macOS browser sits in the same storage fallback as an iPhone and does not get the bookmark feature. `isIosDevice` in `launcher-ui/src/browser-storage.ts` tells the two Safari builds apart. It is the one place the launcher reads a platform name, and it is confined to that predicate.
