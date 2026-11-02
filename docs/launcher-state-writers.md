# Launcher state writers

Every variable `App.svelte` still holds, with who writes it, how often it is read, and which
variables move together. This is the map the state design needs and the two companion notes do
not have: the state tree describes *what branches*, and the extraction notes describe *what a
feature costs to lift*, but neither says *who writes `busy` in twenty four places*.

Generated from `launcher-ui/src/App.svelte` (8080 lines, 6536 lines of script), in the
`main` working tree, which is ahead of the `state-refactor` branch copy of that file by the
extraction work. Regenerate after merging `main` in and the numbers should reproduce exactly.

## What it counts

| | |
|---|---|
| mutable state (`let`) | 178 |
| derived (`$: name = ...`) | 61 |
| `$:` statements in total (assignments and blocks) | 69 |
| statements that assign a variable | 564 |
| assigned once | 41 |
| assigned twice | 52 |
| assigned three or more times | 72 |
| variables that share writing blocks | 82 |
| read in the markup | 115 |
| never read in the markup | 63 |

Every state array in this revision is *replaced* rather than mutated: the mutation column is
empty for all of them, and the seven `push` sites in the page all target local arrays. That is
worth knowing before designing a store, because a replaced array is one write and a mutated one
is a notification problem.

## Drawn and hidden

115 of the 178 variables are read somewhere in the markup, so changing one has to
redraw something and a store is the shape that gives that for free. The other 63 are never
read in the markup at all: they are bookkeeping a function reads back, and they do not need a
store, a subscription or a template change to move. That split is the pass itself, in two
phases: the hidden ones can move into closures first, with no reactive surface to break, and
only then does the drawn half need a design.

The three pending-answer resolvers are in the hidden set, which is why the resolver pattern can
go first of all: `dirtyResolver` and `rebuildOrphanResolver` are never drawn, and
`confirmationResolver` is not either. What is drawn is the confirmation *request*
(`confirmation`) and its button ref, so the prompt itself still needs a store when its turn comes.

```
lithText, fileName, filePath, cancelStatusDeadline, heldStatus, dragCounter, showRecent, 
recentFiles, remoteUnreachable, patchApiAvailable, lockHeartbeat, stageBeat, installStatus, 
installOfferReady, updateUrl, installDismissed, platformInstallable, platformEntry, phoneRow, 
syncReadTicket, syncViewTicket, gitCodeCopyTimer, gitPollAborted, gitDeviceToken, 
serverSyncStatus, serverSyncStatusTimer, serverSyncTick, gitSyncMarkerKnown, 
gitSyncRecentsReady, gitSyncBackupInFlight, gitSyncBackupTimer, gitSyncHealth, 
gitSyncHealthDetail, gitSyncHealthAt, gitSyncHeartbeatInFlight, gitSyncHeartbeatAttemptAt, 
gitSyncHeartbeatFailures, gitSyncLastPushError, gitSyncHealthTarget, gitSyncHealthApplies, 
gitReconnectMode, gitSyncProgressTimer, backupRoots, gitSyncPreferredFolder, 
gitSyncResolvedFor, gitSyncResolveToken, gitSyncJobId, trailSource, gitSyncIconState, 
gitSyncIconTitle, gitSyncPollTimer, shimPendingTimer, gitSyncSyncingUntil, gitSyncTick, 
cacheSearchRequest, historyDownloads, dirtyResolver, rebuildOrphanResolver, 
confirmationResolver, instanceReadBusy, orphanDownloads, backupDownload, fullBackupTaken
```

## The hot variables

Three or more assignments is where a variable starts behaving like a state machine rather
than a flag, so these are the ones a store boundary has to account for. `writers` is the number
of distinct top level functions that assign it, which is the better measure of spread than the
raw count: `busy` is touched everywhere, `historyError` in one place. `drawn` says whether the
markup reads it, which is the difference between state that needs a store and state that can
live in a closure.

| variable | writes | writers | reads | drawn |
|---|---|---|---|---|
| `busy` | 27 | 11 | 35 | yes |
| `gitSyncError` | 23 | 12 | 23 | yes |
| `gitSyncBusy` | 19 | 9 | 27 | yes |
| `gitSyncMessage` | 14 | 8 | 15 | yes |
| `historyError` | 14 | 6 | 14 | yes |
| `mountError` | 13 | 10 | 12 | yes |
| `remoteError` | 10 | 6 | 10 | yes |
| `gitSyncHealthApplies` | 9 | 7 | 10 | no |
| `recentFiles` | 7 | 7 | 29 | no |
| `installState` | 7 | 4 | 15 | yes |
| `gitAuthActive` | 7 | 5 | 9 | yes |
| `vaultError` | 7 | 4 | 6 | yes |
| `lithText` | 6 | 6 | 6 | no |
| `fileName` | 6 | 6 | 18 | no |
| `filePath` | 6 | 6 | 9 | no |
| `pendingImports` | 6 | 6 | 12 | yes |
| `emojiStatus` | 6 | 3 | 5 | yes |
| `installStatus` | 6 | 1 | 8 | no |
| `gitSyncHealth` | 6 | 4 | 8 | no |
| `gitSyncStage` | 6 | 5 | 6 | yes |
| `historyCaptureSaving` | 6 | 4 | 8 | yes |
| `historyNotice` | 6 | 5 | 5 | yes |
| `backupDownload` | 6 | 3 | 6 | no |
| `vaultNotice` | 6 | 4 | 5 | yes |
| `vaultBusy` | 6 | 3 | 6 | yes |
| `bookmarks` | 5 | 5 | 14 | yes |
| `brandEmoji` | 5 | 4 | 7 | yes |
| `bookmarkError` | 5 | 3 | 4 | yes |
| `installDismissed` | 5 | 3 | 8 | no |
| `gitPollAborted` | 5 | 5 | 6 | no |
| `gitDeviceToken` | 5 | 5 | 11 | no |
| `gitSyncHealthDetail` | 5 | 3 | 5 | no |
| `gitSyncHealthAt` | 5 | 4 | 5 | no |
| `gitSyncLastPushError` | 5 | 4 | 8 | no |
| `historyDirty` | 5 | 4 | 7 | yes |
| `historyCaptureOpen` | 5 | 5 | 5 | yes |
| `orphanDownloads` | 5 | 5 | 11 | no |
| `vaultEntries` | 5 | 5 | 4 | yes |
| `vaultChecks` | 5 | 3 | 7 | yes |
| `dragCounter` | 4 | 1 | 5 | no |
| `showNewLithModal` | 4 | 4 | 3 | yes |
| `gitCodeCopy` | 4 | 4 | 4 | yes |
| `gitReconnectMode` | 4 | 4 | 4 | no |
| `gitSyncCancelling` | 4 | 3 | 5 | yes |
| `gitSyncFolderError` | 4 | 2 | 3 | yes |
| `cachedEntries` | 4 | 4 | 16 | yes |
| `cacheSearchMatches` | 4 | 4 | 12 | yes |
| `dirtyEntries` | 4 | 3 | 11 | yes |
| `backupStatus` | 4 | 3 | 4 | yes |
| `vaultStatus` | 4 | 2 | 7 | yes |
| `vaultCoverage` | 4 | 1 | 5 | yes |
| `vaultSecret` | 4 | 4 | 6 | yes |
| `vaultListOpen` | 4 | 4 | 3 | yes |
| `instanceUnlockError` | 4 | 3 | 3 | yes |
| `flashProblem` | 3 | 2 | 2 | yes |
| `remoteFiles` | 3 | 2 | 10 | yes |
| `remoteNotice` | 3 | 3 | 2 | yes |
| `remoteUnreachable` | 3 | 2 | 5 | no |
| `showEmojiPicker` | 3 | 3 | 2 | yes |
| `emojiChoice` | 3 | 3 | 8 | yes |
| `platformInstallable` | 3 | 2 | 3 | no |
| `platformEntry` | 3 | 2 | 3 | no |
| `gitUserCode` | 3 | 3 | 4 | yes |
| `gitSyncHeartbeatFailures` | 3 | 3 | 5 | no |
| `gitSyncElapsed` | 3 | 2 | 2 | yes |
| `backupRoots` | 3 | 1 | 7 | no |
| `trailView` | 3 | 1 | 3 | yes |
| `gitSyncConnectedRepo` | 3 | 2 | 9 | yes |
| `historyEntries` | 3 | 2 | 3 | yes |
| `historyDownloads` | 3 | 3 | 4 | no |
| `instanceUnlock` | 3 | 3 | 3 | yes |
| `instanceSecret` | 3 | 3 | 2 | yes |

## The groups

Two variables are joined when at least two writing blocks touch both, so a dialog that happens
to write one unrelated flag does not merge two machines. A group is a candidate boundary:
lifting or storing its members together keeps a transition whole, and cutting through one is
how a refactor moves a bug.

### gitSyncError and 18 others (130 writes)

`gitSyncError` 23, `gitSyncBusy` 19, `gitSyncMessage` 14, `gitSyncHealthApplies` 9, 
`gitAuthActive` 7, `gitSyncHealth` 6, `gitSyncStage` 6, `gitPollAborted` 5, `gitDeviceToken` 5, 
`gitSyncHealthDetail` 5, `gitSyncHealthAt` 5, `gitSyncLastPushError` 5, `gitCodeCopy` 4, 
`gitReconnectMode` 4, `gitUserCode` 3, `gitSyncHeartbeatFailures` 3, `gitSyncElapsed` 3, 
`showGitSyncModal` 2, `gitSyncHeartbeatAttemptAt` 2

9 of its 19 members are drawn.

### busy and 16 others (111 writes)

`busy` 27, `mountError` 13, `remoteError` 10, `recentFiles` 7, `lithText` 6, `fileName` 6, 
`filePath` 6, `pendingImports` 6, `bookmarks` 5, `showNewLithModal` 4, `cachedEntries` 4, 
`cacheSearchMatches` 4, `dirtyEntries` 4, `remoteNotice` 3, `skippedImports` 2, 
`intentionalImports` 2, `remoteCollision` 2

13 of its 17 members are drawn.

### historyError and 8 others (46 writes)

`historyError` 14, `historyCaptureSaving` 6, `historyNotice` 6, `historyDirty` 5, 
`historyCaptureOpen` 5, `historyEntries` 3, `historyDownloads` 3, `showHistoryModal` 2, 
`historyBrowserOnly` 2

8 of its 9 members are drawn.

### vaultError and 7 others (39 writes)

`vaultError` 7, `vaultNotice` 6, `vaultBusy` 6, `vaultEntries` 5, `vaultChecks` 5, 
`vaultSecret` 4, `vaultListOpen` 4, `showVaultModal` 2

8 of its 8 members are drawn.

### backupDownload and 5 others (21 writes)

`backupDownload` 6, `orphanDownloads` 5, `backupStatus` 4, `resetAtRisk` 2, 
`showInstanceBackup` 2, `fullBackupTaken` 2

3 of its 6 members are drawn.

### instanceUnlockError and 3 others (12 writes)

`instanceUnlockError` 4, `instanceUnlock` 3, `instanceSecret` 3, `instanceSecretReset` 2

4 of its 4 members are drawn.

### emojiStatus and 2 others (14 writes)

`emojiStatus` 6, `brandEmoji` 5, `emojiChoice` 3

3 of its 3 members are drawn.

### installState and 2 others (13 writes)

`installState` 7, `platformInstallable` 3, `platformEntry` 3

1 of its 3 members are drawn.

### showDirtyModal and 2 others (6 writes)

`showDirtyModal` 2, `dirtyInfo` 2, `dirtyResolver` 2

2 of its 3 members are drawn.

### bookmarkError and 1 others (7 writes)

`bookmarkError` 5, `showBookmarkModal` 2

2 of its 2 members are drawn.

### flashProblem and 1 others (6 writes)

`flashProblem` 3, `showEmojiPicker` 3

2 of its 2 members are drawn.

### remoteFiles and 1 others (5 writes)

`remoteFiles` 3, `patchApiAvailable` 2

1 of its 2 members are drawn.

### rebuildOrphans and 1 others (4 writes)

`rebuildOrphans` 2, `rebuildOrphanResolver` 2

1 of its 2 members are drawn.

### confirmation and 1 others (4 writes)

`confirmation` 2, `confirmationResolver` 2

1 of its 2 members are drawn.

### The shape of it

82 of the 178 variables share a writing block with at least one other,
and they carry 418 of the 564 assignments. The four largest groups are the four
biggest features:

- `gitSyncError` and 18 others: 19 variables, 130 writes
- `busy` and 16 others: 17 variables, 111 writes
- `historyError` and 8 others: 9 variables, 46 writes
- `vaultError` and 7 others: 8 variables, 39 writes

The other 96 variables are single purpose, which is the good news: they are flags and
strings that belong to one action, and a store does not need to know about them.

### The resolver pattern, three times over

Three variables hold a `resolve` function for a dialog that has to be answered before the caller
continues. They are different features and the same mechanism, which is what makes them a
natural first module, and none of them is drawn:

| variable | writes | drawn | group |
|---|---|---|---|
| `dirtyResolver` | 2 | no | `showDirtyModal` |
| `rebuildOrphanResolver` | 2 | no | `rebuildOrphans` |
| `confirmationResolver` | 2 | no | `confirmation` |

## Assigned twice, and once

```
twice: status 2, statusSettled 2, cancelStatusDeadline 2, skippedImports 2, 
       intentionalImports 2, introBusy 2, showBookmarkModal 2, flashBrowserBusy 2, 
       remoteBusy 2, patchApiAvailable 2, activeRemote 2, remoteCollision 2, lockHeartbeat 2, 
       stageBeat 2, emojiBusy 2, newLithError 2, installBusy 2, installOfferReady 2, 
       updateUrl 2, showGitSyncModal 2, gitSyncMarkerKnown 2, gitSyncBackupTimer 2, 
       gitSyncHeartbeatInFlight 2, gitSyncHeartbeatAttemptAt 2, gitSyncProgressTimer 2, 
       rebuildBusy 2, gitSyncPreferredFolder 2, gitSyncPicking 2, trailCommits 2, trailNote 2, 
       fileStamps 2, showHistoryModal 2, historyBrowserOnly 2, historyBusy 2, 
       historyAvailable 2, showDirtyModal 2, dirtyInfo 2, dirtyResolver 2, rebuildOrphans 2, 
       resetAtRisk 2, rebuildOrphanResolver 2, confirmation 2, confirmationResolver 2, 
       instanceReads 2, instanceReadBusy 2, showInstanceBackup 2, backupBusy 2, 
       fullBackupTaken 2, showVaultModal 2, pinReveal 2, instanceUnlockBusy 2, 
       instanceSecretReset 2
once:  shimBackendUp, heldStatus, showRecent, search, flashShow, online, appliance, 
       bookmarkInput, newLithName, pickerRefused, platformGitSync, platformCredentials, 
       gitSyncView, syncViewTicket, gitCodeCopyTimer, gitManagedRepos, gitOtherRepos, 
       gitRepoChoice, gitCustomRepoInput, gitRepoNamePending, gitTokenInput, serverSyncStatus, 
       serverSyncFailed, serverSyncStatusTimer, serverSyncTick, gitSyncRecentsReady, 
       gitSyncBackupInFlight, gitSyncHealthTarget, gitSyncFolderOverridden, gitSyncResolvedFor, 
       trailSource, gitSyncIconState, gitSyncIconTitle, gitSyncPollTimer, shimPendingTimer, 
       gitSyncSyncingUntil, gitSyncTick, historyName, importCollisions, vaultPinReset, 
       credentialOffer
```

## Derived, not state

61 names are computed by a `$:` statement, so they are not state to move.

```
hasLocalSync, showBookmarks, shownSkipped, installOffer, footerControlsShown, installWord, 
installOfferLabel, installOfferTitle, gitSyncSubject, gitSyncFolder, gitSyncNoTarget, 
gitSyncFolderEditable, gitSyncFolderLive, trailOffered, backupCoverage, localOnlyPaths, 
showBackupStatus, showRebuildControl, recentPanelShown, serverSync, headingSyncState, 
headingSyncTitle, serverSyncAge, gitSyncHealthBroken, gitSyncHealthNote, gitSyncHealthEchoed, 
gitSyncRepoUrl, bookmarkOrigins, instanceCacheHits, filteredRecent, filteredRemote, 
offlineLauncher, offlineEntries, offlineRows, filteredBookmarks, filteredCached, 
newLithNormalized, newLithAsTyped, newLithRenamed, newLithTaken, emojiGrid, 
historyLocalOnlyPath, historySyncedFolder, historyUnsavedTs, historyRows, historyRow, 
historyMergeRung, orphanRows, orphanNote, resetRiskRows, resetRiskNote, backupPill, backupRows, 
backupOpen, backupResettable, backupCopy, vaultCreateMode, vaultSavedCount, vaultManagerTitle, 
listEmpty, emptyMessage
```

## How this was produced, and what it cannot say

- **Writer**: a statement position assignment (`^`, after `{`, or after `;`), which is the
  same anchor the status funnel used. A compound write (`+=`, `++`) counts, and so does an
  array mutator (`push`, `splice` and the rest), listed separately because a mutation is a
  write that no `=` shows.
- **Drawn**: whether the name appears anywhere after `</script>`, with no attempt to tell a
  drawn value from a drawn handler: a variable a template only passes to a function is counted
  as drawn, which overstates the store surface slightly and never understates it.
- **Attribution**: an assignment belongs to the nearest preceding top level `function`, `const
  name = (`, or `$:` block. A nested arrow function inside one of those is attributed to its
  outer block, so a writer count is an upper bound on the number of *callers*, not of scopes.
- **What it cannot say**: whether two writes are the same transition. `busy` set at the start
  of a mount and `busy` set at the start of a backup are the same variable and two different
  machines, and only a reader can decide that. The map puts those cases in front of the reader
  in the order they matter; it does not resolve them.
- **Reproducing it**: the generator was a throwaway script whose whole content is the rules
  above, so nothing in the build depends on it. Re-deriving the map means rewording those
  rules into text scanning, which is cheaper than keeping a one-off analyser in `scripts/` that
  no check runs.
