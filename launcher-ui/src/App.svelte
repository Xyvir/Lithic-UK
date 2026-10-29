<script lang="ts">
  import { onMount } from 'svelte';
  // Every word this component shows. Nothing below spells copy of its own.
  import { LOCALE_TAG, copy, type LaunchEntry } from './copy';
  import { boardFromDeepLink, declaresBrowserOnly, handoffIntent, handoffQuery, LAUNCHER_QUERY_PARAM, launcherReturn, openedInApp, withLauncherHandoff, type LauncherMode } from './mode';
  import { armStatusClear, armStatusHold } from './status-lifetime';
  import {
    createFileBridge,
    PickerUnavailableError,
    type SaveOutcome,
    saveTextVerifiably,
    tauriInvoke,
    tauriListen
  } from './file-bridge';
  import { opensInstanceInBrowser, type PlatformCapabilities } from './platform-capabilities';
  import { backupGate, orphanPill, orphanDownloadNote, type OrphanDownloadState } from './orphan-download';
  import { isScratchFileName, isHtmlMonolithName, tracksUnsavedEdits, resolveMountName, resolveScratchKind, type ScratchKind } from './scratch-editor';
  import { pwaInstall, promptPwaInstall, shouldRestoreInstallOfferOnReset } from './pwa-install';
  import { RELEASES_LATEST_PAGE, latestReleaseTag, readBuildTag, updateOffered } from './update-notice';
  import { readShimToken, shimCommand } from './shim-command';
  import { shimCapabilities, shimInstall, shimInstallStatus, shimModifiedTimes, shimRead, shimStartupPath, shimTakeOpen, shimWrite } from './shim-files';
  import { shimFolderLiths, shimGitCoverage, shimGitStatus } from './shim-git';
  import {
    awaitShimJob,
    shimClearFolderPick,
    shimCreateRepo,
    shimDeviceCode,
    shimDevicePoll,
    shimGitCancel,
    shimGitDisconnect,
    shimGitFolder,
    shimGitHeartbeat,
    shimGitHistory,
    shimGitRevert,
    shimGitReauth,
    shimGitSetup,
    shimListRepos,
    shimPickFolder
  } from './shim-sync';
  import { bootLegacyWiki, bootLegacyHtml, writeHandoff, type RemoteTarget } from './legacy-launcher-runtime';
  import { EMOJI_LIST, uploadInstanceIcon, clearInstanceIcon, emojiFaviconUrl, applyFavicon, bustIconCache, readInstanceEmoji, readServerEmoji, saveInstanceEmoji, clearInstanceEmoji, instanceMarkUrl } from './instance-icon';
  import { getRecentFiles, setRecentRows, mergeRecentRow, mergeRecentLists, isAnonymousRow, clearAllRecentFiles, purgeOldestCachesIfNeeded, saveSearchCache, forgetWikiCache, cachedWikiNames, idb, getSearchCacheText, readFetchedLith, rememberFetchedLith, listWikiVersions, wikiHasHistory, downloadWikiVersion, getDirtyState, clearDirtyState, listDirtyRecoveries, isWikiDriftedFromHead, isInstallDismissed, setInstallDismissed, recentDiskPath, type DirtyStateRecord, type RecentEntry, type RecentRow } from './storage';
  import { isIosDevice, rememberRowKind, resolveStorageMode, storageModeOverride, browserOnlyMarkTitle, type StorageMode } from './browser-storage';
  import { readBookmarkEntries, saveBookmark, removeBookmark, setBookmarkIcon, writeBookmarkList, refreshBookmarkIcon, verifyInstanceUrl, normalizeInstanceUrl, instanceLabel, type BookmarkEntry, type InstanceVerification } from './bookmarks';
  import { LOGIN_CHECK_LABELS, askInstanceAboutLogin, loginVerdict, loginVerdictFromError, typedLoginCheck, type LoginCheckState, type LoginVerdict } from './login-check';
  import { copyDropNote, forgetInstanceCopy } from './instance-copy';
  import { offlineMode, looksUnreachable } from './offline-mode';
  import { createStageBeat, type InstallPreflight, type StageBeat } from './launcher-stage';
  import PinEntry from './PinEntry.svelte';
  import { deleteRemoteFile, fetchRemoteFiles, fetchRemoteWiki, fetchRemoteWikiMeta, probeAppliance, probePatchApi, createLockHeartbeat, readRemoteLock, uploadRemoteFile, webdavUrl, resolveSessionId, lithUploadName, type WebdavFile } from './webdav';
  import { normalizeLithName } from './legacy-saver';
  import { esp32PasswordOk, esp32Percent, esp32StageLine, flashLithicAppliance, serialFlashSupported } from './esp32-flash';
  import { documentStem, runsInWebView, typedDocumentName } from './document-format';
  import { searchCachedWikis } from './cache-search';
  import { matchMarkup, showsForQuery, titleMatches, titleMarkup } from './name-match';
  import { cachedStamp, modifiedTitle } from './last-modified';
  import { topHits, type InstanceCacheRead, type InstanceReads } from './instance-search';
  import { computeBackupCoverage, folderOf, hasBackedUpRepo, orphanedEntries, reindexFolders, resetCasualties, syncedDirFor, type CoverageRow, type RebuildOrphan } from './backup-coverage';
import { backupFileName, collectInstanceBackup, mergeBookmarks, parseInstanceBackup, planBackupImport, restoreInstanceBackup, serializeInstanceBackup, type InstanceBackup } from './instance-backup';
  import { parseDeviceCode, parseDevicePoll, pollDelayMs, formatUserCode, generateRepoName, partitionRepos } from './github-device';
  import { copyText } from './clipboard';
  import { syncIndicator, shouldHeartbeat, healthFailure, verifiedAge, SYNC_PULSE_MS, type SyncIndicator, type HealthState } from './git-sync-health';
  import { gapCount, versionGap } from './history-gap';
  import { unsavedFileName, utcStamp } from './wiki-history';
  import { TRAIL_LIMIT, parseTrailCommits, trailGapLabel, trailRows as trailRowList, type TrailCommit, type TrailPill, type TrailRow } from './instance-trail';
  import { createServerRepo, disconnectServerSync, fetchServerSyncHistory, fetchServerSyncStatus, listServerRepos, pollServerDeviceToken, requestServerDeviceCode, revertServerSync, serverSyncIndicator, setupServerSync, type ServerSyncStatus } from './server-git-sync';
  import { serializeJsonToLith, parseLithToJSON } from './lithic-format';
  import { mergeCaptureIntoDocument } from './dirty-merge';
  import { reportUnsavedEdits, takePendingClose } from './close-guard';
  import { importIntoOpenWiki } from './open-wiki-import';
  // Inlined as a base64 data URL (assetsInlineLimit: Infinity) so the brand
  // mark survives when launcher.html is bundled into the Tauri app.
  import mstile150 from './mstile-150x150.png';
  import {
    parsePayloadText,
    tagRootDogear,
    parseDroppedData,
    decodePayloadParam,
    fetchRemotePayload,
    mergePendingImports,
    removePendingImport,
    queuePendingImports,
    replacingTitles,
    isPayloadShareUrl,
    pinCachedTiddler,
    sharedPayload,
    type PendingTiddler
  } from './pending-imports';

  export let mode: LauncherMode;
  /**
   * What the process behind this page said it can do, read before this component mounted
   * (`main.ts`). Null on every page with no process behind it, and null for an app whose
   * report could not be read: both mean the platform's behaviour as it has always been,
   * which is why every use below asks `!== false` rather than for truth.
   */
  export let platformCapabilities: PlatformCapabilities | null = null;
  /**
   * Whether this app has documents of its own to open and write (`Capabilities::local_files`),
   * which is what decides whether the launcher uses its own process or the browser's file powers.
   *
   * True on every platform this app ships to, Android included: a phone's picker answers with a
   * granted `content://` reference rather than a path, but the app can still read and write it,
   * so the reference is what a recents row carries and what a save is aimed at. Read as
   * `!== false` because a report that did not arrive must leave the behaviour that has always
   * been rather than move a desktop into browser storage.
   */
  const documents = platformCapabilities?.local_files !== false;
  const files = createFileBridge(documents);
  /**
   * Whether this page is inside a WebView, which is what the board's sign-in window is.
   *
   * Read once, because what hosts the page cannot change while it lives. Where it is true the
   * mount control is the hand-off to a browser from the first press, which is the one-tap version
   * of what `pickerRefused` otherwise reaches only after a refusal: that window answers no file
   * chooser, so a press that asked for one would do nothing at all.
   */
  const inWebView = runsInWebView();
  /**
   * Where this page's saves can land: a real file, or (on a platform with no
   * File System Access API (Safari and Firefox, which is the whole of macOS
   * outside Chrome, and the only place a PWA can be installed there)) only
   * this browser's own storage. Settled once, at boot: the answer cannot change
   * while the page lives, and every mount below inherits it.
   */
  /**
   * Whether the process that served this document said it is not an instance. Read once,
   * with the mode and for the same reason: what served the page cannot change while the
   * page lives.
   */
  const browserOnly = declaresBrowserOnly(typeof document === 'undefined' ? null : document);
  /**
   * The release tag the process that served this page was built from, or null.
   *
   * A released shim serves this one tag with its document, and having one is the whole
   * declaration the update notice needs: a published deployment, an instance and the
   * desktop app all serve no tag, so none of them reaches that notice. Read once for the
   * same reason as the mode above, since what served the page cannot change while it lives.
   */
  const buildTag = readBuildTag(typeof document === 'undefined' ? null : document);
  /** Whether this page came from a shim the release workflow cut, which is what its notice needs. */
  const shimUpdateHost = buildTag !== null;
  /**
   * The command wire's per-launch secret, or null on a page no shim served.
   *
   * Its presence is what makes this page able to reach the shim's own backend: the desktop
   * app, a published deployment and an instance all serve no secret, so none of them can
   * post to a wire that only exists behind this shim. Read once, like the mode and the tag
   * above, because what served the page cannot change while the page lives.
   */
  const shimToken = readShimToken(typeof document === 'undefined' ? null : document);
  /**
   * Whether a shim served this page, which is what makes its wire reachable at all.
   *
   * The secret's presence and nothing else: a published deployment, an instance and the
   * desktop app all serve no tag, so this is the one fact that separates a page behind a shim
   * from every other distribution. It is what lets the install offer, which the desktop app
   * answers through Tauri, be answered here through the wire instead.
   */
  const shimBackend = shimToken !== null;
  /**
   * Whether the shim that served this page answered its command wire.
   *
   * A shim with no backend behind it is indistinguishable from one with: the secret says a
   * wire exists, not that anything answers on it. The probe is the difference, and it is
   * recorded on the root element rather than acted on, because nothing in this build sends
   * a command yet. The phase that puts file access, git and the credential vault behind the
   * wire reads it here instead of asking again.
   */
  let shimBackendUp = false;
  /**
   * Whether this page can ask a process about a folder's backup at all.
   *
   * Two distributions can. The desktop app, whose Rust bridge owns the git repository, and a
   * shim, whose wire answers the same questions out of `.git/config` (`shim/src/git.rs`). A
   * published deployment and an instance cannot ask about *this machine's* folders, which is
   * why the checks that used to read "is this the app" read this instead.
   *
   * Both halves now, reads and writes. What the shim cannot do is bounded by the *document* it
   * serves rather than by this flag: it injects its per-launch secret into the launcher page
   * alone, so the wiki page a saved Lith opens as has no wire to reach and the save-time commit
   * rides on the desktop app's bridge (`legacy-launcher-runtime.ts`). Everything the launcher
   * page itself does, this flag covers in both backends, and the calls that still name one
   * backend say why at their call site.
   */
  $: hasLocalSync = mode === 'tauri' || shimToken !== null;
  /**
   * A shim that served this page answers `file` on every browser, because the shim itself
   * writes the path the desktop's chooser named: on Firefox the platform has no File System
   * Access API, yet this page does have a process that can write a real file. Everywhere else
   * the platform still decides. `shimToken` is read above and cannot change while the page lives.
   */
  const storageMode: StorageMode = shimToken
    ? 'file'
    : resolveStorageMode(
        mode,
        typeof window === 'undefined' ? undefined : (window as unknown as { showSaveFilePicker?: unknown }),
        typeof window === 'undefined' ? null : storageModeOverride(window.location.search),
        // A process that cannot hold a document of its own gets the storage fallback, so the
        // version history is the copy that can be taken off the device. Every platform this app
        // ships to can hold one, the phone included; the branch is kept for a build that cannot.
        documents
      );
  /**
   * The index-db-only fallback: no Lith mounted here has a file behind it, so
   * its cached copy in this browser *is* the document.
   */
  const indexDbOnly = storageMode === 'index-db';
  /**
   * Whether this page is an iPhone, asked once because it cannot change while the page lives.
   * The only platform read in the launcher, and `isIosDevice` explains why it has to exist.
   */
  const iosDevice = isIosDevice();
  /**
   * Whether the bookmark (meta-launcher) feature belongs on this page.
   *
   * Bookmarks are the thick app's feature, and the published PWA exists to be the zero-setup
   * way in, so a browser with a native build to offer is not given them: a desktop or Android
   * visitor is meant to install the app rather than keep a second list of instances, and a
   * first run stays one action rather than a panel. The two pages that keep them are the app
   * itself and the published PWA on an iPhone or iPad, which is the one platform with no native
   * build to point at: there the meta-launcher is the whole of how one instance is kept beside
   * another.
   *
   * macOS Safari lands in the same storage fallback as an iPhone and is deliberately not given
   * the feature, because a Mac has the disk image to install and its PWA is the same
   * minimum-friction path the rest of the desktop is offered. Telling the two apart is what
   * `isIosDevice` is for, and it is the reason this is written as a platform question.
   */
  $: showBookmarks = mode === 'tauri' || (mode === 'webapp' && iosDevice);
  /**
   * The instance's own mark, or null where there is no instance to read one from (see
   * `instanceMarkUrl`). Settled at boot like the storage mode, and for the same reason:
   * which address served this page cannot change while the page lives.
   */
  const instanceMark = isSelfHost() ? instanceMarkUrl() : null;
  /**
   * Set when that mark cannot be read. An instance whose icon set was never published is
   * the one case the address cannot answer for, and the shipped mark is what is left.
   */
  let instanceMarkMissing = false;
  const RECENT_KEY = 'lithic-recent-liths';
  /**
   * The largest row text worth writing into the recents key.
   *
   * That key is localStorage, whose whole budget is a few megabytes. Measured, about 5 MB
   * over `file://`, so a document big enough to be worth quoting could never fit beside the
   * rows that name it. A text over this is left in memory for the session and not mirrored,
   * which keeps the row itself; see `persistRecentRows`.
   */
  const RECENT_TEXT_LIMIT = 512 * 1024;
  let lithText = '';
  let fileName = 'untitled.lith';
  let filePath: string | undefined;
  let status = '';
  /**
   * Whether a line that has to stand has stopped claiming that work is happening.
   *
   * The animated dots beside a status are the launcher saying work is happening. An ordinary
   * line needs nothing done to them: it is cleared at the deadline, dots and all. A held line
   * stays past that deadline, and this is the half of it that still has to end, because a
   * failure that stood for the rest of the session would read as work that never finished. So
   * the movement stops at the deadline and the sentence stays where it can still be read.
   */
  let statusSettled = false;
  let cancelStatusDeadline: (() => void) | null = null;
  /**
   * The sentence the line is holding, or '' while it is an ordinary one.
   *
   * Held by its text rather than by a flag, so an ordinary writer that runs after a failure
   * cannot inherit the exemption by writing next: a line is held only while it is the exact
   * sentence a hold was asked for.
   */
  let heldStatus = '';

  /**
   * Start the deadline the line now lives by, and take back the one armed for the line it
   * replaced. See `status-lifetime.ts` for why it exists and what it costs.
   *
   * An ordinary line is cleared at the deadline. A held line keeps that deadline's settle half
   * alone, so the movement stops there and the sentence stands until something replaces it. The
   * clear is guarded by the text, like `reportAndRetire`, so an older line's deadline arriving
   * late can never take away a sentence that arrived after it.
   */
  function syncStatusDeadlines(text: string, held: string): void {
    cancelStatusDeadline?.();
    cancelStatusDeadline = null;
    statusSettled = false;
    if (!text) return;
    const settle = () => { statusSettled = true; };
    cancelStatusDeadline = text === held
      ? armStatusHold({ settle })
      : armStatusClear({ clear: () => { if (status === text) status = ''; } });
  }

  /**
   * Say something the launcher cannot finish for the person, and let it stand.
   *
   * A failure is not a status report. "Open failed: ..." and "No file path recorded" name
   * something the person has to act on, so the line stops claiming to be busy at the same moment
   * any other line does and then keeps standing until the next thing replaces it, which is how
   * the error lines beside it have always behaved. A clock cannot tell a failure from a success,
   * so the writers that report one say so here, one site at a time, and every other writer stays
   * transient by default.
   */
  function reportHeld(message: string): void {
    heldStatus = message;
    status = message;
  }

  $: syncStatusDeadlines(status, heldStatus);
  let busy = false;
  let pendingImports: PendingTiddler[] = [];
  /**
   * Whether the pending panel draws its list or only its own bar.
   *
   * The panel is fixed over the corner that holds New Blank Lith and Mount a Lith, which is the
   * pair a queued row exists to be acted on with. On a phone there is no room beside it, so a
   * phone starts folded and leaves the bar, one row, over the heading; a desktop starts unfolded
   * because the panel fits beside the actions and the list is the thing worth reading there.
   *
   * Decided once, when the page starts, rather than followed on every resize: the fold is the
   * person's to open, and a window that grows afterwards must not shut what they just opened.
   * The two shapes are the ones the stylesheet already treats as a phone (its own 600px row and
   * its sideways-phone block), and both are true of a phone whichever way it is held.
   */
  const phonePanelQuery =
    typeof window === 'undefined'
      ? null
      : window.matchMedia('(max-width: 600px), (orientation: landscape) and (max-height: 560px) and (max-width: 950px)');
  let pendingCollapsed = phonePanelQuery ? phonePanelQuery.matches : false;
  /** Titles the last queue addition refused, because the queue already held them. */
  let skippedImports: string[] = [];
  /** The refusals still worth showing: their queued row has not been removed since. */
  $: shownSkipped = skippedImports.filter((title) => pendingImports.some((tiddler) => tiddler.title === title));
  /**
   * Titles queued by a gesture that means "take this copy" rather than "add this file".
   *
   * A search preview's pin is the case: it queues the note the person just clicked, tagged so
   * it opens at the top, precisely so the merge writes it into the Lith it came from. Asking
   * whether that may replace the stored copy would put a question in front of the one gesture
   * that already answered it.
   */
  let intentionalImports: string[] = [];
  let introBusy = false;
  let dragCounter = 0;
  let showRecent = false;
  let recentFiles: Array<RecentEntry | { name: string; path?: string; text?: string; handle?: any }> = [];
  let search = '';
  let mountError = '';
  let bookmarks: BookmarkEntry[] = [];
  let showBookmarkModal = false;

  /**
   * The one-time flash offer. A blank board is its whole subject, so the page feeds it one
   * thing: the password the board will broadcast its network with. The images come from the
   * firmware branch, and the password is written into the flash beside them.
   */
  let flashShow = false;
  let flashBusy = false;
  let flashLine = '';
  let flashProblem = '';
  let flashPercent = 0;
  let flashPassword = '';
  /** Whether the flash may start, which is the one thing the field decides. */
  let flashPasswordOk = false;
  $: flashPasswordOk = esp32PasswordOk(flashPassword);
  /** The handoff in flight, so the row cannot be pressed twice while a browser starts. */
  let flashBrowserBusy = false;
  /**
   * This window can flash a board by itself: its webview implements Web Serial.
   *
   * A Chromium tab does, and so does a current WebView2. That is measured rather than assumed:
   * the runtime answers `navigator.serial` and draws its own chooser, titled "tauri.localhost
   * wants to connect to a serial port". WKWebView and WebKitGTK implement none of it, and an
   * older WebView2 may not either, which is what `flashInBrowser` is for.
   */
  const flashSupported = serialFlashSupported();
  /**
   * The route where the window has no serial port: a Chromium browser on this machine, when one
   * is installed (see `flash_browser` in `src-tauri/src/platform/mod.rs`). Pressing the row
   * hands the same page to it at `?flash=1` (`Flash.svelte`), which is a real browser and so
   * brings a chooser the write can rely on.
   */
  const flashInBrowser = mode === 'tauri' && platformCapabilities?.flash_browser === true;
  const flashOfferable = flashSupported || flashInBrowser;

  // --- Self-host (WebDAV listing + the git-backed patch API) ---
  // remoteFiles is the server's .lith listing; activeRemote is the wiki this
  // tab currently has open over the network, which drives the file name in the
  // heading and the presence-lock heartbeat.
  let remoteFiles: WebdavFile[] = [];
  let remoteBusy = false;
  let remoteError = '';
  let remoteNotice = '';
  /**
   * Offline mode's two inputs: whether this browser still has a network, and whether
   * this instance failed to answer as a network fault rather than with a refusal. Only a
   * cached self-host launcher can be offline, so both are read by `offline-mode.ts` and
   * the result is what the banner and the list below read.
   */
  let online = typeof navigator === 'undefined' ? true : navigator.onLine;
  let remoteUnreachable = false;
  let patchApiAvailable = false;
  /**
   * Whether the thing serving this page is a bare appliance rather than an instance (`probeAppliance`).
   *
   * It decides one thing, and it is the round control in the heading: a board carries no
   * repository and no introduction either, so the heading draws no round control at all rather
   * than a way into GitHub backups that could never complete. False is every instance, including
   * one that did not answer, because a question that could not be asked must leave the control it
   * has always had.
   */
  let appliance = false;
  let activeRemote: { name: string; digest: string; api: boolean } | null = null;
  // Set when the server reports a live lock held by someone else: the open is
  // paused on a choice (read-only / ignore / cancel) instead of guessing.
  let remoteCollision: { name: string; who: string } | null = null;
  let lockHeartbeat: ReturnType<typeof createLockHeartbeat> | null = null;
  /**
   * This window's own beat: where it is, said often enough for the other copies of this app on
   * this machine to act on it.
   *
   * Started on a desktop launcher and never stopped by a page, because the beat has to outlive
   * the document: a mount hands the whole document to the engine, and the window, this timer and
   * everything else here carry on through it (see `launcher-stage.ts`). Nothing else reads this
   * value, so a `null` is simply a window with no registry behind it.
   */
  let stageBeat: StageBeat | null = null;

  // --- Instance icon (emoji favicon), and the Instance Management dialog it lives in ---
  let brandEmoji = '';
  /**
   * The Instance Management dialog, behind the heading mark in every mode.
   *
   * The picker's names are kept, because the picker is still the largest thing inside it and
   * renaming them would touch every selector in the gallery and the smoke suite for a change
   * of wording. What the dialog *is* has moved: the picker is drawn only on an instance that can
   * serve the icons it writes (not on an appliance, see `appliance`), and the docs link and the
   * full backup are drawn everywhere.
   */
  let showEmojiPicker = false;
  let emojiChoice = '';
  let emojiBusy = false;
  let emojiStatus = '';
  let bookmarkInput = '';
  let bookmarkError = '';
  let bookmarkInputElement: HTMLInputElement;
  let showNewLithModal = false;
  let newLithName = '';
  let newLithError = '';
  let newLithInputElement: HTMLInputElement;
  /**
   * Whether a chooser has been refused on this page, which is the one signal that the window
   * cannot pick a file at all.
   *
   * Set from the failure rather than guessed from the user agent, because every in-app browser and
   * every webview claims nothing in particular and only one of them cannot pick. Once it is true
   * the mount control stops asking for a chooser and offers the app instead, which is the only
   * hand-off a page in that window can still make.
   */
  let pickerRefused = false;

  // Desktop install: copies the app executable to a stable per-user location
  // and registers Windows "Open with" entries for the editor file types.
  // PWA-style visibility: hidden while an identical copy is installed,
  // shown as an update when the installed copy is older than this build.
  let installBusy = false;
  let installStatus = '';
  let installState: 'uninstalled' | 'current' | 'stale' | 'update' = 'uninstalled';
  // Whether the app has been told what the offer should be, which is the one thing
  // it cannot work out for itself: if a copy is installed, whether that copy is older
  // than this build, whether the release this build was cut from is still the newest.
  // Every earlier default was a guess, and the wrong guess was visible: 'uninstalled'
  // is a *showing* state, so an installed copy painted an Install button for the frame
  // or two before `install_status` answered, then took it away. Nothing renders at all
  // until this is true, so the offer arrives as the app's answer instead of being a
  // guess that gets corrected in front of the user.
  let installOfferReady = false;
  /**
   * Which offer the footer is making, or null for none. See the rule below.
   *
   * Declared rather than left to inference, because the template and the action both read
   * it and a widened `string` would let a typo be a mode that never matches.
   */
  let installOffer: 'desktop' | 'pwa' | 'update' | null = null;
  /** Where the manual update offer sends the user. Rust's answer, never a literal here. */
  let updateUrl = '';
  // "Dismiss" on the install offer: hides the button until manually restored
  // (clear site data in a browser; delete recents.txt beside the exe in
  // tauri mode). A pending Update Install is the one offer dismissal does not
  // hide: that newer exe is already on this machine and the user is mid-update.
  // The manual Update Available offer is hidden like the rest, because a user
  // who defers updates wants to manage them by hand, and that is their answer.
  let installDismissed = false;
  // What the desktop app can do on this platform, as the Rust side reports it, read
  // before the offer is allowed to exist. It is what decides whether there is an offer
  // at all: an AppImage installs into the application menu and a Mac bundle installs by
  // being dragged out of a disk image, so neither has the Windows answer, and a platform
  // with nothing to offer should say nothing rather than draw a button that does not
  // work. `platformEntry` is only for the sentence, never for deciding anything.
  let platformInstallable = false;
  let platformEntry: LaunchEntry | null = null;
  /**
   * Whether this build can back a folder up to GitHub at all.
   *
   * A separate question from `hasLocalSync` above, and asked of the platform rather
   * than of the distribution: the desktop app and a shim both have a process behind
   * them, but only some builds carry the git half. The Android app links no git, so its
   * commands refuse, and the answer comes from the side that knows through
   * `platform_capabilities`.
   *
   * True until something says otherwise, and the default is deliberate: it is what keeps
   * every distribution that has always had a backup, including a shim, which never
   * answers this question at all, exactly as it was. Only a platform that says no loses
   * the control.
   */
  let platformGitSync = true;
  /**
   * Whether this build carries the credential vault at all.
   *
   * Asked of the platform like the flag above it, and answered no on Android alone: a
   * phone has its own place for a password. Its WebView asks for the instance's Basic
   * credentials itself and keeps what was typed, which is the arrangement the published
   * PWA has through the browser, so the manager dialog, the PIN prompt and the key on a
   * bookmark row are none of them drawn there. Same reason in both cases: a platform that
   * keeps credentials already is not helped by a second copy under an app.
   *
   * True until something says otherwise, exactly like the git flag beside it, so a desktop
   * copy whose capability report could not be read keeps the vault it has always had
   * rather than losing it to a failure that says nothing about the platform.
   */
  let platformCredentials = true;

  async function refreshInstallState() {
    if (mode !== 'tauri') {
      installDismissed = await isInstallDismissed();
      // The shim answers the same question the desktop app answers through Tauri, through its
      // wire: whether this copy can install itself, and the state of the copy already on disk.
      // A page behind no shim has no copy to install, so this stays the browser's own offer.
      if (shimBackend) {
        await refreshShimInstallState();
      }
      // A browser's install prompt is what the webapp offer waits on, and that
      // arrives when it arrives; this only stops the footer guessing in the meantime.
      installOfferReady = true;
      // The shim's notice is the one browser-side offer that has to ask the network, and
      // it asks here rather than above for the desktop branch's own reason: a user who
      // dismissed the notice must not watch it arrive for as long as the answer takes.
      // Only an installed, current copy asks, matching the desktop app's gate: a copy that is
      // not installed is offered Install instead, and an update notice beside it would be a
      // weaker second offer for the same button.
      if (shimUpdateHost && !installDismissed && installState === 'current') {
        await checkForInstallUpdate();
      }
      return;
    }
    let launchedFromInstall = false;
    try {
      // The boot-time report where there was one, and a fresh ask only where the first
      // failed: what this command answers is a fact about the running process, which cannot
      // change while the page lives (the rule every other boot constant here follows).
      const capabilities =
        platformCapabilities ?? (await tauriInvoke<PlatformCapabilities>('platform_capabilities'));
      platformInstallable = capabilities.install;
      platformEntry = capabilities.launch_entry;
      // A build with no git in it says so, and the backup control is then not drawn at
      // all. Read as `!== false` rather than for truth: a Rust side older than this field
      // sends nothing, and a missing answer must not be read as a refusal.
      platformGitSync = capabilities.git_sync !== false;
      // The same reading, of the same kind of answer, about the vault.
      platformCredentials = capabilities.credentials !== false;
      // The vault does not stay unlocked between visits: an instance load asks for the
      // secret again, every time. Opening the launcher is therefore the moment to drop
      // whatever the last load was holding, and the status that comes back is what the
      // rows and the manager control are drawn from. Touched only where this build has a
      // vault, so a platform that answered no never has the file opened at all.
      if (platformCredentials) {
        void tauriInvoke('lock_credentials')
          .catch(() => { /* a build without the vault: nothing to lock */ })
          .then(() => Promise.all([refreshVaultStatus(), refreshVaultCoverage()]));
      }
    } catch {
      // A capability report that could not be read is not an install. The offer stays
      // hidden rather than promising something this platform may not do. The two
      // permissive flags above are deliberately left alone: a report that did not arrive
      // says nothing about the platform, and turning that into a refusal would take the
      // vault away from every desktop copy the moment one read failed.
      platformInstallable = false;
      platformEntry = null;
    }
    try {
      const result = await tauriInvoke<{ installed: boolean; up_to_date: boolean; running_from_install: boolean }>('install_status');
      installState = result.installed ? (result.up_to_date ? 'current' : 'stale') : 'uninstalled';
      launchedFromInstall = result.running_from_install;
    } catch {
      installState = 'uninstalled';
    }
    try {
      const offer = await tauriInvoke<{ installed: boolean; dismissed: boolean }>('install_offer_status');
      installDismissed = offer.dismissed;
    } catch {
      installDismissed = false;
    }
    // Both reads above are local and quick, and between them they are everything the
    // offer's *existence* turns on, so this is where it may be shown. Deliberately before
    // the release question below, which is a network round trip: holding the offer back
    // behind GitHub would make a launcher with nothing to offer wait on the internet to
    // say nothing. The offer appears on its own answer, and only its claim about the
    // newest release waits for the answer that needs the network.
    //
    // After the dismissal read and never before it: a user who dismissed the offer must
    // not watch it arrive and then be taken away in the same breath.
    installOfferReady = true;
    // Only an install sitting in its own folder asks about releases, and only
    // while the offer is still on show: asking a user who dismissed it would put
    // the button back on screen for as long as the answer took.
    if (launchedFromInstall && !installDismissed) {
      await checkForInstallUpdate();
    }
  }

  /**
   * What the shim's own copy can do and what state it is in, asked through its wire.
   *
   * The same two facts the desktop app reads through Tauri, in the same shape, so the offer
   * rule below reads one state in both modes. A wire that did not answer is not an install:
   * the capability stays false and no offer is drawn, rather than a button that could not work.
   */
  async function refreshShimInstallState(): Promise<void> {
    const capabilities = await shimCapabilities({ token: shimToken });
    platformInstallable = capabilities.ok && capabilities.value.install === true;
    platformEntry = capabilities.ok ? capabilities.value.launch_entry : null;
    const status = await shimInstallStatus({ token: shimToken });
    if (status.ok) {
      installState = status.value.installed ? (status.value.up_to_date ? 'current' : 'stale') : 'uninstalled';
    } else {
      installState = 'uninstalled';
    }
  }

  /**
   * Ask whether the release this build was cut from is still the newest.
   *
   * Read-only, and all it can do is relabel the offer: the app never downloads a
   * file, never runs one and never writes to the install location. The user
   * fetches the new exe in their browser and launches it themselves, then presses
   * Update Install, which is the same manual step a portable copy makes.
   */
  async function checkForInstallUpdate() {
    if (shimUpdateHost) {
      // The shim asks GitHub itself, because the API answers any origin and a notice is
      // all this is: no backend behind the file, and no command to carry it.
      const latest = await latestReleaseTag();
      if (!updateOffered(buildTag, latest)) return;
      updateUrl = RELEASES_LATEST_PAGE;
      installState = 'update';
      return;
    }
    try {
      const update = await tauriInvoke<{ available: boolean; url: string }>('install_update_check');
      if (!update.available) return;
      updateUrl = update.url;
      installState = 'update';
    } catch {
      // A question that could not be answered is not an update.
    }
  }

  /**
   * What the footer should be offering, worked out once for every mode.
   *
   * One value rather than a condition written into each branch of the template, because
   * the rule is the same in all three modes: say nothing until the answer is in, then
   * reveal the offer that answer asks for. The modes differ only in *what* their answer
   * is. A browser answers with the install prompt (the published launcher and an
   * instance's own copy alike, which is why self-host is not a special case here) and
   * the desktop app answers with the state of the copy on disk.
   *
   * `installOfferReady` is the half they share, and the reason none of them can drift back
   * into painting a guess: until the app has been told what to make of itself there is no
   * offer, so there is never a first paint to take back. The dismissal outranks an ordinary
   * offer in every mode (a user who hid it wants it hidden wherever they are) with the one
   * exception of a pending Update Install, because that newer exe is already on this machine
   * and the user is mid-update. A page whose own server declared it browser-only draws no
   * offer at all: the shim distribution has no copy to install and no browser prompt worth
   * answering, so the declaration is this rule's first term.
   *
   * The one browser page that does offer something is a shim, and the tag its server sent is
   * what says so. That shape is 'update' and it is the only one a shim can reach: there is no
   * copy to install and no prompt to answer, so neither 'desktop' nor 'pwa' can come out of a
   * page this server sent. It is also why the first term is a disjunction now, since the
   * browser-only declaration had been standing in for "not a shim" as well.
   */
  $: installOffer =
    (!browserOnly || shimUpdateHost || shimBackend) && installOfferReady && !(installDismissed && installState !== 'stale')
      ? mode === 'tauri' || shimBackend
        ? installState === 'current' || !platformInstallable
          ? null
          : 'desktop'
        : shimUpdateHost
          ? installState === 'update'
            ? 'update'
            : null
          : $pwaInstall.installable
            ? 'pwa'
            : null
      : null;

  /**
   * Whether either of the window's bottom corners holds a control.
   *
   * The stylesheet reserves a bottom band under the panel on a window between 601px and 899px,
   * where a corner control sits over the launcher column instead of beside it (see that query
   * in styles.css). The reservation is room made for something that is there, so it follows the
   * two conditions the footer renders on rather than the mode: a desktop window draws no project
   * link, and a window whose install question answered "nothing to offer" draws no button, and
   * with both absent the band was 76px of nothing under the last row of the list.
   */
  $: footerControlsShown = (mode === 'webapp' && !browserOnly) || Boolean(installOffer && !recentPanelShown);

  /**
   * Whether the window is the width at which the install offer leaves the window's corner for
   * the panel's foot row. The number is the stylesheet's own, the `@media (max-width: 600px)`
   * block that moves the offer into that row, mirrored because the button's word changes with
   * it: the row is shared with the control the list is rebuilt from, so the button is about two
   * thirds of the width it has in the corner.
   *
   * A fact about the width rather than about which of the offer's two homes is in play, because
   * a launcher with a panel and one without are both phone width at phone width, and the corner
   * it falls back to there is the same narrow control.
   */
  const phoneRowQuery = typeof window === 'undefined' ? null : window.matchMedia('(max-width: 600px)');
  let phoneRow = phoneRowQuery ? phoneRowQuery.matches : false;
  phoneRowQuery?.addEventListener('change', (event) => (phoneRow = event.matches));

  /**
   * The word this button wears for the browser's own install offer: the full one where the
   * button has the corner to itself, and the plain one in the phone's foot row, where the
   * rebuild control beside it owns the rest of the line.
   */
  $: installWord = phoneRow ? copy.install.label.plain : copy.install.label.install;

  /**
   * The offer button's label, and what it promises on hover.
   *
   * Reactive statements rather than functions the template calls: Svelte reads a
   * call expression untracked, so a label computed inside one never followed
   * `installState` as it arrived. The button kept the word it mounted with, which
   * is 'Install' for every offer that starts life before the first status read.
   */
  $: installOfferLabel = installBusy
    ? copy.install.label.installing
    : installOffer === 'pwa'
      ? installWord
      : installOffer === 'update'
        ? copy.install.label.updateAvailable
        : installState === 'update'
          ? copy.install.label.updateAvailable
          : installState === 'stale'
            ? copy.install.label.updateInstall
            : copy.install.label.plain;
  $: installOfferTitle =
    installStatus ||
    (installOffer === 'pwa'
      ? copy.install.offer.browser
      : installOffer === 'update'
        ? copy.install.offer.notice
        : installState === 'update'
          ? copy.install.offer.update
          : copy.install.offer.desktop(platformEntry));

  /**
   * The offer's primary action: prompt the browser, install, update the install, or open
   * the release page. Switched on the offer rather than on the mode, so the button and the
   * thing it does cannot disagree about which offer is on screen.
   */
  async function installOfferAction(): Promise<void> {
    if (installOffer === 'pwa') {
      await installPwa();
      return;
    }
    // The shim's notice opens the releases page in the user's own browser and leaves this
    // page where it is. That is `openExternally` rather than Rust's `open_external`, since
    // there is no webview behind this page to hand the address to.
    if (installOffer === 'update') {
      openExternally(updateUrl);
      return;
    }
    if (installState === 'update') {
      // The desktop app hands the address to Rust; a page behind a shim has no webview to hand
      // it to, so it opens a tab the way every other browser-side link here does.
      if (mode === 'tauri') {
        try {
          await tauriInvoke('open_external', { url: updateUrl });
        } catch (error) {
          status = copy.install.openFailed(error instanceof Error ? error.message : String(error));
        }
      } else {
        openExternally(updateUrl);
      }
      return;
    }
    await installMonolith();
  }

  /** The project, which the mark and the footer both point at. */
  const PROJECT_URL = 'https://github.com/Xyvir/Lithic-UK';

  /**
   * Ask the machine to open an address the launcher does not own.
   *
   * In a browser that is a new tab and nothing more. In the desktop app it has to be Rust,
   * and the reason is worth keeping: the webview has no second window to open, so a
   * `target="_blank"` click lands nowhere at all. That is how the project link and the
   * device-login page both became dead controls in the app while the update offer, which
   * already asks Rust, kept working. The project link, the device-login page and the
   * introduction all come through here, so they cannot disagree about how an address is
   * opened. The update offer keeps its own call, because it has a failure to report.
   */
  function openExternally(url: string) {
    if (mode !== 'tauri') {
      window.open(url, '_blank');
      return;
    }
    // A refused open is not worth a dialog of its own: the address is also in the `href`, and
    // the browser-side path is what every other mode takes.
    void tauriInvoke('open_external', { url }).catch(() => {});
  }

  /**
   * Ask the wire whether there is a backend on the other end, once, at boot.
   *
   * Reachability is not something the secret can state: a shim serves the secret and its
   * wire together, but only an answer proves the two are connected. This is the whole
   * liveness proof, and it stays a boolean on the page rather than a rendered state.
   */
  async function probeShimBackend(): Promise<void> {
    shimBackendUp = (await shimCommand('ping', {}, { token: shimToken })).ok;
  }

  /**
   * Open the `.lith` this shim was started with, if a file manager handed one over. A served
   * page cannot see its own process, so the shim is asked; nothing opens when it answers null,
   * which is every launch that was not an Open With or a command line naming a file.
   */
  async function openShimStartup(): Promise<void> {
    const answer = await shimStartupPath({ token: shimToken });
    if (!answer.ok) return;
    const path = answer.value.path;
    if (!path) return;
    await mountDiskPath(path);
  }

  /**
   * Open a Lith a second launch handed to this shim, if one left a request.
   *
   * A launch that finds this shim already on the port joins it rather than replacing it, and
   * the file it named cannot reach this page's wire (that process holds no secret), so it waits
   * in a file the shim reads once (`shimTakeOpen`). Asked at boot for the window a launch just
   * opened, and answered on a timer for the window it merely raised: bringing an already-loaded
   * window to the front runs no boot code at all, which is the one case a boot ask cannot cover.
   */
  async function openShimPending(): Promise<void> {
    const answer = await shimTakeOpen({ token: shimToken });
    if (!answer.ok) return;
    const path = answer.value.path;
    if (!path) return;
    await mountDiskPath(path);
  }

  /**
   * An anchor's own click, taken over only in the one mode that cannot honour it.
   *
   * Everywhere else it is left alone: a browser's handling is what right-click, copy-link and
   * the modifier keys depend on, and the address stays in the `href` so the control is a link
   * even if this script never runs.
   */
  function openExternalLink(event: MouseEvent, url: string) {
    if (mode !== 'tauri') return;
    event.preventDefault();
    openExternally(url);
  }

  /** Hide the install offer; per-mode persistence (IndexedDB / sidecar). */
  async function dismissInstallOffer() {
    installDismissed = true;
    if (mode === 'tauri') {
      void tauriInvoke('set_install_dismissed', { dismissed: true }).catch(() => { /* best effort */ });
    } else {
      void setInstallDismissed(true);
    }
  }

  /** Legacy parity: fire the browser's native PWA install prompt. */
  async function installPwa() {
    const outcome = await promptPwaInstall();
    if (outcome === 'unavailable') {
      status = copy.install.unavailable;
    }
  }

  // GitHub sync (Tauri): the legacy launcher's slick flow, server-free.
  // install the Lithic Sync GitHub App, authorize via OAuth device flow
  // (github.com/login/device + user code), pick or create a lithic-sync-*
  // repo, then the folder auto-commits on every save. Rust proxies the two
  // GitHub OAuth endpoints; a PAT form stays as the advanced fallback.
  type GitSyncView = 'disconnected' | 'connecting' | 'selecting' | 'connected';
  let showGitSyncModal = false;
  let gitSyncView: GitSyncView = 'disconnected';
  /**
   * Monotonic counter: every status read takes the next ticket as it is issued, and every
   * decision about the dialog's view takes one as it is made.
   */
  let syncReadTicket = 0;
  /** The ticket of the read or decision that last set the view. */
  let syncViewTicket = 0;

  /**
   * Set the dialog's view, and record where the answer came from.
   *
   * Two things write this view (the flow's own steps, and the answers to status reads)
   * and the network does not order the second kind against the first: the status read the
   * dialog makes on the way in can be answered *after* a disconnect lands, and believing it
   * puts the dialog back on the connected view, with the repository filled in from a world
   * the user has just stopped. So a decision takes a ticket as it is made (superseding every
   * read already in flight), a read that applies its answer passes its own ticket, and
   * `refreshServerSyncStatus` and `refreshGitSyncStatus` discard anything older than the
   * ticket this records.
   */
  function setGitSyncView(view: GitSyncView, ticket: number = ++syncReadTicket): void {
    gitSyncView = view;
    syncViewTicket = ticket;
  }
  let gitSyncBusy = false;
  let gitSyncMessage = '';
  let gitSyncError = '';
  let gitAuthActive = false;
  let gitUserCode = '';
  /** What the code button last answered: a copy it made, a copy it could not, or nothing. */
  let gitCodeCopy: '' | 'copied' | 'failed' = '';
  let gitCodeCopyTimer: ReturnType<typeof setTimeout> | undefined;
  let gitPollAborted = false;
  let gitDeviceToken: string | null = null;
  let gitManagedRepos: string[] = [];
  let gitOtherRepos: string[] = [];
  let gitRepoChoice = '';
  let gitCustomRepoInput = '';
  let gitRepoNamePending = generateRepoName();
  // Advanced fallback (direct PAT), hidden behind a details toggle.
  let gitRepoInput = '';
  let gitTokenInput = '';

  // The same flow, backing up an *instance* instead of a folder: there /data is
  // the repository and the server does the git work, so all the launcher page
  // holds is the last answer it got. Nothing about the connection is local, and
  // no token this machine sees is used for anything except the setup request.
  let serverSyncStatus: ServerSyncStatus | null = null;
  let serverSyncFailed = false;
  let serverSyncStatusTimer: ReturnType<typeof setInterval> | null = null;
  /** Bumped by each status poll, so the button's "syncing" window can expire. */
  let serverSyncTick = 0;

  // Sync health. The marker poll answers "is this folder wired to a
  // repository"; only the heartbeat answers "is the backup still working", and
  // only one of those costs a network round trip.
  /**
   * Whether the marker read has answered for the focused folder. False only for
   * the moment between the page painting and that read landing, which is amber:
   * grey is reserved for "nothing is synced here", and claiming that before
   * asking is what made returning from a wiki look like sync was never set up.
   */
  let gitSyncMarkerKnown = false;
  /**
   * Whether the recent list has loaded. It decides what the icon is even about:
   * with no Lith open, the icon describes the most recent one, so an empty list
   * at boot is not evidence that nothing is synced. It is evidence that the
   * question cannot be asked yet.
   */
  let gitSyncRecentsReady = false;
  /**
   * Rust has a backup of the focused folder running right now. Usually the exit
   * save of the wiki the user just came back from, still pushing. Reported by the
   * side doing the work, so it outranks even an unknown marker.
   */
  let gitSyncBackupInFlight = false;
  let gitSyncBackupTimer: ReturnType<typeof setInterval> | null = null;
  let gitSyncHealth: HealthState | null = null;
  let gitSyncHealthDetail = '';
  let gitSyncHealthAt = 0;
  let gitSyncHeartbeatInFlight = false;
  let gitSyncHeartbeatAttemptAt = 0;
  let gitSyncHeartbeatFailures = 0;
  let gitSyncLastPushError: string | null = null;
  /** Which folder the current verdict describes, so a change can void it. */
  let gitSyncHealthTarget = '';
  /**
   * Whether the open dialog is looking at the folder the verdict describes.
   * The icon always means "the Lith I have open", so a dialog opened on some
   * other recent row must not wear that folder's health as if it were its own.
   */
  let gitSyncHealthApplies = false;
  /** Reconnect reuses the device flow but lands on the existing remote. */
  let gitReconnectMode = false;

  /** What `git_sync_setup` returns: the modal line plus the folder's wikis. */
  interface GitSyncSetupResult { summary: string; recents: string[] }

  /**
   * What `git_sync_status` returns. `in_flight` is optional so a launcher built
   * ahead of the desktop app still reads the answer instead of throwing.
   */
  interface GitSyncStatus { connected: boolean; repo: string; in_flight?: boolean }

  /**
   * What `git_sync_heartbeat` returns, in either backend's shape. `last_commit_error` is the
   * last save that failed to reach GitHub, which is the only way a push that died inside the
   * engine document is ever visible.
   */
  interface GitSyncHealth {
    state: HealthState;
    repo: string;
    detail: string;
    last_commit_error?: string | null;
  }

  // Connect is a few long blocking git calls inside Rust (fetch, rescue writes,
  // commit, push). The stage it reports plus a live seconds counter is what
  // keeps a slow first sync from looking like a hung app.
  let gitSyncStage = '';
  let gitSyncElapsed = 0;
  let gitSyncProgressTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The user asked the running connect to stop. Rust's command answers at once
   * and the work ends at its next checkpoint, so this is a request, not a fact.
   * the modal keeps its progress line until `git_sync_setup` itself returns.
   */
  let gitSyncCancelling = false;

  function startGitSyncProgress(): void {
    stopGitSyncProgressTimer();
    gitSyncStage = copy.dialogs.gitSync.starting;
    gitSyncElapsed = 0;
    gitSyncProgressTimer = setInterval(() => { gitSyncElapsed += 1; }, 1000);
  }

  function stopGitSyncProgressTimer(): void {
    if (gitSyncProgressTimer) clearInterval(gitSyncProgressTimer);
    gitSyncProgressTimer = null;
  }

  function endGitSyncProgress(): void {
    stopGitSyncProgressTimer();
    gitSyncStage = '';
    gitSyncElapsed = 0;
    gitSyncCancelling = false;
  }

  /**
   * A first connect hands back the folder's wikis (plus whatever was rescued
   * from GitHub). They are already on disk by then, so they belong in recents
   * the moment the connection lands. The point of connecting a folder is to
   * have its wikis in front of you, not to go hunting for them through Mount.
   * Rust returns them newest-first and `remember` unshifts, so walk backwards.
   *
   * Being on screen is not the same as being known here: nothing has read a file
   * whose row only just appeared, so the folder's Liths are indexed for this device
   * behind the dialog that asked for them.
   */
  async function adoptSyncedWikis(paths: string[] | undefined): Promise<void> {
    if (!paths || paths.length === 0) return;
    for (const path of [...paths].reverse()) {
      await remember({ name: path.split(/[\\/]/).pop() || path, path });
    }
    // Built from the paths Rust handed back rather than from the recent list, which
    // caps itself at twenty rows and would quietly index the first of a big folder.
    void indexRestoredLiths(paths.map((path) => ({ name: path.split(/[\\/]/).pop() || path, path })));
  }

  function openGitSyncModal() {
    gitSyncMessage = '';
    gitSyncError = '';
    if (gitSyncView === 'connecting') {
      // The poll loop was aborted when the dialog last closed; start fresh
      // rather than showing a dead "waiting for authorization" screen.
      gitPollAborted = true;
      gitAuthActive = false;
      setGitSyncView('disconnected');
      gitUserCode = '';
      gitCodeCopy = '';
    }
    showGitSyncModal = true;
    gitSyncHealthApplies = healthAppliesToActive();
    void refreshGitSyncStatus(true);
    // The history is read again on every open, for the reason the status is: a save made inside
    // the wiki since the last look is a commit, so the rows in hand describe a repository that
    // has moved. The read is local (a revwalk, or the server's own `git log`), so this costs
    // nothing a person waits for.
    void loadTrail(true);
    // Opening the dialog is the user asking "is this working?". Worth a check
    // even inside the throttle floor.
    void runGitSyncHeartbeat(true);
  }

  function closeGitSyncModal() {
    showGitSyncModal = false;
    gitSyncHealthApplies = false;
    gitPollAborted = true;
    gitReconnectMode = false;
  }

  function resetGitSyncFlow() {
    gitPollAborted = true;
    gitAuthActive = false;
    gitSyncCancelling = false;
    gitReconnectMode = false;
    gitDeviceToken = null;
    gitUserCode = '';
    gitCodeCopy = '';
    setGitSyncView('disconnected');
    gitSyncError = '';
    gitSyncMessage = '';
    gitSyncBusy = false;
    endGitSyncProgress();
    void refreshGitSyncStatus(true);
  }

  /** Wiki path -> the backed-up folder covering it; absent when none does. */
  let backupRoots: Record<string, string> = {};
  let rebuildBusy = false;
  let localOnlyPaths: Set<string> = new Set();

  /**
   * The folder the sync targets: the open file, else the newest recent row that
   * records a disk path. `recentDiskPath` is what makes the second case work at
   * all. A Lith saved from inside the wiki records its path as `tauriPath`, so
   * a row-shape check for `path` alone concluded nothing was open and greyed the
   * sync icon out right after a save.
   */
  function gitSyncTargetPath(): string | null {
    return filePath ?? newestRecentPath(recentFiles);
  }

  /** The newest recent row that records a disk path, or nothing when none does. */
  function newestRecentPath(items: readonly any[]): string | null {
    for (const item of items) {
      const path = recentDiskPath(item);
      if (path) return path;
    }
    return null;
  }

  /**
   * The path the modal and its commands act on: the folder Rust prefers, else the
   * one derived from the open Lith or the newest recent row.
   *
   * There is no per-row override any more: a row outside a backed-up folder is
   * offered a copy into the covered folder rather than a second repository of its
   * own, so the modal always means the Lith you have open or the newest one you
   * opened, or, when a folder Lithic already backs up outranks both, that folder.
   */
  function gitSyncActivePath(): string | null {
    return gitSyncPreferredFolder ?? gitSyncTargetPath();
  }

  /**
   * The folder Rust prefers: one a previous attachment already left a repository
   * in, which outranks the folder the derived path implies.
   *
   * Only Rust can answer it. The question is a `.git` sitting in a folder on disk,
   * and only the launcher knows what to fall back on, so the two halves meet
   * here.
   */
  let gitSyncPreferredFolder: string | null = null;
  /**
   * Whether that folder is the one the user picked, rather than one Lithic worked out
   * from the open Lith and the library folders. Only an override can be put back, so
   * this is what decides whether the dialog offers to.
   */
  let gitSyncFolderOverridden = false;
  /** A picker is open, or its answer is on the way. */
  let gitSyncPicking = false;
  /** A folder pick that failed, said under the line it happened to. */
  let gitSyncFolderError = '';
  /** The derived path the resolution already ran for; undefined before any. */
  let gitSyncResolvedFor: string | null | undefined = undefined;
  let gitSyncResolveToken = 0;

  /**
   * The derived subject, written where Svelte can see what it depends on: a
   * reactive statement tracks the variables it *names*, and `filePath`/
   * `recentFiles` are read inside a helper that names neither, so through
   * `gitSyncTargetPath()` this would never re-run when the open Lith changed.
   */
  $: gitSyncSubject = filePath ?? newestRecentPath(recentFiles);
  $: if (gitSyncSubject !== gitSyncResolvedFor) void resolveSyncFolder(gitSyncSubject);

  async function resolveSyncFolder(derived: string | null): Promise<void> {
    const token = ++gitSyncResolveToken;
    gitSyncResolvedFor = derived;
    if (!hasLocalSync) {
      gitSyncPreferredFolder = null;
      return;
    }
    let answer: { folder: string | null; overridden: boolean } | null = null;
    try {
      answer = await readGitFolder(derived);
    } catch {
      answer = null;
    }
    // A newer subject is already being resolved, and its answer is the one to
    // keep: this one describes a file nobody is looking at any more.
    if (token !== gitSyncResolveToken) return;
    gitSyncPreferredFolder = answer?.folder ?? null;
    gitSyncFolderOverridden = answer?.overridden ?? false;
    // The icon, the heartbeat and the dialog all read the resolved folder, so the
    // answers that depend on it are only now knowable.
    refreshGitSyncIcon();
  }

  /**
   * The folder the modal's actions act on, named in the dialog itself.
   *
   * The target is *derived* (the open Lith, else the newest recent row) and a
   * recent row can live anywhere, so the folder is not something the user chose at
   * the moment they connect. Saying which one it is, before they press anything, is
   * the difference between "back up these notes" and involuntarily committing a
   * Downloads folder. Both halves are named directly here, because Svelte only
   * tracks the variables a reactive statement reads.
   */
  $: gitSyncFolder = (gitSyncPreferredFolder ?? folderOf(gitSyncSubject ?? '')).replace(/[\\/]+$/, '');

  /**
   * Nothing to act on at all: no folder was worked out and none is picked.
   *
   * A variable rather than `!gitSyncActivePath()` asked in the markup, because Svelte only
   * re-runs a block when a variable it *names* changes and a function call names none. The
   * line the block draws is the one that says to save a Lith first, and it has to go when a
   * pick from the empty line gives the dialog something to act on. Which is the one route
   * out of this state that exists.
   */
  $: gitSyncNoTarget = hasLocalSync && !(gitSyncPreferredFolder ?? gitSyncSubject);

  /**
   * Whether the folder line is the control or the answer.
   *
   * The folder is decided while the backup is being set up, so the picker is drawn on the
   * screens that end at the commit (the Connect screen, the device-code step it rides on
   * while GitHub is waited on, and the repository choice after it) and the connected
   * dialog names the folder instead. Variables rather than conditions asked in the markup,
   * for the usual reason: Svelte only re-runs a block when a variable it *names* changes.
   */
  $: gitSyncFolderEditable = hasLocalSync && gitSyncView !== 'connected';
  /** The other half of that line: connected, so the folder is named rather than offered. */
  $: gitSyncFolderLive = hasLocalSync && gitSyncView === 'connected';

  /**
   * Ask the OS for the folder to back up, instead of the one Lithic worked out.
   *
   * The line in the dialog named a folder nobody chose: it came from the open Lith, else
   * the newest recent row, else a folder Lithic already had a repository in. That is right
   * until it is not, and until now moving a backup meant disconnecting first.
   *
   * Rust keeps the choice in the recents sidecar beside the exe, spelled relative to the
   * bundle when it lives under it, so a thumb drive keeps backing up its own folder on a
   * machine that gives the drive another letter. A shim has no sidecar, so its half keeps the
   * same one line in its own data directory ('git-folder' in `shim/src/syncfolder.rs`).
   */
  async function chooseSyncFolder(): Promise<void> {
    if (gitSyncPicking || gitSyncBusy) return;
    gitSyncPicking = true;
    gitSyncFolderError = '';
    try {
      const picked = await pickSyncFolder();
      if (picked) {
        // Re-read rather than trust the path we were handed: Rust is the one that spells
        // the folder portably, and the read is also what moves the override flag.
        await resolveSyncFolder(gitSyncSubject);
        // Another folder is another question, so the verdict and the repository the dialog
        // is showing belong to a folder that is no longer the one in force.
        await refreshGitSyncStatus(true);
      }
    } catch (error) {
      gitSyncFolderError = error instanceof Error ? error.message : String(error);
    } finally {
      gitSyncPicking = false;
    }
  }

  /**
   * Ask the OS for the folder to back up, in whichever backend keeps the choice.
   *
   * `null` is a cancelled pick and is not an error; a `no-picker` code from a shim is, because
   * that machine has no chooser to show and the line under the folder is where that is said.
   */
  async function pickSyncFolder(): Promise<string | null> {
    if (mode === 'tauri') {
      return tauriInvoke<string | null>('pick_sync_folder', { current: gitSyncFolder || null });
    }
    const answer = await shimPickFolder(gitSyncFolder || null, { token: shimToken });
    if (!answer.ok) throw new Error(answer.detail ?? answer.error);
    return answer.value.folder;
  }

  /** Put the folder Lithic works out back, dropping the recorded choice. */
  async function clearSyncFolderOverride(): Promise<void> {
    if (gitSyncBusy) return;
    gitSyncFolderError = '';
    try {
      if (mode === 'tauri') {
        await tauriInvoke('clear_sync_folder_override');
      } else {
        const answer = await shimClearFolderPick({ token: shimToken });
        if (!answer.ok) throw new Error(answer.detail ?? answer.error);
      }
      await resolveSyncFolder(gitSyncSubject);
      await refreshGitSyncStatus(true);
    } catch (error) {
      gitSyncFolderError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Ask the running connect to stop. The outcome arrives as `git_sync_setup`
   * failing, so there is nothing to report here. An unreachable backend means
   * the run it would have stopped has already ended.
   */
  async function cancelGitSync(): Promise<void> {
    if (gitSyncCancelling) return;
    gitSyncCancelling = true;
    try {
      if (mode === 'tauri') {
        await tauriInvoke('git_sync_cancel');
      } else if (gitSyncJobId !== null) {
        // A shim stops one job rather than "the current one", because its commands are
        // stateless and several could in principle be running. Nothing to name means the run
        // this would have stopped has already ended.
        const answer = await shimGitCancel(gitSyncJobId, { token: shimToken });
        if (!answer.ok) gitSyncCancelling = false;
      }
    } catch {
      gitSyncCancelling = false;
    }
  }

  /** Recent rows reduced to the name/path pair coverage is computed from. */
  function recentRows(): CoverageRow[] {
    return recentFiles.map((item) => ({ name: getEntryName(item), path: recentDiskPath(item as any) }));
  }

  /**
   * Which of the recent Liths sit inside a backed-up folder. One Rust call for
   * the whole list: the backend walks each file's ancestors itself, so a wiki
   * nested in a synced folder is covered by that folder's repository rather
   * than reported as un-backup-up because only the root holds the `.git`.
   */
  async function refreshBackupCoverage(): Promise<void> {
    if (!hasLocalSync) return;
    const paths = recentRows().map((row) => row.path).filter((path): path is string => Boolean(path));
    if (paths.length === 0) {
      backupRoots = {};
      return;
    }
    try {
      // `?? {}` because a command can answer nothing at all, which is not a rejection and
      // therefore not the catch below: every reader of this map indexes it by a row's path, so
      // a null here used to take the whole list down over one unanswerable question.
      backupRoots = (await readGitCoverage(paths)) ?? {};
    } catch {
      backupRoots = {};
    }
  }

  /**
   * The synced repository's folder, when the backend says a managed one is there.
   *
   * A rebuild recrawls the folders its own rows point into, which covers every folder a row is
   * backed up in and is enough while the list still holds a row from the repository. It is
   * exactly what a list that has lost those rows cannot do: with no path left pointing into the
   * synced folder, the crawl has nowhere to go, and the one control that could regrow the list
   * from the repository it is backed up in would rebuild it out of nothing.
   *
   * So the folder the dialog already resolves is asked about as its own question, and the
   * backend's answer is what makes it a folder to crawl. Asked rather than trusted, because the
   * folder is resolved by inference as often as by a pick: it is the proposal on a machine whose
   * launcher names nothing, and a proposal is not a promise that a repository was ever connected
   * there. Only a `connected` answer, which is the backend recognising the marker Lithic itself
   * wrote, turns it into a subject.
   */
  async function connectedSyncFolder(): Promise<string | null> {
    if (!hasLocalSync) return null;
    const folder = gitSyncPreferredFolder;
    if (!folder) return null;
    try {
      const status = await readGitStatus(folder);
      return status && status.connected ? folder : null;
    } catch {
      // A backend that cannot answer is not a folder to crawl. Nothing is discovered, and the
      // rebuild keeps the list it has rather than replacing it with the failure.
      return null;
    }
  }

  /**
   * Which of these paths sit in a backed-up folder, through whichever process can answer.
   *
   * The desktop app asks its Rust bridge; a shim asks its own wire, which answers the same
   * shape from the marker in `.git/config`. One function because three callers want it (the
   * boot read, the index pass and the rebuild) and a mode branch at each of them is a branch
   * that drifts.
   */
  async function readGitCoverage(paths: string[]): Promise<Record<string, string>> {
    if (mode === 'tauri') return tauriInvoke<Record<string, string>>('git_sync_coverage', { paths });
    const answer = await shimGitCoverage(paths, { token: shimToken });
    if (!answer.ok) throw new Error(answer.error);
    return answer.value;
  }

  /**
   * The rest of the sync surface, through whichever process can answer it.
   *
   * Every read and write below is written once and branches on `mode` inside, rather than
   * leaving a `mode === 'tauri'` ternary at each of the dozen call sites that want it: an
   * answer's *shape* has to agree between the two backends (the launcher's decoding is shared),
   * and a branch per call site is a branch that drifts. The shim's half is `shim-sync.ts`, and
   * the one place its answers differ is the job model, which `runShimSyncJob` folds back into
   * the shape the desktop app's blocking commands return.
   */
  async function readGitFolder(derived: string | null): Promise<{ folder: string | null; overridden: boolean }> {
    if (mode === 'tauri') {
      return (
        (await tauriInvoke<{ folder: string | null; overridden: boolean } | null>('git_sync_folder', { derived })) ?? {
          folder: null,
          overridden: false
        }
      );
    }
    const answer = await shimGitFolder(derived, { token: shimToken });
    if (!answer.ok) throw new Error(answer.detail ?? answer.error);
    return answer.value;
  }

  /** Whether the folder behind a path is a repository Lithic backs up. */
  async function readGitStatus(path: string): Promise<GitSyncStatus | null> {
    if (mode === 'tauri') return tauriInvoke<GitSyncStatus | null>('git_sync_status', { path });
    const answer = await shimGitStatus(path, { token: shimToken });
    if (!answer.ok) throw new Error(answer.error);
    return answer.value;
  }

  /** Whether that backup still works: a revoked token, a deleted repo, a read-only one. */
  async function readGitHeartbeat(path: string): Promise<GitSyncHealth | null> {
    if (mode === 'tauri') return tauriInvoke<GitSyncHealth | null>('git_sync_heartbeat', { path });
    const answer = await shimGitHeartbeat(path, { token: shimToken });
    if (!answer.ok) throw new Error(answer.error);
    return answer.value;
  }

  /**
   * Run a shim sync job to its end and hand back the desktop app's own answer shape.
   *
   * A shim answers a long connect with a job id rather than with the work done, because a first
   * fetch, rescue, commit and push can outlive the wire's write timeout. This is where that id
   * becomes the answer the flow already expects, reporting each stage into the dialog's progress
   * line as it moves. The id is kept in `gitSyncJobId` for the whole run so the modal's Stop can
   * reach it. A job a person stopped is not a fault: it answers with the one line that says so.
   */
  async function runShimSyncJob<T>(handle: { job: number }): Promise<T> {
    gitSyncJobId = handle.job;
    try {
      const job = await awaitShimJob<T>(handle.job, {
        call: { token: shimToken },
        onStage: (stage) => {
          gitSyncStage = stage;
        }
      });
      if (!job.ok) throw new Error(job.error === 'cancelled' ? copy.dialogs.gitSync.cancelled : job.error);
      return job.value;
    } finally {
      gitSyncJobId = null;
    }
  }

  /** A shim sync job's id while it runs, so the modal's Stop has something to cancel. */
  let gitSyncJobId: number | null = null;

  /**
   * The four GitHub calls the device flow makes, through whichever side can reach GitHub.
   *
   * The shim makes all four rather than leaving the two REST ones to the page: doing them there
   * means one token path and one place the credential is handled, which is worth more than the
   * two cross-origin reads it saves. `detail` is what a refusal from GitHub says about itself,
   * so it is what is raised when there is one.
   */
  async function githubDeviceCode(): Promise<unknown> {
    if (mode === 'tauri') return tauriInvoke<unknown>('github_device_code');
    const answer = await shimDeviceCode({ token: shimToken });
    if (!answer.ok) throw new Error(answer.detail ?? answer.error);
    return answer.value;
  }

  async function githubDevicePoll(deviceCode: string): Promise<unknown> {
    if (mode === 'tauri') return tauriInvoke<unknown>('github_device_poll', { deviceCode });
    const answer = await shimDevicePoll(deviceCode, { token: shimToken });
    if (!answer.ok) throw new Error(answer.detail ?? answer.error);
    return answer.value;
  }

  async function githubListRepos(token: string): Promise<Array<{ full_name: string }>> {
    if (mode === 'tauri') return tauriInvoke<Array<{ full_name: string }>>('github_list_repos', { token });
    const answer = await shimListRepos(token, { token: shimToken });
    if (!answer.ok) throw new Error(answer.detail ?? answer.error);
    return answer.value;
  }

  async function githubCreateRepo(token: string, name: string): Promise<{ full_name: string }> {
    if (mode === 'tauri') return tauriInvoke<{ full_name: string }>('github_create_repo', { token, name });
    const answer = await shimCreateRepo(token, name, { token: shimToken });
    if (!answer.ok) throw new Error(answer.detail ?? answer.error);
    return answer.value;
  }

  /** A first connect: clone or adopt the folder, commit it, push, and answer the folder's wikis. */
  async function gitSetup(path: string, repo: string, token: string): Promise<GitSyncSetupResult> {
    if (mode === 'tauri') return tauriInvoke<GitSyncSetupResult>('git_sync_setup', { path, repo, token });
    const started = await shimGitSetup(path, repo, token, { token: shimToken });
    if (!started.ok) throw new Error(started.detail ?? started.error);
    return runShimSyncJob<GitSyncSetupResult>(started.value);
  }

  /** Land a fresh token on the remote the folder already has. */
  async function gitReauth(path: string, repo: string, token: string): Promise<void> {
    if (mode === 'tauri') {
      await tauriInvoke('git_sync_reauth', { path, repo, token });
      return;
    }
    const answer = await shimGitReauth(path, repo, token, { token: shimToken });
    if (!answer.ok) throw new Error(answer.detail ?? answer.error);
  }

  /** Drop the managed origin, so saves in that folder stop being pushed. */
  async function gitDisconnect(path: string): Promise<void> {
    if (mode === 'tauri') {
      await tauriInvoke('git_sync_disconnect', { path });
      return;
    }
    const answer = await shimGitDisconnect(path, { token: shimToken });
    if (!answer.ok) throw new Error(answer.detail ?? answer.error);
  }

  // --- the instance's history trail -----------------------------------------
  //
  // The last few commits whatever backs this instance up has made, and the one way back to an
  // earlier one. Everything with a GitHub backup has a history, and a self-host instance kept in
  // local git with no backup has one too, because the commits are on its own disk either way.
  //
  // What the trail adds is a way back that rewrites nothing: the backend commits the old tree on
  // top of where the branch is, so the trail grows by one row and the move is itself undone by
  // reverting to the commit it replaced.

  /** What the trail in hand is: a read in flight, rows, or one of the two ways of having none. */
  type TrailView = 'idle' | 'loading' | 'ready' | 'no-repo' | 'failed';

  /**
   * One shape for the three backends' answers, so the state machine below is written once.
   *
   * The server's own read answers this already (`ServerTrail`); the two local backends are
   * folded into it here. `no-repo` means a repository to have a trail in, and the dialog draws
   * nothing at all for it. `[]` is a repository with no commits yet, which it says out loud.
   */
  type TrailAnswer =
    | { state: 'trail'; commits: TrailCommit[] }
    | { state: 'no-repo' }
    | { state: 'failed'; message: string };

  /**
   * What a revert answers, in the desktop app's own field names, whichever prong ran it.
   * `error` is the push's: the instance is back either way, and a backup that did not upload is
   * a second fact rather than a failed revert.
   */
  interface GitSyncRevert {
    short: string;
    target: string;
    changes: number;
    saved_first: boolean;
    error?: string | null;
  }

  let trailView: TrailView = 'idle';
  let trailCommits: TrailCommit[] = [];
  let trailNote = '';
  /** Which repository the rows in hand came from, so a reopen does not re-read it. */
  let trailSource = '';

  /**
   * A row's pill: what the commit was, in one of three words.
   *
   * The tones are the version trail's own badge tones, so the two lists are not learnt twice:
   * green for a save Lithic made on its own, the accent blue for a deliberate go-back, and the
   * quiet grey for a commit nothing here recognises. Each title carries the explanation and then
   * the commit's own message, which is the fact a pill cannot state and the row no longer prints.
   */
  function trailBadge(kind: TrailPill, message: string) {
    const trail = copy.dialogs.gitSync.trail;
    const raw = message.trim();
    if (kind === 'auto') return { label: trail.pillAuto, tone: 'sync', title: trail.pillAutoTitle(raw).trim() };
    if (kind === 'revert') return { label: trail.pillRevert, tone: '', title: trail.pillRevertTitle(raw).trim() };
    return { label: trail.pillOther, tone: 'delta', title: trail.pillOtherTitle(raw).trim() };
  }

  /**
   * The rows the list draws: each commit stamped, its distance from the row above, and the pill
   * its own message earns it.
   */
  $: trailRows = trailRowList(trailCommits).map((row) => ({ ...row, badge: trailBadge(row.pill, row.summary) }));

  /**
   * Whether there is a screen to draw a trail on.
   *
   * A connected backup always has one, on every prong. A self-host instance has one before it is
   * connected too, because its history is a local read there: an instance kept in git with no
   * GitHub account is exactly the case the trail exists for, and hiding it until a backup exists
   * would hide it where it is the only way back.
   */
  $: trailOffered = gitSyncView === 'connected' || (isSelfHost() && gitSyncView === 'disconnected');

  /** Read the history once per repository, as soon as there is a screen to draw it on. */
  $: if (showGitSyncModal && trailOffered) void loadTrail();

  /**
   * The instance's own history, from whichever backend is behind this launcher.
   *
   * A self-host instance is read over its own CGI, because the commits are on the server; the
   * desktop app's command and the shim's both open the folder's object store on this device, so
   * they differ only in how the call travels.
   */
  async function readTrail(): Promise<TrailAnswer> {
    if (isSelfHost()) return fetchServerSyncHistory(TRAIL_LIMIT);
    const path = gitSyncFolder ?? '';
    if (mode === 'tauri') {
      try {
        // Parsed rather than trusted: this is another process's JSON, and a shape this launcher
        // does not recognise is a backend that did not answer the question rather than a crash
        // in the dialog that asked it.
        const commits = parseTrailCommits(
          await tauriInvoke<unknown>('git_sync_history', { path, limit: TRAIL_LIMIT })
        );
        return commits
          ? { state: 'trail', commits }
          : { state: 'failed', message: copy.dialogs.gitSync.trail.unreadable };
      } catch (error) {
        return { state: 'failed', message: copy.dialogs.gitSync.trail.failed(trailFailure(error)) };
      }
    }
    const answer = await shimGitHistory(path, TRAIL_LIMIT, { token: shimToken });
    return answer.ok
      ? { state: 'trail', commits: answer.value }
      : { state: 'failed', message: copy.dialogs.gitSync.trail.failed(answer.detail ?? answer.error) };
  }

  /**
   * Read the history into the dialog, dropping an answer nobody is waiting for any more.
   *
   * A read in flight when the dialog closes, or when the folder behind it changes, describes a
   * repository the person is no longer looking at, so its answer is discarded rather than drawn.
   */
  async function loadTrail(force = false): Promise<void> {
    const source = isSelfHost() ? 'server' : `folder:${gitSyncFolder ?? ''}`;
    if (!force && source === trailSource && trailView !== 'idle') return;
    trailSource = source;
    trailView = 'loading';
    trailNote = '';
    const answer = await readTrail();
    if (trailSource !== source) return;
    if (answer.state === 'failed') {
      trailCommits = [];
      trailView = 'failed';
      trailNote = answer.message;
      return;
    }
    trailCommits = answer.state === 'trail' ? answer.commits : [];
    trailView = answer.state === 'no-repo' ? 'no-repo' : 'ready';
  }

  /** A caught failure as the one line the dialog shows. */
  function trailFailure(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  /**
   * Ask before writing the whole instance, then do it.
   *
   * The confirmation is not red, and that is a reading of the rule the other callers follow:
   * a revert appends a commit rather than rewriting one, unsaved work is committed first, and
   * the way back is the row it moved away from. Nothing here is unrecoverable, so nothing here
   * is drawn as the button that cannot be taken back.
   */
  async function askTrailRevert(row: TrailRow): Promise<void> {
    if (gitSyncBusy) return;
    const confirmed = await askConfirmation({
      title: copy.dialogs.gitSync.trail.confirmTitle(row.short),
      body: copy.dialogs.gitSync.trail.confirmBody(row.stamp),
      confirmLabel: copy.dialogs.gitSync.trail.confirm
    });
    if (confirmed) await revertTrail(row);
  }

  /** Put this device's folder back, through the app or the shim. */
  async function revertLocalTrail(commit: string): Promise<GitSyncRevert> {
    const path = gitSyncFolder ?? '';
    if (mode === 'tauri') return tauriInvoke<GitSyncRevert>('git_sync_revert', { path, commit });
    const started = await shimGitRevert(path, commit, { token: shimToken });
    if (!started.ok) throw new Error(started.detail ?? started.error);
    return runShimSyncJob<GitSyncRevert>(started.value);
  }

  /** The server's own revert, in the shape the dialog reads. */
  async function revertServerTrail(commit: string): Promise<GitSyncRevert> {
    const answer = await revertServerSync(commit);
    if ('ok' in answer) throw new Error(answer.message);
    return {
      short: answer.short,
      target: answer.target,
      changes: answer.changes,
      saved_first: answer.savedFirst,
      error: answer.error
    };
  }

  /**
   * Put the instance back as it was at one of its own commits.
   *
   * Nothing is rewound: the backend commits the old tree on top of where the branch is, so the
   * commits this goes back over stay in the history and the move is undone by reverting to the
   * commit it replaced. The instance's own uncommitted work is committed first, which is what
   * keeps a revert from discarding a change git was never given. A push that did not land is
   * said beside the revert, because the instance is back either way and a backup that did not
   * upload has to be visible rather than implied.
   */
  async function revertTrail(commit: TrailCommit): Promise<void> {
    if (gitSyncBusy) return;
    gitSyncBusy = true;
    gitSyncError = '';
    gitSyncMessage = '';
    startGitSyncProgress();
    gitSyncStage = copy.dialogs.gitSync.trail.working;
    try {
      const answer = isSelfHost()
        ? await revertServerTrail(commit.hash)
        : await revertLocalTrail(commit.hash);
      gitSyncMessage = copy.dialogs.gitSync.trail.reverted(answer.short || commit.short);
      if (answer.saved_first) gitSyncMessage += ` ${copy.dialogs.gitSync.trail.savedFirst}`;
      if (answer.error) gitSyncError = copy.dialogs.gitSync.trail.notUploaded(answer.error);
      // The trail it just drew is a row out of date, and the heading's own mark describes a
      // backup that has moved: both are re-read rather than assumed.
      await loadTrail(true);
      void refreshGitSyncStatus(false);
      void runGitSyncHeartbeat(true);
    } catch (error) {
      gitSyncError = copy.dialogs.gitSync.trail.failed(trailFailure(error));
    } finally {
      gitSyncBusy = false;
      endGitSyncProgress();
    }
  }

  $: backupCoverage = computeBackupCoverage(recentRows(), backupRoots);
  $: localOnlyPaths = new Set(backupCoverage.localOnlyPaths);
  // Coverage only means something once something is backed up: with nothing,
  // every row is un-backed-up and the marks would say nothing about any of them.
  $: showBackupStatus = hasLocalSync && hasBackedUpRepo(backupRoots);
  // Where the list is derived rather than authored (the desktop app's synced folders,
  // and self-host's server) rebuilding beats clearing. The desktop app only learns its
  // own list is a view rather than a catalogue once a folder is backed up; on an instance
  // there was never any doubt, the server is the only list there is.
  //
  // A connected repository counts as derivation on its own, ahead of any coverage answer, and
  // that is the difference between a recoverable state and the one this was. Coverage is
  // computed from the paths the rows carry, so a list that has lost them reports nothing
  // covered, however connected the folder behind it is: measured as a launcher whose every
  // synced Lith had been replaced by one saved row, reading `Reset Recents` with no way back,
  // because clearing was the only control left and it does exactly what it says. The folder
  // the dialog names is evidence of its own (`connectedSyncFolder`), and while it answers, the
  // rebuild is the honest operation and stays.
  $: showRebuildControl = showBackupStatus || Boolean(gitSyncConnectedRepo) || isSelfHost();
  // Whether the recent panel is on screen at all. Named because two places now ask: the
  // panel itself, and the install offer, which waits in a launcher with no panel to hold
  // it rather than in one that does (see the offer's two homes in the markup).
  $: recentPanelShown =
    (showBookmarks && bookmarks.length > 0) ||
    recentFiles.length > 0 ||
    remoteFiles.length > 0 ||
    isSelfHost() ||
    Object.keys(cachedEntries).length > 0 ||
    showRecent;

  /**
   * Offer to copy a Lith that no backup covers into the folder that is covered.
   *
   * The offer is the whole point: the file stays where it is, nothing is moved
   * or deleted, and the answer to "this one is not backed up" is a single copy
   * into the folder that already is. Setting up a repository for its own folder
   * instead would make every stray download a backup of its own.
   */
  async function offerCopyToSyncedDir(name: string, path: string): Promise<void> {
    const folder = syncedDirFor(recentRows(), backupRoots);
    if (!folder) return;
    const agreed = await askConfirmation({
      title: copy.install.copyToSyncedDir,
      body: copy.install.copyToSyncedDirBody(name, folder),
      confirmLabel: copy.install.copyConfirm,
    });
    if (!agreed) return;
    try {
      const copied = await tauriInvoke<{ name: string; path: string }>('copy_lith_to_synced_dir', { path, folder });
      // The row follows the file. Same name, so the copy keeps the cached history
      // and dirty-state keys it already had, and `remember` drops the old row.
      await remember({ name: copied.name, path: copied.path });
      // A copy is not a save, so nothing would commit it until the next edit.
      // Best effort: a failure here is reported by the sync icon like any other
      // backup that did not land, and the file is still backed up by its next save.
      await tauriInvoke('git_sync_commit', { path: copied.path, message: `Add ${copied.name} from Lithic` }).catch(() => {});
      status = copy.install.copied(copied.name, folder);
    } catch (error) {
      mountError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Fold one `git_sync_status` answer into the icon's state, so the modal's read
   * and the background poll cannot drift apart.
   *
   * `failed` is the distinction that matters: a read that did not answer is not
   * news about the folder, so it must not be folded in as "nothing is synced
   * here". It does end the amber "still checking" phase either way, because the
   * caller reports the failure itself.
   */
  function foldGitSyncStatus(status: GitSyncStatus | null, failed = false): void {
    const wasKnown = gitSyncMarkerKnown;
    const wasInFlight = gitSyncBackupInFlight;
    if (!failed) {
      gitSyncConnectedRepo = status && status.connected ? status.repo : '';
      gitSyncBackupInFlight = Boolean(status?.in_flight);
      gitSyncMarkerKnown = true;
      // Nothing synced here any more: a verdict about a repository that is no
      // longer wired up would only paint a warning over nothing.
      if (!status) forgetGitSyncHealth();
    } else {
      gitSyncMarkerKnown = true;
    }
    if (gitSyncBackupInFlight && !wasInFlight) watchGitSyncBackup();
    // Ask for a verdict the moment one is missing and the folder is there. On
    // the marker's first answer, and again when a backup that was running has
    // finished, since a landed push is exactly when green becomes true. Forced
    // because it is a transition, not a poll: the throttle would otherwise hold
    // the icon amber for up to a minute.
    const wanted = !failed && Boolean(gitSyncConnectedRepo) && gitSyncHealth === null;
    if (wanted && (!wasKnown || (wasInFlight && !gitSyncBackupInFlight))) {
      void runGitSyncHeartbeat(true);
    }
  }

  /**
   * Re-read the marker every 1.5s while a backup is running, so the purple
   * "syncing" state ends when the push does instead of at the next 10s poll.
   * Self-clearing: it exists for the few seconds a push takes, not as a second
   * poll loop.
   */
  function watchGitSyncBackup(): void {
    if (gitSyncBackupTimer) return;
    gitSyncBackupTimer = setInterval(() => {
      if (!gitSyncBackupInFlight) {
        if (gitSyncBackupTimer) clearInterval(gitSyncBackupTimer);
        gitSyncBackupTimer = null;
        return;
      }
      void refreshGitSyncStatus(false);
    }, 1500);
  }

  /** A `git_sync_status` call that did not answer at all. */
  function noteGitSyncStatusFailure(error: unknown): void {
    // Failing to read the state is not a failed backup, but it is not a green
    // light either. A plain-browser preview (no Tauri API at all) is exempt:
    // the icon is not real there anyway.
    if (error instanceof Error && error.message === 'Tauri API unavailable') return;
    gitSyncHealth = 'offline';
    gitSyncHealthDetail = '';
    gitSyncHealthAt = Date.now();
    gitSyncHealthApplies = healthAppliesToActive();
  }

  /**
   * No folder to ask about. Only an answer once the recents have loaded: before
   * that the fallback target simply is not known yet, and painting grey would
   * claim "nothing is synced here" about a list nobody has read. This is the
   * grey the icon used to show on every return from a wiki.
   */
  function noteNoGitSyncTarget(): void {
    if (gitSyncRecentsReady) foldGitSyncStatus(null);
  }

  /** Ask Rust whether the target folder is a Lithic-managed sync repo. */
  async function refreshGitSyncStatus(applyView: boolean): Promise<void> {
    if (isSelfHost()) return refreshServerSyncStatus(applyView);
    // The same ticket as the self-host read: a `git_sync_status` call is not ordered
    // against the disconnect that follows it, and the window here is the wider of the two.
    const ticket = ++syncReadTicket;
    const target = gitSyncActivePath();
    // A verdict describes one folder: re-pointing at another makes it
    // meaningless, and showing it would be worse than showing nothing. Keyed on
    // the icon's folder, because that is the one the verdict is always about.
    syncHealthTarget(gitSyncActivePath());
    gitSyncHealthApplies = healthAppliesToActive();
    if (!target) {
      noteNoGitSyncTarget();
      return;
    }
    try {
      const status = await readGitStatus(target);
      // An answer asked for before the last decision about this dialog describes a folder
      // that decision has left, and is discarded rather than folded in. The same rule the
      // instance's own read follows, and the reason for it is the same one (see
      // `setGitSyncView`).
      if (ticket < syncViewTicket) return;
      foldGitSyncStatus(status);
    } catch (error) {
      if (ticket < syncViewTicket) return;
      foldGitSyncStatus(null, true);
      noteGitSyncStatusFailure(error);
    }
    if (applyView && gitSyncView !== 'connecting' && gitSyncView !== 'selecting') {
      setGitSyncView(gitSyncConnectedRepo ? 'connected' : 'disconnected', ticket);
    }
  }

  let gitSyncConnectedRepo = '';

  /**
   * Copy the device code, because this step is a code that has to be typed into a window the
   * page cannot reach. Transcribing eight characters by hand is where a device flow is usually
   * lost, and the pill is already the thing on screen that means "this is the code".
   *
   * The answer is said out loud rather than assumed: a copy can be refused (the clipboard API
   * needs a secure context or a permission, and the legacy launcher is opened over `file://`),
   * and a button that silently does nothing is worse than one that says it could not.
   */
  async function copyUserCode(): Promise<void> {
    if (!gitUserCode) return;
    const copied = await copyText(formatUserCode(gitUserCode));
    gitCodeCopy = copied ? 'copied' : 'failed';
    clearTimeout(gitCodeCopyTimer);
    // Gone by the time GitHub is usually answered, which is the point of this step.
    gitCodeCopyTimer = setTimeout(() => (gitCodeCopy = ''), 4000);
  }

  /** Legacy flow, step 1: device code + user code display, then poll. */
  async function startDeviceAuth() {
    if (gitSyncBusy || gitAuthActive) return;
    gitSyncBusy = true;
    gitAuthActive = true;
    gitSyncError = '';
    setGitSyncView('connecting');
    gitPollAborted = false;
    try {
      const parsed = await requestDeviceCode();
      gitUserCode = parsed.user_code;
      gitCodeCopy = '';
      void pollDeviceToken(parsed.device_code, parsed.interval);
    } catch (error) {
      gitSyncError = error instanceof Error ? error.message : String(error);
      setGitSyncView('disconnected');
      gitAuthActive = false;
    } finally {
      gitSyncBusy = false;
    }
  }

  /** Legacy flow, step 2: poll until the user authorizes (RFC 8628 timing). */
  async function pollDeviceToken(deviceCode: string, interval: number | undefined) {
    let delay = pollDelayMs(interval, false);
    while (!gitPollAborted && gitAuthActive) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (gitPollAborted) return;
      try {
        const decision = isSelfHost()
          ? await pollServerDeviceToken(deviceCode)
          : parseDevicePoll(await githubDevicePoll(deviceCode));
        if (decision.kind === 'authorized') {
          gitAuthActive = false;
          gitDeviceToken = decision.token;
          // Reconnecting knows its repository already, so it skips discovery
          // entirely instead of asking the user to pick one again.
          if (gitReconnectMode) {
            await finishGitReconnect();
            return;
          }
          await loadRepoDiscovery();
          return;
        }
        if (decision.kind === 'pending') {
          delay = pollDelayMs(interval, Boolean(decision.slowDown));
          continue;
        }
        gitAuthActive = false;
        gitSyncError = decision.message;
        setGitSyncView('disconnected');
        return;
      } catch (error) {
        // Transient network hiccups shouldn't kill the flow; keep polling.
        gitSyncError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  /** Legacy flow, step 3: discover lithic-managed repos and offer creation. */
  async function loadRepoDiscovery() {
    gitSyncBusy = true;
    gitSyncError = '';
    try {
      const partitioned = isSelfHost()
        ? await listServerRepos(gitDeviceToken ?? '')
        : partitionRepos(await githubListRepos(gitDeviceToken ?? ''));
      if ('ok' in partitioned) throw new Error(partitioned.message);
      gitManagedRepos = partitioned.managed;
      gitOtherRepos = partitioned.other;
      gitRepoNamePending = generateRepoName();
      gitRepoChoice = gitManagedRepos[0] ?? '';
      gitCustomRepoInput = '';
      setGitSyncView('selecting');
    } catch (error) {
      gitSyncError = error instanceof Error ? error.message : String(error);
      setGitSyncView('disconnected');
      gitAuthActive = false;
    } finally {
      gitSyncBusy = false;
    }
  }

  function gitRepoSelection(): string {
    if (gitRepoChoice === '__create__') return gitRepoNamePending;
    if (gitRepoChoice === '__custom__') return gitCustomRepoInput.trim();
    return gitRepoChoice;
  }

  /** Legacy flow, step 4: (optionally create the repo and) set up the sync. */
  async function finalizeGitSync() {
    const target = gitSyncActivePath();
    const repo = gitRepoSelection();
    if (!repo || !gitDeviceToken || gitSyncBusy) return;
    if (isSelfHost()) return finishServerSync(repo, gitDeviceToken, gitRepoChoice === '__create__');
    if (!target) return;
    // Same rule as finishServerSync, for the same reason: the create's answer is
    // the name the remote needs, and the picked name is not it.
    let targetRepo = repo;
    gitSyncBusy = true;
    gitSyncError = '';
    gitSyncMessage = '';
    startGitSyncProgress();
    try {
      if (gitRepoChoice === '__create__') {
        const created = await githubCreateRepo(gitDeviceToken, repo);
        targetRepo = created.full_name;
        gitSyncMessage = copy.dialogs.gitSync.created(created.full_name);
      }
      const result = await gitSetup(target, targetRepo, gitDeviceToken);
      gitSyncMessage += result?.summary || copy.dialogs.gitSync.synced;
      gitDeviceToken = null;
      setGitSyncView('connected');
      markGitSyncActivity();
      void refreshGitSyncStatus(false);
      await adoptSyncedWikis(result?.recents);
    } catch (error) {
      gitSyncError = error instanceof Error ? error.message : String(error);
    } finally {
      gitSyncBusy = false;
      endGitSyncProgress();
    }
  }

  /** Advanced fallback: direct token entry (original MVP path). */
  async function connectGitSync() {
    const target = gitSyncActivePath();
    if (gitSyncBusy) return;
    // The same escape hatch, pointed at the instance: the server's setup route
    // takes a token as readily as the device flow's, so a blocked OAuth app or a
    // hands-off server is still reachable from the dialog.
    if (isSelfHost()) return finishServerSync(gitRepoInput.trim(), gitTokenInput, false);
    if (!target) return;
    gitSyncBusy = true;
    gitSyncError = '';
    gitSyncMessage = '';
    startGitSyncProgress();
    try {
      const result = await gitSetup(target, gitRepoInput, gitTokenInput);
      gitSyncMessage = result?.summary || copy.dialogs.gitSync.synced;
      gitTokenInput = '';
      setGitSyncView('connected');
      markGitSyncActivity();
      void refreshGitSyncStatus(false);
      await adoptSyncedWikis(result?.recents);
    } catch (error) {
      gitSyncError = error instanceof Error ? error.message : String(error);
    } finally {
      gitSyncBusy = false;
      endGitSyncProgress();
    }
  }

  async function disconnectGitSync() {
    const target = gitSyncActivePath();
    if (gitSyncBusy) return;
    if (isSelfHost()) {
      const agreed = await askConfirmation({
        title: copy.dialogs.gitSync.disconnectTitle,
        body: copy.dialogs.gitSync.disconnectConfirm.server,
        confirmLabel: copy.dialogs.gitSync.disconnectConfirm.label
      });
      if (!agreed) return;
      gitSyncBusy = true;
      try {
        if (!(await disconnectServerSync())) {
          gitSyncError = copy.dialogs.gitSync.instanceNoDisconnect;
          return;
        }
        gitSyncConnectedRepo = '';
        setGitSyncView('disconnected');
        await refreshServerSyncStatus(false);
      } finally {
        gitSyncBusy = false;
      }
      return;
    }
    if (!target) return;
    const confirmed = await askConfirmation({
      title: copy.dialogs.gitSync.disconnectTitle,
      body: copy.dialogs.gitSync.disconnectConfirm.desktop,
      confirmLabel: copy.dialogs.gitSync.disconnectConfirm.label
    });
    if (!confirmed) return;
    gitSyncBusy = true;
    try {
      await gitDisconnect(target);
      gitSyncConnectedRepo = '';
      setGitSyncView('disconnected');
      void refreshBackupCoverage();
      // That folder is no longer attached and the disconnect forgot the pick that named it,
      // so what Rust answers may have moved: re-read rather than keep naming a folder
      // nothing is recorded for any more.
      void resolveSyncFolder(gitSyncSubject);
    } catch (error) {
      gitSyncError = error instanceof Error ? error.message : String(error);
    } finally {
      gitSyncBusy = false;
    }
  }

  /**
   * Reconnect an already-synced folder: the same device flow, but the fresh
   * token lands on the remote the folder already has instead of re-running the
   * first-connect merge (which would re-fetch and re-merge a folder that is
   * already merged, to fix nothing but the credential).
   */
  async function reconnectGitSync() {
    if (gitSyncBusy || gitAuthActive) return;
    gitReconnectMode = true;
    gitSyncError = '';
    gitSyncMessage = '';
    await startDeviceAuth();
  }

  // --- GitHub backup of a self-hosted instance -------------------------------

  /**
   * Ask the instance about its repository.
   *
   * `applyView` is the difference between the button's poll and the dialog's: a
   * background refresh must not yank the dialog out of the flow the user is in
   * the middle of. Nothing here can fail in a way that needs handling. An
   * instance that never answers is a state the button renders ("did not answer")
   * and the dialog repeats, which is why there is no throw to catch: on a plain
   * WebDAV server this is the ordinary answer rather than a fault.
   */
  async function refreshServerSyncStatus(applyView: boolean): Promise<void> {
    const ticket = ++syncReadTicket;
    const status = await fetchServerSyncStatus();
    // An answer asked for before the last decision about this dialog is describing the
    // world that decision left, and every word of it is wrong now: `connected: true,
    // repo: X` is exactly what a disconnect has just said is no longer true. Discarded
    // rather than folded, because the decision's own read follows it and answers. This is
    // how a status read that was in flight when the repository was stopped is stopped
    // from putting the dialog back on it.
    if (ticket < syncViewTicket) return;
    serverSyncFailed = status === null;
    if (status) {
      serverSyncStatus = status;
      // The repo name is shared with the dialog's connected view, so both ends of
      // the same fact come from the server's answer rather than from what we
      // asked it to do.
      gitSyncConnectedRepo = status.connected ? status.repo : '';
    }
    // Every in-flight read is older than this decision, so none of them can undo it, but a
    // read issued *after* it passes the ticket check, and `connecting` and `selecting` are
    // steps no read may interrupt.
    if (applyView && gitSyncView !== 'connecting' && gitSyncView !== 'selecting') {
      setGitSyncView(status?.connected ? 'connected' : 'disconnected', ticket);
    }
    serverSyncTick += 1;
  }

  /**
   * Poll the instance's status every 15s while the page is a self-hosted
   * launcher. The legacy launcher's interval, kept for a reason that outlives
   * parity: the *server* keeps syncing on its own, watcher passes included, so a
   * status read only when the dialog opened would be describing the past. It is
   * one small JSON request, and it is the only thing that lets the button say
   * "syncing" for a sync nobody in this browser started.
   */
  function startServerSyncPolling(): void {
    if (serverSyncStatusTimer || !isSelfHost()) return;
    serverSyncStatusTimer = setInterval(() => {
      void refreshServerSyncStatus(false);
      // The other way back out of offline mode. A lost network announces itself, so the
      // `online` listener below catches that; an instance that was merely down does not,
      // and one List read is what says whether it is up again. Same interval, one request.
      if (remoteUnreachable && navigator.onLine) void refreshRemoteList();
    }, 15_000);
  }

  /**
   * Point the instance's data directory at a repository, then re-read its list.
   *
   * The list matters: connecting brings down any Lith the repository has and the
   * server did not, so the rows on screen are out of date the moment this lands.
   * `createFirst` is the flow's "+ Create …" choice, folded in here so the whole
   * setup (creating, pointing, pushing) is one busy state with one progress
   * line, rather than a progress line that starts after the slow part.
   */
  async function finishServerSync(repo: string, token: string, createFirst: boolean): Promise<void> {
    // The repository the instance is pointed at. A fresh repository answers with
    // its full `owner/name`, and the setup builds a remote URL out of whatever it
    // is given: a bare name has no owner, so there is nowhere to push. The
    // legacy launcher passed the create's `full_name` for the same reason.
    let targetRepo = repo;
    gitSyncBusy = true;
    gitSyncError = '';
    gitSyncMessage = '';
    startGitSyncProgress();
    try {
      if (createFirst) {
        gitSyncStage = copy.dialogs.gitSync.creatingRepo;
        const created = await createServerRepo(token, repo);
        if (typeof created !== 'string') {
          gitSyncError = created.message;
          return;
        }
        targetRepo = created;
        gitSyncMessage = copy.dialogs.gitSync.created(created);
      }
      gitSyncStage = copy.dialogs.gitSync.settingUp;
      const result = await setupServerSync(token, targetRepo);
      if (!result.ok) {
        gitSyncError = result.message;
        return;
      }
      gitDeviceToken = null;
      gitSyncMessage += copy.dialogs.gitSync.backingUp(targetRepo);
      setGitSyncView('connected');
      await refreshServerSyncStatus(false);
      await refreshRemoteList();
      // Same pass the rebuild runs on an instance, for the same reason it exists
      // there: the store's Liths are now this client's rows, and search here is a
      // local index. One this client has never built for Liths it has not opened.
      void indexRestoredLiths(remoteFiles.map((file) => ({ name: file.name, path: null })));
    } finally {
      gitSyncBusy = false;
      endGitSyncProgress();
    }
  }

  /**
   * The device code, from whichever side is doing the authorizing.
   *
   * Rust runs the desktop flow; on an instance the *server* asks GitHub, with its
   * own client id, because the token it receives is the one it will push with.
   * Both failures are raised the same way so the caller's catch renders one
   * message from one code path.
   */
  async function requestDeviceCode() {
    if (isSelfHost()) {
      const code = await requestServerDeviceCode();
      if ('ok' in code) throw new Error(code.message);
      return code;
    }
    const parsed = parseDeviceCode(await githubDeviceCode());
    if (!parsed) throw new Error(copy.dialogs.gitSync.noDeviceCode);
    return parsed;
  }

  /** The last step of a reconnect: land the token on the existing remote. */
  async function finishGitReconnect(): Promise<void> {
    const target = gitSyncActivePath();
    const repo = gitSyncConnectedRepo;
    const token = gitDeviceToken;
    gitReconnectMode = false;
    if (!target || !repo || !token) {
      gitSyncError = copy.dialogs.gitSync.noFolder;
      setGitSyncView('disconnected');
      return;
    }
    gitSyncBusy = true;
    gitSyncError = '';
    startGitSyncProgress();
    try {
      await gitReauth(target, repo, token);
      gitDeviceToken = null;
      gitSyncMessage = copy.dialogs.gitSync.reconnected(repo);
      setGitSyncView('connected');
      // Proven by construction: the token that just authenticated is the one
      // now sitting in the remote, so the next save has somewhere to go.
      markGitSyncVerified();
      void runGitSyncHeartbeat(true);
    } catch (error) {
      gitSyncError = error instanceof Error ? error.message : String(error);
      setGitSyncView('disconnected');
    } finally {
      gitSyncBusy = false;
      endGitSyncProgress();
    }
  }

  // --- Status-reactive icon (legacy #github-sync-btn parity) ---
  // grey = not synced, amber = verifying, green = verified, purple pulsing =
  // syncing, red = the backup is not landing. The precedence lives in
  // git-sync-health.ts, where it is testable instead of buried in markup.
  let gitSyncIconState: SyncIndicator = 'idle';
  let gitSyncIconTitle = copy.dialogs.gitSync.title;
  let gitSyncPollTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * The timer that asks the shim for a file a second launch handed it (see `openShimPending`).
   *
   * Only a shim page starts one, and it exists because the interesting case is the window this
   * page is already in being raised rather than reloaded, which no event on this page reports.
   */
  let shimPendingTimer: ReturnType<typeof setInterval> | null = null;
  let gitSyncSyncingUntil = 0;
  let gitSyncTick = 0;

  $: {
    void gitSyncTick;
    const indicator = syncIndicator({
      // null while the marker read is outstanding: the icon says "checking"
      // rather than "nothing is synced here" before it has asked.
      hasMarker: gitSyncMarkerKnown ? Boolean(gitSyncConnectedRepo) : null,
      health: gitSyncHealth,
      backupInFlight: gitSyncBackupInFlight,
      syncingUntil: gitSyncSyncingUntil,
      lastPushError: gitSyncLastPushError,
      repo: gitSyncConnectedRepo || null,
      verifiedAt: gitSyncHealthAt || null,
      now: Date.now()
    });
    gitSyncIconState = indicator.state;
    gitSyncIconTitle = indicator.title;
  }

  /**
   * The heading's cloud button, in whichever mode is showing it.
   *
   * One control with two sources, because they answer the same question about
   * different subjects: on the desktop it is this machine's folder, on an
   * instance it is that server's own repository. `serverSyncTick` is named so the
   * self-host reading is recomputed on each poll. The "syncing" window is
   * derived from the clock, and nothing else would move it along.
   */
  $: serverSync = (() => {
    void serverSyncTick;
    return serverSyncIndicator(serverSyncStatus, Date.now(), serverSyncFailed);
  })();
  $: headingSyncState = isSelfHost() ? serverSync.state : gitSyncIconState;
  $: headingSyncTitle = isSelfHost() ? serverSync.title : gitSyncIconTitle;

  /** How long ago the instance last synced, or null when it never has. */
  $: serverSyncAge = (() => {
    void serverSyncTick;
    return serverSyncStatus?.lastSync ? verifiedAge(serverSyncStatus.lastSync, Date.now()) : null;
  })();

  /** Whether the dialog should offer a way out of the current state. */
  $: gitSyncHealthBroken =
    gitSyncHealthApplies &&
    (Boolean(gitSyncLastPushError) || healthFailure(gitSyncHealth) !== null);

  /** The dialog's one line about health, matching the icon's tooltip. */
  $: gitSyncHealthNote = !gitSyncHealthApplies
    ? ''
    : gitSyncLastPushError
      ? copy.dialogs.gitSync.lastSaveFailed(gitSyncLastPushError)
      : gitSyncHealthDetail;

  /**
   * Whether that line would be the dialog saying the same thing twice.
   *
   * A setup that has just finished sets a message reporting what it did ("Backed up to
   * github.com/owner/name", plus whatever it pulled or kept), and the health line answers with
   * the same sentence about the same repository: measured right after a first sync, two lines
   * under the pill reading "Backed up to github.com/owner/name" and "Backed up to
   * github.com/owner/name.". The report is the one that carries the detail and the one that
   * goes away on its own, so the standing line steps aside while it is on screen. A *failed*
   * push is not the same sentence and is never suppressed, because that line is the whole
   * reason the Reconnect button beside it is offered.
   */
  $: gitSyncHealthEchoed = Boolean(gitSyncMessage) && !gitSyncHealthBroken;

  /**
   * The connected repository's page on github.com, or nothing when what the dialog holds is not
   * a repository name.
   *
   * The name is read back out of settings rather than remembered from the setup that wrote it,
   * so it can be whatever a hand-edited sidecar or a server's own status line says, and a link
   * built out of that has to be one this page would have made itself: `owner/name` and nothing
   * else, so a stray value cannot become a link to somewhere else entirely.
   */
  $: gitSyncRepoUrl = /^[\w.-]+\/[\w.-]+$/.test(gitSyncConnectedRepo)
    ? `https://github.com/${gitSyncConnectedRepo}`
    : '';

  /**
   * Void a verdict that belongs to a different folder, because a stale green
   * carried over from the previous one is worse than admitting nothing is known.
   */
  function syncHealthTarget(path: string | null): void {
    const key = path ?? '';
    if (gitSyncHealthTarget === key) return;
    gitSyncHealthTarget = key;
    forgetGitSyncHealth();
  }

  function forgetGitSyncHealth(): void {
    gitSyncHealth = null;
    gitSyncHealthDetail = '';
    gitSyncHealthAt = 0;
    gitSyncLastPushError = null;
    gitSyncHeartbeatAttemptAt = 0;
    gitSyncHeartbeatFailures = 0;
    gitSyncHealthApplies = healthAppliesToActive();
  }

  /** Whether the subject of the open dialog is the folder the verdict covers. */
  function healthAppliesToActive(): boolean {
    return Boolean(gitSyncConnectedRepo) && gitSyncActivePath() === gitSyncHealthTarget;
  }

  /** Something proved the backup works: a landed push, a reconnect, a heartbeat. */
  function markGitSyncVerified(): void {
    gitSyncHealth = 'ok';
    gitSyncHealthAt = Date.now();
    gitSyncHeartbeatFailures = 0;
    gitSyncLastPushError = null;
    gitSyncHealthApplies = healthAppliesToActive();
  }

  /**
   * Ask GitHub whether this folder's backup still works.
   *
   * The marker poll says the folder is wired up; this is the only thing that can
   * tell a revoked token, a deleted repository and a read-only token apart from
   * a healthy backup, because all three leave the marker intact. Throttled, and
   * never while the window is hidden: nobody can see the answer.
   */
  async function runGitSyncHeartbeat(force = false): Promise<void> {
    if (!hasLocalSync) return;
    const target = gitSyncActivePath();
    syncHealthTarget(target);
    if (!target || gitSyncHeartbeatInFlight) return;
    const hidden = typeof document !== 'undefined' && document.hidden;
    const now = Date.now();
    const due = shouldHeartbeat({
      lastAttemptAt: gitSyncHeartbeatAttemptAt,
      failures: gitSyncHeartbeatFailures,
      now,
      hidden,
      force
    });
    if (!due) return;
    gitSyncHeartbeatInFlight = true;
    gitSyncHeartbeatAttemptAt = now;
    try {
      const health = await readGitHeartbeat(target);
      if (!health || health.state === 'unmanaged') {
        // The marker is gone: there is no verdict left to hold, and keeping the
        // old one would paint a failure over a folder that is simply not synced.
        gitSyncHealth = null;
        gitSyncHealthDetail = '';
        gitSyncLastPushError = null;
        gitSyncHealthApplies = healthAppliesToActive();
        return;
      }
      gitSyncHealth = health.state;
      gitSyncHealthDetail = health.detail || '';
      gitSyncHealthAt = Date.now();
      // Rust remembers the last save that failed to reach GitHub, which is the
      // only way a push that died inside the engine document is ever visible:
      // the event has nowhere to land once the wiki has replaced the page.
      gitSyncLastPushError = health.last_commit_error || null;
      gitSyncHealthApplies = healthAppliesToActive();
      // Rust reads the repository out of the folder's own remote, so it is the
      // better authority on the name when the two disagree.
      if (health.repo) gitSyncConnectedRepo = health.repo;
      if (health.state === 'ok') gitSyncHeartbeatFailures = 0;
      else gitSyncHeartbeatFailures += 1;
    } catch {
      // The command itself did not answer: say unreachable rather than invent a
      // verdict, and let the backoff stretch the next attempt out.
      gitSyncHealth = 'offline';
      gitSyncHealthDetail = '';
      gitSyncHealthAt = Date.now();
      gitSyncHeartbeatFailures += 1;
      gitSyncHealthApplies = healthAppliesToActive();
    } finally {
      gitSyncHeartbeatInFlight = false;
    }
  }

  function markGitSyncActivity() {
    // Purple pulse for a few seconds after each save-commit, mirroring the
    // legacy "synced in the last 5 seconds" heuristic. The tick re-runs the
    // reactive block when the pulse expires (Svelte reacts to assignments).
    gitSyncSyncingUntil = Date.now() + SYNC_PULSE_MS;
    setTimeout(() => {
      gitSyncTick += 1;
    }, SYNC_PULSE_MS + 100);
  }

  function refreshGitSyncIcon() {
    if (!hasLocalSync) return;
    const target = gitSyncActivePath();
    syncHealthTarget(target);
    if (!target) {
      noteNoGitSyncTarget();
      return;
    }
    // Reading the marker is in-process libgit2, but while the window is hidden
    // nobody can see the icon, so skip the work until it is shown again
    // (visibilitychange triggers an immediate refresh below).
    if (typeof document !== 'undefined' && document.hidden) return;
    readGitStatus(target)
      .then((status) => foldGitSyncStatus(status))
      .catch((error) => {
        foldGitSyncStatus(null, true);
        noteGitSyncStatusFailure(error);
      });
  }

  async function installMonolith() {
    if (installBusy) return;
    installBusy = true;
    installStatus = '';
    try {
      // The same install on both backends: the desktop app answers through Tauri, a shim
      // through its wire. The wire's failure is a code with an optional sentence, which is
      // turned into a thrown Error so the one report below covers both.
      let result: { path: string; entry: string | null; revealed?: boolean };
      if (shimBackend) {
        const answer = await shimInstall({ token: shimToken });
        if (!answer.ok) throw new Error(answer.detail ?? answer.error);
        result = answer.value;
      } else {
        // Asked before the copy and never after it, because it is what decides whether there
        // is a copy to attempt: the operating system will not let an install write over the
        // program a window is running, so the windows still sitting on a launcher are asked to
        // close first, and a window that has a Lith open is reported rather than closed or
        // waited on (see `instances` in the Rust side). With nothing to ask, the answer comes
        // back at once and the line below is never seen.
        installStatus = copy.install.closing;
        const preflight = await tauriInvoke<InstallPreflight>('install_preflight');
        if (preflight.blocked) {
          installStatus = preflight.holder
            ? copy.install.blocked(preflight.holder)
            : copy.install.blockedUnknown;
          status = installStatus;
          return;
        }
        installStatus = '';
        result = await tauriInvoke<{ path: string; entry: string | null; revealed?: boolean }>('install_monolith');
      }
      // The tooltip is where the file went. The line names the entry instead when there is
      // one, because that is the thing the user can click. Neither sentence is written
      // here: what installing does on this platform is said once, in the offer's own copy,
      // and both of these are paths.
      installStatus = result.path;
      installState = 'current';
      status = copy.install.installed(result.entry ?? result.path);
      // The status line animates while it has text; retire the message
      // once it has had a moment to be read.
      setTimeout(() => { if (status.startsWith(copy.install.installedPrefix)) status = ''; }, 6000);
      // The install has said all it has to say, and the folder the new copy landed in is open
      // in front of the user: this window is the older copy now, so it gets out of the way and
      // leaves them to launch the new one. Only where the folder was actually opened: a
      // platform that cannot do that (see the shim) keeps the line that says where the file
      // went, since it is the only thing the user has to read.
      if (mode === 'tauri' && result.revealed) closeForInstall();
    } catch (error) {
      installStatus = copy.install.failed(error instanceof Error ? error.message : String(error));
      status = installStatus;
    } finally {
      installBusy = false;
    }
  }

  /**
   * Close this window, which an install on another window has just made the older copy.
   *
   * Asked of the app rather than done with `window.close()`, so it closes the way the app's own
   * handling of a close closes it, and so nothing here sits beside the ordinary exit path as a
   * second, quieter way out. The user reopens from the copy that was just installed, whose
   * folder is open in front of them.
   */
  function closeForInstall(): void {
    void tauriInvoke('quit_launcher').catch(() => { /* the window is going either way */ });
  }
  /**
   * One cached wiki, as the list draws it.
   *
   * `lastModified` is when this device wrote that copy. It is the answer a row's hover shows
   * wherever no process could name the file's own stamp (see `last-modified.ts`), which is
   * every browser mount: the handle's permission has not been granted, and asking for it on a
   * hover is a prompt nobody wanted.
   */
  type CacheSearchEntry = { name: string; text: string; sizeBytes: number; lastModified?: number | null };
  type CacheSearchMatch = { preview: string; title?: string };

  function formatCacheSize(bytes: number): string {
    if (bytes <= 0) return '0 MB';
    const megabytes = bytes / (1024 * 1024);
    if (megabytes < 0.01) return '<0.01 MB';
    return `${megabytes.toFixed(2).replace(/\.?(0+)$/, '')} MB`;
  }

  /**
   * How big a Lith on the server is, in the server's own bytes.
   *
   * Terse and at most one decimal: this sits beside a name, and the question it answers is
   * which of these is the big one, which does not need a digit of precision. Below a
   * kilobyte the count is the honest answer rather than a rounded nothing.
   */
  function formatLithSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const kilobytes = bytes / 1024;
    if (kilobytes < 1024) return `${kilobytes < 10 ? kilobytes.toFixed(1) : Math.round(kilobytes)} KB`;
    const megabytes = kilobytes / 1024;
    return `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`;
  }

  /**
   * Shorten a wiki file name for the version-history title while keeping its
   * extension visible (a 30+ char stem reads as `Long…name.lith` rather than
   * losing the `.lith`). The full name stays available via the title tooltip.
   */
  function clipFilename(name: string, limit = 20): string {
    if (name.length <= limit) return name;
    const ext = name.match(/\.(?:html?|lith|json)$/i)?.[0] ?? '';
    const stemLimit = limit - ext.length;
    if (stemLimit <= 3) return name.slice(0, limit - 1) + '…';
    return name.slice(0, stemLimit - 1) + '…' + ext;
  }

  /**
   * The grey line the history trail draws between two versions: how much later the row above
   * was saved than the row below it, in the one unit `versionGap` picks and this locale's own
   * decimal mark. Only the greatest unit is ever named, so one sentence covers a four second
   * step and a three week gap. Empty when the two stamps are the same instant, and then the
   * chevron joins them alone.
   */
  function historyGapLabel(newerTs: number, olderTs: number): string {
    const gap = versionGap(newerTs - olderTs);
    return gap ? copy.dialogs.history.later[gap.unit](gapCount(gap, LOCALE_TAG)) : '';
  }
  let cachedEntries: Record<string, CacheSearchEntry> = {};
  /**
   * When each file behind a row was last written, keyed by its path, as the process read it.
   *
   * Only the desktop app and the shim can answer this. Everywhere else the map stays empty and
   * the rows fall back on the copy this device holds, which is the only stamp a page can see.
   */
  let fileStamps: Record<string, number> = {};
  let cacheSearchMatches: Record<string, CacheSearchMatch> = {};
  let cacheSearchRequest = 0;
  type HistoryEntry = { id: string; ts: number; sizeBytes: number; isBase?: boolean; external?: boolean; lastModified: string };
  let showHistoryModal = false;
  let historyName = '';
  let historyEntries: HistoryEntry[] = [];
  /**
   * Whether the dialog is about a Lith with no file at all. The fallback's claim used
   * to be a line above the recent list; this is where it moved, because a hover is no
   * use on a phone and the download this dialog offers is the way out it names.
   */
  let historyBrowserOnly = false;
  let historyBusy = false;
  let historyError = '';
  /**
   * The capture itself, when this Lith has one.
   *
   * `dirtyEntries` carries only the moment a capture was stamped, which is enough for a badge
   * and not for a body: the row now says how many edits it holds and what they are called, and
   * offers to take them somewhere real, so the record is loaded with the versions rather than
   * re-read on every press.
   */
  let historyDirty: DirtyStateRecord | null = null;
  /** The capture row's own key: the one row in the trail that is not a version, so it has no id. */
  const CAPTURE_ROW_ID = 'inline';
  let historyCaptureOpen = false;
  let historyCaptureSaving = false;
  /**
   * What this dialog says after a merge lands. The header's status line is behind the modal, so a
   * sentence about what the dialog just wrote has to be drawn in the dialog.
   */
  let historyNotice = '';
  /**
   * What each row's download reports, in the pill the warning dialogs have always drawn beside a
   * row's download button (`orphanPill`). These rows reported in the header's status line
   * instead, which this dialog covers: on an instance page inside the app a download wrote the
   * file and said nothing at all. Keyed by the row's own id, so a row's mark stays on its row.
   */
  let historyDownloads: Record<string, OrphanDownloadState> = {};

  function setHistoryDownload(id: string, state: OrphanDownloadState): void {
    historyDownloads = { ...historyDownloads, [id]: state };
  }
  // Per-wiki version-history availability keys the history affordance:
  // wikis with no recorded versions (never saved, scratch-before-save)
  // hide the button instead of opening an empty modal.
  let historyAvailable: Record<string, boolean> = {};

  async function refreshHistoryAvailability(names: string[]) {
    const wanted = names.filter((name) => !(name in historyAvailable));
    if (wanted.length > 0) await rereadHistoryAvailability(wanted);
  }

  /**
   * Ask again about names the list already has an answer for.
   *
   * `refreshHistoryAvailability` reads each name once, which is right for a list that
   * only grows, but these answers are not permanent. They are read off this device's
   * own version store, and indexing a Lith writes versions into that store: a row told
   * "no history here" when it appeared has several the moment a rebuild has read its
   * file, and the row's own Download History affordance is waiting on exactly that
   * answer. So the pass that changes the store asks the question again.
   */
  async function rereadHistoryAvailability(names: string[]) {
    if (names.length === 0) return;
    const availability = await wikiHasHistory(names);
    historyAvailable = { ...historyAvailable, ...availability };
  }
  type DirtyInfo = { name: string; ts: number; tiddlers: Array<Record<string, string>> };
  let showDirtyModal = false;
  let dirtyInfo: DirtyInfo | null = null;
  let dirtyResolver: ((decision: 'merge' | 'discard' | 'later') => void) | null = null;
  let dirtyEntries: Record<string, number> = {};

  /**
   * Rows a rebuild is about to drop because their file is not where the list
   * says it is, held while the user decides. Each carries the list's own
   * history/download button, so a real file can be written before proceeding.
   */
  let rebuildOrphans: RebuildOrphan[] = [];
  /**
   * What a plain `Reset Recents` would take with the list, held while the person decides.
   *
   * Not the rebuild list above: nothing here is missing. The files are exactly where the rows
   * say they are, and what goes is the copy this device took of each one, its version history
   * and any unsaved capture, which a reset deletes in the same pass as the list. The panel has
   * no rebuild control in this shape, so this is the last moment any of them can be written
   * out; a row with none of the three is only a list entry and is not listed here.
   */
  let resetAtRisk: RebuildOrphan[] = [];
  let rebuildOrphanResolver: ((proceed: boolean) => void) | null = null;

  /**
   * The launcher's own confirmation, in place of `window.confirm`. In the desktop
   * app that call renders as an OS message box: another typeface, the OS accent
   * colour, and window chrome belonging to no part of the app it interrupts, with
   * nothing that can be styled. This is the same overlay as every other dialog,
   * so a confirmation looks like it came from the launcher it is about.
   */
  interface ConfirmationRequest {
    title: string;
    body: string;
    confirmLabel: string;
    /**
     * The caller's own button is the destructive one. The dialog cannot tell (it renders
     * whatever it is handed) so the red is asked for by the one place that knows the act
     * cannot be undone, and the confirmations that only change a state stay blue.
     */
    danger?: boolean;
  }
  let confirmation: ConfirmationRequest | null = null;
  let confirmationResolver: ((ok: boolean) => void) | null = null;
  let confirmationButton: HTMLButtonElement | null = null;

  /** Ask, and resolve once the user answers. Escape and Cancel both decline. */
  function askConfirmation(request: ConfirmationRequest): Promise<boolean> {
    // One at a time: a second ask would strand the first promise forever.
    confirmationResolver?.(false);
    confirmation = request;
    setTimeout(() => confirmationButton?.focus(), 0);
    return new Promise((resolve) => { confirmationResolver = resolve; });
  }

  function resolveConfirmation(ok: boolean): void {
    const resolve = confirmationResolver;
    confirmationResolver = null;
    confirmation = null;
    resolve?.(ok);
  }

  function positionCachePreview(node: HTMLElement) {
    let frame = 0;
    const list = node.closest('.recent-list');

    const update = () => {
      frame = 0;
      if (window.matchMedia('(max-width: 950px)').matches) {
        node.style.display = 'none';
        return;
      }

      const row = node.closest('.recent-row');
      const listRect = list?.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      if (!rowRect || !listRect || rowRect.bottom < listRect.top || rowRect.top > listRect.bottom) {
        node.style.opacity = '0';
        return;
      }

      const containerRect = document.querySelector('.container')?.getBoundingClientRect();
      if (!containerRect) return;
      node.style.display = 'block';
      node.style.maxWidth = `${Math.min(430, Math.max(120, window.innerWidth - containerRect.right - 20))}px`;
      node.style.left = `${containerRect.right + 10}px`;
      node.style.top = `${rowRect.top + rowRect.height / 2}px`;
      node.style.transform = 'translateY(-50%)';
      node.style.opacity = '1';
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    schedule();
    window.addEventListener('resize', schedule);
    list?.addEventListener('scroll', schedule, { passive: true });
    return {
      destroy() {
        if (frame) cancelAnimationFrame(frame);
        window.removeEventListener('resize', schedule);
        list?.removeEventListener('scroll', schedule);
      }
    };
  }

  /**
   * Draw the recent list's scrollbar only while the list is being scrolled.
   *
   * A scrollbar is a fact about the list, not about the row being read: at rest the panel's
   * rows already carry the gap and the reserved gutter a thumb needs, so what the thumb
   * adds is four dark pixels of furniture on the one panel that is nearly all list, and on
   * a phone, where the window is barely wider than the column, the gutter is the only thing
   * in the panel's right padding at all.
   *
   * `.scrolling` is the whole mechanism (see the stylesheet) because a native scrollbar
   * cannot be animated: Blink paints a scrollbar from its un-animated style, so a transition
   * or an animation on the thumb is measured to do nothing at all, and the thumb can only
   * cut between hidden and drawn. A class toggle costs the same frame either way.
   *
   * Written as a class rather than reactive state because a scroll burst fires on every
   * frame of the gesture and nothing else on the page reads this: state would schedule a
   * render per frame to change one attribute the user is not looking at, and the linger is a
   * timer, which is not something a template can hold.
   *
   * The linger is the other half of the idea. Hiding the thumb as soon as the last scroll
   * event lands would blink it off between two wheel notches (a flick of a trackpad lands
   * events tens of milliseconds apart) so the class outlives the gesture by long enough
   * that a burst reads as one continuous scroll.
   */
  function trackListScroll(node: HTMLElement) {
    let linger: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      node.classList.add('scrolling');
      if (linger) clearTimeout(linger);
      linger = setTimeout(() => node.classList.remove('scrolling'), 700);
    };
    node.addEventListener('scroll', onScroll, { passive: true });
    return {
      destroy() {
        if (linger) clearTimeout(linger);
        node.removeEventListener('scroll', onScroll);
      }
    };
  }

  /**
   * Align the new-document label, and the reset control under the card, with the centered
   * mount label in the landscape layout.
   *
   * The measurement is published on the page's container rather than on the button it was
   * taken from, because two controls in two subtrees read it: the label inside New Blank
   * Lith, and the reset control in the panel's foot, which is a sibling of the action card
   * rather than a child of it. The number is the distance from the card's own content edge
   * to the type the two of them are matching, so each turns it into the padding its own box
   * needs (see the landscape block in the stylesheet).
   *
   * The property outlives the button it was measured against. When the inline title field
   * takes that button's row the field is the same full width, so the mount label does not
   * move and the reset control below stays where it was while a title is typed.
   */
  function alignNewLithLabel(node: HTMLButtonElement) {
    const card = node.parentElement;
    const page = node.closest<HTMLElement>('main.container');
    let frame = 0;
    const update = () => {
      frame = 0;
      if (!window.matchMedia('(orientation: landscape) and (max-height: 560px) and (max-width: 950px)').matches) {
        page?.style.removeProperty('--mount-label-offset');
        return;
      }
      const mount = card?.querySelector<HTMLButtonElement>('.mount-button');
      const label = mount?.querySelector<HTMLElement>('.mount-label');
      if (!mount || !label) return;
      const newRect = node.getBoundingClientRect();
      const mountRect = mount.getBoundingClientRect();
      const labelRect = label.getBoundingClientRect();
      if (!newRect.width || !mountRect.width || !labelRect.width) return;
      const style = getComputedStyle(node);
      const inset =
        (Number.parseFloat(style.borderLeftWidth) || 0) + (Number.parseFloat(style.paddingLeft) || 0);
      page?.style.setProperty('--mount-label-offset', `${Math.max(0, labelRect.left - newRect.left - inset)}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    observer?.observe(node);
    if (card) observer?.observe(card);
    const mount = card?.querySelector('.mount-button');
    if (mount) observer?.observe(mount);
    const label = mount?.querySelector('.mount-label');
    if (label) observer?.observe(label);
    window.addEventListener('resize', schedule);
    schedule();
    return {
      destroy() {
        if (frame) cancelAnimationFrame(frame);
        observer?.disconnect();
        window.removeEventListener('resize', schedule);
      }
    };
  }

  function getEntryName(entry: RecentEntry | { name?: string; handle?: any }): string {
    if (entry.handle && entry.handle.name) return entry.handle.name;
    return (entry as any).name || 'untitled.lith';
  }

  // Esc deselects (blurs) the search while preserving the active query.
  // non-destructive, per the Puppeteer regression spec. The × button remains
  // the explicit clear. Enter opens the first visible result (recent or
  // cached-only), mirroring the legacy handleSearchKeydown behavior.
  async function handleSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      (event.currentTarget as HTMLInputElement).blur();
      return;
    }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    const first = filteredRecent[0] ?? filteredCached[0];
    if (!first) return;
    if ('title' in first || filteredRecent.includes(first as any)) {
      await openRecent(first as any);
    } else {
      await openCachedEntry(first as CacheSearchEntry);
    }
  }

  /**
   * Other instances' cached wikis, read once per instance per session.
   *
   * A cached wiki lives in the storage of the instance it belongs to, and this page can
   * never read that: an instance is a different origin. The app can, because every one of
   * its webviews shares one profile, so the reading is done for it, by its own runtime
   * (`instance_search.rs`), and the addresses it is asked about are exactly the bookmarks
   * below. Nothing is asked for an address the user did not save.
   */
  let instanceReads: InstanceReads = {};
  let instanceReadBusy = false;
  $: bookmarkOrigins = bookmarks.map((entry) => entry.url);
  // One hit per instance for whatever is typed right now. Recomputed from what was
  // already read, so typing never asks the app for anything again.
  $: instanceCacheHits = topHits(instanceReads, search);
  // Only while a search is running, and only for addresses not read yet: no search
  // means no reason to hold anybody's cache in memory.
  $: if (mode === 'tauri' && search.trim() && bookmarkOrigins.length > 0) void readInstanceCaches(bookmarkOrigins);

  async function readInstanceCaches(origins: string[]) {
    const missing = origins.filter((origin) => !(origin in instanceReads));
    if (missing.length === 0 || instanceReadBusy) return;
    instanceReadBusy = true;
    try {
      const reads = await tauriInvoke<InstanceCacheRead[]>('instance_cache_search', { origins: missing });
      const next = { ...instanceReads };
      for (const read of reads) next[read.origin] = read;
      instanceReads = next;
    } catch {
      // No such command in this build, or a runtime that refused it: no instance hits,
      // which is what the launcher showed before any of this existed. The addresses are
      // recorded as read anyway, so a build without the command is not asked on every
      // keystroke for an answer it will never give.
      const next = { ...instanceReads };
      for (const origin of missing) next[origin] = { origin, caches: [], truncated: false };
      instanceReads = next;
    } finally {
      instanceReadBusy = false;
    }
  }

  // The name half of every list's search is `showsForQuery`: a Lith is found by its
  // title, which is its name without the extension every row shares. See `name-match`
  // for why the suffix is not searchable, and why the same answer also decides where
  // a row's matched characters are marked.
  $: filteredRecent = recentFiles.filter((file) => {
    const name = getEntryName(file);
    return showsForQuery(name, search) || Boolean(cacheSearchMatches[name]?.preview);
  });

  // Self-host: the server's own Liths are the primary list, filtered by the
  // same search box as the local recents.
  // ...and by what this device holds of them, which is the half the local list has always
  // had and this one was missing. A word that appears only inside a Lith's body is worth
  // exactly as much here as there: the launcher cached that Lith when it was last opened,
  // so the text is on this machine and the row is an answer rather than a blank list. It
  // does not mix the two lists, which is what the device's own rows are kept out of here
  // for: the row is still the server's, and the panel beside it is an annotation on it,
  // exactly as a match inside a recent row is.
  $: filteredRemote = remoteFiles.filter(
    (file) => showsForQuery(file.name, search) || Boolean(cacheSearchMatches[file.name]?.preview)
  );

  /**
   * Whether this cached self-host launcher is in offline mode. See `offline-mode.ts`
   * for why only this one mode has the state. Read by the banner above the list and by
   * the list itself, so the two can never disagree about which launcher is on screen.
   */
  $: offlineLauncher = offlineMode(mode, online, remoteUnreachable);

  /**
   * The rows an offline launcher holds: the Liths this device already has a copy of, which
   * are the only ones that can be opened without the instance.
   *
   * By name rather than by date: with no server there is nothing to order by, and the
   * server's order would change under the reader the moment it answered. Every row is a
   * copy this device took, so the set is `cachedEntries` (the same store the online
   * list already reads for its sizes and its search) and nothing new is fetched to
   * build it, which is the whole point of a mode with no network.
   *
   * The query filters these rather than the set itself, and the two are separate on purpose:
   * a search narrows what the list draws, and must never narrow what a download covers. The
   * backup dialog reads the set (see `backupRows`).
   */
  $: offlineEntries = offlineLauncher
    ? Object.values(cachedEntries).sort((a, b) => a.name.localeCompare(b.name))
    : [];
  $: offlineRows = offlineEntries.filter(
    (entry) => showsForQuery(entry.name, search) || Boolean(cacheSearchMatches[entry.name]?.preview)
  );

  /**
   * Bookmark rows to draw: the address matches, *or* the instance holds a cached wiki
   * that matches.
   *
   * The second half is the rule `filteredRecent` already follows for this device's own
   * caches, and it has to be followed here too. Without it a query that appears only
   * inside an instance's wiki renders no row, which is the one case the whole search is
   * for.
   */
  $: filteredBookmarks = bookmarks.filter((entry) =>
    entry.label.toLowerCase().includes(search.toLowerCase()) ||
    entry.url.toLowerCase().includes(search.toLowerCase()) ||
    Boolean(instanceCacheHits[entry.url]?.preview) ||
    // A partly read instance is listed even with nothing to show for it, because the
    // alternative is the one answer this search must never give: nothing at all, when
    // the truth is that an older Lith in there might match and was not read. The row
    // then carries the sentence that says so.
    Boolean(search.trim() && instanceReads[entry.url]?.truncated)
  );

  $: filteredCached = Object.values(cachedEntries).filter((entry) => {
    const isRecent = recentFiles.some((file) => getEntryName(file) === entry.name);
    // Rows only a search can produce, so no query means no row. Unlike the lists
    // above, where an empty box is the whole list.
    if (!search.trim()) return false;
    return !isRecent && (titleMatches(entry.name, search) || Boolean(cacheSearchMatches[entry.name]?.preview));
  });

  // The name that will actually be created (extension normalized), used to
  // detect case-insensitive collisions with liths in the recent list.
  $: newLithNormalized = normalizeLithName(newLithName);
  // The name as it was typed, so the field can say when the launcher had to change it. Every
  // rule that makes a name legal somewhere also merges two names into one (`a/b` and `a-b`),
  // and a rewrite nobody is shown is a document nobody asked for under a name they did not
  // choose.
  $: newLithAsTyped = typedDocumentName(newLithName);
  $: newLithRenamed = Boolean(newLithAsTyped) && newLithAsTyped !== newLithNormalized;
  // Self-host: a name already on the server is taken even though this device
  // has never seen it, so the checkmark reports the collision before a PUT.
  $: newLithTaken = recentFiles.some((file) => getEntryName(file).toLowerCase() === newLithNormalized.toLowerCase())
    || (isSelfHost() && remoteNameTaken(newLithNormalized));

  async function updateCacheMatches(query: string) {
    const request = ++cacheSearchRequest;
    const entries: Record<string, CacheSearchEntry> = {};
    try {
      // `cachedWikiNames` owns the which-keys-are-wikis rule: history snapshots
      // share the cache prefix, and a base snapshot carries text too, so a
      // prefix test alone lists wikis that do not exist under names like
      // `base_recipes.lith_3f2a`. Enough to keep the panel on screen with
      // nothing in it, and findable only by a search that cannot open them.
      for (const name of cachedWikiNames(await idb.keys())) {
        try {
          const cache = await idb.get<{ text?: string; lastModified?: string; backupTimestamp?: number }>('search_cache_' + name);
          if (typeof cache?.text === 'string') {
            entries[name] = {
              name,
              text: cache.text,
              sizeBytes: new Blob([cache.text]).size,
              // When this device last wrote the copy, which is the only stamp a row's hover can
              // name in a browser. Read beside the text because both are in the same record.
              lastModified: cachedStamp(cache)
            };
          }
        } catch { /* cached search is best effort */ }
      }
    } catch { /* IndexedDB may be unavailable */ }

    if (request !== cacheSearchRequest) return;
    cachedEntries = entries;
    void refreshDirtyBadges();
    const matches = searchCachedWikis(Object.values(entries), query);
    const next: Record<string, CacheSearchMatch> = {};
    for (const [name, result] of Object.entries(matches)) {
      next[name] = { preview: result.preview, title: result.title };
    }
    cacheSearchMatches = next;
  }

  $: void updateCacheMatches(search);

  /**
   * Ask the process for each row's file stamp, where there is a process that can answer.
   *
   * One call for the whole list, because a hover is not worth a round trip per row, and one
   * call per recents change, because the list is what the question is about. The desktop app
   * and the shim are the two shapes with a file and a way to stat it; a browser page keeps the
   * copy's own stamp instead. A failure here is not a failure of the list: the rows fall back
   * on that copy, and nothing about opening one depends on this having answered.
   */
  async function refreshFileStamps(rows: readonly RecentRow[]) {
    const paths = [
      ...new Set(rows.map((row) => recentDiskPath(row)).filter((path): path is string => Boolean(path)))
    ];
    if (paths.length === 0) {
      fileStamps = {};
      return;
    }
    if (mode === 'tauri') {
      try {
        fileStamps = (await tauriInvoke<Record<string, number>>('lith_modified_times', { paths })) ?? {};
      } catch { /* the copy's stamp is the fallback */ }
      return;
    }
    if (!shimToken) return;
    const answer = await shimModifiedTimes(paths, { token: shimToken });
    if (answer.ok) fileStamps = answer.value;
  }

  // The list is what the question is about, so it is asked again whenever the list is: a
  // mount adds a row, and a rebuild replaces every path in it.
  $: void refreshFileStamps(recentFiles);

  /**
   * The hover a Lith on the server carries, from the stamp its listing reported.
   *
   * The row's own file is not on this machine, so the store's answer is the true one, and it
   * is already in hand: the listing that drew the row carried it. A store that omitted the
   * stamp keeps the sentence the hover always said rather than a date nobody reported.
   */
  function remoteRowTitle(file: WebdavFile): string {
    return modifiedTitle(file.lastModified?.getTime(), LOCALE_TAG) ?? copy.row.openFromServer;
  }

  // Version-history availability tracks the recents + cached lists so newly
  // appearing rows get their answer without re-checking existing ones.
  $: void refreshHistoryAvailability([
    ...recentFiles.map((file) => getEntryName(file)),
    ...filteredCached.map((entry) => entry.name),
    // An instance's rows are the server's rather than this device's, so they are in
    // neither list above, and the history this client holds for one of them is the
    // whole of what its row has to add.
    ...(isSelfHost() ? remoteFiles.map((file) => file.name) : [])
  ]);

  async function loadRecent() {
    // The store and the mirror are two copies of one list, so they are read as one. Taking the
    // store's answer whenever it is non-empty is how the copies drifted apart: a list of synced
    // Liths in the mirror beside one saved row in the store read as the one row, and the
    // rebuild over that list had no backed-up folder left to crawl. A mirror that cannot be
    // parsed is not allowed to cost the store's rows either, which is the same rule.
    let stored: any[] = [];
    try {
      stored = await getRecentFiles();
    } catch {
      stored = [];
    }
    let mirrored: any[] = [];
    try {
      const parsed = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
      mirrored = Array.isArray(parsed) ? parsed : [];
    } catch {
      mirrored = [];
    }
    recentFiles = mergeRecentLists(stored, mirrored);
    // The sidecar is the desktop app's own file beside its executable, so only it can read one.
    // The coverage question is not: a shim answers it out of the folder's `.git/config`, and
    // asking only the desktop app left every shim boot with no coverage at all. Which is the
    // whole reason the panel's foot read `Reset Recents` on a folder that was backed up: with
    // no roots there was no backup to rebuild from, so the one control that can regrow the list
    // offered to throw it away instead.
    if (mode === 'tauri') await mergeRecentsSidecar();
    if (hasLocalSync) await refreshBackupCoverage();
    // Dirty-state rows are keyed off the recent list (plus caches), so refresh
    // the unsaved-edit indicator once recents are known. A blank lith edited
    // but never saved has no cache, so the cache path alone never sees it.
    void refreshDirtyBadges();
    // The mount-time sync check had no subject; this is the list that gives it
    // one, so ask now instead of leaving the icon amber until the next poll.
    gitSyncRecentsReady = true;
    refreshGitSyncIcon();
  }

  /**
   * Implicit portable mode: recents.txt beside the exe carries one path per
   * line so a thumb-drive bundle regrows its recents on any machine. Sidecar
   * entries merge ahead of local ones (they were opened most recently on
   * some machine); local entries are kept, browser storage stays the source
   * of truth. Unresolvable paths are dropped by the Rust read and files
   * that vanished from the drive are pruned here.
   */
  async function mergeRecentsSidecar() {
    try {
      const sidecarPaths = await tauriInvoke<string[]>('read_recents_sidecar');
      if (sidecarPaths.length > 0) {
        const existing = new Set(recentFiles.map((item) => recentDiskPath(item) ?? getEntryName(item)));
        const merged = [...recentFiles];
        for (const path of [...sidecarPaths].reverse()) {
          if (existing.has(path)) continue;
          merged.unshift({ name: path.split(/[\\/]/).pop() || path, path } as any);
        }
        recentFiles = merged.slice(0, 20);
      }
    } catch {
      // No sidecar support (browser/dev). Ignore.
    }
  }

  /**
   * Mirror the current recents into the sidecar (fire-and-forget). The command
   * takes `paths` and `dismissed` together (the flag rides the same file) so
   * omitting the second argument makes Tauri reject the call as a missing
   * field, which is how the mirror stayed silently dead.
   */
  function persistRecentsSidecar() {
    if (mode !== 'tauri') return;
    const paths = recentFiles
      .map((item) => recentDiskPath(item))
      .filter((path): path is string => Boolean(path));
    void tauriInvoke('write_recents_sidecar', { paths, dismissed: installDismissed })
      .catch(() => { /* best effort */ });
  }

  /**
   * Mirror the recents into the one key localStorage has.
   *
   * A row's own text rides along only where it is the row's last copy: a row with a path is
   * re-read from disk, and a Lith's content is in the search cache the mount's own saver
   * writes, so those bodies are weight this key cannot afford. The failure this exists for
   * was a 10 MB Lith that broke its own mount with `QuotaExceededError`, under
   * "Could not open …", from a store whose whole budget is a few megabytes.
   *
   * A full store must never cost a mount, so this does not throw: a write that would not fit
   * is retried with the texts dropped, and a list of names and paths is what is left. The
   * in-memory list is the copy that matters either way; this is the mirror beside it.
   */
  function persistRecentRows(): void {
    const rows = recentFiles.map((item) => {
      const path = recentDiskPath(item) ?? undefined;
      const text = (item as any).text;
      return {
        name: getEntryName(item),
        ...(path ? { path } : {}),
        ...(text && !path && text.length <= RECENT_TEXT_LIMIT ? { text } : {})
      };
    });
    if (writeRecentRows(rows)) return;
    writeRecentRows(rows.map(({ name, path }) => ({ name, path })));
  }

  /** One attempt at the recents key; false when the store will not take it. */
  function writeRecentRows(rows: Array<{ name?: string; path?: string; text?: string }>): boolean {
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(rows));
      return true;
    } catch {
      return false;
    }
  }

  async function remember(file: { name: string; path?: string; text?: string; handle?: any }) {
    // Which store this row belongs in is `rememberRowKind`'s rule, and it answers
    // browser-only before it looks at a handle: a row built on one would claim a file that
    // every save in this mode leaves exactly as it was. The handle is still how the pick's
    // bytes were read, once, before it gets here.
    const kind = rememberRowKind(indexDbOnly, Boolean(file.handle));
    const row =
      kind === 'browser-only'
        ? {
            // Nothing here has a file to remember and nothing can, so the row says so, and it
            // is stored in the store the Lith's content is stored in. An HTML monolith has no
            // tiddler snapshot to read its page back from, so its text travels in the row; a
            // Lith's is already in the search cache the mount's own saver writes.
            handle: null,
            tauriPath: null,
            name: file.name,
            browserOnly: true,
            ...(isHtmlMonolithName(file.name) && file.text ? { text: file.text } : {})
          }
        : kind === 'handle'
          ? { handle: file.handle, tauriPath: file.path ?? null, name: file.name }
          : { name: file.name, path: file.path, ...(file.text ? { text: file.text } : {}) };
    // A row that names no file is not a row, and a blank Lith is the one mount that would make
    // one: it is created with nowhere to save it yet, so there is nothing here to remember, and
    // the save that follows records its own row through the engine's saver, which is the only
    // writer that knows the path the chooser named. Writing the placeholder anyway put a second
    // row in the list beside the real one, a row that cannot be opened or backed up beside one
    // that can, and it is what turned a list of the backup's own Liths into that one row on a
    // relaunch. So nothing is remembered, and the list stays a list of Liths.
    if (isAnonymousRow(row)) return;
    // One list, and a save adds to it: the row goes in front of what is already listed, and the
    // result is written through to both stores rather than a store being asked what it holds.
    // The difference is the whole of a reported bug. With a backup connected, the synced Liths
    // in the list are path rows that only ever reached the localStorage mirror, so a save whose
    // new list was an adopted store answer deleted every one of them, and what replaced them
    // was a single handle row with no path, which is also why the panel's foot turned from
    // `Rebuild Recents` into `Reset Recents`: coverage had no paths left to compute from.
    recentFiles = await setRecentRows(await mergeRecentRow(recentFiles, row));
    persistRecentRows();
    persistRecentsSidecar();
    // A save can land in a folder never seen before, which is the moment its
    // coverage answer changes. Fire-and-forget so a batch of remember() calls
    // (adopting a whole folder) does not serialize behind it.
    void refreshBackupCoverage();
  }

  /**
   * Transient-recovery gate: if this wiki has unsaved edits captured by the
   * realtime dirty watcher, ask the user what to do before booting. Returns
   * the decision ('later' means the caller should abort the mount).
   */
  async function prepareDirtyRecovery(safeName: string, answer?: 'merge'): Promise<'merge' | 'discard' | 'later'> {
    const dirty = await getDirtyState(safeName);
    if (!dirty) return 'merge'; // Nothing to recover; proceed.
    // A caller that has already asked (the history trail's Recover) answers rather than
    // opening the prompt a second time about a capture the row it came from has described.
    const decision = answer ?? await promptDirtyRecovery(safeName, dirty);
    if (decision === 'merge') {
      // Queued after the file's own tiddlers, so recovered edits win title
      // conflicts but stay below engine plumbing.
      pendingImports = mergePendingImports(pendingImports, dirty.tiddlers.map((tiddler) => ({ ...tiddler })));
      await clearDirtyState(safeName);
      status = copy.status.recovering(dirty.tiddlers.length, safeName);
    } else if (decision === 'discard') {
      await clearDirtyState(safeName);
    }
    return decision;
  }

  function promptDirtyRecovery(name: string, record: { ts: number; tiddlers: Array<Record<string, string>> }): Promise<'merge' | 'discard' | 'later'> {
    dirtyInfo = { name, ts: record.ts, tiddlers: record.tiddlers };
    showDirtyModal = true;
    return new Promise((resolve) => {
      dirtyResolver = resolve;
    });
  }

  /**
   * Ask before a rebuild drops rows whose file has gone missing.
   *
   * Nothing on disk is touched. The cached copy and the version history both
   * survive, and both stay reachable through search. What goes away is the row,
   * and finding that wiki again afterwards means knowing to search for it. A
   * missing file is usually a move or an unmounted drive, so the decision is
   * surfaced rather than taken silently.
   */
  function promptRebuildOrphans(orphans: RebuildOrphan[]): Promise<boolean> {
    rebuildOrphans = orphans;
    // A fresh warning starts with no downloads claimed.
    orphanDownloads = {};
    return new Promise((resolve) => {
      rebuildOrphanResolver = resolve;
    });
  }

  function resolveRebuildOrphans(proceed: boolean) {
    const resolver = rebuildOrphanResolver;
    rebuildOrphanResolver = null;
    rebuildOrphans = [];
    orphanDownloads = {};
    resolver?.(proceed);
  }

  function resolveDirtyModal(decision: 'merge' | 'discard' | 'later') {
    showDirtyModal = false;
    const resolver = dirtyResolver;
    dirtyResolver = null;
    dirtyInfo = null;
    resolver?.(decision);
    void refreshDirtyBadges();
  }

  async function refreshDirtyBadges() {
    try {
      const names = [...recentFiles.map((file) => getEntryName(file)), ...Object.keys(cachedEntries)];
      dirtyEntries = await listDirtyRecoveries(names);
    } catch {
      dirtyEntries = {};
    }
  }

  async function mountWiki(
    contents: string,
    name: string,
    path?: string,
    handle?: any,
    extraTiddlers: Array<Record<string, string>> = [],
    // Self-host mounts carry the text and digest the saver diffs against, so a
    // save sends only changed lines instead of re-serializing the whole wiki.
    remote: RemoteTarget | null = null,
    // The container a PDF's own open asked the engine to draw, when this mount is the Lith
    // beside that PDF. Every other mount leaves it undefined, and the boot answers the
    // question either way (see publishBoardRequest), so a request cannot outlive its mount.
    openBoardFor?: string,
    /**
     * The facts a mount carries that are not its own content, gathered rather than added as more
     * positional arguments: four of the ten mounts pass the first and one the second.
     */
    mount: {
      /**
       * An answer this mount already carries to the unsaved-edit gate, from a caller that has
       * asked its own question about the same capture (the history trail's own Recover). Only
       * merge can arrive this way: discarding and deciding later are answers a person gives, so
       * they never come from a button whose whole claim is that it recovers the edits.
       */
      dirtyAnswer?: 'merge';
      /**
       * True when `path` names where a save will go and nothing is written there yet: the Lith
       * beside a PDF or an image, which is created by the first save rather than by the open
       * (see `importIntoNewLith`). Nothing is remembered and no capture is watched, because
       * there is no file and no document yet, only a view of one.
       */
      unwritten?: boolean;
    } = {}
  ) {
    const { dirtyAnswer, unwritten = false } = mount;
    mountError = '';
    // A complete wiki page rather than a Lithic document: served as-is, with
    // its own tiddler store and its own save behavior.
    const isHtmlMonolith = isHtmlMonolithName(name);
    // A .json file holding a top-level tiddler array is a wiki backup and
    // mounts as a lith; other .json files are verbatim scratch documents.
    const isJsonBackup = /\.json$/i.test(name) && contents.trim().startsWith('[');
    const isScratch = isScratchFileName(name) && !isJsonBackup;
    // One name for the recent row, the flat cache, the version history and the
    // dirty-state key. See resolveMountName for why they must not diverge.
    const safeName = resolveMountName(name, { scratch: isScratch, htmlMonolith: isHtmlMonolith });
    // A queued tiddler can replace one this document already holds, and until the next save that
    // copy exists nowhere else. Asked before `remember`, because a mount that is declined must
    // leave no recents row behind. A blank document carries no tiddlers, and a monolith is a
    // page rather than a store, so neither has anything to replace.
    if (pendingImports.length > 0 && !isHtmlMonolith && !isScratch) {
      const added = pendingImports.filter((tiddler) => !intentionalImports.includes(tiddler.title ?? ''));
      const replacing = replacingTitles(parseDroppedData(contents, !isJsonBackup), added);
      if (replacing.length > 0) {
        const replace = await askConfirmation({
          title: replacing.length === 1 ? copy.pending.replaceTitleOne : copy.pending.replaceTitleMany,
          body: replacing.length === 1
            ? copy.pending.replaceBodyOne(replacing[0], safeName)
            : copy.pending.replaceBodyMany(replacing.length, safeName),
          confirmLabel: copy.pending.replaceConfirm,
          danger: true
        });
        if (!replace) {
          busy = false;
          status = '';
          return;
        }
      }
    }
    // A mount whose file is still to be written has nothing to remember: the list holds Liths
    // that exist, and a row for one that does not cannot be opened or backed up. Its row is
    // written by the save that creates the file, which is the writer that knows there is one.
    if (!unwritten) await remember({ name: safeName, path, text: contents, handle });
    // Drift compares the file against the tiddler chain, and only a .lith file
    // holds a tiddler store to compare (a scratch document is flat text and a
    // monolith is a page) so the SYNC marker stays lith-only. Unsaved-edit
    // recovery is the one thing a monolith opts out of: it may already keep its
    // own recovery through add-ons or plugins, and the launcher must not
    // interpose on what the page does with its own edits. Saved history is not
    // interposition, so monoliths keep it like every other mount.
    // Drift asks whether the file changed outside this device since the last
    // local save. In the browser-storage fallback there is no file that could
    // have changed (the cached copy *is* the document) so the comparison is
    // the cache against itself, and answering it there marks a full SYNC
    // snapshot on mounts that changed nothing.
    const driftedFromHead = !isHtmlMonolith && !isScratch && !indexDbOnly && !unwritten && await isWikiDriftedFromHead(safeName, contents);
    // Nothing on disk to be behind or to have a capture against. A viewer's target that lags a
    // cached copy was deleted rather than saved, and asking to recover edits into it would offer
    // the pages the import just read back as changes a person made.
    if (!unwritten && tracksUnsavedEdits(name)) {
      if ((await prepareDirtyRecovery(safeName, dirtyAnswer)) === 'later') {
        busy = false;
        status = copy.status.editsKept;
        return;
      }
    }
    // A shim has no browser handle to offer, only a path, so it hands the saver a handle of
    // its own that carries the path: that is what makes a save write back where the file came
    // from instead of opening a picker on every save.
    const shimHandle = !handle && path && shimToken ? { name: safeName, path, __lithicShimPath__: path } : undefined;
    if (typeof window !== 'undefined') {
      const target = handle ?? shimHandle;
      if (target) {
        (window as any).__LITHIC_FILE_HANDLE__ = target;
      } else {
        delete (window as any).__LITHIC_FILE_HANDLE__;
      }
    }
    if (isHtmlMonolith) {
      // HTML monoliths are complete wiki pages. Serve them as-is, with an
      // HTML-mode saver injected that writes the page back (legacy parity).
      // The path travels with it so the saver targets the file the user
      // actually opened, not a handoff left behind by an earlier mount.
      // In the browser-storage fallback there is no file to write back to, so the
      // serialized page goes into the monolith's own recents row instead.
      stageBeat?.stage('wiki', safeName);
      await bootLegacyHtml(contents, safeName, path, indexDbOnly, shimToken);
      // The mount replaced this document, and `document.open` took its listeners with it: the
      // share ask is armed again on the document that is now showing.
      armShareWatch();
      return;
    }
    const handoff = { name: safeName, path, text: contents, ...(unwritten ? { unwritten: true } : {}) };
    // The legacy `?mount` handoff, offered to the session store rather than forced on it: this
    // line used to put the whole document into a key with a few megabytes to spend, which is what
    // made a 10 MB Lith fail its own mount with `QuotaExceededError`. See writeHandoff.
    writeHandoff(handoff);
    const scratchKind: ScratchKind | null = resolveScratchKind(safeName);
    const scratchMode = isScratch && scratchKind ? scratchKind : undefined;
    // This window stops being a launcher here, and saying so first is what keeps an install on
    // another window from closing this one: only a window that is still saying `launcher` is
    // ever asked to close, and a window that has a Lith open says which Lith instead (see
    // `instances` in the Rust side). Said before the document is handed over, not after,
    // because after is a document the engine owns.
    stageBeat?.stage('wiki', safeName);
    // Drain whatever the user queued via drop / share URL / intro.
    // The engine boots in place (document.open/write/close), keeping the
    // launcher URL in the address bar and preserving window globals; the
    // globals are also injected defensively so integrations that read them
    // (e.g. the Ephemeral runner's __EPHEMERAL_MODE__ hint) work regardless
    // of the boot path.
    await bootLegacyWiki(handoff, [...pendingImports, ...extraTiddlers], {
      __EPHEMERAL_MODE__: mode === 'self-host' ? 'self-host' : 'paper-light',
      __LITHIC_LAUNCHER_MODE__: mode
    }, { driftedFromHead, scratchMode, remote, browserOnly: indexDbOnly, shimToken, openBoardFor });
    // Same as the monolith branch above: the engine booted in place, so the share ask is armed
    // again on the document it wrote.
    armShareWatch();
    pendingImports = [];
    skippedImports = [];
    intentionalImports = [];
  }

  async function blankLith() {
    busy = true;
    status = copy.status.loadingBlank;
    try {
      await mountWiki('', 'new.lith');
    } catch (error) {
      mountError = error instanceof Error ? error.message : String(error);
      reportHeld(copy.status.blankLithFailed);
      busy = false;
    }
  }

  function openNewLithModal() {
    newLithName = '';
    newLithError = '';
    showNewLithModal = true;
    setTimeout(() => newLithInputElement?.focus(), 0);
  }

  function closeNewLithModal() {
    showNewLithModal = false;
  }

  // New Blank Lith prompts for a name (unifying local mode with the legacy
  // self-host / WebDAV flow), then hydrates $:/SiteTitle with the filename
  // (sans extension) as the blank-lith placeholder.
  // Enter (on the input) and the inset checkmark both route through here so a
  // collision with an existing recent lith blocks creation with a message.
  function submitNewLith() {
    if (newLithTaken) {
      newLithError = copy.newLith.takenError;
      return;
    }
    if (isSelfHost()) {
      void createRemoteLith(newLithName);
      return;
    }
    createBlankLith();
  }

  async function createBlankLith() {
    const safeName = normalizeLithName(newLithName);
    // The title is the name without its extension, whichever extension this build writes.
    const siteTitle = documentStem(safeName);
    showNewLithModal = false;
    busy = true;
    status = copy.status.loadingBlank;
    try {
      await mountWiki('', safeName, undefined, undefined, [{ title: '$:/SiteTitle', text: siteTitle }]);
    } catch (error) {
      mountError = error instanceof Error ? error.message : String(error);
      reportHeld(copy.status.blankLithFailed);
      busy = false;
    }
  }

  /**
   * The one button's two jobs, decided by the mode rather than offered as a choice.
   *
   * On a device with files, mounting a Lith means opening one from disk and working on it
   * there. A self-hosted instance has no such Lith to open: the server's store *is* the
   * library, so the useful direction is the other one. Send a file up and open it from the
   * server. A local file opened *in* self-host mode would be a Lith from another mode's
   * world sitting in this one's list, which is what this mode deliberately does not do.
   *
   * A Lith is a file, so the dialog picks several where the platform can name them
   * afterwards. One file is what the button promises (add it and open it) so that is
   * what happens, with nothing in between. Several files are a list rather than a
   * decision: they are all added to Recents and none of them is opened, because the
   * picker answered the question "which Liths are mine" and not "which one am I reading".
   * The list is already the mechanism for opening one of several, so nothing has to be
   * asked here: pick them all up in one trip, then click the row you want.
   */
  async function mountFromDisk() {
    if (mode === 'self-host') return uploadLithToServer();
    busy = true; status = copy.status.opening;
    try {
      const picks = await files.openMany();
      if (picks.length === 0) { status = ''; return; }
      if (picks.length === 1) {
        const [only] = picks;
        // The picker named the file; the bytes are read here, once, for the one Lith
        // that is about to be opened. A multi-file pick never gets this far.
        const text = await files.readText(only);
        lithText = text; fileName = only.name; filePath = only.path;
        await mountWiki(text, only.name, only.path, only.handle);
        status = copy.status.mounted(only.name);
        return;
      }
      // In reverse, because every row goes to the head of the list: folding the last
      // pick in last leaves the list reading in the order the dialog listed them. A
      // pick with no path and no handle could never be reopened from its row, so it is
      // not one. The browser whose picker can only answer that way is offered a single
      // file instead.
      for (const pick of [...picks].reverse()) {
        if (!pick.path && !pick.handle) continue;
        await remember(pick);
      }
      // No full stop: the status line strips trailing punctuation, because the
      // activity dots sit right after it.
      status = copy.status.added(picks.length);
    } catch (error) {
      // A chooser the platform never drew is not a failure of a file: it is a page that cannot
      // ask for one, and the sentence that helps is the address this page is served from. The
      // `Opening` line goes with it, because nothing was ever being opened.
      const refused = refusedPicker(error);
      if (refused) status = '';
      reportHeld(refused ?? copy.status.openFailed(error instanceof Error ? error.message : String(error)));
    }
    finally { busy = false; }
  }

  /**
   * Put the picked files on the server, then open one of them from there.
   *
   * Uploads land as `.lith` by the same rule the create path uses, and the list is re-read
   * before opening, because a Lith that is on the server but not in the list is one nobody
   * could find again. An upload over a name the server already holds replaces it, and since
   * that copy exists nowhere else (this mode keeps no local recents to fall back on) it is
   * asked about first, in the one colour this app uses for an act that cannot be undone.
   *
   * Every picked file goes up, because putting files on the server is what this button is
   * for and one trip through the picker should not cost one trip per file. Which of them
   * is opened is decided the same way it is on a device: one file is what the button
   * promises, so it opens; several are a list, so they are uploaded and none is opened,
   * and the list the server answers with is how one of them is read next.
   */
  async function uploadLithToServer(): Promise<void> {
    busy = true; status = copy.status.opening;
    try {
      const picks = await files.openMany();
      // A dismissed chooser is an answer, and the control has to come back: this branch used to
      // return with `busy` still set, which left the mount button disabled for the rest of the
      // session after nothing more than closing a dialog.
      if (picks.length === 0) { status = ''; busy = false; return; }
      // A Lith lands under the server's name for it, so everything said about the
      // uploads below (the replace question and the progress line) uses that name.
      const uploaded = picks.map((pick) => ({ ...pick, name: lithUploadName(pick.name) }));
      // One question for the batch, and it names exactly the files it would replace.
      const clashes = uploaded.filter((pick) =>
        remoteFiles.some((file) => file.name.toLowerCase() === pick.name.toLowerCase())
      );
      if (clashes.length > 0) {
        status = ''; busy = false;
        const replace = await askConfirmation({
          title: clashes.length === 1 ? copy.status.replaceOne : copy.status.replaceMany,
          body: clashes.length === 1
            ? copy.status.replaceBodyOne(clashes[0].name)
            : copy.status.replaceBodyMany(clashes.map((pick) => pick.name).join(', ')),
          confirmLabel: copy.status.replaceConfirm,
          danger: true
        });
        if (!replace) return;
        busy = true;
      }
      status = copy.status.uploading(uploaded.map((pick) => pick.name));
      for (const pick of uploaded) {
        await uploadRemoteFile(pick.name, await files.readText(pick));
      }
      await refreshRemoteList();
      busy = false;
      if (uploaded.length > 1) {
        // A list, not a decision: the uploads are the work and the list below is how
        // one of them is opened, so nothing opens by itself here.
        status = copy.status.uploaded(uploaded.length);
        return;
      }
      await openRemoteFile(uploaded[0].name);
    } catch (error) {
      const refused = refusedPicker(error);
      if (refused) status = '';
      remoteError = refused ?? copy.status.uploadFailed(error instanceof Error ? error.message : String(error));
      busy = false;
    }
  }

  /**
   * What a refused chooser says instead of a failure about a file.
   *
   * A platform that never drew a chooser has told us nothing about the Lith, and saying so would
   * send somebody looking at their file. The address is this page's own, so the sentence names the
   * one place the same page works: a browser, which is where a file input is not inert. Android's
   * captive portal window is the case, and the address is also the fact worth having in hand when
   * the phone is on mobile data and cannot reach it (see `PICK_REFUSAL_MS`).
   */
  function refusedPicker(error: unknown): string | null {
    if (!(error instanceof PickerUnavailableError)) return null;
    pickerRefused = true;
    return copy.status.pickerUnavailable();
  }

  /**
   * This page's own address, asked for where it can actually open a file picker.
   *
   * Chrome's intent syntax is the one hand-off a page in a window that refuses a chooser can still
   * make, and it was measured on the board: a plain link to another host, a new window and a link
   * to the board under another name all stayed in the window, while an intent reached a browser
   * with the page loaded and its picker working.
   *
   * The app is named first, because where it is installed the page opens in a window of its own
   * with no address bar, and the app answers a picker itself. Nothing has to detect which phone
   * this is: the intent names the app and carries the browser as its fallback, so a phone without
   * it lands in Chrome exactly as it did before. Inside the app the order flips, because there the
   * app is the window that cannot pick and naming it would bring it forward onto itself.
   */
  function mountHandoff(): string {
    return handoffIntent(location, openedInApp(location) ? 'browser' : 'app');
  }

  /**
   * Open the board the app was started for, when it was started for one.
   *
   * A tap in the board's sign-in window reaches the app two ways: as the intent that launched it, or
   * as an intent handed to a copy already running in the background. Both end here, because this is
   * asked once at boot and again every time the page is shown.
   *
   * The board page then runs in this window with the marker the app put on it, which is what it
   * reads to know that a refused chooser should be handed to a browser rather than back here.
   */
  async function openHandedBoard(): Promise<void> {
    if (mode !== 'tauri') return;
    let link: string | null = null;
    try {
      link = await tauriInvoke<string | null>('take_deep_link');
    } catch {
      // A build with no such command is a build from before the app could be handed anything.
      return;
    }
    const board = boardFromDeepLink(link);
    if (board) location.assign(board);
  }

  /**
   * Take what another app shared into this one, when one did.
   *
   * The phone's own share sheet is how content arrives from outside: a link out of a browser, a
   * paragraph out of a reader, the text of anything at all. The app receives it as an intent
   * (`MainActivity`), holds it beside the board hand-off, and this is the page asking for it. The
   * answer is consumed when read, so a reload is not handed the same share twice.
   *
   * Where it goes is decided by what this window is showing, and there are only two answers.
   *
   * A Lith that has taken the window over takes the share, through its own import view, because
   * the panel is not on screen there: the person is reading a document, and the note belongs in
   * the one they have open or nowhere. That is also why the share cannot simply be queued while a
   * Lith is showing, which is what this used to do: the queue drains into the *next* mount, so a
   * share into an open Lith was held until the person saved and closed the thing they were
   * already in, and nothing on screen said so.
   *
   * A window showing the launcher queues it in the panel, which is unchanged and is the right
   * destination there: the person picks which Lith it belongs in, or starts a new one, and every
   * mount drains the queue into whatever opens.
   *
   * The conversion is the same one either way (`sharedPayload`), so a share becomes the same
   * tiddlers it would have become had it waited.
   *
   * A build with no such command, and every desktop, answer nothing, so this is silent where the
   * platform has no share sheet to receive from.
   */
  async function openHandedShare(): Promise<void> {
    if (mode !== 'tauri') return;
    let shared: { text?: string; title?: string } | null = null;
    try {
      shared = await tauriInvoke<{ text?: string; title?: string } | null>('take_shared_text');
    } catch {
      return;
    }
    if (!shared) return;
    const payload = sharedPayload(shared.text ?? '', shared.title ?? '');
    if (payload.length === 0) return;
    // Asked of the window rather than of any state kept here: a Lith is in this window exactly
    // when this window carries its `$tw`, and that is the same question the delivery itself has
    // to answer (`open-wiki-import.ts`).
    if (importIntoOpenWiki(payload, (window as any).$tw)) return;
    enqueuePending(payload);
    status = copy.pending.sharedReady(payload.length);
  }

  /**
   * Ask for a share whenever this page is shown.
   *
   * Its own handler rather than a line in `onVisibilityChange`, because it is the one listener
   * that has to outlive a mount. A share brings the app forward instead of starting it, so there
   * is no boot to hang this on, and the ask has to be armed on the document that is showing.
   * Measured in Chromium: a listener registered on the document is gone once the engine has taken
   * it (the same Document object comes back with an empty body, so it is the document that was
   * emptied and not a new one), and a listener registered afterwards is reached by the next event.
   * Without this second arming, a Lith that has just taken the window would never read a share.
   * Arming the same function twice is safe either way, because `addEventListener` ignores it.
   */
  function armShareWatch(): void {
    document.addEventListener('visibilitychange', onShareVisible);
  }

  function onShareVisible(): void {
    if (document.hidden) return;
    void openHandedShare();
  }

  async function openRecent(
    recent: RecentEntry | { name?: string; path?: string; text?: string; handle?: any },
    /**
     * The history trail's own Recover starts this mount with the unsaved-edit gate already
     * answered, and asks for silence on failure because it has a second rung to try: a Lith
     * whose file cannot be read can still be rebuilt from its last saved copy, and a sentence
     * about the file would be answered a moment later by the copy that worked. Every other
     * caller passes nothing and keeps today's messages.
     */
    opts: { dirtyAnswer?: 'merge'; quietFail?: boolean } = {}
  ): Promise<boolean> {
    busy = true;
    status = copy.status.openingRecent;
    try {
      const rawHandle = (recent as any).handle;
      const tauriPath = recentDiskPath(recent);
      // A Lith that lives only in this browser's storage (or any row this
      // platform could not write back to a file) mounts *writable*, from the
      // cached copy, so the next save lands in the same place it came from.
      // The cache is read in preference to the row, because the cache is what
      // every save has been updating.
      if ((recent as any).browserOnly === true || (indexDbOnly && !rawHandle?.getFile && !tauriPath)) {
        const name = getEntryName(recent);
        const cached = isHtmlMonolithName(name) ? '' : await getSearchCacheText(name);
        const text = cached || (recent as any).text || '';
        await mountWiki(text, name, undefined, undefined, [], null, undefined, { dirtyAnswer: opts.dirtyAnswer });
        status = copy.status.mounted(name);
        return true;
      }
      // A row with a disk path is read through whichever process can: the app's Rust bridge
      // under Tauri, the shim's wire when a shim served this page. A shim handle carries a
      // path and no `getFile`, so it belongs here rather than in the browser-handle block.
      if ((mode === 'tauri' || shimToken !== null) && tauriPath) {
        return await mountDiskPath(tauriPath, undefined, opts);
      }
      if (mode === 'tauri' && !rawHandle?.getFile) {
        // A handle-less or pseudo-handle row with no path can't be opened:
        // browser handles don't exist in this WebView.
        if (!opts.quietFail) reportHeld(copy.status.noPath);
        return false;
      }
      // The same dead end on a shim: a handle with no resolvable path has nothing to read.
      if (shimToken !== null && rawHandle && !rawHandle.getFile) {
        if (!opts.quietFail) reportHeld(copy.status.noPath);
        return false;
      }
      const handle = rawHandle;
      if (handle) {
        if (handle.queryPermission) {
          const options = { mode: 'read' };
          if ((await handle.queryPermission(options)) !== 'granted') {
            await handle.requestPermission(options);
          }
        }
        const file = await handle.getFile();
        const text = await file.text();
        await mountWiki(text, file.name, recentDiskPath(recent) ?? undefined, handle, [], null, undefined, { dirtyAnswer: opts.dirtyAnswer });
        status = copy.status.mounted(file.name);
        return true;
      }
      if ((recent as any).text !== undefined) {
        lithText = (recent as any).text;
        fileName = (recent as any).name || 'untitled.lith';
        filePath = recentDiskPath(recent) ?? undefined;
        status = copy.status.mounted(fileName);
        await mountWiki(lithText, fileName, filePath, undefined, [], null, undefined, { dirtyAnswer: opts.dirtyAnswer });
        return true;
      } else if (recentDiskPath(recent) && mode === 'tauri') {
        // Tauri recents opened through the save dialog carry only a disk
        // path (no cached text). Read fresh from disk so in-place edits
        // made outside the app are picked up.
        return await mountDiskPath(recentDiskPath(recent) as string, undefined, opts);
      } else {
        // Nothing left to open it from: the row has no path this build can read and
        // no body to mount. The case a store too small to mirror a large Lith leaves
        // behind (`persistRecentRows`). Said out loud rather than left as a click that
        // does nothing, which is what it looked like from the outside.
        if (!opts.quietFail) reportHeld(copy.status.noPath);
        return false;
      }
    } catch (error) {
      if (!opts.quietFail) reportHeld(copy.status.openFailed(error instanceof Error ? error.message : String(error)));
      return false;
    } finally {
      busy = false;
      showRecent = false;
    }
  }

  /**
   * Open a file by absolute disk path. The Tauri startup-file handoff
   * (CLI arg or "Open with" association) and the recents list both land
   * here. Reads through the Rust bridge, then mounts as lith or scratch.
   */
  async function openTauriPath(path: string) {
    if (busy) return;
    busy = true;
    status = copy.status.opening;
    try {
      await mountDiskPath(path);
    } finally {
      busy = false;
    }
  }

  /**
   * The kinds of associated file this app imports rather than edits.
   *
   * A PDF is rendered into pages, an EPUB is split into a chapter per spine document, and an
   * image is drawn on a board. None is a document body, so each has to be told apart before
   * anything reads it as text, and the three share everything after that: a Lith is written
   * beside the file, the bytes travel to the engine, and the importer's own converter does the
   * work there, so a double-click and a drop produce the same tiddlers.
   *
   * `jpg` is the same format as `jpeg` under the extension most cameras write, and both are
   * registered, so both have to arrive here.
   */
  type ImportKind = 'pdf' | 'epub' | 'image';

  function importKindOf(path: string): ImportKind | null {
    if (/\.pdf$/i.test(path)) return 'pdf';
    if (/\.epub$/i.test(path)) return 'epub';
    if (/\.(png|jpe?g|bmp|webp)$/i.test(path)) return 'image';
    return null;
  }

  /**
   * The window property each converter is handed on, one per kind.
   *
   * A window property rather than a tiddler, because the payload is a whole file and the store is
   * not a place to carry one, and a separate key per kind because the engine reads one and never
   * the others: one gesture is one file, and a startup that had to sniff the bytes would be
   * guessing (see `pdf-open-request.js`, which takes each of these).
   */
  const IMPORT_REQUEST: Record<ImportKind, string> = {
    pdf: '__LITHIC_PDF_IMPORT__',
    epub: '__LITHIC_EPUB_IMPORT__',
    image: '__LITHIC_IMAGE_IMPORT__'
  };

  /** The name each kind falls back to when a path carries none of its own. */
  const IMPORT_FALLBACK_NAME: Record<ImportKind, string> = {
    pdf: 'document.pdf',
    epub: 'book.epub',
    image: 'image.png'
  };

  /**
   * The container the import names after the file: its name without the extension.
   *
   * The importer derives its own titles from the file the same way (`paper.pdf` becomes a
   * container `paper` holding `paper-text` and `paper-whiteboard`, and `photo.png` becomes
   * `photo` holding `photo-whiteboard`), so this is that name and not a second rule. It travels
   * with the mount so the engine can open the board under it when that file is what a person
   * opened (see `openBoardFor`).
   */
  function importContainerTitle(path: string): string {
    const name = path.split(/[\\/]/).pop() || '';
    return name.replace(/\.(?:pdf|png|jpe?g|bmp|webp)$/i, '');
  }

  /**
   * Import the file into the Lith that sits beside it: a PDF's pages, a book's chapters, or an
   * image on a board.
   *
   * Nothing here renders anything: the three converters live in the wiki, so the launcher reads
   * the file's bytes, hands them to the mounted document, and the importer's own startup turns
   * them into the tiddlers. The source file itself is only ever read.
   *
   * The sibling is not written and not listed: reading a PDF or a book through this app is a view
   * of that file, and a file on the desktop for every look is clutter nobody asked for. The path
   * is where a save will go, so the file the first save creates is the one `import_lith_target`
   * would have answered with on the next open, and the row arrives with it (see `mount.unwritten`
   * below).
   */
  async function importIntoNewLith(sourcePath: string, lithPath: string, kind: ImportKind) {
    const sourceName = sourcePath.split(/[\\/]/).pop() || IMPORT_FALLBACK_NAME[kind];
    const lithName = lithPath.split(/[\\/]/).pop() || `${importContainerTitle(sourceName) || 'document'}.lith`;
    // The bytes are read before anything is mounted, so a file this process cannot read opens no
    // document at all rather than one holding a failed import.
    const base64 = await tauriInvoke<string>('read_file_base64', { path: sourcePath });
    (window as any)[IMPORT_REQUEST[kind]] = {
      filename: sourceName,
      base64
    };
    lithText = '';
    fileName = lithName;
    filePath = lithPath;
    await mountWiki('', lithName, lithPath, undefined, [], null, undefined, { unwritten: true });
  }

  /**
   * Read a path through whichever process can, then mount it. The app reads through its Rust
   * bridge; a shim reads through its own wire, which is the same shape of answer: a name, the
   * path and the text. Callable while a mount is already in flight.
   */
  async function mountDiskPath(
    path: string,
    openBoardFor?: string,
    /** The history trail's Recover, on its first rung: the same answer and the same silence. */
    opts: { dirtyAnswer?: 'merge'; quietFail?: boolean } = {}
  ): Promise<boolean> {
    try {
      const kind = importKindOf(path);
      if (kind) {
        // Before the text read below, which none of these has any business going through: a
        // PDF's pages, a book's chapters or an image's pixels are turned into a Lith beside the
        // file instead of being mounted as a body.
        const target = await tauriInvoke<{ path: string; exists: boolean }>('import_lith_target', { file: path });
        if (target.exists) {
          // This file has already become a Lith, so the copy opens as it stands. Re-importing
          // would replace whatever has been written in it since it was made.
          //
          // The gesture was still `open the PDF` or `open the image` though, and what that means
          // is the board rather than the layout that Lith was last saved in, so the container the
          // import wrote travels along and the engine opens the board. Opening that same Lith on
          // its own, from the recents list or a Mount, carries no container and leaves it exactly
          // as it says. A book has no container to force open: its sibling is the whole book, so
          // `open the EPUB` means the Lith as it says, at whatever chapter it was left on.
          return await mountDiskPath(target.path, kind === 'epub' ? undefined : importContainerTitle(path), opts);
        }
        await importIntoNewLith(path, target.path, kind);
        status = copy.status.mounted(fileName);
        return true;
      }
      const result =
        mode === 'tauri'
          ? await tauriInvoke<{ name: string; path: string; text: string }>('read_lith_path', { path })
          : await (async () => {
              const read = await shimRead(path, { token: shimToken });
              if (!read.ok) throw new Error(read.error);
              return read.value;
            })();
      lithText = result.text;
      fileName = result.name;
      filePath = result.path;
      await mountWiki(result.text, result.name, result.path, undefined, [], null, openBoardFor, { dirtyAnswer: opts.dirtyAnswer });
      status = copy.status.mounted(result.name);
      return true;
    } catch (error) {
      if (!opts.quietFail) reportHeld(copy.status.openFailed(error instanceof Error ? error.message : String(error)));
      return false;
    }
  }

  async function openIntro() {
    if (busy || introBusy) return;
    introBusy = true;
    try {
      try {
        const target = window.location.protocol === 'file:'
          ? 'https://raw.githubusercontent.com/Xyvir/Lithic-UK/refs/heads/main/intro.lith'
          : '/intro.lith';
        const response = await fetch(target);
        if (response.ok) {
          const text = await response.text();
          const parsed = parsePayloadText(text);
          if (parsed.length > 0) {
            pendingImports = tagRootDogear(parsed);
            await blankLith();
            return;
          }
        }
      } catch {
        // Fall through to the online introduction below.
      }
      if (navigator.onLine) {
        openExternally('https://lithic.uk/intro.html');
      } else {
        mountError = copy.status.introFailed;
      }
    } finally {
      introBusy = false;
    }
  }

  /**
   * Add payloads to the queue, refusing a copy whose title is already queued.
   *
   * The wiki keeps one tiddler per title and the last writer wins, so queueing both copies
   * would draw two rows for one tiddler and import only the second. The first copy stays and
   * `skippedImports` says which copy did not arrive, which is what lets the panel offer the
   * remedy (remove that row, then drop again) instead of leaving the difference silent.
   */
  function enqueuePending(payload: PendingTiddler[]): void {
    const result = queuePendingImports(pendingImports, payload);
    pendingImports = result.queued;
    skippedImports = result.refused;
  }

  /**
   * Start a Lith from a book dropped on the launcher.
   *
   * A book dropped here has no sibling to become: the launcher is the page before any document,
   * so the drop starts one, named the way the Lith beside a file is named. The chapters are made
   * by the importer inside the mounted document rather than here, so the bytes are read, encoded
   * and left on the window for the engine's startup to take, which is what a double-clicked book
   * does too (see `pdf-open-request.js`).
   */
  async function openDroppedBook(file: File) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    // A chunk at a time rather than one character per byte: a book runs to megabytes, and 32 KB
    // is under the argument count every browser accepts.
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    (window as any)[IMPORT_REQUEST.epub] = { filename: file.name, base64: btoa(binary) };
    const name = `${file.name.replace(/\.epub$/i, '')}_epub.lith`;
    lithText = '';
    fileName = name;
    filePath = undefined;
    await mountWiki('', name);
    status = copy.status.mounted(name);
  }

  async function handleDrop(event: DragEvent) {
    const droppedText = event.dataTransfer?.getData('URL') || event.dataTransfer?.getData('text/plain') || '';
    if (droppedText && isPayloadShareUrl(droppedText)) {
      try {
        const urlObj = new URL(droppedText);
        const b64Json = urlObj.searchParams.get('json') ?? urlObj.searchParams.get('lith');
        const remoteUrl = urlObj.searchParams.get('url');
        let payload: PendingTiddler[] | null = null;
        if (remoteUrl) payload = await fetchRemotePayload(remoteUrl);
        else if (b64Json) payload = decodePayloadParam(b64Json);
        if (payload && payload.length > 0) {
          enqueuePending(payload);
          return;
        }
      } catch {
        // Not a payload URL after all. Treat as a file drop below.
      }
    }

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    // Every file in the gesture is read, not just the first. Three dropped Liths are three
    // payloads queued, because the panel lists what will be merged and a person who dragged
    // three files expects to see three. Reading `files[0]` made the rest arrive nowhere.
    const queued: PendingTiddler[] = [];
    let wiki: File | null = null;
    let book: File | null = null;
    let unreadable = false;
    for (const file of Array.from(files)) {
      const lowerName = file.name.toLowerCase();
      if (/\.(?:lith|json)$/.test(lowerName)) {
        try {
          const contents = await file.text();
          // A dropped `.json` is read as an instance backup first, because that is the one file
          // whose contents are this device's own store rather than a document to open. Anything
          // that is not one falls through to the payload path below, which is what a `.json`
          // holding a tiddler array has always been.
          if (lowerName.endsWith('.json')) {
            const backup = parseInstanceBackup(contents);
            if (backup.ok) {
              await importInstanceBackup(backup.backup);
              continue;
            }
          }
          queued.push(...parseDroppedData(contents, lowerName.endsWith('.lith')));
        } catch {
          unreadable = true;
        }
      } else if (/\.(?:html?|htm)$/.test(lowerName) && !wiki) {
        // One page opens at a time, so the first wiki in a drop is the one that opens.
        wiki = file;
      } else if (lowerName.endsWith('.epub') && !book) {
        // One book at a time, for the same reason: a mount holds one document.
        book = file;
      }
    }
    if (queued.length > 0) {
      enqueuePending(queued);
    }
    if (unreadable) {
      mountError = copy.status.droppedInvalid;
    }
    if (wiki) {
      // The mount drains the queue, so a wiki dropped with documents beside it opens with
      // those tiddlers merged rather than leaving them queued behind a replaced page.
      try {
        await mountWiki(await wiki.text(), wiki.name);
      } catch (error) {
        mountError = error instanceof Error ? error.message : String(error);
      }
    } else if (book) {
      // A book dropped beside a page is not opened: the page is the document, and the second
      // mount would replace it.
      try {
        await openDroppedBook(book);
      } catch (error) {
        mountError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async function processUrlPayload() {
    const params = new URLSearchParams(window.location.search);
    const b64Json = params.get('json') ?? params.get('lith');
    const remoteUrl = params.get('url');
    if (!remoteUrl && !b64Json) return;
    let payload: PendingTiddler[] | null = null;
    try {
      payload = remoteUrl ? await fetchRemotePayload(remoteUrl) : decodePayloadParam(b64Json!);
    } catch {
      payload = null;
    }
    if (payload && payload.length > 0) {
      // Clear the query params to prevent a reload loop, then boot a fresh
      // wiki with the shared payload queued for injection.
      window.history.replaceState({}, document.title, window.location.pathname);
      pendingImports = payload;
      status = copy.pending.sharedReady(payload.length);
      await blankLith();
    } else {
      mountError = copy.status.payloadFailed;
      status = '';
    }
  }

  // --- Self-host: listing, opening, presence locks ---------------------------

  /**
   * The self-host server is same-origin by construction, so "the remote" in
   * this mode is always the origin serving this page.
   */
  function isSelfHost(): boolean {
    return mode === 'self-host';
  }

  /**
   * Ask what is serving this page, once, at boot.
   *
   * One question with one consequence: an appliance answers with its own name and the heading
   * draws no round control, while every instance answers 404 and keeps the backup control it has
   * always had. Asked at boot because the heading is the first thing the page draws, and a
   * control that changes its meaning after the first paint was drawn saying the wrong thing.
   */
  async function refreshAppliance(): Promise<void> {
    appliance = await probeAppliance();
  }

  /**
   * List the server's Liths and ask whether it exposes the git-backed patch
   * API. An older deployment answers 404 and simply lists with whole-file
   * saves, so a failure here degrades rather than blocks.
   */
  async function refreshRemoteList(): Promise<void> {
    if (!isSelfHost()) return;
    remoteBusy = true;
    remoteError = '';
    try {
      patchApiAvailable = await probePatchApi();
      remoteFiles = await fetchRemoteFiles();
      remoteUnreachable = false;
    } catch (error) {
      remoteFiles = [];
      // Nothing answered: that is offline mode, and the banner says why better than a
      // raw fetch error can, so the error line stands down and the list below becomes
      // this device's own. A refusal is the opposite case -- the instance is talking to
      // us -- and keeps its message, which is the only thing that explains it.
      remoteUnreachable = looksUnreachable(error);
      remoteError = remoteUnreachable || !online
        ? ''
        : copy.status.listingFailed(error instanceof Error ? error.message : String(error));
    } finally {
      remoteBusy = false;
    }
  }

  function remoteNameTaken(name: string): boolean {
    return remoteFiles.some((file) => file.name.toLowerCase() === name.toLowerCase());
  }

  /**
   * Open a Lith from the server. With the patch API the fetch also returns the
   * digest the server will check the next patch against; without it the wiki
   * still opens, and saves fall back to whole-file PUTs.
   */
  async function openRemoteFile(name: string): Promise<void> {
    if (busy) return;
    busy = true;
    remoteError = '';
    status = copy.status.openingName(name);
    // readRemoteLock is failure-tolerant by design: a lock check that cannot
    // run (or a stale/own lock) returns null, so the open proceeds normally.
    const lock = await readRemoteLock(name, resolveSessionId());
    if (lock) {
      // Someone else's lock is live. Legacy parity: offer a read-only open
      // (claims no lock, installs no saver) instead of a yes/no prompt that
      // would otherwise silently overwrite their copy.
      busy = false;
      status = '';
      remoteCollision = { name, who: lock.user || '' };
      return;
    }
    remoteNotice = '';
    await mountRemoteFile(name);
  }

  /**
   * Fetch a remote Lith and mount it. A read-only mount claims no lock and
   * installs no saver, so the other session keeps their lock and nothing here
   * can write over their copy. The legacy "Open Read-Only" path.
   */
  async function mountRemoteFile(name: string, readOnly = false): Promise<void> {
    busy = true;
    remoteError = '';
    status = copy.status.openingName(name);
    try {
      let text: string;
      let digest = '';
      let fetchedFromServer = true;
      if (patchApiAvailable) {
        // This device's own copy first. One metadata read says whether the instance is still on
        // the revision that copy was taken from, and when it is, the file never crosses the wire
        // at all. Which is the point of keeping the fetched text beside its digest. With no copy
        // to compare, the metadata read could only tell us what the file's digest is, so it is
        // skipped and the file is read as it always was.
        const known = await readFetchedLith(name);
        if (!known) {
          const remote = await fetchRemoteWiki(name);
          text = remote.text;
          digest = remote.digest;
        } else {
          const read = await fetchRemoteWikiMeta(name);
          if (read.state === 'unchanged' && read.meta.digest === known.digest) {
            text = known.text;
            digest = read.meta.digest;
            fetchedFromServer = false;
          } else {
            // Either the file moved on, or this instance is older than the metadata read and
            // answered with the file itself. Which is the read that was about to be made anyway.
            const wiki = read.state === 'file' ? read.wiki : await fetchRemoteWiki(name);
            text = wiki.text;
            digest = wiki.digest;
          }
        }
      } else {
        const response = await fetch(webdavUrl(name));
        if (!response.ok) throw new Error(`GET failed: ${response.status}`);
        text = await response.text();
      }
      if (fetchedFromServer) {
        // A Lith this device has never cached is indexed from the copy just fetched, which is what
        // makes a first open searchable and gives it an offline copy. A record that already holds
        // text keeps it: that text is the baseline the drift check compares against, and rewriting
        // it on every open would retire the notice it exists to raise.
        if (!(await getSearchCacheText(name))) {
          await saveSearchCache(name, JSON.stringify(parseLithToJSON(text)));
        }
        await rememberFetchedLith(name, { text, digest });
      }

      activeRemote = { name, digest, api: patchApiAvailable && Boolean(digest) };
      if (readOnly) {
        stopLockHeartbeat();
        status = copy.status.mountedReadOnly(name);
      } else {
        await startLockHeartbeat(name);
        status = activeRemote.api ? copy.status.mountedPatched(name) : copy.status.mounted(name);
      }
      await mountWiki(text, name, undefined, undefined, [], {
        fileName: name,
        baseText: text,
        digest,
        apiAvailable: activeRemote.api,
        readOnly
      });
    } catch (error) {
      activeRemote = null;
      stopLockHeartbeat();
      remoteError = copy.status.openNameFailed(name, error instanceof Error ? error.message : String(error));
      busy = false;
    }
  }

  /** Apply the user's choice from the active-session dialog. */
  function resolveRemoteCollision(choice: 'read-only' | 'ignore'): void {
    const collision = remoteCollision;
    if (!collision) return;
    remoteCollision = null;
    remoteNotice = choice === 'ignore' && collision.who ? `${collision.who} also has this Lith open.` : '';
    void mountRemoteFile(collision.name, choice === 'read-only');
  }

  /**
   * Claim a Lith on the server and mount it blank. The name is PUT first so the
   * patch API has a file to diff against, and so two launchers cannot silently
   * create the same Lith.
   */
  async function createRemoteLith(rawName: string): Promise<void> {
    const name = lithUploadName(normalizeLithName(rawName));
    showNewLithModal = false;
    remoteError = '';
    busy = true;
    status = copy.status.creating(name);
    try {
      await uploadRemoteFile(name, '');
      await refreshRemoteList();
      busy = false;
      await openRemoteFile(name);
    } catch (error) {
      remoteError = copy.status.createFailed(name, error instanceof Error ? error.message : String(error));
      busy = false;
    }
  }

  /**
   * Delete a Lith from the server, and only after being asked.
   *
   * The legacy store put a × on every row of the remote list and its answer was
   * `window.confirm`; the act behind it is the same and the answer is now the app's own
   * dialog, so the question looks like it came from the launcher it interrupts. It is
   * asked at all because this is the one control here that reaches every other reader of
   * the instance: the file is gone from the server, not from a copy held on this device,
   * and nothing in this mode holds one. The row is not dropped here. The list is the
   * server's answer, so it is re-read and the row leaves when the server stops naming it.
   *
   * The presence lock goes with it, best effort, exactly as the legacy delete did: a Lith
   * nobody has open has no lock file, and a missing one is not a failed delete.
   */
  async function removeRemoteLith(name: string): Promise<void> {
    const confirmed = await askConfirmation({
      title: copy.status.deleteTitle,
      body: copy.status.deleteBody(name),
      confirmLabel: copy.status.deleteConfirm,
      danger: true
    });
    if (!confirmed) return;
    remoteError = '';
    remoteNotice = '';
    busy = true;
    status = copy.status.deleting(name);
    try {
      await deleteRemoteFile(name);
      void fetch(`${webdavUrl(name)}.lock`, { method: 'DELETE' }).catch(() => {});
      await refreshRemoteList();
    } catch (error) {
      remoteError = copy.status.deleteFailed(name, error instanceof Error ? error.message : String(error));
    } finally {
      status = '';
      busy = false;
    }
  }

  async function startLockHeartbeat(name: string): Promise<void> {
    stopLockHeartbeat();
    const heartbeat = createLockHeartbeat({ sessionId: resolveSessionId() });
    lockHeartbeat = heartbeat;
    // The mounted wiki is a rewrite of this document and cannot call back into
    // the launcher, so the injected `$:/lithic/startup/webdav-utils.js` startup
    // tiddler looks for this global to release the lock from inside the engine.
    (window as any).webdavStopHeartbeat = () => stopLockHeartbeat();
    await heartbeat.start(name);
  }

  function stopLockHeartbeat(): void {
    lockHeartbeat?.stop();
    lockHeartbeat = null;
  }

  // --- Instance icon: the emoji favicon this instance is known by ------------

  /**
   * Apply this instance's icon to the launcher header and the tab favicon.
   *
   * The icon is the instance's, so the instance is asked first: whoever set it, it is
   * the same mark for everyone who opens this address, which is the entire point of
   * telling instances apart. The answers are told apart. The store holding no choice
   * means the shipped mark, while an instance that cannot be asked at all falls back to
   * the mirror this browser keeps, so a deployment behind a broken proxy does not
   * silently lose an icon its owner picked. The mirror is then set to whatever the
   * instance said, so it can never outvote a later answer.
   */
  async function restoreInstanceIcon(): Promise<void> {
    const local = readInstanceEmoji();
    if (!isSelfHost()) {
      brandEmoji = local;
      applyFavicon(local ? emojiFaviconUrl(local) : null);
      return;
    }
    const fromServer = await readServerEmoji();
    brandEmoji = fromServer ?? local;
    applyFavicon(brandEmoji ? emojiFaviconUrl(brandEmoji) : null);
    if (fromServer === null) return;
    if (fromServer) saveInstanceEmoji(fromServer);
    else clearInstanceEmoji();
  }

  /**
   * Open the heading mark's dialog.
   *
   * Every mode opens it, which is the point: the picker inside is an instance's own job (an
   * appliance has none of the machinery behind it, so it draws no picker), and the docs link and
   * the full backup belong to every page. The desktop app draws no footer
   * link, so for that mode this is also the only way out to the project.
   */
  function openInstanceManagement(): void {
    emojiChoice = brandEmoji;
    emojiStatus = '';
    backupStatus = '';
    backupDownload = 'idle';
    flashProblem = '';
    showEmojiPicker = true;
  }

  /*
   * The grid's contents: `EMOJI_LIST`, with the instance's current icon in front of it
   * when that icon is not one of them. It can be: the list is a curated shortlist (42 glyphs
   * went on 2026-09-26), while what an instance carries is whatever was saved on it,
   * and a dialog that highlighted nothing while previewing the icon the instance is
   * actually using would read as broken rather than as a shortlist. The extra cell is the
   * choice itself, so it is the selected one, and it disappears the moment the choice
   * changes to something the list holds.
   */
  $: emojiGrid = EMOJI_LIST;

  function closeInstanceManagement(): void {
    showEmojiPicker = false;
    backupStatus = '';
    backupDownload = 'idle';
  }

  /** Preview on click: the header and tab update before anything is saved. */
  function chooseEmoji(emoji: string): void {
    emojiChoice = emoji;
    brandEmoji = emoji;
    applyFavicon(emojiFaviconUrl(emoji));
  }

  /**
   * Write the chosen emoji out as this instance's whole icon set. The emoji is
   * remembered locally even when the server write fails, so the choice still
   * disambiguates instances in this browser.
   */
  async function confirmEmojiIcon(): Promise<void> {
    if (!emojiChoice || emojiBusy) return;
    emojiBusy = true;
    saveInstanceEmoji(emojiChoice);
    brandEmoji = emojiChoice;
    applyFavicon(emojiFaviconUrl(emojiChoice));
    emojiStatus = copy.dialogs.icon.saving;
    const result = await uploadInstanceIcon(emojiChoice, {
      onProgress: (saved, total) => {
        emojiStatus = copy.dialogs.icon.savingProgress(saved, total);
      }
    });
    if (result.ok) {
      emojiStatus = copy.dialogs.icon.savedInstance(emojiChoice);
      bustIconCache();
    } else {
      emojiStatus = copy.dialogs.icon.savedHere(result.error ?? 'unknown error');
    }
    emojiBusy = false;
  }

  async function restoreDefaultInstanceIcon(): Promise<void> {
    clearInstanceEmoji();
    brandEmoji = '';
    // The dialog stays open, so it has to say what the icon is now: nothing selected in
    // the grid, and the preview above it showing the shipped mark instead of the emoji
    // that was just given up.
    emojiChoice = '';
    applyFavicon(null);
    // The set changed here too, and the header and the tab read those files rather than the
    // choice: the same doorbell the save path rings, for the same reason. The delay inside
    // it is also what gives the deployment's watcher time to publish the restored set.
    bustIconCache();
    emojiStatus = (await clearInstanceIcon()) ? copy.dialogs.icon.savedServer : copy.dialogs.icon.restoredHere;
  }

  /**
   * Cache each bookmark's own icon. Sequential on purpose: this runs on
   * launcher boot and must not stampede several instances at once. Only
   * missing or stale icons are actually fetched.
   */
  /** One instance icon, fetched through Rust, where CORS does not apply. */
  function nativeIconLoader(url: string): Promise<{ content_type?: string; bytes?: number[] } | null> {
    return tauriInvoke<{ content_type?: string; bytes?: number[] } | null>('fetch_instance_icon', { url });
  }

  async function refreshBookmarkIcons(): Promise<void> {
    for (const entry of readBookmarkEntries()) {
      // The desktop app fetches through Rust: a self-hosted instance normally
      // serves its favicon without `Access-Control-Allow-Origin`, and a response
      // the browser withholds cannot be cached as this entry's icon. That icon
      // is the point of the list. It is what tells a personal instance from a
      // work one at a glance.
      await refreshBookmarkIcon(
        entry.url,
        fetch,
        localStorage,
        Date.now(),
        mode === 'tauri' ? nativeIconLoader : undefined
      );
    }
    bookmarks = readBookmarkEntries();
  }

  /**
   * Ask Rust whether this address is a Lithic instance.
   *
   * Preferred in the desktop app, because the probe is cross-origin and a
   * self-hosted instance normally sends no `Access-Control-Allow-Origin`: the
   * browser is handed nothing at all, so its verdict is "could not verify" about
   * an instance that is answering perfectly well. Rust sees the real status.
   */
  async function verifyInstanceNatively(url: string): Promise<InstanceVerification> {
    try {
      const probe = await tauriInvoke<{ state: string; status: number }>('probe_instance', { url });
      if (probe.state === 'lithic') return { verified: true };
      // There, but asking for credentials: the user decides.
      if (probe.state === 'protected') return { verified: true, requiresManualConfirm: true };
      if (probe.state === 'unreachable') return { verified: false, unreachable: true };
      return { verified: false };
    } catch {
      // A desktop build older than the command: the browser path still verifies
      // instances that do send CORS headers.
      return verifyInstanceUrl(url);
    }
  }

  function openBookmarkModal() {
    bookmarkInput = '';
    bookmarkError = '';
    showBookmarkModal = true;
    setTimeout(() => bookmarkInputElement?.focus(), 0);
  }

  function closeBookmarkModal() {
    showBookmarkModal = false;
    bookmarkError = '';
  }

  /**
   * The saved logins, from the bookmark dialog.
   *
   * The manager lists and forgets, so nothing typed here is carried into it: a login
   * is saved from the key on a bookmark row, or from the offer an instance makes while
   * it is being opened, and both of those know the address already. The dialog closes
   * behind it anyway, because two overlays stacked on each other would leave Escape
   * and the outside-click both ambiguous.
   */
  function openSavedLoginsFromBookmarks() {
    closeBookmarkModal();
    openVaultModal();
  }

  async function addInstanceBookmark() {
    let normalized: string;
    try {
      normalized = normalizeInstanceUrl(bookmarkInput);
    } catch (error) {
      bookmarkError = error instanceof Error ? error.message : String(error);
      return;
    }
    try {
      const result = mode === 'tauri' ? await verifyInstanceNatively(normalized) : await verifyInstanceUrl(normalized);
      if (!result.verified) {
        bookmarkError = result.unreachable
          ? copy.dialogs.bookmark.unreachable
          : copy.dialogs.bookmark.notInstance;
        return;
      }
      if (result.requiresManualConfirm) {
        const confirmed = await askConfirmation({
          title: copy.dialogs.bookmark.unverifiedTitle,
          body: copy.dialogs.bookmark.unverifiedBody,
          confirmLabel: copy.dialogs.bookmark.unverifiedConfirm
        });
        if (!confirmed) return;
      }
      bookmarks = saveBookmark(normalized);
      // A newly bookmarked address can already have a login saved (it may have been
      // added by hand before the bookmark existed), so the row's key control has to
      // be told what the vault says about it.
      void refreshVaultCoverage();
      // Cache the instance's own icon so the meta-launcher list can tell
      // instances apart at a glance, and keep doing so offline.
      void refreshBookmarkIcons();
      closeBookmarkModal();
      reportAndRetire(copy.dialogs.bookmark.saved);
    } catch (error) {
      bookmarkError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * How this page can get back to the launcher that opened it, if it was opened
   * by one. Answered once: the document's own address (and the injected Tauri
   * global) do not change while it is open.
   */
  const launcherReturnTarget = launcherReturn(window.location);

  function openInstance(url: string) {
    window.location.href = url;
  }

  /**
   * Hand this window to a bookmarked instance. Unlike a recent file (whose URL
   * already says which instance it belongs to), an instance is reached at its
   * bare origin, so the handoff has to carry both what the destination is and
   * how to get back here. See `withLauncherHandoff` in mode.ts.
   */
  function backToLauncher() {
    if (!launcherReturnTarget) return;
    // Prefer the address we were handed; a marked page may have been reached
    // without ever visiting the launcher in this window (`history.back()` would
    // then leave the app entirely).
    if (launcherReturnTarget.kind === 'url') window.location.href = launcherReturnTarget.url;
    else window.history.back();
  }

  function removeInstanceBookmark(url: string, label: string) {
    bookmarks = removeBookmark(url);
    void refreshVaultCoverage();
    void dropBookmarkedCopy(url, label);
  }

  /**
   * The half of removing a bookmark that this page cannot do itself.
   *
   * The instance's downloaded copy (its launcher page, its scripts, its icons) sits
   * under the instance's own origin, which is another origin's storage to this page
   * however it asks (see `instance-copy.ts`). So the request goes to the app, which is
   * not a page and shares one profile with every origin the window has visited. Only the
   * page goes: the cached wikis, the instance's own settings and the saved login all stay,
   * and the last of those stays by design. Forgetting a login is the vault's own action.
   *
   * Nothing is said when nothing was lost, and nothing is said where this half was never
   * on offer: a row that goes quietly is the whole of what the × does there.
   */
  async function dropBookmarkedCopy(url: string, label: string) {
    if (mode !== 'tauri') return;
    const origin = vaultOriginOf(url);
    // An address with no readable origin is no copy to go looking for: a sentence about
    // the one it could not clear would be about the wrong thing entirely.
    if (!origin) return;
    // The row's own name, not one derived from the address: an entry carried over from
    // the legacy launcher can hold a path rather than a bare origin, and what the user
    // just threw away is the row they clicked, whatever its address looks like.
    const note = copyDropNote(label, await forgetInstanceCopy(origin));
    if (note) reportHeld(note);
  }

  /**
   * The Lith the history dialog's adaptive header is about: the one it lists
   * versions for, when that Lith sits outside every backed-up folder. Separate
   * from the row's own coverage test because the row no longer asks it. The
   * mark that opens this dialog is the same mark an unfinished or fallback row
   * carries, so the copy offer has to travel into the dialog with it.
   */
  $: historyLocalOnlyPath = (() => {
    if (!showHistoryModal || !showBackupStatus) return '';
    const row = recentFiles.find((item) => getEntryName(item) === historyName);
    const path = row ? recentDiskPath(row as any) : null;
    return path && localOnlyPaths.has(path) ? path : '';
  })();
  /** The folder that offer would copy into, named rather than promised. */
  $: historySyncedFolder = historyLocalOnlyPath ? syncedDirFor(recentRows(), backupRoots) ?? '' : '';
  /**
   * The unsaved-edit capture this dialog's Lith has, when it has one.
   *
   * The row's mark is amber for three different reasons, and this dialog already answered two
   * of them in its header: the fallback's claim, and the offer to copy a Lith that sits outside
   * every backed-up folder. Edits never saved to disk were the third, and they were the one
   * reason the mark had no answer at all: the trail below lists saves, so a Lith whose only
   * news was an unsaved edit opened onto a dialog that never mentioned it. Read from
   * `dirtyEntries` at render time rather than copied when the dialog opened, so a dialog left
   * open across a recovery stops claiming edits it no longer has.
   */
  $: historyUnsavedTs = showHistoryModal ? historyDirty?.ts ?? dirtyEntries[historyName] ?? 0 : 0;
  /**
   * The trail's rows: this Lith's unsaved capture first, then its saves, newest first.
   *
   * The capture is a row rather than a notice beside the title because the list is where a
   * reader looks for this Lith's states, and the wiki as it stands is one of them: edits no
   * save has written yet, badged `live` beside the `full` and `step` rows they are not.
   * Putting it in the list also gives it
   * the trail's own grammar, so the chevron and the distance below it say how long the edits
   * have been waiting since the save under them, and the row's own trailing control is the
   * download every other row has: what it hands over is the capture, which is a real file even
   * though it is not a version. The row is synthesised here instead of being stored, because
   * it is not a version: no id, no bytes, and it disappears with the capture rather than ageing
   * out of a capped list.
   */
  type HistoryRow = HistoryEntry & { inline?: boolean };
  // Each row's download mark, resolved here so the markup stays a plain loop, the way the
  // warning dialogs' rows resolve theirs.
  $: historyRows = (historyUnsavedTs
    ? [{ id: CAPTURE_ROW_ID, ts: historyUnsavedTs, sizeBytes: 0, lastModified: utcStamp(historyUnsavedTs), inline: true } as HistoryRow]
    : ([] as HistoryRow[])
  )
    .concat(historyEntries)
    .map((row) => ({ ...row, pill: orphanPill(historyDownloads[row.id] ?? 'idle') }));
  /** The row this dialog is about, when the list still has it. */
  $: historyRow = showHistoryModal ? recentFiles.find((item) => getEntryName(item) === historyName) ?? null : null;
  /**
   * Whether this row has a file a merge could write back to.
   *
   * Three shapes can: the browser's own handle (Chromium, and the only one that may still ask
   * for write permission), a path the app's Rust bridge can read and write, and a path on a
   * shim's wire. Everything else (the browser-only fallback, and a row whose file this build
   * cannot reach) has only the cached copy, which is the next question the rung asks.
   */
  function historyHasFile(row: RecentRow | null): boolean {
    if (!row) return false;
    const handle = (row as any).handle;
    if (handle && typeof handle.createWritable === 'function') return true;
    const path = recentDiskPath(row);
    return Boolean(path) && (mode === 'tauri' || shimToken !== null);
  }
  /**
   * Which rung merging is on, and therefore what the disclosure can promise.
   *
   * `file` is the ordinary case and needs no sentence: the edits land in the document they came
   * from. `copy` is a Lith with no reachable file, where the last saved copy in this browser is
   * the document, so merging still produces a proper version rather than nothing. `capture` is
   * both of those gone, where downloading the edits is the only thing that cannot make it worse
   * and Merge is refused rather than pressed into a dead end.
   */
  $: historyMergeRung = historyHasFile(historyRow)
    ? ('file' as const)
    : cachedEntries[historyName]
      ? ('copy' as const)
      : ('capture' as const);
  /**
   * Open the per-wiki version history modal. The history icon no longer
   * downloads a single cache blob. It lists every timestamped version
   * (deltas materialized on demand) and lets the user download any of them
   * as a non-destructive `<stem>_recover_<stamp>.lith` copy.
   */
  async function openHistoryModal(name: string, browserOnly = false) {
    historyName = name;
    historyEntries = [];
    historyDirty = null;
    historyCaptureOpen = false;
    historyCaptureSaving = false;
    historyNotice = '';
    historyDownloads = {};
    historyBrowserOnly = browserOnly;
    historyError = '';
    showHistoryModal = true;
    historyBusy = true;
    try {
      // The capture is read with the versions rather than on the press that opens the row: the
      // row has to name how many edits it holds the moment it is drawn, and a body that filled
      // in a moment later would reflow the dialog under the pointer.
      const [versions, capture] = await Promise.all([listWikiVersions(name), getDirtyState(name)]);
      historyEntries = versions;
      historyDirty = capture;
      // Saying "no saved versions" over a trail that is about to draw this Lith's unsaved
      // capture would read as a dead end, and it is one thing this dialog now has: when the
      // capture is the only row there is, the row is the answer the old sentence denied.
      if (versions.length === 0 && !capture && !dirtyEntries[name]) historyError = copy.status.noHistory;
    } catch (error) {
      historyError = error instanceof Error ? error.message : String(error);
    } finally {
      historyBusy = false;
    }
  }

  function closeHistoryModal() {
    showHistoryModal = false;
    historyBrowserOnly = false;
    historyError = '';
    historyDirty = null;
    historyCaptureOpen = false;
    historyCaptureSaving = false;
    historyNotice = '';
    historyDownloads = {};
  }

  /**
   * Download one materialized version; history is never modified.
   *
   * Through this app's own save wherever it has one, which is every platform it ships to. The
   * browser anchor below is what this used, and on a phone it writes nothing at all: wry's
   * Android client installs no `DownloadListener`, so the same press that reported success left
   * no file and no error (see `Capabilities::downloads`). The app's own bridge puts the version
   * in the folder the save dialog names, which is also the only route that reports whether the
   * write actually landed.
   */
  async function downloadHistoryVersion(id: string) {
    // The mark is the report, on the row whose button was pressed: it says the copy is being
    // written, then what came of it.
    setHistoryDownload(id, 'saving');
    try {
      const version = await downloadWikiVersion(historyName, id);
      if (!version) {
        setHistoryDownload(id, 'idle');
        historyError = copy.status.noHistoryVersion;
        return;
      }
      const lith = version.text.trim().startsWith('[') ? serializeJsonToLith(version.text) : version.text;
      let outcome: SaveOutcome = 'started';
      if (documents) {
        outcome = await saveTextVerifiably(version.fileName, lith, documents);
        // The user backed out of the save dialog: no file, no mark, and no error.
        if (outcome === 'cancelled') {
          setHistoryDownload(id, 'idle');
          return;
        }
      } else {
        saveBlobAs(version.fileName, version.text);
      }
      // Only the app's own write earns the green check: no browser reports whether a download
      // finished, and an instance page inside the app is exactly that shape.
      setHistoryDownload(id, outcome === 'saved' ? 'saved' : 'unverified');
    } catch (error) {
      setHistoryDownload(id, 'failed');
      historyError = error instanceof Error ? error.message : String(error);
    }
  }

  /** Open or close the capture row's own body. */
  function toggleHistoryCapture() {
    historyCaptureOpen = !historyCaptureOpen;
  }

  /**
   * Write the capture out as a `.lith` file the user can keep.
   *
   * The mount-free answer, and the one this dialog can always give: the edits leave the
   * browser's volatile store and land in a file, without the Lith they belong to having to be
   * open first. The capture is a patch rather than a document, so the name says `_unsaved_`
   * beside the `_recover_` the version rows write, and what lands is meant to be dragged back
   * into the wiki it came from. Written through the app's own save wherever it has one, for the
   * reason `downloadHistoryVersion` gives: the browser anchor writes nothing on Android.
   */
  async function saveHistoryCapture() {
    if (historyCaptureSaving) return;
    const record = historyDirty ?? await getDirtyState(historyName);
    if (!record || record.tiddlers.length === 0) {
      historyError = copy.dialogs.history.noCapture;
      return;
    }
    historyCaptureSaving = true;
    setHistoryDownload(CAPTURE_ROW_ID, 'saving');
    historyNotice = '';
    historyError = '';
    try {
      const fileName = unsavedFileName(historyName, record.ts);
      const json = JSON.stringify(record.tiddlers);
      if (documents) {
        const outcome = await saveTextVerifiably(fileName, serializeJsonToLith(json), documents);
        // The user backed out of the save dialog: no file, no mark, and no error.
        if (outcome === 'cancelled') {
          setHistoryDownload(CAPTURE_ROW_ID, 'idle');
          return;
        }
        // The same two states a version row reports, for the reason `downloadHistoryVersion`
        // gives: only the app's own write can prove the bytes landed.
        setHistoryDownload(CAPTURE_ROW_ID, outcome === 'saved' ? 'saved' : 'unverified');
      } else {
        saveBlobAs(fileName, json);
        setHistoryDownload(CAPTURE_ROW_ID, 'unverified');
      }
    } catch (error) {
      setHistoryDownload(CAPTURE_ROW_ID, 'failed');
      historyError = error instanceof Error ? error.message : String(error);
    } finally {
      historyCaptureSaving = false;
    }
  }

  /**
   * The document a merge writes into, and the write itself, or null when this row has no file.
   *
   * The read happens now rather than when the dialog opened, because what is on disk is the
   * truth and the row's memory of it can be minutes old: merging into a stale body would drop
   * whatever changed in between. A browser handle is asked for write permission here, on the
   * press, because that is the only moment a permission prompt is allowed to appear; a lapsed
   * grant is what a PWA sees after a restart, and it is answered by the same prompt the first
   * visit showed rather than by a merge that quietly wrote nothing.
   */
  async function openHistoryDocument(
    name: string
  ): Promise<{ text: string; write: (lith: string) => Promise<void> } | null> {
    const row = historyRow;
    const handle = (row as any)?.handle;
    if (handle && typeof handle.createWritable === 'function') {
      if (handle.queryPermission) {
        const options = { mode: 'readwrite' };
        if (
          (await handle.queryPermission(options)) !== 'granted' &&
          (await handle.requestPermission(options)) !== 'granted'
        ) {
          throw new Error(copy.dialogs.history.mergeNeedsPermission);
        }
      }
      const file = await handle.getFile();
      const text = await file.text();
      return {
        text,
        write: async (lith) => {
          const writable = await handle.createWritable();
          await writable.write(lith);
          await writable.close();
        }
      };
    }
    const path = row ? recentDiskPath(row) : null;
    if (!path) return null;
    if (mode === 'tauri') {
      const read = await tauriInvoke<{ text: string }>('read_lith_path', { path });
      return {
        text: read.text,
        // The same command a save uses, aimed at the path the row already came from, which is
        // the one route that skips the picker.
        write: async (lith) => {
          await tauriInvoke('save_lith_file', { text: lith, suggestedName: name, path });
        }
      };
    }
    if (shimToken !== null) {
      const read = await shimRead(path, { token: shimToken });
      if (!read.ok) throw new Error(read.error);
      return {
        text: read.value.text,
        write: async (lith) => {
          const written = await shimWrite(path, lith, { token: shimToken });
          if (!written.ok) throw new Error(written.error);
        }
      };
    }
    return null;
  }

  /**
   * Write the capture on top of the document without opening it.
   *
   * This is the workflow the button exists for: a Lith whose edits were caught by the watcher
   * and whose file elsewhere is fine, where resolving the difference used to mean mounting the
   * whole wiki only to press Save. The merge produces what a save produces, so the trail gains a
   * real version row where the amber `live` row was, and the mount that follows has nothing to
   * prompt about. Opening the Lith is still the way to read it, which is why this dialog has no
   * Recover: the row in the list already opens.
   *
   * A row with no reachable file merges into the cached copy instead, which is the document in
   * the browser-only store and the last resort everywhere else. A document that cannot be read
   * is refused rather than replaced, because the alternative writes a Lith holding only the
   * edits and none of the wiki they belong to.
   */
  async function mergeHistoryCapture() {
    if (historyCaptureSaving) return;
    const name = historyName;
    const record = historyDirty ?? await getDirtyState(name);
    if (!record || record.tiddlers.length === 0) {
      historyError = copy.dialogs.history.noCapture;
      return;
    }
    historyCaptureSaving = true;
    historyNotice = '';
    historyError = '';
    try {
      const target = historyHasFile(historyRow) ? await openHistoryDocument(name) : null;
      const documentText = target ? target.text : await getSearchCacheText(name);
      if (!target && !documentText) {
        historyError = copy.dialogs.history.captureOnlyNote;
        return;
      }
      const merged = mergeCaptureIntoDocument(documentText, record.tiddlers);
      if (!merged.ok) {
        historyError = merged.reason === 'empty' ? copy.dialogs.history.noCapture : copy.dialogs.history.mergeUnreadable;
        return;
      }
      if (target) await target.write(merged.text);
      // Through the same call a save makes, so the version chain and the searchable copy both
      // move: a merge that wrote the file and left the trail alone would be the exact half
      // answer this trail exists to avoid.
      await saveSearchCache(name, JSON.stringify(merged.tiddlers));
      await clearDirtyState(name);
      historyDirty = null;
      historyCaptureOpen = false;
      historyEntries = await listWikiVersions(name);
      void refreshDirtyBadges();
      historyNotice = target
        ? copy.dialogs.history.merged(merged.applied)
        : copy.dialogs.history.mergedIntoCopy(merged.applied);
    } catch (error) {
      historyError = copy.dialogs.history.mergeFailed(error instanceof Error ? error.message : String(error));
    } finally {
      historyCaptureSaving = false;
    }
  }

  /**
   * Throw the capture away, which is the same answer the mount's own prompt gives.
   *
   * Nothing on disk is touched and no version is written: the edits were the only copy of
   * themselves, and discarding them is the decision this button names. The row goes with them,
   * which is the whole confirmation the action needs.
   */
  async function discardHistoryCapture() {
    if (historyCaptureSaving) return;
    await clearDirtyState(historyName);
    historyDirty = null;
    historyCaptureOpen = false;
    historyNotice = '';
    historyError = '';
    void refreshDirtyBadges();
  }

  /**
   * Write cached tiddler text out as a `.lith` the user can keep, as a browser download.
   *
   * The fallback for a process that cannot write a document of its own (`Capabilities::local_files`);
   * every platform this app ships to can, so the app's own save above is the route
   * that is taken. Cached text is the serialized tiddler array, not the on-disk format, so it is
   * converted back first.
   */
  function saveBlobAs(fileName: string, text: string) {
    const lith = text.trim().startsWith('[') ? serializeJsonToLith(text) : text;
    const blob = new Blob([lith], { type: 'application/x-lith' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  /**
   * Save the newest cached copy of a wiki as a real file. The rebuild warning
   * needs this to be unconditional: a Lith can hold a cached snapshot with no
   * versioned history behind it (legacy caches predate the diff chain), so
   * "download a copy first" cannot depend on the history modal having anything
   * to show.
   *
   * The reported outcome is the point of the row's pill. "Saved" means the
   * platform confirmed the write, which is what lets the user press Proceed
   * knowing exactly what they are giving up; a started-but-unconfirmed download
   * says so instead of borrowing the green check.
   */
  async function downloadCachedSnapshot(name: string, fallbackText = ''): Promise<void> {
    setOrphanDownload(name, 'saving');
    try {
      // A browser-only HTML monolith keeps its page in the recents row rather than in a cache,
      // which is the one row the gated dialog lists that has nothing here to find. Without the
      // fallback its download would fail and the gate it feeds could never open.
      const cached = (await getSearchCacheText(name)) || fallbackText;
      if (!cached) {
        setOrphanDownload(name, 'failed');
        reportHeld(copy.status.noCachedCopy(name));
        return;
      }
      // The copy keeps the extension it came with, so a saved page is written as a page rather
      // than as a Lith holding HTML.
      const extension = /\.[a-z0-9]+$/i.exec(name)?.[0] ?? '.lith';
      const fileName = `${name.replace(/\.[a-z0-9]+$/i, '')}_cached${extension}`;
      const outcome = await saveTextVerifiably(fileName, cached, documents);
      if (outcome === 'cancelled') {
        // The user backed out of the save dialog: leave the row as they found it.
        setOrphanDownload(name, 'idle');
        return;
      }
      // The pill is the report. Every press this reaches is inside a dialog, and the header's
      // status line is behind it, so a sentence there would be no confirmation at all.
      setOrphanDownload(name, outcome === 'saved' ? 'saved' : 'unverified');
    } catch (error) {
      setOrphanDownload(name, 'failed');
      mountError = copy.status.downloadFailed(error instanceof Error ? error.message : String(error));
    }
  }

  /** Per-row download state for the rebuild warning, keyed by wiki name. */
  let orphanDownloads: Record<string, OrphanDownloadState> = {};

  function setOrphanDownload(name: string, state: OrphanDownloadState): void {
    orphanDownloads = { ...orphanDownloads, [name]: state };
  }

  /** Rows with their pill resolved, so the markup stays a plain loop. */
  $: orphanRows = rebuildOrphans.map((orphan) => ({
    orphan,
    pill: orphanPill(orphanDownloads[orphan.name] ?? 'idle')
  }));

  $: orphanNote = orphanDownloadNote(
    rebuildOrphans.map((orphan) => orphanDownloads[orphan.name] ?? 'idle')
  );

  /**
   * The reset warning's rows, carrying the same pill the rebuild warning's do: both dialogs
   * write their copies out through `downloadCachedSnapshot`, so one state map serves them and
   * a download started in either place reports itself in the same words.
   */
  $: resetRiskRows = resetAtRisk.map((row) => ({
    row,
    pill: orphanPill(orphanDownloads[row.name] ?? 'idle')
  }));

  $: resetRiskNote = orphanDownloadNote(resetAtRisk.map((row) => orphanDownloads[row.name] ?? 'idle'));

  /** Every name this device holds a cached copy, a capture or a version history for. */
  function heldCopies(): string[] {
    return [
      ...Object.keys(cachedEntries),
      ...Object.keys(dirtyEntries),
      ...Object.keys(historyAvailable).filter((name) => historyAvailable[name])
    ];
  }

  /**
   * `Reset Recents`, asked first where there is something to ask about.
   *
   * The list on its own is not worth a question: every row points at a file that outlives it.
   * What a reset also deletes is the copy, the history and the unsaved capture held below each
   * row, and this shape has no rebuild control to grow them back, so the rows that hold any of
   * them are named with a download each before the list goes. Nothing held means nothing to
   * ask, and that reset clears as it always did.
   */
  function requestReset(): void {
    const atRisk = resetCasualties(recentRows() as CoverageRow[], heldCopies());
    if (atRisk.length === 0) {
      void clearRecent();
      return;
    }
    orphanDownloads = {};
    resetAtRisk = atRisk;
  }

  /** The reset the warning lists, once the person has had their say. */
  function confirmReset(): void {
    resetAtRisk = [];
    orphanDownloads = {};
    void clearRecent();
  }

  // --- The instance backup: everything this store holds, out and back in ---------

  /** Whether the fallback's gated Backup and Reset dialog is on screen. */
  let showInstanceBackup = false;
  let backupBusy = false;
  /** Why the last export failed, on whichever dialog offered it. */
  let backupStatus = '';
  /**
   * What the whole-instance export reports, beside the button that was pressed, in the same pill
   * the rows use. `backupStatus` keeps the failures, because a mark says a copy failed while the
   * sentence says why.
   */
  let backupDownload: OrphanDownloadState = 'idle';
  $: backupPill = orphanPill(backupDownload);
  /** Whether the whole instance has been written out this session, which opens the gate. */
  let fullBackupTaken = false;
  /** Names a dropped backup could not land, because this device already holds them. */
  let importCollisions: string[] = [];

  /**
   * The rows the dialog lists: every Lith this device can hand over.
   *
   * Not the rebuild warning's orphan list, which is the rows whose file has gone: here every
   * row is a document, so every row is what a reset would take. `text` is carried through
   * because a browser-only HTML monolith keeps its page in the row rather than in a cache.
   *
   * Offline it is the other list, and for the reason the two are separate there: what is being
   * backed up is the copies this device took, which are exactly the rows the launcher is
   * drawing, and the store's own recents would offer downloads for Liths this page cannot read
   * while missing the ones it can.
   */
  $: backupRows = (offlineLauncher
    ? offlineEntries.map((entry) => ({ name: entry.name, text: '' }))
    : recentFiles.map((row) => {
        const name = getEntryName(row);
        const text = (row as { text?: string }).text;
        return { name, text: typeof text === 'string' ? text : '' };
      })
  ).map((row) => ({ ...row, pill: orphanPill(orphanDownloads[row.name] ?? 'idle') }));

  $: backupOpen = backupGate(
    backupRows.map((row) => orphanDownloads[row.name] ?? 'idle'),
    fullBackupTaken
  );

  /**
   * Whether this dialog draws a reset at all.
   *
   * Only the browser-only store's does: there the store is the document, so clearing it is a
   * thing a person may want and the gate above is what makes it safe to press. An instance's
   * list is not this device's to clear, and offline it is the only copy of anything on screen,
   * so that shape prints the export and stops.
   */
  $: backupResettable = indexDbOnly && !offlineLauncher;

  /**
   * The dialog's own words, which follow the shape above: one decision, so one place the title,
   * the body and the close control's label are read from, and no way for a mode to wear the
   * other mode's sentence over its own buttons.
   */
  $: backupCopy = backupResettable ? copy.dialogs.instanceBackup : copy.dialogs.instanceBackup.backupOnly;

  /**
   * Open the dialog.
   *
   * The marks go with the previous visit: a row whose download was taken wears that mark instead
   * of its button, and coming back here is how a person takes a second copy, so the buttons have
   * to be there when the dialog opens.
   */
  function openInstanceBackup(): void {
    backupStatus = '';
    backupDownload = 'idle';
    orphanDownloads = {};
    showInstanceBackup = true;
  }

  /**
   * Write the whole store out as one file.
   *
   * One answer for all four dialogs that offer it, which is why this takes no `source`: the mark
   * beside the button says what came of the press, and the dialog around it already explains what
   * the file is for.
   */
  async function downloadInstanceBackup(): Promise<void> {
    if (backupBusy) return;
    backupBusy = true;
    backupStatus = '';
    backupDownload = 'saving';
    try {
      // The bookmark list is handed in rather than read: it lives in localStorage, which is the
      // page's store, and the module that builds the document reads only the wiki store.
      const backup = await collectInstanceBackup(idb, { mode, origin: window.location.origin }, Date.now(), bookmarks);
      const outcome = await saveTextVerifiably(backupFileName(), serializeInstanceBackup(backup), documents);
      // The user backed out of the save dialog, which is not a backup: the gate stays shut.
      if (outcome === 'cancelled') {
        backupDownload = 'idle';
        return;
      }
      fullBackupTaken = true;
      // The gate counts an unconfirmed download as a download, which is what the browser's own
      // answer is: `saved` is only ever the app's write.
      backupDownload = outcome === 'saved' ? 'saved' : 'unverified';
    } catch (error) {
      backupDownload = 'failed';
      backupStatus = copy.dialogs.icon.backupFailed(error instanceof Error ? error.message : String(error));
    } finally {
      backupBusy = false;
    }
  }

  /** The gated reset: reachable once every row, or the full backup, has left. */
  async function resetRecentsFromBackup(): Promise<void> {
    if (!backupOpen.open) return;
    showInstanceBackup = false;
    await clearRecent();
    orphanDownloads = {};
    fullBackupTaken = false;
    backupStatus = '';
    backupDownload = 'idle';
  }

  /**
   * Merge a dropped backup into this store, or refuse it whole.
   *
   * Refused rather than merged around, which is the one decision this feature makes. A name
   * this device already holds is either the same Lith or a different one wearing the same
   * name, and the file cannot tell the two apart; importing the rest and leaving the clashes
   * behind would make one drop mean two things. So the answer is the names to settle first.
   */
  async function importInstanceBackup(backup: InstanceBackup): Promise<void> {
    const held = [...new Set([...recentFiles.map((row) => getEntryName(row)), ...Object.keys(cachedEntries)])];
    const plan = planBackupImport(backup, held);
    if (!plan.ok) {
      importCollisions = plan.collisions;
      return;
    }
    try {
      await restoreInstanceBackup(idb, plan.backup);
    } catch (error) {
      mountError = copy.dialogs.backupImport.failed(error instanceof Error ? error.message : String(error));
      return;
    }
    // Read back rather than patched: the file is a whole store, and a list that disagreed with
    // the caches under it is the state this restore exists to make impossible.
    recentFiles = await getRecentFiles();
    await updateCacheMatches(search);
    await rereadHistoryAvailability(plan.backup.wikis.map((wiki) => wiki.name));
    // The bookmarks are the half a store restore cannot write, and the half it must not replace:
    // they live in localStorage, and an import may only ever add addresses here. Merging through
    // the module that owns the list also applies its own cap, so the count below is the list's.
    const mergedBookmarks = writeBookmarkList(mergeBookmarks(bookmarks, plan.backup.bookmarks), localStorage);
    const bookmarksAdded = Math.max(0, mergedBookmarks.length - bookmarks.length);
    if (bookmarksAdded > 0) {
      // Read back through the module, which is where the label fallbacks live. An entry that
      // arrived without an icon is fetched the way a fresh bookmark's is; one that carried the
      // icon its file held is left alone until it goes stale. Fire and forget: an instance that
      // cannot be reached yet must not hold the import open.
      bookmarks = readBookmarkEntries();
      void refreshBookmarkIcons();
    }
    void refreshBackupCoverage();
    status =
      plan.backup.wikis.length === 0
        ? copy.dialogs.backupImport.importedNothing
        : copy.dialogs.backupImport.imported(plan.backup.wikis.length, bookmarksAdded);
  }

  async function clearRecent() {
    await clearAllRecentFiles();
    recentFiles = [];
    cachedEntries = {};
    cacheSearchMatches = {};
    localStorage.removeItem(RECENT_KEY);
    if (shouldRestoreInstallOfferOnReset(mode)) {
      // Tauri keeps that choice in recents.txt and must not reset it here.
      installDismissed = false;
      await setInstallDismissed(false);
    }
    persistRecentsSidecar();
    void refreshBackupCoverage();
  }

  /**
   * The on-disk text of one wiki, read through whichever process can read a path.
   *
   * The app reads through its Rust bridge; a shim reads through its own wire, which answers
   * the same shape of value. This is the read the re-index pass runs for every Lith it lists,
   * so on a shim it is what makes a rebuilt folder searchable on this device rather than only
   * listed.
   */
  async function readDiskWikiText(path: string): Promise<string> {
    if (mode !== 'tauri') {
      const read = await shimRead(path, { token: shimToken });
      if (!read.ok) throw new Error(read.error);
      return read.value.text;
    }
    const result = await tauriInvoke<{ name: string; path: string; text: string }>('read_lith_path', { path });
    return result?.text ?? '';
  }

  /** Every Lith in one folder, newest first, through whichever process can list it. */
  async function readFolderLiths(path: string): Promise<string[]> {
    if (mode === 'tauri') return tauriInvoke<string[]>('list_folder_liths', { path });
    const answer = await shimFolderLiths(path, { token: shimToken });
    return answer.ok ? answer.value : [];
  }

  /** One wiki's text from the self-host server, patch API or plain WebDAV. */
  async function readRemoteWikiText(name: string): Promise<string> {
    if (patchApiAvailable) return (await fetchRemoteWiki(name)).text;
    const response = await fetch(webdavUrl(name));
    if (!response.ok) throw new Error(`GET failed: ${response.status}`);
    return response.text();
  }

  /**
   * Read each of these Liths and write what it holds into this device's cache.
   *
   * One pass, shared by everything that puts a whole list in front of a client at
   * once: a rebuild, and a folder or an instance whose repository has just been
   * restored here. Both leave the same gap. The rows are on screen, but nothing on
   * this machine has read their text, so a search here cannot find them and a row
   * has no history of its own to report. Sequential on purpose: each read is small
   * and awaiting between them is what keeps the window responsive. Returns the
   * names actually written, which is what the callers count and report on.
   */
  async function indexLithsHere(rows: CoverageRow[], label: string): Promise<string[]> {
    const targets: CoverageRow[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const key = row.name.toLowerCase();
      if (!row.name || seen.has(key)) continue;
      seen.add(key);
      targets.push(row);
    }

    const indexed: string[] = [];
    for (const [position, entry] of targets.entries()) {
      status = copy.status.indexProgress(label, position + 1, targets.length, entry.name);
      try {
        // Self-host reads through the patch API when it is there, because that read also
        // answers the digest: a rebuilt cache is then also the copy a later open mounts without
        // downloading, and one request does both jobs.
        const remote = !entry.path && mode === 'self-host' && patchApiAvailable
          ? await fetchRemoteWiki(entry.name)
          : null;
        // `readDiskWikiText` already knows which process can read a path (the app's bridge or a
        // shim's wire), so asking it is the whole of this branch. An earlier form kept a
        // `mode === 'tauri'` check in front of it, which quietly made a shim's rebuild index
        // nothing from disk: the helper was renderable for a shim and unreachable from here.
        const text = remote
          ? remote.text
          : entry.path
            ? await readDiskWikiText(entry.path)
            : mode === 'self-host' ? await readRemoteWikiText(entry.name) : '';
        if (text) {
          await saveSearchCache(entry.name, JSON.stringify(parseLithToJSON(text)));
          if (remote?.digest) {
            await rememberFetchedLith(entry.name, { text: remote.text, digest: remote.digest, rev: remote.rev });
          }
          indexed.push(entry.name);
        }
      } catch {
        // One unreadable Lith must not abort the rest of the index.
      }
    }
    return indexed;
  }

  /**
   * Index a list, then re-ask the two per-row facts indexing just changed.
   *
   * Neither is in the text that was written: whether this device holds version
   * history for a Lith, which is what lets the row offer it at all, and the cached
   * size the row shows beside its name. Both were asked when the row appeared and
   * answered from the store these reads are what fill, so a pass that does not ask
   * again leaves every row it just filled unable to say so.
   */
  async function indexRowsHere(rows: CoverageRow[], label: string): Promise<number> {
    const indexed = await indexLithsHere(rows, label);
    await updateCacheMatches(search);
    await rereadHistoryAvailability(indexed);
    await refreshBackupCoverage();
    return indexed.length;
  }

  /**
   * The same pass, for a list a setup has just restored, run without holding its
   * caller. The point of connecting a folder or an instance is to have its Liths in
   * front of you now, and reading every one of them is not part of answering that.
   * so the rows land first and the index catches up behind them.
   */
  async function indexRestoredLiths(rows: CoverageRow[]): Promise<void> {
    if (rows.length === 0) return;
    const indexed = await indexRowsHere(rows, copy.status.indexingLabel);
    reportAndRetire(indexed > 0 ? copy.status.indexedHere(indexed) : copy.status.nothingToIndex);
  }

  /**
   * Say what a pass found, then take the line back.
   *
   * The header's line holds the last thing the launcher said and only a later thing said
   * replaces it, which is right for a control's own answer: the click that asked is the next
   * thing to happen. A pass that runs behind a dialog has no such click. This one is started
   * while connecting and finishes after the dialog is gone, so its sentence - and the animated
   * dots beside it, which mean work in progress - stood there for the rest of the session,
   * reading as indexing that never stopped. It is retired on a timer instead, guarded by the
   * text it wrote so a newer line is never taken away by an older report arriving late; the
   * install confirmation is retired the same way, for the same reason.
   */
  function reportAndRetire(message: string, ms = 6000): void {
    status = message;
    setTimeout(() => { if (status === message) status = ''; }, ms);
  }

  /**
   * Re-index instead of forgetting.
   *
   * Where the recent list is derived rather than authored (the desktop app's
   * backed-up folders, and self-host's server) clearing it throws away a
   * reconstruction, so rebuilding is the honest operation and the only one that
   * heals a list that has drifted from the files. Two passes, because they cost
   * wildly different things: re-listing is one folder walk or one PROPFIND,
   * while re-indexing content reads every wiki, so the second reports progress
   * as it goes rather than holding the window still.
   *
   * The list it produces is a fresh view, so this is the one control that both
   * forgets a stale list and rebuilds it. Anything the fresh listing cannot
   * account for is surfaced first and deleted only on confirmation: a cache
   * nothing lists is still findable by search, which looks like a file and
   * cannot be opened, so leaving one behind would trade a stale list for a
   * quieter discongruity.
   */
  async function rebuildRecents(): Promise<void> {
    if (rebuildBusy) return;
    rebuildBusy = true;
    mountError = '';
    status = copy.status.reindexing;
    try {
      // Pass 1: re-list, replacing the list rather than patching it. That is
      // what lets one button do the job: the recent list is a *view* of what
      // is really there, so a stale row is removed by rebuilding instead of by
      // a separate destructive control.
      const folders = hasLocalSync ? reindexFolders(recentRows(), backupRoots) : [];
      // The connected folder joins them last, and it is the only one not derived from a row.
      // Last because the rows come first: what they point into is what the user was working
      // in, and the repository answers after it, for the rows that have gone.
      const connectedFolder = hasLocalSync ? await connectedSyncFolder() : null;
      if (connectedFolder) folders.push(connectedFolder);
      const discovered: Array<{ name: string; path?: string }> = [];
      let orphans: RebuildOrphan[] = [];

      if (isSelfHost()) {
        // The server *is* the list here, so rebuilding means re-reading it. Writing the
        // server's names into the local recents would list every wiki twice, so the row
        // list is left where it is and only the caches move: this is also the one pass
        // that indexes Liths this device has never saved, which is what the instance's
        // half of search reads. Re-reading is not free (one request per Lith) but it is
        // the launcher asking for exactly what it is about to index.
        patchApiAvailable = await probePatchApi();
        remoteFiles = await fetchRemoteFiles();
        // The server is the source of truth here, so a cached copy it doesn't
        // hold (and that no local row can open either) is a ghost. Local rows
        // are untouched, so only caches without one are candidates.
        const serverNames = new Set(remoteFiles.map((file) => file.name.toLowerCase()));
        const localNames = new Set(recentFiles.map((item) => getEntryName(item).toLowerCase()));
        orphans = orphanedEntries(
          [],
          Object.keys(cachedEntries).filter((name) => !localNames.has(name.toLowerCase())),
          new Set(),
          serverNames
        );
      } else if (hasLocalSync) {
        // Backed-up roots first, then each known row's own folder, so a Lith
        // that isn't backed up yet still finds its siblings, then the connected
        // repository itself (see `connectedSyncFolder`).
        //
        // Deduped by path, because the list this replaces is the list it just built: the
        // connected folder and a row's own folder can be one folder spelled two ways (a root
        // arrives with no separator on the end, a row's folder keeps one), and the same Lith
        // listed twice would become two rows.
        const seenPaths = new Set<string>();
        for (const folder of folders) {
          const found = await readFolderLiths(folder).catch(() => [] as string[]);
          for (const path of found) {
            const key = path.replace(/[\\/]+$/, '');
            if (seenPaths.has(key)) continue;
            seenPaths.add(key);
            discovered.push({ name: path.split(/[\\/]/).pop() || path, path });
          }
        }

        // Rows the fresh list will not contain. Detection is by listing rather
        // than by stat: a row missing from its own folder's listing is
        // genuinely gone from there.
        const listed = new Set(discovered.map((entry) => entry.path).filter(Boolean) as string[]);
        const listedNames = new Set(discovered.map((entry) => entry.name.toLowerCase()));
        orphans = orphanedEntries(recentRows(), Object.keys(cachedEntries), listed, listedNames);
      }

      // Asked before anything is replaced, in either mode: a missing file is
      // usually a move or an unmounted drive, so it gets a say rather than a
      // silent disappearance.
      if (orphans.length > 0 && !(await promptRebuildOrphans(orphans))) {
        status = copy.status.rebuildCancelled;
        return;
      }
      // Confirmed: nothing about them is kept. Not the row, not the cached
      // copy, not the history.
      for (const orphan of orphans) {
        await forgetWikiCache(orphan.name);
        delete cachedEntries[orphan.name];
        delete cacheSearchMatches[orphan.name];
        delete dirtyEntries[orphan.name];
        delete historyAvailable[orphan.name];
      }
      cachedEntries = cachedEntries;
      cacheSearchMatches = cacheSearchMatches;
      dirtyEntries = dirtyEntries;
      historyAvailable = historyAvailable;

      if (hasLocalSync) {
        // The one place the list is *replaced* on purpose, so it is the one place a write to
        // both stores is not optional: telling the mirror alone left the store holding the
        // list the rebuild had just replaced, and the next launch read that instead.
        //
        // `hasLocalSync` rather than `mode === 'tauri'`, which is the bug this was. A shim is
        // the other backend with a folder on disk, and its rebuild crawled the folder and then
        // threw the answer away: the list was left as it was, so the pass below indexed the
        // rows that were already there and the button read as one that re-lists one Lith.
        recentFiles = await setRecentRows(discovered);
        persistRecentRows();
        persistRecentsSidecar();
      }

      // Pass 2: rebuild each wiki's searchable cache from the file itself.
      const targets: CoverageRow[] = [];
      if (isSelfHost()) for (const file of remoteFiles) targets.push({ name: file.name, path: null });
      else for (const row of recentRows()) if (row.path) targets.push(row);

      const indexed = await indexRowsHere(targets, copy.status.reindexingLabel);
      status = indexed > 0
        ? copy.status.reindexed(indexed)
        : copy.status.nothingToIndex;
    } catch (error) {
      status = '';
      mountError = copy.status.reindexFailed(error instanceof Error ? error.message : String(error));
    } finally {
      rebuildBusy = false;
    }
  }

  /** Latest live cache entry text for a file (empty when none). */
  async function getCacheHistoryText(name: string): Promise<string> {
    return getSearchCacheText(name);
  }

  /**
   * Open a cached-only entry (a file with no live handle but with local
   * history) as a read-only wiki, mirroring the legacy offline fallback.
   */
  async function openCachedEntry(entry: CacheSearchEntry) {
    const cacheText = await getCacheHistoryText(entry.name);
    if (!cacheText) return;
    await mountCachedReadOnly(entry.name, cacheText);
  }

  /**
   * Mount a wiki from its cached tiddler snapshot in read-only mode:
   * hydrate SiteTitle from the file name and inject DisableAutoSaver.
   */
  async function mountCachedReadOnly(name: string, cacheText: string, answer?: 'merge') {
    let parsed: Array<Record<string, string>> = [];
    try {
      const json = JSON.parse(cacheText);
      if (Array.isArray(json)) parsed = json as Array<Record<string, string>>;
    } catch { /* mount with whatever parsed */ }
    // Offer unsaved edits captured since the last real save; merged on top
    // of the cache snapshot when accepted.
    const dirty = await getDirtyState(name);
    if (dirty) {
      // A caller that has already asked (the history trail's Recover, rebuilding a Lith whose
      // file it could not read) answers here instead of opening a second prompt about a
      // capture the row it came from has just described.
      const decision = answer ?? await promptDirtyRecovery(name, dirty);
      if (decision === 'merge') {
        parsed = [...parsed, ...dirty.tiddlers.map((tiddler) => ({ ...tiddler }))];
        await clearDirtyState(name);
        status = copy.status.recovering(dirty.tiddlers.length, name);
      } else if (decision === 'discard') {
        await clearDirtyState(name);
      }
      void refreshDirtyBadges();
    }

    const handoff = {
      name,
      text: '',
      payloadTiddlers: parsed
    };
    await bootLegacyWiki(handoff, [
      { title: '$:/state/DisableAutoSaver', text: 'yes' }
    ], {
      __EPHEMERAL_MODE__: mode === 'self-host' ? 'self-host' : 'paper-light',
      __LITHIC_LAUNCHER_MODE__: mode
    });
  }

  /**
   * The tiddler a cache preview matched, queued as a pending import, and the cached text
   * it was taken from.
   *
   * The note is copied out of the cache rather than out of the file, because the cache is
   * what the preview was cut from: the title came from there and so must the body, or the
   * pinned tiddler would be some other version of the note than the one on screen. Null
   * when there is nothing to pin, which is also the answer when the cache has gone or the
   * note has moved out of it since the match was made.
   *
   * The payload has to be queued before the mount: after the engine boots, this component
   * is torn down, and whatever is queued is what the mount drains.
   */
  async function pinCachedMatch(name: string): Promise<string | null> {
    const match = cacheSearchMatches[name];
    if (!match?.title) return null;
    const cacheText = await getCacheHistoryText(name);
    if (!cacheText) return null;
    const payload = pinCachedTiddler(cacheText, match.title);
    if (!payload) return null;
    pendingImports = mergePendingImports(pendingImports, payload);
    intentionalImports = [...intentionalImports, ...payload.map((tiddler) => tiddler.title ?? '')];
    return cacheText;
  }

  /** Pin the matched tiddler and open the file it is in: the row's own gesture, plus the note. */
  async function pinFromPreview(name: string) {
    const cacheText = await pinCachedMatch(name);
    if (!cacheText) return;
    const recent = recentFiles.find((file) => getEntryName(file) === name);
    if (recent) {
      await openRecent(recent);
    } else {
      await openCachedEntry({ name, text: cacheText, sizeBytes: new Blob([cacheText]).size });
    }
  }

  /**
   * The same gesture on a row that is only this device's copy of a Lith: off a server that
   * is out of reach, the copy is the document, so pinning the note and opening it read-only
   * is the whole of what the row can offer.
   */
  async function pinCachedCopyFromPreview(entry: CacheSearchEntry) {
    if (!(await pinCachedMatch(entry.name))) return;
    await openCachedEntry(entry);
  }

  /**
   * ...and on one the server holds.
   *
   * The row's own click opens the server's copy, so this one does too: the note is pinned
   * from what this device read of that Lith, which is the only copy the launcher can quote,
   * and the document that opens is the instance's current one. The pin is what ties the two
   * together, and it is why this is a step rather than a navigation.
   */
  async function pinRemoteFromPreview(name: string) {
    if (!(await pinCachedMatch(name))) return;
    await openRemoteFile(name);
  }

  /**
   * Drop one row and everything remembered about its wiki.
   *
   * Removing a row while keeping its cache left an entry only a search could
   * find, and the two branches disagreed about it: handle rows were cleaned up,
   * path rows (which is every row the desktop app writes) were not.
   *
   * `marked` and `onlyCopy` are the amber mark the row was wearing when its x was pressed,
   * handed over rather than worked out again here. That mark is the launcher saying this
   * row's cached copy is the only copy of something (no file, not in a backed-up folder, or
   * edits never saved), and the x is about to delete exactly that copy, so the question and
   * the warning have to be the same state. A plain row has nothing behind it to lose: its
   * file is on disk and backed up, so its x stays one press.
   */
  async function removeRecent(
    file: RecentEntry | { name?: string; handle?: any },
    marked = false,
    onlyCopy = false
  ) {
    const name = getEntryName(file);
    if (marked) {
      const remove = await askConfirmation({
        title: copy.row.removeConfirm.title(name),
        body: onlyCopy ? copy.row.removeConfirm.onlyCopyBody : copy.row.removeConfirm.cacheBody,
        confirmLabel: copy.row.removeConfirm.label,
        danger: true
      });
      if (!remove) return;
    }
    // The list is one list, so the row leaves the list and both stores are then told what is
    // left. Taking the row out of one store instead is how the copies drifted apart: a handle
    // row was dropped from the store while the mirror kept it, so a relaunch brought it back
    // and the x read as a button that did nothing. Matching by the row itself rather than by
    // handle or by name is also what keeps two Liths sharing a name from taking the wrong one
    // with them, and it is the row the click came from either way.
    recentFiles = await setRecentRows(recentFiles.filter((item) => item !== file));
    persistRecentRows();
    await forgetWikiCache(name);
    delete cachedEntries[name];
    delete cacheSearchMatches[name];
    delete dirtyEntries[name];
    cachedEntries = cachedEntries;
    cacheSearchMatches = cacheSearchMatches;
    dirtyEntries = dirtyEntries;
    persistRecentsSidecar();
    void refreshBackupCoverage();
  }

  onMount(() => {
    // A board this app was launched from is opened before anything else, since that is the page
    // the person asked for and this one is only the way in.
    void openHandedBoard();
    // Content another app shared into this one is queued for a Lith to be chosen, so this page is
    // not only the way in here: it is where the share waits until its home is decided.
    void openHandedShare();
    // The wire's liveness, asked once and never awaited by anything: no render waits on
    // it, and a backend that does not answer leaves the flag false rather than an error.
    if (shimToken) {
      void probeShimBackend();
      void openShimStartup();
      void openShimPending();
      // A file handed to a shim already serving arrives with no boot: the browser may only
      // raise the window this page is in. Two seconds is imperceptible for a handoff and a
      // local request that answers null the rest of the time.
      shimPendingTimer = setInterval(() => { void openShimPending(); }, 2000);
    }
    // A window handed over *by* a search starts searching. This launcher is the one an
    // instance serves as well as the one this device runs, so the same code answers
    // both: the query rode in on the handoff (see `handoffQuery`), and it is taken back
    // out of the address because it belongs to the handover rather than to the URL the
    // instance then owns. A reload should show the list, not repeat a finished search.
    const handedQuery = handoffQuery(window.location);
    if (handedQuery) {
      search = handedQuery;
      try {
        const cleared = new URL(window.location.href);
        cleared.searchParams.delete(LAUNCHER_QUERY_PARAM);
        window.history.replaceState(null, '', cleared.href);
      } catch {
        // An address that cannot be rewritten still carries the search, which is the
        // part of this that matters.
      }
    }
    loadRecent();
    bookmarks = readBookmarkEntries();
    // The emoji favicon is the instance's identity in the tab, so restore it
    // (and the tab icon) before anything else renders.
    void restoreInstanceIcon();
    if (mode === 'self-host') {
      void refreshAppliance();
      void refreshRemoteList();
      // Whether this instance is backed up, which is a question only the instance
      // can answer, and one that keeps changing on its own, because the server
      // commits and pushes without this page doing anything at all.
      void refreshServerSyncStatus(false);
      startServerSyncPolling();
    } else if (showBookmarks) {
      // Meta-launcher: only the local modes keep a list of remote instances.
      void refreshBookmarkIcons();
    }
    // Reactive sync icon: poll while mounted (legacy refreshed /api/github/status
    // every 15s; 10s keeps the icon honest across mounts and disconnects).
    refreshGitSyncIcon();
    gitSyncPollTimer = setInterval(refreshGitSyncIcon, 10000);
    // The icon is only as honest as its last verification, so ask GitHub once on
    // the way up. Cheap: one request, throttled, and it explains a RED icon
    // before the user has a save to be confused by.
    void runGitSyncHeartbeat();
    // Rust reports each stage of a connect; the modal renders the latest line so
    // the wait shows what is happening instead of a frozen button.
    const stopGitSyncProgressEvents = tauriListen<{ stage: string; detail: string }>(
      'git-sync-progress',
      (payload) => { if (payload?.detail) gitSyncStage = payload.detail; }
    );
    // The engine reports what the save's backup did, not just that it happened:
    // a push that never landed has to reach the icon, or a green cloud sits over
    // a repository that stopped receiving saves.
    const onGitSyncSaved = (event: Event) => {
      markGitSyncActivity();
      const detail = (event as CustomEvent<{ ok?: boolean; managed?: boolean; error?: string | null }>).detail;
      if (!detail) return;
      if (detail.error === 'Tauri API unavailable') return;
      if (detail.ok) {
        // A landed push is the strongest evidence there is, but only for a
        // folder Lithic actually syncs: "nothing to do" must not read as proof.
        if (detail.managed) markGitSyncVerified();
        return;
      }
      gitSyncLastPushError = detail.error || 'the backup did not reach GitHub';
      void refreshBackupCoverage();
      // Ask why: a revoked token, a deleted repository, or simply no network.
      void runGitSyncHeartbeat(true);
    };
    window.addEventListener('lithic-git-sync-saved', onGitSyncSaved);
    // The marker read is local, but a window that just came back may also have
    // been without a network for hours, so refresh both.
    const onVisibilityChange = () => {
      if (document.hidden) return;
      refreshGitSyncIcon();
      void runGitSyncHeartbeat();
      // A tap in the board's sign-in window brings this app forward rather than starting it, so
      // the intent is read again each time the page is shown. The share's own ask is armed
      // separately, because it is the one that has to survive a mount (`armShareWatch`).
      void openHandedBoard();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    armShareWatch();
    // Proactive quota relief, deliberately not run in the index-db-only
    // fallback: it deletes the oldest-modified caches, and there the oldest
    // cache is somebody's only copy of a Lith. The same all-clear this mode
    // goes out of its way not to perform. A save that hits the quota reports
    // the failure instead, which is the honest outcome, and the mark on every
    // row (a title now, and the line in the history dialog it opens) says to
    // keep downloaded copies.
    if (!indexDbOnly) void purgeOldestCachesIfNeeded().catch(() => { /* best effort */ });
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // The confirmation is the top of the stack, so it takes the Escape and
        // the dialog underneath it stays open behind.
        if (confirmation) {
          resolveConfirmation(false);
          return;
        }
        if (showDirtyModal) resolveDirtyModal('later');
        if (showHistoryModal) closeHistoryModal();
        if (instanceUnlock) cancelInstanceUnlock();
        if (showVaultModal) closeVaultModal();
        closeBookmarkModal();
        closeInstanceManagement();
        closeGitSyncModal();
      }
    };
    window.addEventListener('keydown', closeOnEscape);

    // Offline mode's live half. The browser is the only side that knows the network
    // went, and it announces both directions, so the state is never a guess made once at
    // boot. Coming back is also when the server's list is worth reading again: it is the
    // read that failed to put us here.
    const onConnectionChange = () => {
      online = navigator.onLine;
      if (!online) return;
      remoteUnreachable = false;
      if (isSelfHost()) void refreshRemoteList();
    };
    window.addEventListener('online', onConnectionChange);
    window.addEventListener('offline', onConnectionChange);

    // --- Drag and drop (legacy parity) ---
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragEnter = (event: DragEvent) => {
      event.preventDefault();
      dragCounter++;
      if (dragCounter === 1) document.body.classList.add('drag-over');
    };
    const onDragLeave = (event: DragEvent) => {
      event.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        document.body.classList.remove('drag-over');
      }
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      dragCounter = 0;
      document.body.classList.remove('drag-over');
      void handleDrop(event);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    // --- URL payload injection (?json= / ?lith= / ?url=) ---
    void processUrlPayload();

    // A browser honors a previously dismissed install offer; the desktop app reads what is
    // on disk as well, and the tauri branch below is where that one starts. Deliberately not
    // webapp-only, which is how self-host came to have no offer at all: an instance's launcher
    // is a browser page like any other and its offer is the same one (see `installOffer`), so
    // the read that decides it is the same read.
    if (mode !== 'tauri') {
      void refreshInstallState();
    }

    // --- Tauri startup file (CLI arg / "Open with" association) ---
    if (mode === 'tauri') {
      // Nothing on this screen is unsaved (see `launcher-stage.ts`), so the app is told so on
      // every boot, and told before anything here tries to close: the answer is what decides
      // whether a close is questioned. What the app would otherwise still hold is the answer the
      // Lith mounted before this launcher gave, which is the one thing that could make the next
      // close ask about edits that are already gone.
      void (async () => {
        await reportUnsavedEdits(false);
        // A close the browser's own unload prompt interrupted: the person answered it, the page it
        // interrupted is gone, and this launcher is what booted in its place (see `close-guard.ts`
        // on the marker). The window goes, which is the press they made, and it goes now rather
        // than after the work below, which is work for a launcher somebody is staying on.
        if (takePendingClose(sessionStorage)) closeForInstall();
      })();
      void refreshInstallState();
      // Where this window says it is, for the other copies of this app on this machine (see
      // `launcher-stage.ts`). Desktop only: a page with no app behind it has no registry to
      // write to, and only the app carries an install to update and a window to close.
      stageBeat = createStageBeat({
        // An install on another window has put a newer copy where this machine launches the app
        // from, so this window is the older one and it gets out of the way. Nothing here is
        // unsaved: this is the launcher, not a Lith.
        onClose: () => closeForInstall()
      });
      void stageBeat.start();
      // The vault's own boot work (locking it, and reading the status the rows and the
      // manager control are drawn from) travels with the platform read above, because it
      // is that answer which decides whether this build has a vault to lock.
      void tauriInvoke<string | null>('get_startup_file')
        .then((startupPath) => { if (startupPath) void openTauriPath(startupPath); })
        .catch(() => { /* command missing or no startup file; stay on launcher */ });
    }

    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('online', onConnectionChange);
      window.removeEventListener('offline', onConnectionChange);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
      // Leaving the launcher screen entirely: drop the presence lock so the
      // wiki is not held for the full staleness window.
      stopLockHeartbeat();
      stageBeat?.stop();
      stageBeat = null;
      if (gitSyncPollTimer) clearInterval(gitSyncPollTimer);
      if (shimPendingTimer) clearInterval(shimPendingTimer);
      if (gitSyncBackupTimer) clearInterval(gitSyncBackupTimer);
      stopGitSyncProgressEvents?.();
      stopGitSyncProgressTimer();
      window.removeEventListener('lithic-git-sync-saved', onGitSyncSaved);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('visibilitychange', onShareVisible);
      gitPollAborted = true;
    };
  });

  // --- Saved instance logins (the credential vault) --------------------------
  // What stops a protected instance asking for the same password on every
  // launch. Rust answers the page's own Basic-auth challenge from this vault
  // (see `webview_auth.rs`), so the launcher's job is only to create it, unlock
  // it, and manage what is in it. No saved password reaches this code.
  //
  // One secret covers every saved instance. That is deliberate: a secret per
  // site would mean typing and deriving one per site while defending against
  // the same thing (someone who has the file), but it does mean the secret's
  // strength is the strength of every entry. Which is why the creation step
  // measures a weak one and says so, rather than quietly accepting it.
  type VaultStatus = { exists: boolean; granted: boolean; count: number; path: string };
  type VaultEntry = { origin: string; user: string };
  /**
   * A candidate PIN's verdict: the word it reads as, the band that colours it, and the
   * sentence Rust wrote behind the word.
   *
   * The band is a class name as well as a word, so the colour cannot disagree with the
   * arithmetic behind it. `refused` is the one case Rust does not band, because the
   * only refusal possible here is the shape the boxes already enforce. The word is that
   * band capitalized: Rust bands the shape and composes the sentence, so the only thing
   * left to spell here is the word the sentence already opens with.
   */
  type SecretVerdict = { label: string; text: string; band: string };

  let showVaultModal = false;
  let vaultStatus: VaultStatus | null = null;
  let vaultEntries: VaultEntry[] = [];
  /**
   * The addresses a login is already saved for.
   *
   * Answered by the vault file's index, so it needs no unlock and no secret.
   * which is what lets a bookmark row's key control say "nothing saved here"
   * before anything has been opened.
   */
  let vaultCoverage = new Set<string>();
  let vaultSecret = '';
  /**
   * Two toggles, because they are two fields with two labels: one reveals the PIN
   * boxes, the other the password. Both ride in the label row of the field they
   * reveal, so neither costs a row of its own.
   */
  let pinReveal = false;
  let passwordReveal = false;
  /** Bumped when a PIN is refused, so the boxes empty and take the caret again. */
  let vaultPinReset = 0;
  let vaultError = '';
  let vaultNotice = '';
  let vaultBusy = false;

  /**
   * Whether the PIN has been accepted for the dialog that is open, so the list is on
   * screen and the actions after it have something to carry the PIN with.
   *
   * Not "the vault is unlocked": nothing is. Every action below is its own command
   * that takes the PIN and opens the vault for the length of that one call. This flag
   * only says whether the user has typed it yet, and it is set by the list arriving,
   * so it cannot be true about a PIN Rust did not accept.
   */
  let vaultListOpen = false;

  /**
   * What each saved login last answered when it was checked against its instance.
   *
   * Kept per origin, in this component only, and dropped when the dialog closes: a
   * verdict is a fact about a moment, not something the vault should remember.
   */
  let vaultChecks: Record<string, { state: LoginCheckState; label: string; detail: string }> = {};

  /**
   * Ask an instance whether this login still works.
   *
   * The only thing in the launcher that sends a saved password anywhere, and it does
   * it on a click rather than on a timer. Which is the point of the control: a
   * password the server has since changed is otherwise only discovered by being
   * refused a visit.
   */
  async function testVaultEntry(origin: string) {
    vaultChecks = {
      ...vaultChecks,
      [origin]: { state: 'busy', label: LOGIN_CHECK_LABELS.busy, detail: copy.dialogs.credential.checking }
    };
    try {
      const check = await tauriInvoke<{ outcome: string; status: number; detail: string }>('check_credential', {
        origin,
        // The PIN the dialog was opened with: this command opens the vault itself,
        // decrypts the one password, sends it and is done, rather than reading it back
        // out of a vault the launcher is holding open.
        secret: vaultSecret
      });
      const verdict = loginVerdict(check.outcome, check.detail);
      vaultChecks = { ...vaultChecks, [origin]: { ...verdict, label: LOGIN_CHECK_LABELS[verdict.state] } };
    } catch (error) {
      // A command that refused is an answer too: the login could not be sent, so
      // nothing was proved about it either way.
      const verdict = loginVerdictFromError(error);
      vaultChecks = { ...vaultChecks, [origin]: { ...verdict, label: LOGIN_CHECK_LABELS[verdict.state] } };
    }
  }

  /**
   * The instance a saved login is being unlocked for, and the address to open once
   * it has been. `null` means the dialog is closed.
   *
   * The unlock is deliberately not a session: credentials stay locked until an
   * instance is opened, the secret is asked for then, and what it buys is one
   * instance load. Rust holds that credential only until the load is done and drops
   * it when this launcher comes back, so opening the same instance again asks
   * again.
   */
  let instanceUnlock: { origin: string; address: string; query: string } | null = null;
  let instanceSecret = '';
  let instanceUnlockError = '';
  let instanceUnlockBusy = false;
  /** Bumped when a PIN is refused, so the boxes empty and take the caret again. */
  let instanceSecretReset = 0;

  /**
   * The one dialog that writes a login, and the only way a login is ever written.
   *
   * `prompt` is the offer a challenging instance makes while it is being opened, which
   * is also the only place a password can be typed for an instance nothing is saved
   * for; `row` is a bookmark row's key, aimed at that row's own address. Neither takes
   * an arbitrary address (the manager is a list and does not add) so a credential can
   * only ever be written for an instance the user was already pointing at.
   */
  let credentialOffer: { origin: string; address: string; kind: 'prompt' | 'row'; query: string } | null = null;
  let offerPin = '';
  let offerPinConfirm = '';
  let offerUser = '';
  let offerPassword = '';
  let offerError = '';
  /** The candidate PIN's band and sentence, or null while nothing complete is typed. */
  let offerWarning: SecretVerdict | null = null;
  let offerBusy = false;
  /** Bumped when a PIN is refused, so the boxes empty and take the caret again. */
  let offerPinReset = 0;
  /** Bumped when the PIN is complete, to move the caret on to its confirmation. */
  let offerPinConfirmFocus = 0;
  /**
   * What this dialog's fields last answered when they were put to the instance.
   * Null while they are still being typed into, or hold something other than a
   * complete login. See `typedLoginCheck` for when it is asked and when it is
   * cleared. Both buttons of the dialog read it, which is why it is asked for a
   * typed login rather than for a save.
   */
  let offerCheckVerdict: LoginVerdict | null = null;
  const offerLoginCheck = typedLoginCheck((verdict) => (offerCheckVerdict = verdict));
  $: offerLoginCheck(credentialOffer?.origin ?? '', offerUser, offerPassword);

  /** The exact address a saved login is kept under, for the origin field's hints. */
  function vaultOriginOf(url: string): string {
    try {
      const parsed = new URL(url);
      return parsed.origin;
    } catch {
      return '';
    }
  }

  // Still the offer dialog's business, not the manager's: the PIN it will have is
  // chosen by the first login that is saved, so the shape that asks for it is the one
  // with the login in it.
  $: vaultCreateMode = Boolean(vaultStatus) && !vaultStatus?.exists;
  $: vaultSavedCount = vaultStatus?.count ?? 0;
  // The count is known without the PIN (it comes from the file's own origin index),
  // which is the whole point of this title: it can say what is saved without asking
  // for anything. It deliberately says nothing about a vault being "open", because
  // nothing is: this key is only on screen inside the bookmark dialog, and the
  // manager's list is on screen only inside its own dialog. The two are never true
  // at once, so a state for it would be a state nobody sees.
  $: vaultManagerTitle = vaultSavedCount > 0
    ? copy.dialogs.bookmark.manageSaved(vaultSavedCount)
    : copy.dialogs.bookmark.manageEmpty;

  async function refreshVaultStatus() {
    // A build with no vault has no status to answer with, so nothing is asked. This is
    // also what keeps a platform that will never draw the manager from opening a
    // credential file at all.
    if (!platformCredentials) {
      vaultStatus = null;
      return;
    }
    try {
      vaultStatus = await tauriInvoke<VaultStatus>('credentials_status');
    } catch {
      // Not a Tauri window (or an older build): the feature is simply absent.
      vaultStatus = null;
    }
  }

  /**
   * Ask the vault which of the bookmarked addresses it already holds a login for.
   *
   * One command for the whole list rather than a question per row: the answer comes
   * from the file's index, costs no unlock, and is the same for every render of the
   * list.
   */
  async function refreshVaultCoverage() {
    // The same guard as the status read above, and the same reason: where there is no
    // vault, every control that would have read this is absent anyway.
    if (!platformCredentials) {
      vaultCoverage = new Set();
      return;
    }
    const origins = bookmarks.map((entry) => vaultOriginOf(entry.url)).filter(Boolean);
    if (origins.length === 0) {
      vaultCoverage = new Set();
      return;
    }
    try {
      vaultCoverage = new Set(await tauriInvoke<string[]>('credential_coverage', { origins }));
    } catch {
      // A build without the vault command: every control stays in its "can be set
      // up" state, which is honest. Nothing has been saved.
      vaultCoverage = new Set();
    }
  }

  /**
   * What a bookmark row's key control will say and do, said plainly.
   *
   * One control, two jobs, decided by the one thing the file's index can answer without
   * a secret: a login is saved for this address (manage it) or it is not (save one).
   */
  function vaultRowTitle(origin: string): string {
    if (vaultCoverage.has(origin)) return copy.row.vaultSaved(origin);
    return copy.row.vaultSave(origin);
  }

  /**
   * Open the saved-logins manager.
   *
   * It lists and forgets; it does not add. A login is only ever written for an
   * instance the user was already pointing at (a bookmark row's key, or the offer an
   * instance's own password prompt makes) so there is no form here to be aimed at an
   * address that is not the instance in front of the user, and no way to reach this
   * screen and invent one. It is also the only dialog carrying the whole-vault reset,
   * because forgetting everything is a fact about the vault rather than about any
   * instance being opened.
   */
  function openVaultModal() {
    vaultError = '';
    vaultNotice = '';
    vaultSecret = '';
    pinReveal = false;
    passwordReveal = false;
    // Last time's verdicts were about last time; nothing is carried over.
    vaultChecks = {};
    // Every visit starts closed, because nothing is ever left open between them.
    // and the list itself is behind the PIN, since the file's index is salted hashes
    // and nothing can enumerate what is saved without decrypting it.
    vaultListOpen = false;
    vaultEntries = [];
    showVaultModal = true;
    void refreshVaultStatus();
  }

  function closeVaultModal() {
    showVaultModal = false;
    vaultListOpen = false;
    vaultEntries = [];
    // The PIN is a means to an action, never a session, so it does not outlive the
    // dialog that collected it. Nothing needs locking on the way out: nothing was
    // left open to lock, and any credential lent to an instance load is dropped
    // when this launcher comes back, not here.
    vaultSecret = '';
    vaultChecks = {};
  }

  /**
   * Read the saved logins, which is the one thing the PIN is still typed for here.
   *
   * This is not an unlock and the component does not treat it as one: Rust opens the
   * vault for the length of the call and drops it, and what comes back is the list. The
   * PIN is kept for the actions that follow (adding, checking, forgetting) each of
   * which carries it in the same command that uses it, rather than reading a vault the
   * app is holding open. One KDF per action, and no state to leave behind.
   */
  async function openVaultList(pin = vaultSecret) {
    if (vaultBusy) return;
    vaultBusy = true;
    vaultError = '';
    vaultNotice = '';
    try {
      vaultEntries = await tauriInvoke<VaultEntry[]>('list_credentials', { secret: pin });
      vaultListOpen = true;
    } catch (error) {
      vaultError = error instanceof Error ? error.message : String(error);
      // A refused PIN is typed again rather than edited, so the boxes go back to empty.
      vaultSecret = '';
      vaultPinReset += 1;
    } finally {
      vaultBusy = false;
    }
  }

  async function forgetVaultEntry(origin: string) {
    vaultBusy = true;
    vaultError = '';
    vaultNotice = '';
    try {
      vaultEntries = await tauriInvoke<VaultEntry[]>('forget_credentials', {
        origin,
        // Authenticated because forgetting is a change, not because of what it would
        // reveal: the file's index already answers "is there a login for this?" without
        // a secret, which is what colours a bookmark's key before anything is opened.
        secret: vaultSecret
      });
      vaultNotice = copy.dialogs.vault.forgot(origin);
      await refreshVaultStatus();
      await refreshVaultCoverage();
    } catch (error) {
      vaultError = error instanceof Error ? error.message : String(error);
    } finally {
      vaultBusy = false;
    }
  }

  /**
   * The whole-vault reset: the file, every login in it, and the secret with it.
   *
   * Confirmed rather than immediate, because it is the one control here that
   * cannot be undone by knowing the secret. It lives in the manager and nowhere
   * else: forgetting everything is a fact about the vault, not about the instance
   * whose prompt happens to be on screen.
   */
  async function destroyVault() {
    const confirmed = await askConfirmation({
      title: copy.dialogs.vault.forgetAllTitle,
      // The way back is named because this is also how the PIN changes, now that
      // there is no separate rotation: a forgotten or unwanted PIN is replaced by
      // setting the vault up again, and that is worth saying on the one control that
      // costs the logins.
      body: copy.dialogs.vault.forgetAllBody,
      confirmLabel: copy.dialogs.vault.forgetAll,
      // The one confirmation in the app whose answer cannot be undone: the file is gone,
      // and nothing here can bring it back. Disconnecting a sync only stops one.
      danger: true
    });
    if (!confirmed) return;
    vaultBusy = true;
    vaultError = '';
    vaultNotice = '';
    try {
      vaultStatus = await tauriInvoke<VaultStatus>('destroy_credentials');
      vaultEntries = [];
      // There is no vault to have opened, so the dialog goes back to asking for a
      // PIN. The same state a fresh install starts in.
      vaultListOpen = false;
      vaultSecret = '';
      await refreshVaultCoverage();
      vaultNotice = copy.dialogs.vault.everyLoginGone;
    } catch (error) {
      vaultError = error instanceof Error ? error.message : String(error);
    } finally {
      vaultBusy = false;
    }
  }

  /**
   * Open a bookmarked instance.
   *
   * Three things can happen, and which one is decided before anything navigates. A
   * saved login means the PIN is asked for, and answering it opens the instance. No
   * saved login, on an instance that challenges a visitor who has none, means the one
   * dialog that can save a login or lend one for this load alone. Anything else simply
   * opens, because there is nothing the app could answer with and nothing worth
   * interrupting for.
   *
   * `query` is the words this open is a search for, and only the panel beside an
   * instance's match passes one. It rides the handoff through every one of those three
   * paths, including the dialogs: an instance that asks for a login before it opens must
   * still arrive searching once it has been answered, or the one gesture that saves the
   * retyping would be the one gesture that loses it.
   */
  /**
   * Whether the list is empty, and what to say about it.
   *
   * Self-host and the modes with files enumerate different things (the server's store
   * versus this device) so emptiness is two questions rather than one condition that has
   * to stay right for both. The read counts as empty until it lands, since "nothing on this
   * server yet" while the list is still arriving would be a lie, and it stays empty when
   * the read *failed*, because there the error line above already says what happened and
   * "no Liths yet" would be a second, wrong answer to the same question.
   */
  $: listEmpty = mode === 'self-host'
    ? (offlineLauncher
        ? offlineRows.length === 0
        : filteredRemote.length === 0 && !remoteBusy && !remoteError)
    : filteredRecent.length === 0 && filteredCached.length === 0 && filteredRemote.length === 0 && (!showBookmarks || filteredBookmarks.length === 0);
  $: emptyMessage = mode === 'self-host'
    ? (offlineLauncher
        ? (search.trim() ? copy.recent.empty.noMatch : copy.recent.empty.instanceHere)
        : (search.trim() ? copy.recent.empty.noMatch : copy.recent.empty.server))
    : (search.trim() ? copy.recent.empty.noMatch : copy.recent.empty.recents);

  async function openBookmarkedInstance(url: string, query = '') {
    // A platform whose webview cannot answer an instance's own login challenge does not get the
    // navigation at all: the address goes to the platform's browser, which is where that login
    // already lives. Asked first, because a vault that cannot be lent to a window this platform
    // will not use must not be unlocked on the way to nothing. See `opensInstanceInBrowser`.
    //
    // That same answer decides whether the handoff carries a way back. A page opened in another
    // application's browser cannot be returned to this one, so a marker written there would draw
    // a back button on an instance whose launcher is not on the other end of it. The marker is
    // the whole of what draws that button (see `launcherReturn`), so a handoff that cannot be
    // returned from writes none.
    const opensInBrowser = opensInstanceInBrowser(mode, platformCapabilities);
    const addressed = withLauncherHandoff(url, window.location.href, query, !opensInBrowser);
    if (opensInBrowser) {
      try {
        await tauriInvoke('open_external', { url: addressed });
      } catch (error) {
         reportHeld(copy.status.openFailed(error instanceof Error ? error.message : String(error)));
      }
      return;
    }
    const origin = vaultOriginOf(url);
    // On a platform with no vault this is the whole of the opening: the window is handed
    // to the instance and the platform's own WebView asks for the password, which is what
    // the PWA does through its browser.
    if (mode === 'tauri' && platformCredentials && vaultStatus && origin) {
      if (vaultCoverage.has(origin)) {
        instanceUnlock = { origin, address: url, query };
        instanceSecret = '';
        instanceUnlockError = '';
        instanceSecretReset += 1;
        return;
      }
      if (await asksForPassword(url)) {
        openCredentialOffer(origin, url, 'prompt', query);
        return;
      }
    }
    window.location.href = addressed;
  }

  /**
   * Does this instance challenge a visitor who has no password?
   *
   * A saved login is only worth offering where there is a prompt to answer: against
   * an instance that answers everyone, saving one achieves nothing, and asking for a
   * password in order to do it is pure friction. `probe_instance` already answers
   * this (a `protected` verdict is a 401 on its manifest) and this is the one place
   * its verdict decides something *before* a navigation rather than after one.
   */
  async function asksForPassword(url: string): Promise<boolean> {
    try {
      const probe = await tauriInvoke<{ state: string }>('probe_instance', { url });
      return probe.state === 'protected';
    } catch {
      // No probe in this build: never stand between the user and what they clicked.
      return false;
    }
  }

  function cancelInstanceUnlock() {
    instanceUnlock = null;
    instanceSecret = '';
    instanceUnlockError = '';
  }

  /**
   * Lend this instance the credential its PIN unlocks, and open it.
   *
   * The PIN arrives as an argument rather than being read back out of state: it is
   * handed over by the box that completed, which is the one moment the value is
   * certainly the one that was typed.
   */
  async function unlockInstance(pin: string) {
    const target = instanceUnlock;
    if (!target || instanceUnlockBusy) return;
    instanceUnlockBusy = true;
    instanceUnlockError = '';
    try {
      await tauriInvoke('unlock_for_instance', { origin: target.origin, secret: pin });
      instanceSecret = '';
      instanceUnlock = null;
      window.location.href = withLauncherHandoff(target.address, window.location.href, target.query);
    } catch (error) {
      instanceUnlockError = error instanceof Error ? error.message : String(error);
      // A refused PIN is typed again rather than edited, so the boxes go back to empty.
      instanceSecretReset += 1;
    } finally {
      instanceUnlockBusy = false;
    }
  }

  // --- Offering to save a login, when an instance asks for one ------------------
  //
  // Nothing can learn a password by watching a login work, so the only way a login
  // gets saved is being given one. This is that moment: one dialog holding all of it.
  // The PIN that unlocks the vault (or picks the one it will have), the credential
  // for this instance, and the way out of being asked again. One stop, rather than a
  // prompt from the app followed by a prompt from the page.

  /**
   * Open that dialog for one instance's exact address.
   *
   * The address is passed in rather than typed: both entries know it already, which is
   * the whole reason there is no form anywhere that would accept any address at all.
   */
  function openCredentialOffer(origin: string, address: string, kind: 'prompt' | 'row', query = '') {
    credentialOffer = { origin, address, kind, query };
    offerPin = '';
    offerPinConfirm = '';
    offerUser = '';
    offerPassword = '';
    offerError = '';
    offerWarning = null;
    pinReveal = false;
    passwordReveal = false;
    offerPinReset += 1;
  }

  function closeCredentialOffer() {
    credentialOffer = null;
    offerPin = '';
    offerPinConfirm = '';
    offerPassword = '';
    offerError = '';
    offerWarning = null;
  }

  /** A PIN's band and sentence, measured by Rust so the rule has one home. */
  async function secretVerdict(secret: string): Promise<SecretVerdict | null> {
    if (!secret) return null;
    try {
      const verdict = await tauriInvoke<{
        ok: boolean;
        problem?: string | null;
        warning?: string | null;
        band?: string | null;
      }>('check_credentials_secret', { secret });
      if (!verdict.ok) {
        // A refusal is not a band: it is said in the same colour every time, because
        // the only thing it can be is the shape the boxes already enforce.
        return verdict.problem
          ? { label: verdict.problem, text: verdict.problem, band: 'refused' }
          : null;
      }
      if (!verdict.warning) return null;
      const band = verdict.band ?? 'average';
      return { label: band.charAt(0).toUpperCase() + band.slice(1), text: verdict.warning, band };
    } catch (error) {
      return {
        label: error instanceof Error ? error.message : String(error),
        text: error instanceof Error ? error.message : String(error),
        band: 'refused'
      };
    }
  }

  /**
   * The PIN is complete: say whether it is weak, and move on to its confirmation.
   *
   * Only while creating. With a vault already on disk there is nothing to choose.
   * the PIN is either this vault's or it is not, and `Save` is where that is decided,
   * so checking it here would only be a second derivation of the same key.
   */
  async function offerPinComplete(pin: string) {
    if (!vaultCreateMode) return;
    offerPinConfirmFocus += 1;
    offerWarning = await secretVerdict(pin);
  }

  /**
   * Save this instance's login and open it, in one unlock.
   *
   * One command rather than unlock-then-save-then-lend: the PIN is derived once, and
   * the vault that the derivation opens is dropped on the way out with nothing left
   * open behind it. The answer is the same one-origin, expiring grant any other
   * instance open leaves.
   */
  async function saveOfferedCredential() {
    const target = credentialOffer;
    if (!target || offerBusy) return;
    offerBusy = true;
    offerError = '';
    try {
      // A verdict is always about the text in the boxes right now (any change to
      // them clears it) so one that has already arrived costs nothing to use. If
      // none has, the answer is still on its way, and this is the moment it would
      // decide something: the gap between typing and clicking is exactly where a
      // password the instance will refuse would otherwise get through.
      const verdict = offerCheckVerdict && offerCheckVerdict.state !== 'busy'
        ? offerCheckVerdict
        : await askInstanceAboutLogin(target.origin, offerUser, offerPassword);
      offerCheckVerdict = verdict;
      if (verdict.state === 'refused') {
        offerError = copy.dialogs.credential.notSaved;
        return;
      }
      await tauriInvoke('save_login_for_instance', {
        origin: target.origin,
        secret: offerPin,
        user: offerUser,
        password: offerPassword,
      });
      offerPin = '';
      offerPinConfirm = '';
      offerPassword = '';
      credentialOffer = null;
      // The row's key is drawn from the vault file's index, which the save just
      // rewrote: a stale set would leave it grey for a login that now exists.
      void refreshVaultStatus();
      void refreshVaultCoverage();
      window.location.href = withLauncherHandoff(target.address, window.location.href, target.query);
    } catch (error) {
      offerError = error instanceof Error ? error.message : String(error);
      offerPinReset += 1;
    } finally {
      offerBusy = false;
    }
  }

  /**
   * Open it with the login that was just typed, and save nothing.
   *
   * This is the workflow for not using the credential manager, and it is what replaced
   * both reasons the page's own prompt used to appear: the answer is borrowed for one
   * load rather than written down. Nothing is opened and no PIN is needed (the values
   * came from the boxes) so it works in the first-run shape too, where the PIN boxes
   * are empty and only the other button wants them.
   *
   * What is left behind is the same one-origin, expiring grant an unlock leaves, which
   * is what lets the page answer its own 401s (`webview_auth.rs`) (including the
   * instance's `/sync/` traffic) without a login ever being stored for it.
   */
  async function openOfferedLoginWithoutSaving() {
    const target = credentialOffer;
    if (!target || offerBusy) return;
    offerBusy = true;
    offerError = '';
    try {
      // The same question `Save Credential` asks, for the same reason: the one moment
      // a password can be tried before it is handed over.
      const verdict = offerCheckVerdict && offerCheckVerdict.state !== 'busy'
        ? offerCheckVerdict
        : await askInstanceAboutLogin(target.origin, offerUser, offerPassword);
      offerCheckVerdict = verdict;
      if (verdict.state === 'refused') {
        offerError = copy.dialogs.credential.notOpened;
        return;
      }
      await tauriInvoke('lend_instance_credentials', {
        origin: target.origin,
        user: offerUser,
        password: offerPassword,
      });
      offerPassword = '';
      credentialOffer = null;
      // Nothing was written, so no row colour changes and no coverage needs asking
      // again: the vault holds exactly what it held a moment ago.
      window.location.href = withLauncherHandoff(target.address, window.location.href, target.query);
    } catch (error) {
      offerError = error instanceof Error ? error.message : String(error);
    } finally {
      offerBusy = false;
    }
  }

  /**
   * The offer's one action. The stages collapse into a single line because only one of
   * them can be happening, and a failure keeps the loader's own reason after its clause.
   */
  async function runFlash(): Promise<void> {
    flashBusy = true;
    flashProblem = '';
    flashPercent = 0;
    flashLine = copy.esp32.downloading;
    try {
      await flashLithicAppliance({
        password: flashPassword,
        onStage: (stage) => {
          flashLine = esp32StageLine(stage);
        },
        onProgress: (progress) => {
          flashPercent = esp32Percent(progress);
        }
      });
      // The password is on the board now, so the field stops holding a secret.
      flashPassword = '';
    } catch (error) {
      flashProblem = copy.esp32.failed(error instanceof Error ? error.message : String(error));
      flashLine = '';
    } finally {
      flashBusy = false;
    }
  }

  /**
   * The offer's two routes to a serial port.
   *
   * Where this window has Web Serial the dialog below is the whole run. Where it has none, the
   * same page goes to a Chromium browser at `?flash=1` (see `Flash.svelte`), which brings its own
   * chooser. The manager stays open for that handoff, so a browser that will not start can say so
   * where the person pressed instead of in a dialog that never appeared.
   */
  async function openFlash(): Promise<void> {
    flashProblem = '';
    if (!flashSupported) {
      flashBrowserBusy = true;
      try {
        await tauriInvoke('flash_in_browser', { lang: LOCALE_TAG });
      } catch (error) {
        flashProblem = copy.esp32.openFailed(error instanceof Error ? error.message : String(error));
      } finally {
        flashBrowserBusy = false;
      }
      return;
    }
    // The manager is the offer's new home, not a backdrop for it: the flasher is the next
    // dialog, and leaving the first one open underneath would stack two overlays whose
    // dismissal rules disagree about which one Escape ends.
    showEmojiPicker = false;
    flashShow = true;
    flashLine = '';
    flashPercent = 0;
  }

  function closeFlash(): void {
    if (flashBusy) return;
    flashShow = false;
  }
</script>

<svelte:head><title>{copy.app.title}</title></svelte:head>

<main class="container" class:panelled={recentPanelShown} class:footer-controls={footerControlsShown} data-mode={mode} data-shim-backend={shimBackendUp}>
  <!--
    The full-export mark, drawn in front of its label wherever the whole-instance export is
    offered: the Instance Management dialog, the rebuild confirmation and the fallback's gated
    dialog. One snippet rather than three copies of a path this long, because three copies are
    three things to keep in step.

    The drawing is the author's own, from an Inkscape page, and the paths below are verbatim
    apart from their ids and their style attributes. Its ring is the mark the row download
    control draws (`.history-download-icon`): rasterise the two and line them up by the one
    translate their own start points differ by, (-8.334174 2.11647), and the rings differ by
    three pixels in sixty nine thousand, which is antialiasing. So the two marks read as one
    family wherever they appear. Inside the ring sits the disc stack from the same file, whose
    gaps are gaps in the artwork rather than rims the sheet paints, which is why nothing here
    is stroked: it fills in `currentColor` and takes the button's own ink in every state. The
    viewBox is the mark's measured tight box plus a hair, so the glyph fills the 17px square
    the vault's key already occupies.
  -->
  {#snippet fullBackupIcon()}
    <svg class="full-backup-icon" viewBox="66.95 107.65 28.69 32.53" aria-hidden="true" focusable="false">
      <path d="m 81.929682,107.65099 c -7.19823,0 -13.10362,5.58342 -13.64723,12.64471 h -0.007 v 15.85743 h -1.32502 l 2.32389,4.02559 2.32441,-4.02559 h -1.32343 V 120.3019 c 0.53018,-5.97937 5.5348,-10.65103 11.65458,-10.65103 6.47462,0 11.70316,5.22855 11.70316,11.70316 0,6.47462 -5.22854,11.70161 -11.70316,11.70161 -2.64451,0 -5.08081,-0.87232 -7.03781,-2.34508 v 2.39572 c 2.05816,1.23707 4.46633,1.94924 7.03781,1.94924 7.5555,0 13.70356,-6.14599 13.70356,-13.70149 0,-7.5555 -6.14806,-13.70304 -13.70356,-13.70304 z" />
      <path d="m 78.212797,118.56692 c -0.01096,0.0474 -0.01803,0.095 -0.02119,0.14263 3.34e-4,0.002 6.79e-4,0.005 10e-4,0.007 0.0024,-0.05 0.0091,-0.10004 0.02015,-0.14986 z" />
      <path d="m 87.016911,118.48682 c 0.02113,0.0768 0.032,0.15412 0.03256,0.23151 1.5e-5,-0.003 1.5e-5,-0.006 0,-0.009 -0.0013,-0.0745 -0.01219,-0.14882 -0.03256,-0.22273 z" />
      <path d="m 78.31925,118.2548 c -0.04175,0.0756 -0.07332,0.1522 -0.09457,0.22944 0.02124,-0.0772 0.05282,-0.15386 0.09457,-0.22944 z" />
      <g transform="matrix(1.5682946,0,0,1.5682946,-47.223077,-67.863211)">
        <path d="m 86.571973,121.3909 c -0.75366,0.6607 -2.281343,1.07728 -3.95118,1.07745 -1.669763,2e-5 -3.197628,-0.41636 -3.951697,-1.07693 -0.313671,0.27473 -0.477237,0.57832 -0.47749,0.88625 -3.5e-5,0.004 -3.5e-5,0.009 0,0.0134 0.0026,-0.15311 0.04565,-0.30555 0.128157,-0.45423 0.487155,0.87768 2.26252,1.49457 4.30103,1.49448 2.038317,-2e-5 3.813403,-0.61688 4.300512,-1.49448 0.082,0.14905 0.124314,0.30185 0.126091,0.45527 7.29e-4,-0.005 0.0014,-0.01 0.0021,-0.0145 -6.9e-5,-0.30811 -0.16364,-0.61188 -0.47749,-0.88677 z" />
        <path d="m 86.571973,123.17154 c -0.75366,0.6607 -2.281343,1.07728 -3.95118,1.07745 -1.669763,2e-5 -3.197628,-0.41636 -3.951697,-1.07693 -0.313671,0.27473 -0.477237,0.57832 -0.47749,0.88625 -3.5e-5,0.004 -3.5e-5,0.009 0,0.0134 0.0026,-0.15311 0.04565,-0.30555 0.128157,-0.45423 0.487155,0.87768 2.26252,1.49457 4.30103,1.49448 2.038317,-2e-5 3.813403,-0.61688 4.300512,-1.49448 0.082,0.14905 0.124314,0.30185 0.126091,0.45527 7.29e-4,-0.005 0.0014,-0.01 0.0021,-0.0145 -6.9e-5,-0.30811 -0.16364,-0.61188 -0.47749,-0.88677 z" />
        <path d="m 78.67323,119.61337 c -0.316531,0.27582 -0.481558,0.58091 -0.481624,0.89039 -2e-5,0.003 -2e-5,0.007 0,0.0103 0.002,-0.15432 0.04501,-0.308 0.128157,-0.45785 0.487155,0.87768 2.26252,1.49457 4.30103,1.49448 2.038317,-2e-5 3.813403,-0.61688 4.300512,-1.49448 0.08351,0.15053 0.126528,0.30491 0.128158,0.45992 2.9e-5,-0.004 2.9e-5,-0.008 0,-0.0124 -6.6e-5,-0.30948 -0.165093,-0.61457 -0.481624,-0.89039 -0.755239,0.65871 -2.280497,1.07367 -3.947046,1.07384 -1.666735,-8e-5 -3.192239,-0.41506 -3.947563,-1.07384 z" />
        <path d="m 82.620797,116.74533 c -2.048093,0.002 -3.826679,0.62552 -4.30103,1.50895 0.487155,0.87768 2.26252,1.49457 4.30103,1.49448 2.038317,-2e-5 3.813403,-0.61688 4.300512,-1.49448 -0.474306,-0.88334 -2.252613,-1.50731 -4.300512,-1.50895 z" />
      </g>
    </svg>
  {/snippet}
  <!--
    The install offer, written once because it has two homes and never both at once: the
    panel's foot row (where a phone wants it, beside the rebuild control) and the footer
    band (for a launcher with nothing listed yet, where there is no foot row to sit in).
    Which one is in play is a fact about the page (whether the panel is drawn) while
    whether the offer is *beside* the rebuild control at all is a fact about the window's
    width, and that half is the stylesheet's: see `.install-offer`.

    The wrapping `<span>` is the offer's own box, so the button's dismiss affordance
    (absolutely placed in the button's corner) has something to be placed against.
  -->
  {#snippet installOfferControl()}
    <span class="install-offer"><button class="install-button" class:update-available={installState === 'update'} on:click={installOfferAction} disabled={installBusy} title={installOfferTitle}>{installOfferLabel}</button><button class="install-dismiss" on:click={dismissInstallOffer} title={copy.install.dismissTitle} aria-label={copy.install.dismissAria}><span class="install-dismiss-label">{copy.install.dismissText}</span>✕</button></span>
  {/snippet}
  <!--
    The panel's rebuild/reset control, written once because it is drawn twice: at the foot of
    the panel, and as the placeholder the landscape layout keeps under the action card while
    the list is still empty. The placeholder is the same control in the same place with
    `disabled`, so the card's geometry does not change the moment the first Lith arrives, and
    its label greys out through the `:disabled` rule the busy state already uses.

    The fallback gets a third shape, `Backup & Reset Recents`, because there the list *is* the
    only copy: nothing on disk can be re-listed, and Reset alone would take every Lith on the
    device with it. That control opens the gated dialog, where each row can be written out
    first and the reset unlocks once they have been.

    Offline mode gets a fourth, `Backup Recents`, which opens that same dialog with no reset in
    it at all. The shelves belong to an instance this page cannot reach, so clearing them is not
    this page's to offer, while the copies on this device are the one thing a download saves and
    nothing else can replace. The rebuild is not merely unhelpful there either: reading the
    server again is the very thing that just failed.
  -->
  {#snippet recentFootControl(placeholder: boolean)}
    {#if offlineLauncher}
      <button class="reset-cache" disabled={placeholder} on:click={openInstanceBackup} title={copy.foot.backupOnlyTitle}>{copy.foot.backupOnly}</button>
    {:else if indexDbOnly}
      <button class="reset-cache" disabled={placeholder} on:click={openInstanceBackup} title={copy.foot.backupResetTitle}>{copy.foot.backupReset}</button>
    {:else if !indexDbOnly && !offlineLauncher}
      {#if showRebuildControl}
        <button class="reset-cache" disabled={placeholder || rebuildBusy} on:click={rebuildRecents} title={isSelfHost() ? copy.foot.rebuildServerTitle : copy.foot.rebuildDiskTitle}>{rebuildBusy ? copy.foot.reindexing : copy.foot.rebuild}</button>
      {:else}
        <button class="reset-cache" disabled={placeholder} on:click={requestReset} title={copy.foot.resetTitle}>{copy.foot.reset}</button>
      {/if}
    {/if}
  {/snippet}
  <!--
    The heading and the one notice that can belong under it, in a band of their own.
    A box rather than a loose pair, because the sideways-phone layout has a row for the
    heading and a row for nothing else: the notice has to sit in the heading's own row
    rather than take one of its own, and the row is the one that gives (see the landscape
    block in styles.css). It is a wrapper and not a nesting: the notice is still a sibling
    of the heading, so it cannot move the mark, the title or the heading's own buttons.
  -->
  <div class="heading-band">
  <header class="heading">
    <!--
      The way back out of a handed-over instance, in the margin left of the mark rather
      than in the heading's own row: a control that appears only sometimes must not move
      what it appears beside, and this one shows up on exactly the pages where the mark
      and the title are also the instance's identity. It leads the heading in source order
      because position must not depend on the mode's trailing buttons, and it is taken out
      of the flow in CSS, so neither the mark nor the title shifts by a pixel.
    -->
    {#if launcherReturnTarget}<button class="back-to-launcher" type="button" data-target={launcherReturnTarget.kind === 'url' ? launcherReturnTarget.url : 'history'} aria-label={copy.app.backToLauncher} title={copy.app.backToLauncher} on:click={backToLauncher}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg></button>{/if}
    <!--
      The mark, which opens Instance Management in every mode. It used to be three controls:
      the picker's button on an instance, an inert tile on a shim, and a link to the project
      everywhere else. Each was one of the dialog's own jobs, so the dialog is what the click
      opens now, and the mode decides what is inside it. That also makes the project link in
      the dialog the desktop app's only way out, since that mode draws no footer.
    -->
    <button
      type="button"
      class="brand-icon-wrap pickable"
      class:brand-emoji-wrap={Boolean(brandEmoji)}
      aria-label={copy.app.manageInstance}
      title={copy.app.manageInstance}
      on:click={() => openInstanceManagement()}
    >
        {#if brandEmoji}
          <!-- The instance's recorded choice, drawn here rather than fetched: it is the
               same picture the published renders hold, and it is an answer an instance
               that cannot be asked still has. -->
          <span class="brand-emoji" aria-hidden="true">{brandEmoji}</span>
        {:else if isSelfHost() && instanceMark && !instanceMarkMissing}
          <!-- The instance's own file, at the address the legacy launcher's header read.
               Whatever it holds is what this instance currently serves as its mark (
               published renders, an icon dropped in by hand) which is not something a
               build of this page can know. -->
          <img class="brand-icon" src={instanceMark} alt={copy.app.brandAlt} on:error={() => (instanceMarkMissing = true)} />
        {:else}
          <!-- Nothing to read: an instance that answered 404 for the published set, or a
               page with no instance behind it. The shipped mark is the truth there, and
               it is also the whole of what the other modes draw. -->
          <img class="brand-icon" src={mstile150} alt={copy.app.brandAlt} />
        {/if}
    </button>
    <div class="heading-copy">
      <h1>{copy.app.title}</h1>
      {#if isSelfHost()}
        <!-- The heading names the open Lith and nothing else: which launcher you are in is
             evident from the page, and how a save is transmitted is the server's business.
             There is no re-list control either. Asking the server again is what the
             browser's own reload is for, and an in-page button for it was one more thing to
             explain for a job the address bar already does. The status line below says
             whether the patch API answered. -->
        <div class="remote-line">
          {#if activeRemote}<span class="remote-file">{activeRemote.name}</span>{/if}
        </div>
      {/if}
      {#if remoteNotice && !offlineLauncher}<div class="status-line">{remoteNotice}</div>{/if}
      {#if remoteError && !offlineLauncher}<div class="status-line error" role="alert">{remoteError}</div>{/if}
      {#if status}<div class="status-line" role="status"><span class="status-label">{status.replace(/[…\.\s]+$/, '')}</span><span class="activity-dots" class:settled={statusSettled} aria-hidden="true"><i></i><i></i><i></i></span></div>{/if}
      {#if mountError}<div class="status-line error" role="alert">{mountError}</div>{/if}
    </div>
    <div class="heading-actions">
    <!--
      The backup button, on the desktop and on an instance alike. The legacy launcher
      only revealed it once the server had answered with its file list (a proxy for
      "this instance speaks the Lithic API") and that gate is dropped here on purpose:
      the button's own answer now distinguishes ok from inaccessible (the state is
      `error` with the reason in its tooltip), so an offline instance is told apart from
      a server that cannot do this at all instead of the control silently not existing.
    -->
    {#if mode === 'webapp' && !browserOnly}<button class="help-button" aria-label={copy.app.viewIntro} title={copy.app.viewIntro} on:click={openIntro}>{introBusy ? '…' : '?'}</button>{/if}
    <!--
      The round control is one button with one job per page, never both at once. The intro
      belongs to the published PWA, whose server serves `intro.lith` beside it, and the sync
      button to anything that can reach a local repository; on an instance and in the app the
      mode alone separates them. A shim is the one page where it cannot: declaring itself
      browser-only is exactly what makes it resolve to `webapp`, the same as the PWA, so the
      declaration is what tells the two apart. A browser-only page therefore draws the sync
      button alone, matching the desktop app it is the Linux half of, and its header carries
      no way into the intro even though the shim still ships the payload for it.

      An appliance is the other page the mode cannot separate: it answers as a self-host
      instance because that is what it is (a store of Liths and a launcher to open them with),
      yet it has no repository and no GitHub machinery at all, so the backup control would open
      a dialog about something the board cannot do. It says what it is (`probeAppliance`) and
      then the heading draws neither button: the intro's place is a page with an introduction
      beside it, and a board carries the wiki and nothing else.
    -->
    {#if (hasLocalSync && platformGitSync) || (isSelfHost() && !appliance)}<button class="sync-button {headingSyncState}" aria-label={copy.dialogs.gitSync.title} title={headingSyncTitle} on:click={openGitSyncModal}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 17.6A5 5 0 0 0 18 8h-1.3A8 8 0 1 0 4 16.3"/><path d="M12 12v9"/><path d="m8.5 15.5 3.5-3.5 3.5 3.5"/></svg>{#if headingSyncState === 'checking'}<span class="sync-glyph ring" aria-hidden="true"></span>{:else if headingSyncState === 'error'}<span class="sync-glyph alert" aria-hidden="true">!</span>{:else if headingSyncState === 'connected'}<span class="sync-glyph dot" aria-hidden="true"></span>{/if}</button>{/if}
    </div>
  </header>
  <!--
    Offline mode's global line, under the heading rather than inside the list it replaces:
    "the rows below are this device's copies, not the server's" is a fact about the
    launcher, and one line covering the screen is what stops it having to be said again on
    every row. It shares the heading's band so that the sideways-phone layout can draw it
    in the row the heading already has. The rows still carry their own mark (the exclamation
    the unfinished states already use) because which Lith is currently local-only is a
    per-row answer; only the reason is global. Only a cached self-host launcher reaches
    this (see offline-mode.ts).
  -->
  {#if offlineLauncher}
    <div class="offline-banner" role="status">
      <svg class="offline-banner-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20Z"/><path d="M12 10v4.5"/><path d="M12 17.3v.2"/></svg>
      <div class="offline-banner-copy">
        <strong>{copy.offline.title}</strong>
        <span>{copy.offline.body}</span>
      </div>
    </div>
  {/if}
  </div>
  {#if pendingImports.length > 0}
    <div class="pending-imports" class:collapsed={pendingCollapsed} role="status" aria-label={copy.pending.aria}>
      <div class="pending-imports-header">
        <!--
          The fold sits against the title, where a disclosure belongs, and the clear stays at the
          far end where it was: one control opens the list and the other abandons the queue, so
          they are two decisions and are drawn as two. The chevron points down while the list is
          drawn and turns to point right once it is folded away.
        -->
        <button
          type="button"
          class="pending-fold"
          aria-expanded={!pendingCollapsed}
          aria-controls="pending-imports-list"
          aria-label={pendingCollapsed ? copy.pending.show : copy.pending.hide}
          title={pendingCollapsed ? copy.pending.show : copy.pending.hide}
          on:click={() => (pendingCollapsed = !pendingCollapsed)}
        >
          <span>{copy.pending.heading}</span>
          <svg class="pending-chevron" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" /></svg>
        </button>
        <button type="button" class="pending-clear" aria-label={copy.pending.clear} title={copy.pending.clear} on:click={() => { pendingImports = []; skippedImports = []; intentionalImports = []; }}>✕</button>
      </div>
      <ul id="pending-imports-list" hidden={pendingCollapsed}>
        {#each pendingImports as tiddler, index}
          <li class={/^\d{14}-\d{3,4}$/.test(tiddler.title ?? '') || Boolean(tiddler['stream-type']) ? 'tiddler-list' : ''}>
            <span class="pending-row">
              <span class="pending-title">{tiddler.title || copy.pending.untitled}</span>
              <button
                type="button"
                class="pending-remove"
                aria-label={copy.pending.remove(tiddler.title || copy.pending.untitled)}
                title={copy.pending.remove(tiddler.title || copy.pending.untitled)}
                on:click={() => pendingImports = removePendingImport(pendingImports, index)}
              >✕</button>
            </span>
          </li>
        {/each}
      </ul>
      {#if shownSkipped.length > 0}
        <p class="pending-note" hidden={pendingCollapsed}>
          {shownSkipped.length === 1 ? copy.pending.skippedOne(shownSkipped[0]) : copy.pending.skippedMany(shownSkipped.length)}
        </p>
      {/if}
    </div>
  {/if}
  <!--
    The instance's own history, inside the GitHub sync dialog on every prong that has one.

    A snippet rather than one block, because the connected screen is not the only one that draws
    it: on a self-host instance the trail belongs to the unconnected screen too, where the commits
    are `git log` on the server's own disk and no GitHub account is involved at all. The rows, the
    chevron between them and the distance beside it are the wiki trail's (`instance-trail.ts`,
    `.history-link`, `.history-gap`), because two lists about two timestamps that said the same
    thing differently would be drift nobody notices until they sit side by side.

    What each row adds is the one action this list exists for: the revert glyph, which writes the
    instance back to that commit as a NEW commit on top, so the trail grows by a row and the move
    is undone by reverting to the commit it replaced.
  -->
  {#snippet instanceTrail()}
    {#if trailOffered && trailView !== 'no-repo'}
      <div class="trail-panel">
        <p class="trail-title">{copy.dialogs.gitSync.trail.title}</p>
        {#if trailView === 'loading'}
          <p class="trail-note">{copy.dialogs.gitSync.trail.loading}</p>
        {:else if trailView === 'failed'}
          <p class="status-line error" role="alert">{trailNote}</p>
        {:else if trailRows.length === 0}
          <p class="trail-note">{copy.dialogs.gitSync.trail.none}</p>
        {:else}
          <ul class="trail-list">
            {#each trailRows as row, index (row.hash)}
              {#if index > 0}
                <!--
                  What joins two commits, exactly as the wiki trail joins two versions: the
                  chevron points up at the newer row, and the distance beside it is that row's
                  own sentence. Decorative, so it stays out of the accessibility tree, and the
                  chevron is pinned to the column's centre line so the arrows read as one spine.
                -->
                <li class="history-link" aria-hidden="true">
                  <svg viewBox="0 0 14 8" aria-hidden="true"><path d="M1.5 6.5 7 1.5l5.5 5"></path></svg>
                  {#if row.gap}<span class="history-gap">{trailGapLabel(row.gap, copy.dialogs.history.later, LOCALE_TAG)}</span>{/if}
                </li>
              {/if}
              <li class="history-entry">
                <span class="trail-hash" title={row.hash}>{row.short}</span>
                <!--
                  What the commit was, rather than the sentence git stored with it: every
                  message in this history was written by Lithic itself, so the row can say
                  which kind of save it was at a glance. The sentence is still there on the
                  pill's own tooltip, which is where a message nobody can read at a glance
                  belongs. The words and their tones are the deck's (`trailBadge`).
                -->
                <span class="history-badge trail-badge {row.badge.tone}" title={row.badge.title}>{row.badge.label}</span>
                <span class="history-time trail-time">{row.stamp}</span>
                <!--
                  The revert glyph, supplied as artwork rather than redrawn: the history trail's
                  own mark turned a quarter turn, so it reads as the same family as the download
                  icon beside the versions without being mistaken for it. It is drawn in the
                  download icon's own coordinate box (`viewBox`, and the same `.history-download-icon`
                  size rule) with one translate, which is what makes the two marks the same size
                  whatever either of them is later restyled to.
                -->
                <button
                  class="recent-icon-button history-download-button trail-revert"
                  type="button"
                  disabled={gitSyncBusy}
                  aria-label={copy.dialogs.gitSync.trail.revertAria(row.short, row.stamp)}
                  title={copy.dialogs.gitSync.trail.revertTitle}
                  on:click={() => askTrailRevert(row)}
                >
                  <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><g transform="translate(-7.01 5.03)"><path class="history-icon-shape" d="m 80.482426,115.61206 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path><path class="history-icon-shape" d="m 96.232885,121.64218 c 0,-7.19823 -5.58342,-13.10362 -12.64471,-13.64723 v -0.007 h -15.85743 v -1.32502 l -4.02559,2.32389 4.02559,2.32441 v -1.32343 h 15.85123 c 5.97937,0.53018 10.65103,5.5348 10.65103,11.65458 0,6.47462 -5.22855,11.70316 -11.70316,11.70316 -6.47462,0 -11.70161,-5.22854 -11.70161,-11.70316 0,-2.64451 0.87232,-5.08081 2.34508,-7.03781 h -2.39572 c -1.23707,2.05816 -1.94924,4.46633 -1.94924,7.03781 0,7.5555 6.14599,13.70356 13.70149,13.70356 7.5555,0 13.70304,-6.14806 13.70304,-13.70356 z"></path></g></svg>
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  {/snippet}
  {#if showGitSyncModal}
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeGitSyncModal()}>
      <div class="launcher-modal git-sync-modal" class:has-trail={trailOffered && trailRows.length > 0} role="dialog" aria-modal="true" aria-labelledby="gitsync-title">          <button class="modal-close" aria-label={copy.dialogs.gitSync.closeAria} on:click={closeGitSyncModal}>×</button>
        <h2 id="gitsync-title">{copy.dialogs.gitSync.title}</h2>
        {#if gitSyncFolderEditable}
          <!--
            A button, not a label: this is the one thing in the dialog the user can change
            about what is being backed up, and it used to be read-only. Which left
            Disconnect as the only way to aim the backup somewhere else. It keeps the plain
            look the line had, so the affordance is the hint on the right plus the hover.

            Drawn while the backup is being set up, and not after: the Connect screen, the
            device-code step it rides on while GitHub is waited on, and the repository
            choice that follows. Every screen up to the one that commits. The connected
            dialog names the folder instead (see the read-only line below) because a backup
            that is already running is not the place to re-aim it: moving it means
            Disconnect and setting it up again, which is also what forgets the pick.

            Drawn even when no folder could be worked out, which is the state a fresh
            download starts in: the line used to be hidden then, and the dialog's whole
            body was one sentence telling the user to save a Lith first. With no way to
            answer it. The empty line is that way out, and the hint says which.
          -->
          <button
            class="sync-folder"
            class:empty={!gitSyncFolder}
            type="button"
            title={gitSyncFolder ? copy.dialogs.gitSync.folder.changeTitle : copy.dialogs.gitSync.folder.chooseTitle}
            aria-label={gitSyncFolder
              ? copy.dialogs.gitSync.folder.changeAria(gitSyncFolder)
              : copy.dialogs.gitSync.folder.chooseAria}
            disabled={gitSyncBusy || gitSyncPicking}
            on:click={chooseSyncFolder}
          >
            <span class="sync-folder-label">{copy.dialogs.gitSync.folder.label}</span>
            <!-- The path keeps the tooltip it had: the line ellipsizes, and the full path is
                 the one thing a person checking which folder this is needs to read. There is
                 no tooltip to carry when there is no path, so the placeholder has none. -->
            <span class="sync-folder-path" title={gitSyncFolder || undefined}>{gitSyncFolder || copy.dialogs.gitSync.folder.none}</span>
            <span class="sync-folder-change">{gitSyncPicking ? copy.dialogs.gitSync.folder.choosing : gitSyncFolder ? copy.dialogs.gitSync.folder.change : copy.dialogs.gitSync.folder.choose}</span>
          </button>
          {#if gitSyncFolderOverridden}
            <!-- Only an override can be undone, so this line is absent otherwise. -->
            <p class="sync-folder-reset"><button type="button" disabled={gitSyncBusy} on:click={clearSyncFolderOverride}>{copy.dialogs.gitSync.folder.automatic}</button></p>
          {/if}
          {#if gitSyncFolderError}<p class="status-line error" role="alert">{gitSyncFolderError}</p>{/if}
        {:else if gitSyncFolderLive}
          <!--
            The folder a running backup acts on, named rather than offered: it is the answer
            this dialog is about, and the picker that could change it belongs to the
            setting-up screens above. A `<div>` rather than a disabled button. Nothing here
            is a control, and a greyed-out one would read as a choice that is temporarily
            unavailable rather than as a statement of fact.
          -->
          <div class="sync-folder readonly" class:empty={!gitSyncFolder}>
            <span class="sync-folder-label">{copy.dialogs.gitSync.folder.label}</span>
            <!-- The same tooltip the picker carries: this line ellipsizes too. -->
            <span class="sync-folder-path" title={gitSyncFolder || undefined}>{gitSyncFolder || copy.dialogs.gitSync.folder.none}</span>
          </div>
        {/if}
        {#if showBackupStatus && backupCoverage.localOnlyPaths.length > 0}
          <p class="backup-status" role="status">{copy.dialogs.gitSync.backedUp(backupCoverage.backedUp, backupCoverage.tracked)}</p>
        {/if}
        {#if gitSyncNoTarget}
          <p class="status-line error" role="alert">{copy.dialogs.gitSync.noTarget}</p>
        {:else if gitSyncView === 'disconnected'}
          {#if isSelfHost()}
            <p>{copy.dialogs.gitSync.serverIntro}</p>
            {#if serverSyncFailed}
              <p class="status-line error" role="alert">{copy.dialogs.gitSync.serverNoAnswer}</p>
            {/if}
          {:else}
            <p>{copy.dialogs.gitSync.folderIntro}</p>
          {/if}
          {#if gitSyncError}<p class="status-line error" role="alert">{gitSyncError}</p>{/if}
          <!--
            The same two lines the connected screen carries, for the reason the trail is offered
            here at all: on an instance the revert works before a backup exists, so its "I did it"
            has to have somewhere to land. A revert with no remote already made this screen the
            one place a successful write could go unsaid.
          -->
          {#if gitSyncMessage}<p class="status-line" role="status">{gitSyncMessage}</p>{/if}
          {#if gitSyncBusy}<p class="sync-progress" role="status"><span class="sync-spinner" aria-hidden="true"></span><span>{gitSyncStage || copy.dialogs.gitSync.working}</span><span class="sync-elapsed">{gitSyncElapsed}s</span>{#if !gitAuthActive && hasLocalSync}<button type="button" class="sync-cancel" on:click={cancelGitSync}>{gitSyncCancelling ? copy.dialogs.gitSync.stopping : copy.dialogs.gitSync.stopSyncing}</button>{/if}</p>{/if}
          <div class="modal-actions"><button class="modal-action" disabled={gitSyncBusy} on:click={startDeviceAuth}>{gitSyncBusy ? '…' : copy.dialogs.gitSync.connect}</button></div>
          <details class="git-sync-advanced">
            <summary>{copy.dialogs.gitSync.tokenSummary}</summary>
            <input bind:value={gitRepoInput} aria-label={copy.dialogs.gitSync.repoAria} placeholder={copy.dialogs.gitSync.repoPlaceholder} on:keydown={(event) => event.key === 'Enter' && connectGitSync()} />
            <input bind:value={gitTokenInput} type="password" aria-label={copy.dialogs.gitSync.tokenAria} placeholder={copy.dialogs.gitSync.tokenPlaceholder} on:keydown={(event) => event.key === 'Enter' && connectGitSync()} />
            {#if gitSyncBusy}<p class="sync-progress" role="status"><span class="sync-spinner" aria-hidden="true"></span><span>{gitSyncStage || copy.dialogs.gitSync.working}</span><span class="sync-elapsed">{gitSyncElapsed}s</span>{#if !gitAuthActive && hasLocalSync}<button type="button" class="sync-cancel" on:click={cancelGitSync}>{gitSyncCancelling ? copy.dialogs.gitSync.stopping : copy.dialogs.gitSync.stopSyncing}</button>{/if}</p>{/if}
            <div class="modal-actions"><button class="modal-action" disabled={!gitRepoInput || !gitTokenInput || gitSyncBusy} on:click={connectGitSync}>{gitSyncBusy ? copy.dialogs.gitSync.connecting : copy.dialogs.gitSync.connectPush}</button></div>
          </details>
          <!-- Below the connect controls, because connecting is still what this screen is for:
               on a server the trail is a local read that needs no GitHub account, which is what
               makes it worth offering before one is set up. -->
          {@render instanceTrail()}
        {:else if gitSyncView === 'connecting'}
          <p>{copy.dialogs.gitSync.stepOne} <a href="https://github.com/login/device" target="_blank" rel="noreferrer" on:click={(event) => openExternalLink(event, 'https://github.com/login/device')}>github.com/login/device</a></p>
          <p>{copy.dialogs.gitSync.stepTwo}</p>
          {#if gitUserCode}
            <!--
              The code is a button, because this step is a code to be typed into a window
              the page cannot reach and copying it is the one thing the page can do to help.
              The glyph is drawn inside the pill rather than a word so that what the pill
              still *says* is only the code, which is what a person reads it for.
            -->
            <button
              class="user-code-display"
              type="button"
              title={copy.dialogs.gitSync.codeCopyTitle}
              aria-label={copy.dialogs.gitSync.codeCopyAria(formatUserCode(gitUserCode))}
              on:click={copyUserCode}
            >
              {formatUserCode(gitUserCode)}
              <svg class="pill-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/></svg>
            </button>
            <p class="git-sync-note">{copy.dialogs.gitSync.waiting}</p>
            <!--
              Under the standing line rather than over it, so the first `.git-sync-note` in
              the dialog is still the one that says what the step is waiting for.
            -->
            {#if gitCodeCopy}
              <p class="git-sync-note copy-status" class:error={gitCodeCopy === 'failed'} role="status">
                {gitCodeCopy === 'copied' ? copy.dialogs.gitSync.codeCopied : copy.dialogs.gitSync.codeCopyFailed}
              </p>
            {/if}
          {:else}
            <p class="git-sync-note">{copy.dialogs.gitSync.requesting}</p>
          {/if}
          {#if gitSyncError}<p class="status-line error" role="alert">{gitSyncError}</p>{/if}
          <!--
            Not "Cancel": this does not close the dialog, it abandons the authorization
            being waited on and returns the dialog to its start. The × beside it would close
            the dialog instead. Two different outcomes, so the word names the one it does.
          -->
          <div class="modal-actions"><button class="modal-action secondary" on:click={resetGitSyncFlow}>{copy.dialogs.gitSync.stopWaiting}</button></div>
        {:else if gitSyncView === 'selecting'}
          <button class="repo-card create" class:selected={gitRepoChoice === '__create__'} type="button" on:click={() => (gitRepoChoice = '__create__')}>
            <input type="radio" name="git-repo-choice" checked={gitRepoChoice === '__create__'} tabindex={-1} />
            <span>{copy.dialogs.gitSync.createAndSync(gitRepoNamePending)}</span>
          </button>
          {#if gitManagedRepos.length > 0}
            <p class="repo-group-label">{copy.dialogs.gitSync.foundRepos}</p>
            <ul class="repo-cards">
              {#each gitManagedRepos as repo (repo)}
                <li>
                  <button class="repo-card" class:selected={gitRepoChoice === repo} type="button" on:click={() => (gitRepoChoice = repo)}>
                    <input type="radio" name="git-repo-choice" checked={gitRepoChoice === repo} tabindex={-1} />
                    <span>{repo}</span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
          <!--
            The rest of the account's repositories, behind a disclosure and closed by default,
            the way the token form above is: choosing between the repositories Lithic made and
            making a new one is the decision this screen is for, while every other repository
            in somebody's GitHub account is a list nobody needs on screen to make it. The
            triangle the browser draws is the affordance; the name typed inside still picks a
            repository that is not in the list at all.
          -->
          <details class="git-sync-advanced">
            <summary>{copy.dialogs.gitSync.otherReposSummary}</summary>
            <input bind:value={gitCustomRepoInput} class="repo-filter" aria-label={copy.dialogs.gitSync.customRepoAria} placeholder={copy.dialogs.gitSync.customRepoPlaceholder} on:input={() => (gitRepoChoice = gitCustomRepoInput.trim() ? '__custom__' : gitRepoChoice)} />
            {#if gitOtherRepos.length > 0}
              <ul class="repo-list">
                {#each gitOtherRepos.filter((repo) => !gitCustomRepoInput || repo.toLowerCase().includes(gitCustomRepoInput.toLowerCase())) as repo (repo)}
                  <li><button type="button" class="repo-card" class:selected={gitRepoChoice === repo} on:click={() => { gitCustomRepoInput = repo; gitRepoChoice = repo; }}>{repo}</button></li>
                {/each}
              </ul>
            {/if}
          </details>
          {#if gitSyncError}<p class="status-line error" role="alert">{gitSyncError}</p>{/if}
          {#if gitSyncMessage}<p class="status-line" role="status">{gitSyncMessage}</p>{/if}
          {#if gitSyncBusy}<p class="sync-progress" role="status"><span class="sync-spinner" aria-hidden="true"></span><span>{gitSyncStage || copy.dialogs.gitSync.working}</span><span class="sync-elapsed">{gitSyncElapsed}s</span>{#if !gitAuthActive && hasLocalSync}<button type="button" class="sync-cancel" on:click={cancelGitSync}>{gitSyncCancelling ? copy.dialogs.gitSync.stopping : copy.dialogs.gitSync.stopSyncing}</button>{/if}</p>{/if}
          <div class="modal-actions">
            <button class="modal-action" disabled={gitSyncBusy || !gitRepoSelection()} on:click={finalizeGitSync}>{gitSyncBusy ? copy.dialogs.gitSync.syncing : copy.dialogs.gitSync.startSync}</button>
            <button class="modal-action secondary" on:click={resetGitSyncFlow}>{copy.common.back}</button>
          </div>
        {:else}
          <p>{copy.dialogs.gitSync.connectedRepo}</p>
          {#if gitSyncRepoUrl}
            <!--
              The repository name is a link to the repository, which is the one thing this
              dialog is about that lives somewhere else. An anchor rather than a button on
              purpose: the browser's own handling is what right click, copy-link and the
              modifier keys depend on, the address stays in the `href` so the control is still
              a link if this script never runs, and `openExternalLink` is what hands the click
              to the machine in the desktop app, where a `target="_blank"` click has no second
              window to land in. The glyph sits inside the pill for the reason the device
              code's does: what the pill says is the name.
            -->
            <a
              class="user-code-display repo-link"
              href={gitSyncRepoUrl}
              target="_blank"
              rel="noreferrer"
              title={copy.dialogs.gitSync.openRepoTitle(gitSyncConnectedRepo)}
              aria-label={copy.dialogs.gitSync.openRepoAria(gitSyncConnectedRepo)}
              on:click={(event) => openExternalLink(event, gitSyncRepoUrl)}
            >
              {gitSyncConnectedRepo}
              <svg class="pill-glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6"/><path d="M20 4 11 13"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>
            </a>
          {:else}
            <!-- Nothing to point at, so this stays the statement it was: no `href` to promise
                 a click, and the pointer says the same thing. -->
            <p class="user-code-display repo-link">{copy.dialogs.gitSync.notRecorded}</p>
          {/if}
          {#if isSelfHost()}
            <!--
              The server's own clock, not this device's opinion of it: the sync happens
              there, and the only thing the page knows is when the server said it last did.
            -->
            <p class="git-sync-note">{serverSyncAge ? copy.dialogs.gitSync.lastSynced(serverSyncAge) : copy.dialogs.gitSync.noSyncYet}</p>
          {:else if gitSyncHealthNote && !gitSyncHealthEchoed}
            <p class="status-line {gitSyncHealthBroken ? 'error' : ''}" role={gitSyncHealthBroken ? 'alert' : 'status'}>{gitSyncHealthNote}</p>
          {:else}
            <p class="git-sync-note">{copy.dialogs.gitSync.savesHere}</p>
          {/if}
          {@render instanceTrail()}
          {#if gitSyncError}<p class="status-line error" role="alert">{gitSyncError}</p>{/if}
          {#if gitSyncMessage}<p class="status-line" role="status">{gitSyncMessage}</p>{/if}
          {#if gitSyncBusy}<p class="sync-progress" role="status"><span class="sync-spinner" aria-hidden="true"></span><span>{gitSyncStage || copy.dialogs.gitSync.working}</span><span class="sync-elapsed">{gitSyncElapsed}s</span>{#if !gitAuthActive && hasLocalSync}<button type="button" class="sync-cancel" on:click={cancelGitSync}>{gitSyncCancelling ? copy.dialogs.gitSync.stopping : copy.dialogs.gitSync.stopSyncing}</button>{/if}</p>{/if}
          <div class="modal-actions">
            <!--
              One action, because there is one thing left to want: stopping. Pointing the
              instance at a different repository is this, then Connect to GitHub again, which
              runs the same device flow over the same setup route. A second button would
              have been the same journey with the backup left running while it was abandoned.
            -->
            {#if !isSelfHost() && gitSyncHealthBroken}
              <button class="modal-action" disabled={gitSyncBusy || gitAuthActive} on:click={reconnectGitSync}>{gitAuthActive ? copy.dialogs.gitSync.waitingForGitHub : copy.dialogs.gitSync.reconnect}</button>
            {/if}
            <button class="modal-action warn" disabled={gitSyncBusy} on:click={disconnectGitSync}>{copy.dialogs.gitSync.disconnect}</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
  {#if flashShow}
    <!--
      The one-time flash offer. A blank board is the subject, so the dialog asks for one thing:
      the password the board will broadcast its network with, which is written into the flash
      beside the published images. The button waits for a usable password and then stays
      disabled for the run rather than offering a second start over the top of the first. It
      opens only from the manager row, which is drawn only where Web Serial exists, so there
      is no unsupported shape to draw here.
    -->
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeFlash()}>
      <div class="launcher-modal flash-modal" role="dialog" aria-modal="true" aria-labelledby="flash-title">
        <button class="modal-close" aria-label={copy.esp32.closeAria} disabled={flashBusy} on:click={closeFlash}>×</button>
        <h2 id="flash-title">{copy.esp32.title}</h2>
        <p>{copy.esp32.intro}</p>
        <label class="flash-field">
          <span>{copy.esp32.passwordLabel}</span>
          <input bind:value={flashPassword} type="password" autocomplete="new-password" aria-describedby="flash-password-rule" disabled={flashBusy} />
        </label>
        <p class="flash-rule" id="flash-password-rule">{copy.esp32.passwordRule}</p>
        {#if flashLine}
          <p class="status-line" role="status">{flashLine}{#if flashBusy && flashPercent > 0}{' - '}{flashPercent}%{/if}</p>
        {/if}
        {#if flashProblem}<p class="status-line error" role="alert">{flashProblem}</p>{/if}
        <div class="modal-actions">
          <button class="modal-action" disabled={flashBusy || !flashPasswordOk} on:click={runFlash}>{copy.esp32.flash}</button>
        </div>
      </div>
    </div>
  {/if}
  {#if showBookmarks && showBookmarkModal}
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeBookmarkModal()}>
      <div class="launcher-modal bookmark-modal" role="dialog" aria-modal="true" aria-labelledby="bookmark-title">
        <button class="modal-close" aria-label={copy.dialogs.bookmark.closeAria} on:click={closeBookmarkModal}>×</button>
        <h2 id="bookmark-title">{copy.dialogs.bookmark.title}</h2>
        <p>{copy.dialogs.bookmark.intro}</p>
        <input bind:this={bookmarkInputElement} bind:value={bookmarkInput} aria-label={copy.dialogs.bookmark.urlAria} placeholder={copy.dialogs.bookmark.urlPlaceholder} on:keydown={(event) => event.key === 'Enter' && addInstanceBookmark()} />
        {#if bookmarkError}<p class="status-line error" role="alert">{bookmarkError}</p>{/if}
        <div class="modal-actions">
          <button class="modal-action" on:click={addInstanceBookmark}>{copy.dialogs.bookmark.save}</button>
          {#if mode === 'tauri' && platformCredentials && vaultStatus}
          <!--
            The vault, from the dialog that owns the same thing it does: an
            instance's address. It used to be a tile in the launcher's own row.
            The same pairing, but spending permanent space on the main screen for
            something you only reach for while setting an instance up. The key on
            each bookmark row manages one address; this one manages the vault
            itself, which is changing the secret or forgetting every login at once.
            Same two colours as those row keys: grey means nothing saved, green
            means something is.

            Its label is the verb rather than the noun (manage, not the thing
            managed) because the noun is what the dialog it opens is already called
            (Saved Instance Logins, and the panel inside it), and the noun with a
            count is what its tooltip says, so nothing is lost by not repeating it.
            The row it shares is one choice stated twice, which is why the two actions
            are the same width (`styles.css`): a key sized to its own label beside a
            full-width save reads as the lesser option rather than as the other one.
          -->
          <button
            class="modal-action secondary vault-manager-button"
            class:has-logins={vaultSavedCount > 0}
            type="button"
            aria-label={vaultManagerTitle}
            title={vaultManagerTitle}
            on:click={openSavedLoginsFromBookmarks}
          ><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.2" cy="8.2" r="4.3"/><path d="m11.4 11.4 8 8"/><path d="m15.4 15.4 2.6-2.6"/><path d="m18.2 18.2 2.6-2.6"/></svg><span>{copy.dialogs.bookmark.manage}</span></button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
  {#if instanceUnlock}
    <!--
      Asked for every time an instance with a saved login is opened, which is the
      point of the model: the vault is locked until something needs it, and what this
      buys is one instance load. The sixth character is the submit. There is nothing
      else this dialog could be asking for, and nothing in it to confirm. For the same
      reason it has no action row at all: there is nothing to press, and the × in the
      corner already does everything a Cancel button would have done.
    -->
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && cancelInstanceUnlock()}>
      <div class="launcher-modal vault-modal" role="dialog" aria-modal="true" aria-labelledby="instance-unlock-title">
        <button class="modal-close" aria-label={copy.dialogs.unlock.closeAria} on:click={cancelInstanceUnlock}>×</button>
        <h2 id="instance-unlock-title">{copy.dialogs.unlock.title(instanceLabel(instanceUnlock.origin))}</h2>
        <p class="vault-sub">{copy.dialogs.unlock.sub}</p>
        <div class="vault-pin instance-unlock-pin">
          <PinEntry
            bind:value={instanceSecret}
            bind:reveal={pinReveal}
            revealToggle
            label={copy.common.pin}
            disabled={instanceUnlockBusy}
            reset={instanceSecretReset}
            complete={(pin) => void unlockInstance(pin)}
          />
        </div>
        {#if instanceUnlockError}<p class="status-line error" role="alert">{instanceUnlockError}</p>{/if}
      </div>
    </div>
  {/if}
  {#if credentialOffer}
    <!--
      The one dialog that writes a login, and the only place a password can be typed
      for an instance nothing is saved for: either the offer a challenging instance
      makes while it is opened, or a bookmark row's key. Closed, it borrows the login
      for this one load and stores nothing, which is what replaced the page's own prompt.
      The answer is in the grant either way, so the webview never has to ask.
    -->
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeCredentialOffer()}>
      <div class="launcher-modal vault-modal" role="dialog" aria-modal="true" aria-labelledby="credential-offer-title">
        <button class="modal-close" aria-label={copy.dialogs.credential.closeAria} on:click={closeCredentialOffer}>×</button>
        <h2 id="credential-offer-title">{copy.dialogs.credential.title}</h2>
        <!--
          One line, whichever way this dialog was reached. It used to have two: the
          offer's said why the dialog had opened ("www.foobar.com asks for a password")
          and the row's what the credential was tied to ("answered per exact address").
          The first was the heading again with an address in it, and an address the user
          just clicked is not news. The second read as a scope the user might weigh, when
          it is only how the vault decides what to offer. What is left is the one fact
          this dialog cannot do without: which instance the credential is for.
        -->
        <p class="vault-sub">{copy.dialogs.credential.forInstance(instanceLabel(credentialOffer.origin))}</p>
        <div class="vault-pin credential-offer-pin">
          <PinEntry
            bind:value={offerPin}
            bind:reveal={pinReveal}
            revealToggle={!vaultCreateMode}
            label={vaultCreateMode ? copy.common.choosePin : copy.common.pin}
            disabled={offerBusy}
            reset={offerPinReset}
            complete={(pin) => void offerPinComplete(pin)}
          />
          <!--
            The band word, at the end of the boxes' own label line: it is about the PIN
            those boxes hold, and it is the whole of what this dialog says about it. That
            end of that line is where the password field below puts its own Show toggle,
            and the two are never drawn together, because this word exists only while a
            PIN is being chosen, which is the mode that draws no toggle. The
            arithmetic behind the word rides in the word's title, so the estimate is
            still there to be read without a paragraph standing in the dialog. It
            describes a complete candidate, so it goes when the boxes no longer hold one:
            a band about a PIN that has been cleared is about nothing.
          -->
          {#if offerWarning && offerPin.length === 6}
            <p class="vault-band {offerWarning.band}" role="status" title={offerWarning.text}>{offerWarning.label}</p>
          {/if}
        </div>
        {#if vaultCreateMode}
          <div class="vault-pin credential-offer-pin-confirm">
            <PinEntry
              bind:value={offerPinConfirm}
              bind:reveal={pinReveal}
              label={copy.common.repeatPin}
              disabled={offerBusy}
              reset={offerPinReset}
              focusSignal={offerPinConfirmFocus}
            />
          </div>
        {/if}
        <label class="vault-field"><span>{copy.dialogs.credential.username}</span><input class="credential-offer-user" bind:value={offerUser} autocomplete="off" /></label>
        <!-- One password box, not two: the instance is asked about what is typed here,
             and it is the only thing that can tell a mistyped password from a correct
             one. Two identical typos satisfy a repeat box. Its toggle sits in its label
             row, at the right edge of it, which is the input's own width. The same place
             the PIN's toggle lands on its boxes, because this is the field nothing
             repeats back. It is a label of its own rather than one wrapped around the
             field: a label cannot hold another label, and the row above the input is
             where the toggle's place is. -->
        <div class="vault-field">
          <div class="pin-head">
            <label class="pin-label" for="credential-offer-password">{copy.dialogs.credential.password}</label>
            <label class="vault-reveal"><input type="checkbox" bind:checked={passwordReveal} /> {copy.common.show}</label>
          </div>
          <input id="credential-offer-password" class="credential-offer-password" type={passwordReveal ? 'text' : 'password'} bind:value={offerPassword} autocomplete="off" />
        </div>
        {#if offerCheckVerdict}
          <!-- Said in the dialog rather than discovered after the handoff: this is
               the last screen that can tell the user a password is wrong, because
               the page it signs in to is one this app cannot speak on. -->
          <p class="vault-check-line {offerCheckVerdict.state}" role="status" title={offerCheckVerdict.detail}>{offerCheckVerdict.detail}</p>
        {/if}
        {#if offerError}<p class="status-line error" role="alert">{offerError}</p>{/if}
        <div class="modal-actions">
          <button
            class="modal-action credential-offer-save"
            disabled={offerBusy || offerPin.length !== 6 || (vaultCreateMode && offerPin !== offerPinConfirm) || !offerUser || !offerPassword || offerCheckVerdict?.state === 'refused'}
            on:click={saveOfferedCredential}
          >{offerBusy ? copy.dialogs.credential.saving : copy.dialogs.credential.save}</button>
          <!-- No PIN, because nothing is written: this is the whole of "not using the
               credential manager", and it is why the page's own prompt no longer needs
               to exist in the desktop app. -->
          <button
            class="modal-action secondary credential-offer-without-saving"
            disabled={offerBusy || !offerUser || !offerPassword || offerCheckVerdict?.state === 'refused'}
            on:click={openOfferedLoginWithoutSaving}
          >{offerBusy ? '…' : copy.dialogs.credential.openWithoutSaving}</button>
        </div>
      </div>
    </div>
  {/if}
  {#if showVaultModal}
    <!-- Saved logins: the list, and the PIN that opens it. Three shapes rather than a
         wizard: no vault yet (where a login comes from, and nothing to open), the PIN,
         and the list. Rust answers the first (`credentials_status`); the second is only
         whether the list arrived, so it cannot be true about a PIN Rust refused.

         There is no unlocked state to be in. Each action below carries the PIN in the
         same command that uses it, so the app never sits holding a key and closing this
         dialog has nothing to lock. The cost is one KDF per action rather than one per
         visit, which for a vault of this size is the cheap side of the trade. -->
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeVaultModal()}>
      <div class="launcher-modal vault-modal" role="dialog" aria-modal="true" aria-labelledby="vault-title">
        <button class="modal-close" aria-label={copy.dialogs.vault.closeAria} on:click={closeVaultModal}>×</button>
        <h2 id="vault-title">{copy.dialogs.vault.title}</h2>
        {#if vaultListOpen}
          <!--
            Nothing above the rows. The heading names the thing and the rows *are* the
            list, so a sentence here could only restate either, and the one thing this
            dialog cannot do, answer a password prompt, is what the dialog that writes a
            credential says where the user is typing one.
          -->
          {#if vaultEntries.length > 0}
            <ul class="vault-list">
              {#each vaultEntries as entry (entry.origin)}
                <li>
                  <span class="vault-origin" title={entry.origin}>{entry.origin}</span>
                  <span class="vault-user" title={entry.user}>{entry.user}</span>
                  {#if vaultChecks[entry.origin]}
                    <span
                      class="vault-check {vaultChecks[entry.origin].state}"
                      role="status"
                      title={vaultChecks[entry.origin].detail}
                    >{vaultChecks[entry.origin].label}</span>
                  {/if}
                  <!-- The one place a saved login can be tried against its instance: the
                       row knows which address to ask about, and the command carries the
                       PIN, so Rust decrypts the password, sends it and drops it without
                       it ever reaching this code. -->
                  <button
                    class="vault-test"
                    type="button"
                    disabled={vaultBusy || vaultChecks[entry.origin]?.state === 'busy'}
                    aria-label={copy.dialogs.vault.checkAria(entry.origin)}
                    title={copy.dialogs.vault.checkTitle}
                    on:click={() => testVaultEntry(entry.origin)}
                  ><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.6-5.9"/><path d="m8.4 11.6 3 3 8.2-8.2"/></svg></button>
                  <button class="vault-forget" type="button" disabled={vaultBusy} aria-label={copy.dialogs.vault.forgetAria(entry.origin)} title={copy.dialogs.vault.forgetTitle} on:click={() => forgetVaultEntry(entry.origin)}>✕</button>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="vault-empty">{copy.dialogs.vault.empty}</p>
          {/if}
          <div class="modal-actions">
            {#if vaultStatus?.exists}
              <!-- The only destructive control, and the PIN's only replacement: an
                   unwanted or forgotten PIN is changed by setting the vault up again,
                   which costs the logins and nothing else. Confirmed, because that is
                   the one thing here that knowing the secret cannot undo. It lives in
                   this dialog and nowhere else: forgetting everything is a fact about
                   the vault, not about whichever instance happens to be opening. -->
              <button class="modal-action secondary vault-danger" disabled={vaultBusy} on:click={destroyVault}>{copy.dialogs.vault.forgetAll}</button>
            {/if}
          </div>
        {:else if !vaultStatus?.exists}
          <!--
            No vault at all. There is nothing to open and nothing to write here: a login
            is saved for an instance you are already pointing at (a row's key, or the
            offer an instance's own prompt makes) so this says what the dialog is for
            instead of offering a form that would take any address at all. Where a login
            comes from is on the key that writes one, which is the only control that can
            name an address, so this does not repeat it. There is no action row either:
            there is nothing in here to decide, and the × is the only way out a dialog
            like this needs.
          -->
          <p class="vault-sub">{copy.dialogs.vault.intro}</p>
        {:else}
          <p class="vault-sub">{copy.dialogs.vault.pinPrompt}</p>
          {#if vaultSavedCount > 0}
            <!-- Known without unlocking, from the file's index. Which is why the
                 manager can say what is in there without opening it. -->
            <p class="vault-count" role="status">{copy.dialogs.vault.count(vaultSavedCount)}</p>
          {/if}
          <div class="vault-pin vault-unlock-pin">
            <!-- The toggle rides in the PIN's own label row: this is a PIN typed once,
                 at a dialog whose only business is opening, so being able to read it
                 back is the only check it gets. -->
            <PinEntry
              bind:value={vaultSecret}
              bind:reveal={pinReveal}
              revealToggle
              label={copy.common.pin}
              disabled={vaultBusy}
              reset={vaultPinReset}
              complete={(pin) => void openVaultList(pin)}
            />
          </div>
          <div class="modal-actions">
            <button class="modal-action" disabled={vaultBusy || vaultSecret.length !== 6} on:click={() => openVaultList()}>{vaultBusy ? '…' : copy.common.open}</button>
            {#if vaultStatus?.exists}<button class="modal-action secondary vault-danger" disabled={vaultBusy} on:click={destroyVault}>{copy.dialogs.vault.forgetAll}</button>{/if}
          </div>
        {/if}
        {#if vaultNotice}<p class="vault-notice" role="status">{vaultNotice}</p>{/if}
        {#if vaultError}<p class="status-line error" role="alert">{vaultError}</p>{/if}
        {#if vaultStatus}<p class="vault-path">{copy.dialogs.vault.storedIn} <code>{vaultStatus.path}</code></p>{/if}
      </div>
    </div>
  {/if}
  {#if remoteCollision}
    <div class="modal-overlay" role="presentation">
      <div class="launcher-modal" role="dialog" aria-modal="true" aria-labelledby="collision-title">
        <button class="modal-close" aria-label={copy.dialogs.collision.closeAria} on:click={() => (remoteCollision = null)}>×</button>
        <h2 id="collision-title">{copy.dialogs.collision.title}</h2>
        <p>{remoteCollision.who || copy.dialogs.collision.someone} {copy.dialogs.collision.hasOpenBefore} <strong>{remoteCollision.name}</strong> {copy.dialogs.collision.hasOpenAfter}</p>
        <p class="git-sync-note">{copy.dialogs.collision.note}</p>
        <div class="modal-actions">
          <button class="modal-action" on:click={() => resolveRemoteCollision('read-only')}>{copy.dialogs.collision.openReadOnly}</button>
          <button class="modal-action secondary" on:click={() => resolveRemoteCollision('ignore')}>{copy.dialogs.collision.ignoreLock}</button>
        </div>
      </div>
    </div>
  {/if}
  {#if showEmojiPicker}
    <div class="modal-overlay emoji-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeInstanceManagement()}>
      <div class="launcher-modal emoji-modal" role="dialog" aria-modal="true" aria-labelledby="emoji-title">
        <button class="modal-close" aria-label={copy.dialogs.icon.closeAria} on:click={closeInstanceManagement}>×</button>
        <h2 id="emoji-title">{copy.dialogs.icon.title}</h2>
        <!--
          The picker, on an instance that can actually serve the icons: this is the one page
          whose icon can be set, and the icon belongs to the deployment rather than to this
          browser. An appliance is the page mode cannot separate and this question can: a board
          stores whatever is PUT into its `/sync/` and serves none of it, because the watcher
          that turns a written icon set into the mark a tab draws is part of a deployment, not
          of the firmware. So the picker is left out there rather than offering a change nothing
          would make.
        -->
        {#if isSelfHost() && !appliance}
        <p>{copy.dialogs.icon.intro}</p>
        <div class="emoji-preview" aria-hidden="true">
          {#if emojiChoice}
            <span class="emoji-preview-glyph">{emojiChoice}</span>
          {:else}
            <img class="emoji-preview-mark" src={mstile150} alt="" />
          {/if}
        </div>
        <div class="emoji-grid" role="listbox" aria-label={copy.dialogs.icon.chooseAria}>
          {#each emojiGrid as emoji}
            <button
              type="button"
              class="emoji-btn"
              class:selected={emojiChoice === emoji}
              role="option"
              aria-selected={emojiChoice === emoji}
              on:click={() => chooseEmoji(emoji)}
            >{emoji}</button>
          {/each}
        </div>
        {#if emojiStatus}<p class="status-line" role="status">{emojiStatus}</p>{/if}
        <div class="modal-actions">
          <button class="modal-action" disabled={emojiBusy || !emojiChoice} on:click={confirmEmojiIcon}>{emojiBusy ? copy.dialogs.icon.saving : copy.dialogs.icon.save}</button>
          <button class="modal-action secondary" disabled={emojiBusy} on:click={restoreDefaultInstanceIcon} title={copy.dialogs.icon.restoreTitle}>{copy.dialogs.icon.restore}</button>
        </div>
        {/if}
        <!--
          The dialog's other two jobs, in every mode, under a rule so they read as the rest of
          its business rather than as part of the icon choice above.
        -->
        <div class="modal-actions management-actions">
          {#if backupPill}
          <span class="orphan-pill {backupPill.tone}" role="status" title={backupPill.title}>{backupPill.label}</span>
          {:else}
          <button class="modal-action secondary full-backup-button" disabled={backupBusy} on:click={downloadInstanceBackup} title={copy.dialogs.icon.backupTitle}>{@render fullBackupIcon()}{backupBusy ? '…' : copy.dialogs.icon.backup}</button>
          {/if}
          <!--
            The appliance offer, drawn only where pressing it can reach a board: a Chromium
            tab has Web Serial, and the desktop app has a browser it can hand the page to.

            It was a footer link, beside the project link, on every page. Two things were
            wrong with that: it is not a thing every page is for, and the footer is drawn in
            the desktop app and on a phone, where there is no serial device to reach at all,
            so the one control a person could press there only ever failed. A platform with
            nothing to offer says nothing rather than drawing a button that does not work,
            which is the rule the install offer already follows.

            The board itself is the third audience it is not for, and the one its own condition
            cannot see: a flash writes a blank board, and the page a board serves is the thing
            that would receive it, so an appliance is excluded (`appliance`) rather than offered
            a second copy of itself.
          -->
          {#if flashOfferable && !appliance}
            <button class="modal-action secondary flash-button" type="button" disabled={flashBrowserBusy} on:click={openFlash} title={flashSupported ? copy.esp32.openTitle : copy.esp32.openBrowserTitle}>{copy.esp32.open}</button>
          {/if}
          <!--
            The way out to the project as a small link at the end of the row rather than a
            third full-width button: the dialog has two jobs (the icon and the backup) and
            this is neither of them. It is drawn in every mode, so it stays the desktop
            app's only way out, since that mode draws no footer link.
          -->
          <a class="modal-footnote-link" href={PROJECT_URL} target="_blank" rel="noreferrer" title={copy.dialogs.icon.docsTitle} on:click={(event) => openExternalLink(event, PROJECT_URL)}>{copy.dialogs.icon.docs}</a>
        </div>
        {#if backupStatus}<p class="status-line" role="status">{backupStatus}</p>{/if}
        {#if flashProblem}<p class="status-line error" role="alert">{flashProblem}</p>{/if}
      </div>
    </div>
  {/if}
  {#if rebuildOrphans.length > 0}
    <div class="modal-overlay" role="presentation">
      <div class="launcher-modal orphan-modal" role="dialog" aria-modal="true" aria-labelledby="orphan-title">
        <h2 id="orphan-title">{isSelfHost() ? copy.dialogs.rebuild.titleServer : copy.dialogs.rebuild.titleDisk}</h2>
        <p>
          {#if isSelfHost()}
            {copy.dialogs.rebuild.bodyServer(rebuildOrphans.length)}
          {:else}
            {copy.dialogs.rebuild.bodyDisk(rebuildOrphans.length)}
          {/if}
        </p>
        {#if rebuildOrphans.some((orphan) => dirtyEntries[orphan.name])}
          <p class="orphan-warning" role="alert">
            {copy.dialogs.rebuild.unsavedWarning(rebuildOrphans.filter((orphan) => dirtyEntries[orphan.name]).length)}
          </p>
        {/if}
        <ul class="orphan-list">
          {#each orphanRows as row (row.orphan.name)}
            <li class="orphan-row">
              <span class="orphan-name" title={row.orphan.path ?? copy.dialogs.rebuild.noFile}>{row.orphan.name}</span>
              {#if !row.orphan.path}<span class="orphan-tag">{copy.dialogs.rebuild.cachedOnly}</span>{/if}
              {#if dirtyEntries[row.orphan.name]}<span class="orphan-tag dirty" title={copy.dialogs.rebuild.unsavedCaptured(new Date(dirtyEntries[row.orphan.name]).toLocaleString(LOCALE_TAG))}>{copy.dialogs.rebuild.unsavedTag}</span>{/if}
              {#if cachedEntries[row.orphan.name]}
                {#if row.pill}<span class="orphan-pill {row.pill.tone}" role="status" title={row.pill.title}>{row.pill.label}</span>
                {:else}
                <button class="recent-icon-button" type="button" aria-label={copy.row.downloadAria(row.orphan.name)} title={copy.row.downloadTitle} on:click={() => downloadCachedSnapshot(row.orphan.name)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"></path><path d="m7.5 10.5 4.5 4.5 4.5-4.5"></path><path d="M5 19h14"></path></svg>
                </button>
                {/if}
              {/if}
              {#if historyAvailable[row.orphan.name]}
              <button class="recent-icon-button cache-history-button" type="button" aria-label={copy.row.historyAria(row.orphan.name)} title={copy.row.olderVersions} on:click={() => openHistoryModal(row.orphan.name)}>
                <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
              </button>
              {/if}
            </li>
          {/each}
        </ul>
        {#if orphanNote}<p class="orphan-progress" role="status">{orphanNote}</p>{/if}
        <!--
          The whole-instance export, beside the per-row downloads. It is the other way to keep
          everything this dialog is about to drop, and the only one that also carries the
          recents that were never in the list below; the note under it says so.
        -->
        <div class="instance-backup-full">
          {#if backupPill}
          <span class="orphan-pill {backupPill.tone}" role="status" title={backupPill.title}>{backupPill.label}</span>
          {:else}
          <button class="modal-action secondary full-backup-button" disabled={backupBusy} on:click={downloadInstanceBackup} title={copy.dialogs.rebuild.fullBackupTitle}>{@render fullBackupIcon()}{backupBusy ? '…' : copy.dialogs.rebuild.fullBackup}</button>
          {/if}
        </div>
        <p class="git-sync-note">{copy.dialogs.rebuild.fullBackupNote}</p>
        {#if backupStatus}<p class="status-line" role="status">{backupStatus}</p>{/if}
        <div class="modal-actions">
          <button class="modal-action secondary" on:click={() => resolveRebuildOrphans(false)}>{copy.common.cancel}</button>
          <!-- The destructive half of the question, in the red the app uses for one: the
               rows it drops keep nothing (not the cached copy, not the history) and a
               download from this dialog is the only way to write one of them out first. -->
          <button class="modal-action danger" on:click={() => resolveRebuildOrphans(true)}>{copy.dialogs.rebuild.proceed}</button>
        </div>
      </div>
    </div>
  {/if}
  <!--
    What a plain `Reset Recents` asks before it goes, in the shape the rebuild warning above
    already uses, because it is the same loss by another route: a reset deletes every cached
    copy, version history and unsaved capture with the list, and in this mode there is no
    rebuild to grow them back. The rows are the ones that hold something, a download stands
    beside each copy, one full backup covers them all (captures and history included), and
    Cancel leaves everything as it was. It is a yes/no confirmation, so it keeps its Cancel
    instead of a corner ×.
  -->
  {#if resetAtRisk.length > 0}
    <div class="modal-overlay" role="presentation">
      <div class="launcher-modal orphan-modal reset-modal" role="dialog" aria-modal="true" aria-labelledby="reset-title">
        <h2 id="reset-title">{copy.dialogs.reset.title}</h2>
        <p>{copy.dialogs.reset.body(resetAtRisk.length)}</p>
        {#if resetAtRisk.some((row) => dirtyEntries[row.name])}
          <p class="orphan-warning" role="alert">
            {copy.dialogs.reset.unsavedWarning(resetAtRisk.filter((row) => dirtyEntries[row.name]).length)}
          </p>
        {/if}
        <ul class="orphan-list">
          {#each resetRiskRows as row (row.row.name)}
            <li class="orphan-row">
              <span class="orphan-name" title={row.row.path ?? copy.dialogs.rebuild.noFile}>{row.row.name}</span>
              {#if !row.row.path}<span class="orphan-tag">{copy.dialogs.rebuild.cachedOnly}</span>{/if}
              {#if dirtyEntries[row.row.name]}<span class="orphan-tag dirty" title={copy.dialogs.rebuild.unsavedCaptured(new Date(dirtyEntries[row.row.name]).toLocaleString(LOCALE_TAG))}>{copy.dialogs.rebuild.unsavedTag}</span>{/if}
              {#if cachedEntries[row.row.name]}
                {#if row.pill}<span class="orphan-pill {row.pill.tone}" role="status" title={row.pill.title}>{row.pill.label}</span>
                {:else}
                <button class="recent-icon-button" type="button" aria-label={copy.row.downloadAria(row.row.name)} title={copy.row.downloadTitle} on:click={() => downloadCachedSnapshot(row.row.name)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"></path><path d="m7.5 10.5 4.5 4.5 4.5-4.5"></path><path d="M5 19h14"></path></svg>
                </button>
                {/if}
              {/if}
            </li>
          {/each}
        </ul>
        {#if resetRiskNote}<p class="orphan-progress" role="status">{resetRiskNote}</p>{/if}
        <div class="instance-backup-full">
          {#if backupPill}
          <span class="orphan-pill {backupPill.tone}" role="status" title={backupPill.title}>{backupPill.label}</span>
          {:else}
          <button class="modal-action secondary full-backup-button" disabled={backupBusy} on:click={downloadInstanceBackup} title={copy.dialogs.rebuild.fullBackupTitle}>{@render fullBackupIcon()}{backupBusy ? '…' : copy.dialogs.rebuild.fullBackup}</button>
          {/if}
        </div>
        <p class="git-sync-note">{copy.dialogs.rebuild.fullBackupNote}</p>
        {#if backupStatus}<p class="status-line" role="status">{backupStatus}</p>{/if}
        <div class="modal-actions">
          <button class="modal-action secondary" on:click={() => (resetAtRisk = [])}>{copy.common.cancel}</button>
          <button class="modal-action danger" on:click={confirmReset}>{copy.foot.reset}</button>
        </div>
      </div>
    </div>
  {/if}
  <!--
    The export's own dialog, in the two shapes the one decision above gives it (see
    `backupResettable`). The browser-only store's is the guardrail, and the one dialog in the
    launcher whose action is gated: every row there is the only copy of a Lith there is, so
    Reset waits for a download per row or for one full backup, and the line above it says how
    many are left. The close control is the way out, which is why there is no Cancel beside it
    (see the dismissal rule in styles.css).

    On an instance that cannot be reached the same dialog prints with no reset in it: the rows
    are the copies this device holds, the export is offered exactly as it is here, and the action
    row and its gate line are gone rather than disabled, because there is nothing under them to
    unlock and this page has no business clearing somebody's instance.
  -->
  {#if showInstanceBackup}
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && (showInstanceBackup = false)}>
      <div class="launcher-modal orphan-modal instance-backup-modal" role="dialog" aria-modal="true" aria-labelledby="instance-backup-title">
        <button class="modal-close" aria-label={backupCopy.closeAria} on:click={() => (showInstanceBackup = false)}>×</button>
        <h2 id="instance-backup-title">{backupCopy.title}</h2>
        <p>{backupCopy.body}</p>
        <ul class="orphan-list">
          {#each backupRows as row (row.name)}
            <li class="orphan-row">
              <span class="orphan-name" title={row.name}>{row.name}</span>
              {#if row.pill}<span class="orphan-pill {row.pill.tone}" role="status" title={row.pill.title}>{row.pill.label}</span>
              {:else}
              <button class="recent-icon-button" type="button" aria-label={copy.row.downloadAria(row.name)} title={copy.row.downloadTitle} on:click={() => downloadCachedSnapshot(row.name, row.text)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"></path><path d="m7.5 10.5 4.5 4.5 4.5-4.5"></path><path d="M5 19h14"></path></svg>
              </button>
              {/if}
            </li>
          {/each}
        </ul>
        <div class="instance-backup-full">
          {#if backupPill}
          <span class="orphan-pill {backupPill.tone}" role="status" title={backupPill.title}>{backupPill.label}</span>
          {:else}
          <button class="modal-action secondary full-backup-button" disabled={backupBusy} on:click={downloadInstanceBackup} title={copy.dialogs.instanceBackup.fullBackupTitle}>{@render fullBackupIcon()}{backupBusy ? '…' : copy.dialogs.instanceBackup.fullBackup}</button>
          {/if}
        </div>
        {#if backupStatus}<p class="status-line" role="status">{backupStatus}</p>{/if}
        {#if backupResettable}
          {#if !backupOpen.open}<p class="instance-backup-gate" role="status">{copy.dialogs.instanceBackup.gate(backupOpen.remaining)}</p>{/if}
          <div class="modal-actions">
            <button class="modal-action danger" disabled={!backupOpen.open} title={backupOpen.open ? copy.foot.resetTitle : copy.dialogs.instanceBackup.resetLockedTitle} on:click={resetRecentsFromBackup}>{copy.dialogs.instanceBackup.reset}</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
  <!--
    A dropped backup this device cannot take whole. It is a refusal and not a question, so
    there is no action row: the names are the work, and the close control is the way back.
  -->
  {#if importCollisions.length > 0}
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && (importCollisions = [])}>
      <div class="launcher-modal" role="dialog" aria-modal="true" aria-labelledby="import-collision-title">
        <button class="modal-close" aria-label={copy.dialogs.backupImport.closeAria} on:click={() => (importCollisions = [])}>×</button>
        <h2 id="import-collision-title">{copy.dialogs.backupImport.title}</h2>
        <p>{copy.dialogs.backupImport.body(importCollisions.length)}</p>
        <ul class="orphan-list">
          {#each importCollisions as name (name)}
            <li class="orphan-row"><span class="orphan-name" title={name}>{name}</span></li>
          {/each}
        </ul>
        <p class="git-sync-note">{copy.dialogs.backupImport.note}</p>
      </div>
    </div>
  {/if}
  {#if showHistoryModal}
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeHistoryModal()}>
      <div class="launcher-modal history-modal" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <button class="modal-close" aria-label={copy.dialogs.history.closeAria} on:click={closeHistoryModal}>×</button>
        <h2 id="history-title" title={historyName}>{copy.dialogs.history.title(clipFilename(historyName))}</h2>
        <!--
          The header is adaptive: a Lith that lives outside every backed-up
          folder leads with the offer to copy it in, because that is the one
          thing this dialog can do about it and GitHub sync is already wired
          up. Above the fallback's claim and the versions, so the row's mark
          opens onto the same answer whether the Lith is unsaved, browser-only,
          or simply not where the backup is.
        -->
        <!--
          The app only. The offer's one action is `copy_lith_to_synced_dir`, and both the copy
          and the commit that would follow it are the desktop app's: a shim reads a folder's
          backup state today but cannot write to it yet, so offering the copy there would hand
          the user a button that cannot answer.
        -->
        {#if mode === 'tauri' && historyLocalOnlyPath && historySyncedFolder}
          <div class="history-backup-offer" role="group" aria-label={copy.dialogs.history.backupGroupAria}>
            <p title={historySyncedFolder}>{copy.dialogs.history.localOnly(historySyncedFolder)}</p>
            <button class="modal-action" on:click={() => offerCopyToSyncedDir(historyName, historyLocalOnlyPath)}>{copy.dialogs.history.copy}</button>
          </div>
        {/if}
        {#if historyBrowserOnly}
          <!--
            The fallback's claim, said here because this is the only place a touch
            screen can read it: the mark that opens this dialog carries it as a title,
            and a title is a hover. The download below is what it points at.
          -->
          <p class="browser-only-history-note">{copy.row.browserOnlyNote}</p>
        {/if}
        {#if historyBusy}
          <p class="history-empty">{copy.dialogs.history.loading}</p>
        {:else if historyRows.length === 0}
          <p class="history-empty">{historyError || copy.dialogs.history.none}</p>
        {:else}
          <ul class="history-list">
            {#each historyRows as entry, index (entry.id)}
              {@const newer = historyRows[index - 1]}
              {@const gap = newer ? historyGapLabel(newer.ts, entry.ts) : ''}
              {#if newer}
                <!--
                  What joins two versions, and the only thing that says which way the list
                  runs. The store hands these over newest first, so the row above any entry
                  is the version written after it: the chevron points UP at that one, from
                  the older version at the bottom towards the newer one above, which is the
                  direction the trail is read back in. The arrow is also what makes a `step`
                  read as a delta against the version above rather than as an unrelated row.
                  Beside it, in grey, the distance between the two as one unit: the answer
                  to a question two long timestamps otherwise leave to mental arithmetic.
                  Decorative, so it stays out of the accessibility tree (the stamps either
                  side of it already say exactly when each version was written) and the chevron
                  is pinned to the column's centre line, the distance hung off its right.
                -->
                <li class="history-link" aria-hidden="true">
                  <svg viewBox="0 0 14 8" aria-hidden="true"><path d="M1.5 6.5 7 1.5l5.5 5"></path></svg>
                  {#if gap}<span class="history-gap">{gap}</span>{/if}
                </li>
              {/if}
              <li class="history-entry" class:inline={entry.inline} class:capture-open={entry.inline && historyCaptureOpen}>
                {#if entry.inline}
                  <!--
                    The capture row is a disclosure, and what it discloses is the two things
                    this dialog can do about edits no save has written, without opening the
                    Lith: merge them into the document they came from, or throw them away.
                    Opening is not one of them, because the row in the list behind this dialog
                    already opens, and that is where the unsaved-edits prompt lives.

                    The head is a button, so the whole first line is the target and the
                    keyboard gets the same one. The download sits outside it, at the far end,
                    because it is the control every version row below carries in the same
                    place, and the chevron turns when the disclosure is open.
                  -->
                  <div class="history-capture-head-row">
                    <button type="button" class="history-capture-head" aria-expanded={historyCaptureOpen} aria-controls="history-capture-body" on:click={toggleHistoryCapture}>
                      <span class="history-badge unsaved" title={copy.row.unsavedFrom(new Date(entry.ts).toLocaleString(LOCALE_TAG))}>{copy.dialogs.history.inlinePill}</span>
                      <span class="history-time">{entry.lastModified}</span>
                      <span class="history-inline-note">{copy.dialogs.history.inlineNote}</span>
                      <svg class="history-capture-chevron" viewBox="0 0 14 8" aria-hidden="true"><path d="M1.5 1.5 7 6.5l5.5-5"></path></svg>
                    </button>
                    {#if entry.pill}<span class="orphan-pill {entry.pill.tone}" role="status" title={entry.pill.title}>{entry.pill.label}</span>
                    {:else}
                    <button class="recent-icon-button history-download-button" type="button" aria-label={copy.dialogs.history.downloadCaptureAria(entry.lastModified)} title={copy.dialogs.history.downloadCaptureTitle} disabled={historyCaptureSaving} on:click={saveHistoryCapture}>
                      <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
                    </button>
                    {/if}
                  </div>
                  {#if historyCaptureOpen}
                    <div class="history-capture-body" id="history-capture-body">
                      {#if historyDirty && historyDirty.tiddlers.length > 0}
                        <!-- The same list the recovery prompt draws, so the edits on offer are the
                           edits either window would recover: a title apiece, capped, and a count
                           for the rest rather than a scrollbar nobody reads. No sentence above
                           it: the row's own stamp is the moment, `Not saved yet` is the state,
                           and a line repeating either would be the third account of one fact. -->
                        <ul class="dirty-tiddler-list">
                          {#each historyDirty.tiddlers.slice(0, 8) as tiddler (tiddler.title)}
                            <li>{tiddler.title}</li>
                          {/each}
                          {#if historyDirty.tiddlers.length > 8}<li class="dirty-more">{copy.dialogs.dirty.more(historyDirty.tiddlers.length - 8)}</li>{/if}
                        </ul>
                      {/if}
                      <!-- What merging can promise on this rung, and nothing where the ordinary
                           answer needs no explaining. -->
                      {#if historyMergeRung === 'copy'}<p class="history-capture-why">{copy.dialogs.history.rebuildNote}</p>{:else if historyMergeRung === 'capture'}<p class="history-capture-why">{copy.dialogs.history.captureOnlyNote}</p>{/if}
                      <div class="history-capture-actions">
                        <button class="modal-action" disabled={historyMergeRung === 'capture' || historyCaptureSaving} on:click={mergeHistoryCapture}>{copy.dialogs.history.merge}</button>
                        <button class="modal-action danger" disabled={historyCaptureSaving} on:click={discardHistoryCapture}>{copy.dialogs.dirty.discard}</button>
                      </div>
                    </div>
                  {/if}
                {:else}
                  {#if entry.isBase && entry.external}<span class="history-badge sync" title={copy.dialogs.history.badgeSyncTitle}>{copy.dialogs.history.badgeSync}</span>{:else if entry.isBase}<span class="history-badge" title={copy.dialogs.history.badgeFullTitle}>{copy.dialogs.history.badgeFull}</span>{:else}<span class="history-badge delta" title={copy.dialogs.history.badgeStepTitle}>{copy.dialogs.history.badgeStep}</span>{/if}
                  <span class="history-time">{entry.lastModified}</span>
                  <span class="history-size">{formatCacheSize(entry.sizeBytes)}</span>
                  {#if entry.pill}<span class="orphan-pill {entry.pill.tone}" role="status" title={entry.pill.title}>{entry.pill.label}</span>
                  {:else}
                  <button class="recent-icon-button history-download-button" type="button" aria-label={copy.dialogs.history.downloadAria(entry.lastModified)} title={copy.row.downloadTitle} on:click={() => downloadHistoryVersion(entry.id)}>
                    <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
                  </button>
                  {/if}
                {/if}
              </li>
            {/each}
          </ul>
          {#if historyError}<p class="status-line error" role="alert">{historyError}</p>{/if}
          <!--
            What the last merge said, at the dialog's own level rather than inside the
            disclosure: a merge that worked retires the very row the notice would have been
            drawn in, and a sentence hidden by the thing it describes is no confirmation at all.
            A download needs no sentence here: it leaves a mark on its own row.
          -->
          {#if historyNotice}<p class="history-capture-notice" role="status">{historyNotice}</p>{/if}
          <!--
            Only when something here can be downloaded. The line tells a reader what to do
            with a version they take; beside a trail whose only row is the unsaved capture
            there is nothing to take, and the instruction would point at an absence.
          -->
          {#if historyEntries.length > 0}<p class="history-note">{copy.dialogs.history.note}</p>{/if}
        {/if}
      </div>
    </div>
  {/if}
  {#if showDirtyModal && dirtyInfo}
    <div class="modal-overlay" role="presentation">
      <div class="launcher-modal dirty-modal" role="dialog" aria-modal="true" aria-labelledby="dirty-title">
        <h2 id="dirty-title">{copy.dialogs.dirty.title}</h2>
        <p>
          {copy.dialogs.dirty.body(dirtyInfo.name, dirtyInfo.tiddlers.length, new Date(dirtyInfo.ts).toLocaleString(LOCALE_TAG))}
        </p>
        <ul class="dirty-tiddler-list">
          {#each dirtyInfo.tiddlers.slice(0, 8) as tiddler (tiddler.title)}
            <li>{tiddler.title}</li>
          {/each}
          {#if dirtyInfo.tiddlers.length > 8}<li class="dirty-more">{copy.dialogs.dirty.more(dirtyInfo.tiddlers.length - 8)}</li>{/if}
        </ul>
        <div class="modal-actions">
          <button class="modal-action" on:click={() => resolveDirtyModal('merge')}>{copy.dialogs.dirty.recover}</button>
          <button class="modal-action secondary" on:click={() => resolveDirtyModal('later')}>{copy.dialogs.dirty.later}</button>
          <!--
            The one answer here that cannot be taken back, so the one that wears the red: merging
            folds the edits into the mount and deciding later leaves the question open, where
            discarding clears the copy of them that exists nowhere else (see
            `prepareDirtyRecovery`). The dialog is the three-way prompt with no × and no Cancel,
            so the cost has to be on the button rather than on a second window behind it.
          -->
          <button class="modal-action danger" on:click={() => resolveDirtyModal('discard')}>{copy.dialogs.dirty.discard}</button>
        </div>
      </div>
    </div>
  {/if}
  {#if confirmation}
    <div class="modal-overlay" role="presentation">
      <div class="launcher-modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
        <h2 id="confirm-title">{confirmation.title}</h2>
        <p>{confirmation.body}</p>
        <div class="modal-actions">
          <button bind:this={confirmationButton} class="modal-action" class:danger={confirmation.danger} on:click={() => resolveConfirmation(true)}>{confirmation.confirmLabel}</button>
          <button class="modal-action secondary" on:click={() => resolveConfirmation(false)}>{copy.common.cancel}</button>
        </div>
      </div>
    </div>
  {/if}
  <section class="launcher-actions" aria-label={copy.actions.aria}>
    <div class="action-card action-pair" class:new-lith-open={showNewLithModal}>
      {#if showNewLithModal}
        <div class="new-lith-inline" role="dialog" aria-label={copy.newLith.placeholder}>
          <div class="new-lith-row">
            <div class="new-lith-field">
              {#if newLithError}<span class="new-lith-error" role="alert">{newLithError}</span>{:else if newLithRenamed}<span class="new-lith-rename" role="status">{copy.newLith.renamed(newLithNormalized)}</span>{/if}
              <input bind:this={newLithInputElement} bind:value={newLithName} aria-label={copy.newLith.nameAria} placeholder={copy.newLith.placeholder} spellcheck="false" on:keydown={(event) => { if (event.key === 'Enter') submitNewLith(); else if (event.key === 'Escape') closeNewLithModal(); }} on:input={() => (newLithError = '')} />
              <button type="button" class="new-lith-check" class:invalid={newLithTaken} aria-label={newLithTaken ? copy.newLith.taken : copy.newLith.create} title={newLithTaken ? copy.newLith.taken : copy.newLith.create} on:click={submitNewLith}>{#if newLithTaken}<svg class="new-lith-warn" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20Z"/><path d="M12 10v4.5"/><path d="M12 17.3v.2"/></svg>{:else}✓{/if}</button>
            </div>
            <button type="button" class="recent-icon-button remove-recent new-lith-close" aria-label={copy.newLith.closeAria} title={copy.common.cancel} on:click={closeNewLithModal}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button>
          </div>
        </div>
      {:else}
        <button class="action-button new-blank-button" use:alignNewLithLabel on:click={openNewLithModal} disabled={busy}><span class="new-blank-label">{copy.actions.newBlank}</span></button>
      {/if}
      {#if pickerRefused || (inWebView && mode !== 'tauri')}
        <!--
          A window that refused a chooser has told us the one thing it can still do is hand the page
          to the browser, so that is what the control becomes: the same face, an intent address for
          the page the person is already on, and a browser at the other end where a chooser opens.
          The line above it says what the second tap will do.
        -->
        <a class="action-button mount-button" href={mountHandoff()}><span class="mount-label">{mode === 'self-host' ? copy.actions.upload : copy.actions.mount}</span></a>
      {:else}
        <button class="action-button mount-button" on:click={mountFromDisk} disabled={busy}><span class="mount-label">{mode === 'self-host' ? copy.actions.upload : copy.actions.mount}</span></button>
      {/if}
      {#if showBookmarks}
      <button class="bookmark-button" aria-label={copy.actions.bookmarkAria} title={copy.actions.bookmarkTitle} on:click={openBookmarkModal}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16l-6-4z" /></svg></button>
      {/if}
    </div>
  </section>
  {#if recentPanelShown}
    <section class="recent-section" aria-label={copy.recent.aria}>
      <div class="recent-search-wrap">
        <svg class="recent-search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7.5"></circle><path d="m16.5 16.5 4 4"></path></svg>
        <input class="recent-search" aria-label={copy.recent.searchAria} placeholder={copy.recent.searchPlaceholder} bind:value={search} on:keydown={handleSearchKeydown} />
        {#if search}<button class="recent-search-clear" type="button" aria-label={copy.recent.clearSearch} on:click={() => search = ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button>{/if}
      </div>
      <div class="recent-list" use:trackListScroll>
        {#if isSelfHost()}
          {#if offlineLauncher}
            <!--
              The same rows the online list draws, taken from this device instead of the
              server, because these are the only Liths that can be opened now. Each keeps
              the mark the unfinished rows already carry -- the history icon with an
              exclamation -- which is the per-row half of what the banner above says: this
              Lith is currently local only. Clicking mounts the copy read-only, and the
              dialog behind the mark is where a real file can be taken from it.
            -->
            {#each offlineRows as entry (entry.name)}
              {@const offlineTitle = modifiedTitle(cachedEntries[entry.name]?.lastModified, LOCALE_TAG) ?? copy.offline.rowOpenTitle}
              <div class="recent-row offline-row">
                <button class="recent-name" title={offlineTitle} on:click={() => void openCachedEntry(entry)}>{@html titleMarkup(entry.name, search)}<span class="cached-size">{formatCacheSize(entry.sizeBytes)}</span></button>
                <button class="recent-icon-button cache-history-button modified" type="button" title={copy.offline.rowMarkTitle} aria-label={copy.row.historyAria(entry.name)} on:click={() => openHistoryModal(entry.name)}>
                  <svg class="history-download-icon modified" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z"></path><path class="history-icon-mark" d="M72.3 116h2.6v9h-2.6z"></path><circle class="history-icon-mark" cx="73.6" cy="128.4" r="1.6"></circle></svg>
                </button>
                <!--
                  The same panel a local match draws, on the rows that ARE the local copies:
                  offline there is no server to take a Lith from, so pinning the matched note
                  and opening this device's copy read-only is the whole of what the row can
                  offer, and it is what the row's own click already does.
                -->
                {#if cacheSearchMatches[entry.name]?.preview}
                  <div
                    use:positionCachePreview
                    class="cache-preview"
                    role="button"
                    tabindex="0"
                    aria-label={cacheSearchMatches[entry.name].title ? copy.row.pinAria(entry.name, cacheSearchMatches[entry.name].title ?? '') : copy.row.openAria(entry.name)}
                    title={copy.row.pinTitle}
                    on:click={() => void pinCachedCopyFromPreview(entry)}
                    on:keydown={(event) => (event.key === 'Enter' || event.key === ' ') && void pinCachedCopyFromPreview(entry)}
                  >{@html cacheSearchMatches[entry.name].preview}</div>
                {/if}
              </div>
            {/each}
          {:else}
            {#if remoteBusy && remoteFiles.length === 0}
              <p class="empty">{copy.recent.readingServer}</p>
            {/if}
            <!--
              The server's files, and nothing else, with no group heading over them and no
              marker beside them: both existed to separate these rows from this device's own,
              and in this mode there are no others to separate them from. The list is the
              store; a Lith somewhere on this machine belongs to the mode that owns that
              machine.
            -->
            {#each filteredRemote as file (file.name)}
              <div class="recent-row remote-row">
                <!--
                  The row's suffix is the file's size on the server, not its date: on this
                  list the dates of a store are its least interesting fact (the server
                  commits constantly, so they all read "today"), while the size is the one
                  thing a name cannot tell you about a Lith you are about to open. The date
                  is on the hover instead, where a reader who wants it asks for it. The
                  suffix is absent when the store does not report a size, rather than shown
                  as a zero.
                -->
                <button class="recent-name" title={remoteRowTitle(file)} on:click={() => openRemoteFile(file.name)}>{@html titleMarkup(file.name, search)}{#if file.sizeBytes !== null}<span class="cached-size">{formatLithSize(file.sizeBytes)}</span>{/if}</button>
                <!--
                  The one fact about a Lith in a store that only this client can tell you:
                  what *it* has read of that Lith, and when. Same control, same place and the
                  same meaning as on this device's own rows, drawn only where there is
                  something behind it. A Lith nothing here has indexed has no versions, and a
                  button that opens an empty dialog is worse than none. Which is why an
                  instance's rows are bare until a rebuild has read the store.
                -->
                {#if dirtyEntries[file.name] || historyAvailable[file.name]}
                  <button
                    class="recent-icon-button cache-history-button"
                    class:modified={Boolean(dirtyEntries[file.name])}
                    type="button"
                    disabled={!cachedEntries[file.name]}
                    aria-label={copy.row.historyAria(file.name)}
                    title={dirtyEntries[file.name] ? copy.row.unsavedFrom(new Date(dirtyEntries[file.name]).toLocaleString(LOCALE_TAG)) : copy.row.showHistory}
                    on:click={() => openHistoryModal(file.name)}
                  >
                    {#if dirtyEntries[file.name]}
                      <svg class="history-download-icon modified" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z"></path><path class="history-icon-mark" d="M72.3 116h2.6v9h-2.6z"></path><circle class="history-icon-mark" cx="73.6" cy="128.4" r="1.6"></circle></svg>
                    {:else}
                      <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
                    {/if}
                  </button>
                {/if}
                <!--
                  Beside the row, the same panel with the same grey preview this device's own
                  matched rows draw, because it is the same fact: these words are in a copy
                  the launcher holds of this Lith. The gesture matches too, pinning the note
                  the preview was cut from and opening the Lith, and the one difference is
                  worth knowing: the note comes out of the cache, and the document that opens
                  is the server's current copy of it.
                -->
                {#if cacheSearchMatches[file.name]?.preview}
                  <div
                    use:positionCachePreview
                    class="cache-preview"
                    role="button"
                    tabindex="0"
                    aria-label={cacheSearchMatches[file.name].title ? copy.row.pinAria(file.name, cacheSearchMatches[file.name].title ?? '') : copy.row.openAria(file.name)}
                    title={copy.row.pinTitle}
                    on:click={() => void pinRemoteFromPreview(file.name)}
                    on:keydown={(event) => (event.key === 'Enter' || event.key === ' ') && void pinRemoteFromPreview(file.name)}
                  >{@html cacheSearchMatches[file.name].preview}</div>
                {/if}
                <!--
                  The × the legacy store carried on every remote row, kept: on an instance
                  the launcher's list is the store, and a Lith that can only be added is a
                  store nobody can tidy. It asks first, because this one deletes the file
                  every reader of the instance opens rather than a copy of it held here.
                -->
                <button class="recent-icon-button remove-recent remove-remote" type="button" aria-label={copy.row.deleteFromServerAria(file.name)} title={copy.row.deleteFromServerTitle} on:click={() => removeRemoteLith(file.name)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button>
              </div>
            {/each}
          {/if}
        {/if}
        {#if listEmpty}
          <p class="empty">{emptyMessage}</p>
        {/if}
        <!-- The device's own lists: recents, caches, bookmarks. Never drawn in self-host,
             for the same reason the server's rows are drawn only there. -->
        {#if mode !== 'self-host'}
        {#if showBookmarks}
        {#each filteredBookmarks as entry (entry.url)}
          <div class="recent-row bookmark-row">
            <!--
              The cached instance icon belongs to the link, not beside it: inside
              the button the hover/focus highlight covers it. As a sibling it sat
              outside the button's background, so the row read as two controls.
              An icon that did nothing and a label that opened the instance.
            -->
            <button class="recent-name bookmark-name" title={copy.row.openUrl(entry.url)} on:click={() => openBookmarkedInstance(entry.url)}>
              {#if entry.icon}
                <img class="bookmark-icon" src={entry.icon} alt="" aria-hidden="true" />
              {:else}
                <span class="bookmark-icon bookmark-icon-empty" aria-hidden="true"></span>
              {/if}
              <!--
                The address is drawn the way every other row's name is: with the query that
                listed the row marked inside it. The label is the address (`instanceLabel`),
                so the mark lands on the characters the person typed, and a row that is here
                because of its address reads as an answer rather than as a shorter list.
              -->
              <span class="bookmark-label">{@html matchMarkup(entry.label, search)}</span>
            </button>
            {#if mode === 'tauri' && platformCredentials && vaultStatus}
              {@const origin = vaultOriginOf(entry.url)}
              <!--
                One key per bookmark, and the only way a login is ever written. Grey
                while nothing is saved for the address, green once a login is, and the
                state is known without unlocking anything, from the vault file's index.
                Clicking it either opens the manager on that login, or the one dialog
                that can save one for this exact address; the address is never typed,
                which is what makes every stored credential instance-specific.
              -->
              <button
                class="recent-icon-button vault-row-button"
                class:covered={vaultCoverage.has(origin)}
                type="button"
                disabled={!origin}
                aria-label={origin ? vaultRowTitle(origin) : copy.row.noAddressAria(entry.url)}
                title={origin ? vaultRowTitle(origin) : copy.row.noAddress}
                on:click={() => (origin && (vaultCoverage.has(origin) ? openVaultModal() : openCredentialOffer(origin, entry.url, 'row')))}
              ><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8.2" cy="8.2" r="4.3"/><path d="m11.4 11.4 8 8"/><path d="m15.4 15.4 2.6-2.6"/><path d="m18.2 18.2 2.6-2.6"/></svg></button>
            {/if}
            <!--
              Beside the row, exactly as a match inside one of this device's own Liths is
              drawn (same panel, same place, same marked preview) because it is the same
              fact: these words are somewhere this row leads to. What it cannot be is the
              local panel's pin. That click writes a pending tiddler into the document the
              launcher is about to rewrite in place, and an instance's wiki is at another
              origin with no such document to write into. So the gesture hands the window
              over carrying the query instead, and the instance's own search (which is
              where the rest of the matches are, this being one hit per instance and no
              more) takes it from there.
            -->
            {#if instanceCacheHits[entry.url]?.preview}
              <div
                use:positionCachePreview
                class="cache-preview"
                role="button"
                tabindex="0"
                aria-label={copy.row.openSearchingAria(entry.label, search.trim())}
                title={copy.row.openSearchingTitle(entry.label)}
                on:click={() => openBookmarkedInstance(entry.url, search.trim())}
                on:keydown={(event) => (event.key === 'Enter' || event.key === ' ') && openBookmarkedInstance(entry.url, search.trim())}
              >{@html instanceCacheHits[entry.url].preview}</div>
            {/if}
            <!--
              The read of an instance is bounded, and this says so where the answer it
              bounds is drawn. The alternative is a row that looks like a complete answer
              while an older Lith in the same instance matches and is simply not read,
              which is the one failure a search cannot show the user by being empty.
            -->
            {#if mode === 'tauri' && search.trim() && instanceReads[entry.url]?.truncated}
              <span class="instance-truncated-note">{copy.row.instanceTruncated}</span>
            {/if}
            <button class="recent-icon-button remove-recent" type="button" aria-label={copy.row.removeBookmarkAria(entry.url)} on:click={() => removeInstanceBookmark(entry.url, entry.label)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button>
          </div>
        {/each}
        {/if}
        {#each filteredRecent as file}
          {@const name = getEntryName(file)}
          {@const diskPath = recentDiskPath(file as any)}
          <!--
            Read here rather than through a helper: Svelte re-evaluates these when the
            variables they name change, and a function reads none of them from the template's
            point of view. Through a helper the stamp only appeared on a row that happened to
            be drawn again, which is exactly how half the list kept its old hover.
          -->
          {@const stamp = (diskPath ? fileStamps[diskPath] : undefined) ?? cachedEntries[name]?.lastModified}
          {@const rowTitle = modifiedTitle(stamp, LOCALE_TAG) ?? diskPath ?? undefined}
          {@const browserOnlyRow = (file as any).browserOnly === true}
          {@const unsavedRow = Boolean(dirtyEntries[name])}
          {@const localOnlyRow = showBackupStatus && Boolean(diskPath) && localOnlyPaths.has(diskPath as string)}
          {@const markedRow = browserOnlyRow || localOnlyRow || unsavedRow}
          <div class="recent-row">
            <!--
              The hover answers when this Lith was last written. The file's own stamp is the
              answer wherever a process can read it, which is the desktop app and a shim; the
              copy this device holds is the answer everywhere else, because a browser's handle
              needs a permission the person has not been asked for and a hover is not the place
              to ask. A row with neither keeps the place it lives, which is what the hover said
              before, and a row with no place at all keeps no tooltip rather than a made-up one.
            -->
            <button class="recent-name" title={rowTitle} on:click={() => openRecent(file)}>{@html titleMarkup(name, search)}{#if cachedEntries[name]}<span class="cached-size">{formatCacheSize(cachedEntries[name].sizeBytes)}</span>{/if}</button>
            <!--
              One mark for every kind of unfinished row: no file at all, a file
              outside every backed-up folder, or edits never saved. It is the
              history icon with an exclamation where the clock hands sit, in
              yellow, because opening it is the answer to all three. The dialog
              lists the versions, carries the fallback's claim, and offers the
              copy into the synced folder, so a row that needs attention stays
              one icon wide instead of growing a second and a third.

              The states are read into locals at the top of the block rather than
              asked of a helper: Svelte re-evaluates a template condition when the
              variables it names change, and a function call names none of them,
              so through a helper the mark only appeared once something else
              rebuilt the row. Which is after the coverage answer landed.
            -->
            {#if markedRow || historyAvailable[name]}
              <button
                class="recent-icon-button cache-history-button"
                class:modified={markedRow}
                type="button"
                disabled={!markedRow && !cachedEntries[name]}
                aria-label={browserOnlyRow ? browserOnlyMarkTitle(name) : unsavedRow ? copy.row.unsavedAria(name) : localOnlyRow ? copy.row.localOnlyAria(name) : copy.row.historyAria(name)}
                title={browserOnlyRow ? browserOnlyMarkTitle(name) : unsavedRow ? copy.row.unsavedFrom(new Date(dirtyEntries[name]).toLocaleString(LOCALE_TAG)) : localOnlyRow ? copy.row.localOnlyTitle : (cachedEntries[name] ? copy.row.showHistory : copy.row.noHistory)}
                on:click={() => openHistoryModal(name, browserOnlyRow)}
              >
                {#if markedRow}
                  <!--
                    The history icon with the clock hands swapped for an
                    exclamation: same outer arc and rewind tail, so the shape is
                    still the control the row already had, and the mark reads as
                    a state of that control rather than a different thing.
                  -->
                  <svg class="history-download-icon modified" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z"></path><path class="history-icon-mark" d="M72.3 116h2.6v9h-2.6z"></path><circle class="history-icon-mark" cx="73.6" cy="128.4" r="1.6"></circle></svg>
                {:else}
                  <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
                {/if}
              </button>
            {/if}
            {#if cacheSearchMatches[name]?.preview}
              <div
                use:positionCachePreview
                class="cache-preview"
                role="button"
                tabindex="0"
                aria-label={cacheSearchMatches[name].title ? copy.row.pinAria(name, cacheSearchMatches[name].title) : copy.row.openAria(name)}
                title={copy.row.pinTitle}
                on:click={() => pinFromPreview(name)}
                on:keydown={(event) => (event.key === 'Enter' || event.key === ' ') && pinFromPreview(name)}
              >{@html cacheSearchMatches[name].preview}</div>
            {/if}
            <button class="recent-icon-button remove-recent" type="button" aria-label={copy.row.removeAria(name)} on:click={() => removeRecent(file, markedRow, browserOnlyRow)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button>
          </div>
        {/each}
        {#each filteredCached as entry}
          {@const cachedTitle = modifiedTitle(cachedEntries[entry.name]?.lastModified, LOCALE_TAG)}
          <div class="recent-row cached-only-row">
            <div class="recent-name cached-result" role="note" title={cachedTitle}>{@html titleMarkup(entry.name, search)}<span class="cached-size">{formatCacheSize(entry.sizeBytes)}</span><span class="cached-label">{copy.row.cachedLocally}</span></div>
            {#if dirtyEntries[entry.name] || historyAvailable[entry.name]}<button class="recent-icon-button cache-history-button" class:modified={dirtyEntries[entry.name]} type="button" aria-label={copy.row.historyAria(entry.name)} title={dirtyEntries[entry.name] ? copy.row.unsavedFrom(new Date(dirtyEntries[entry.name]).toLocaleString(LOCALE_TAG)) : copy.row.showHistory} on:click={() => openHistoryModal(entry.name)}>
              {#if dirtyEntries[entry.name]}
                <svg class="history-download-icon modified" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z"></path><path class="history-icon-mark" d="M72.3 116h2.6v9h-2.6z"></path><circle class="history-icon-mark" cx="73.6" cy="128.4" r="1.6"></circle></svg>
              {:else}
                <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
              {/if}
            </button>
            {/if}
            {#if cacheSearchMatches[entry.name]?.preview}
              <div
                use:positionCachePreview
                class="cache-preview"
                role="button"
                tabindex="0"
                aria-label={cacheSearchMatches[entry.name].title ? copy.row.pinAria(entry.name, cacheSearchMatches[entry.name].title ?? '') : copy.row.openAria(entry.name)}
                title={copy.row.pinTitle}
                on:click={() => pinFromPreview(entry.name)}
                on:keydown={(event) => (event.key === 'Enter' || event.key === ' ') && pinFromPreview(entry.name)}
              >{@html cacheSearchMatches[entry.name].preview}</div>
            {/if}
          </div>
        {/each}
        {/if}
      </div>
      <!--
        The panel's foot row, and with it the phone layout's answer to horizontal space.
        The control the panel's list is rebuilt from ends the panel, and at phone width the
        install offer joins it here instead of hovering in the window's corner: the corner
        is width taken from the panel's own rows (a phone's window is barely wider than the
        column), while the row the rebuild control already has is one button wide and has
        room for a second. Anything wider than a phone the offer goes back to that corner,
        which is where it is pinned. See `.install-offer`.

        The control in the row comes from `recentFootControl`, which owns which modes draw
        one and which operation each of them keeps. The row itself is the panel's last
        element and exists whether or not it has anything in it, so a launcher that rebuilds
        nothing (offline mode, the browser-only store) simply draws an empty row of no height
        rather than a second layout.
      -->
      <div class="recent-foot">
        {@render recentFootControl(false)}
        {#if installOffer}{@render installOfferControl()}{/if}
      </div>
    </section>
  {:else}
    <!--
      The landscape layout keeps its left column whole here: the search box and the reset
      control both stand where they will stand once the first Lith arrives, disabled and out of
      the accessibility tree, and the panel's copy takes the right column. They are what fixes
      the shape of the page a first visit lands in: the header band is the row that gives, and
      these are the rows it gives to, so without them the band is 34px taller (the mark and the
      title 17px lower with it) and the card is 40px shorter than the card the first Lith lands
      in. Neither draws anywhere else, because the whole section is hidden outside phone
      landscape.
    -->
    <section class="recent-section recent-section-empty" aria-label={copy.recent.aria}>
      <div class="recent-search-wrap" aria-hidden="true">
        <svg class="recent-search-icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7.5"></circle><path d="m16.5 16.5 4 4"></path></svg>
        <input class="recent-search" placeholder={copy.recent.searchPlaceholder} disabled />
      </div>
      <div class="recent-list recent-list-empty" aria-hidden="true">
        <p class="empty">{copy.recent.empty.landscape}</p>
      </div>
      <div class="recent-foot" aria-hidden="true">{@render recentFootControl(true)}</div>
    </section>
  {/if}
  <!--
    The footer band is the one control this launcher keeps in the window's corner, and it
    is the browser-only half of the mark above: the launcher a deployment serves shows the
    link here, and the desktop app has never had it (it syncs from the header instead). On
    a phone it goes, because the mark carries the same link. A page whose own server declared
    it browser-only shows neither link: the shim distribution is the app, not a deployment of
    the browser one, so it carries no way out to the project.

    The install offer waits here only when there is no panel foot row to hold it. The
    launcher with nothing listed yet. Everything else about it, including where it is
    drawn, is the offer's own business; the two sites are mutually exclusive, which is why
    the markup for it is written once, above.
  -->
  <footer>{#if mode === 'webapp' && !browserOnly}<a class="github-link" href={PROJECT_URL} target="_blank" rel="noreferrer">{copy.app.footerLink}</a>{/if}{#if installOffer && !recentPanelShown}{@render installOfferControl()}{/if}</footer>
</main>
