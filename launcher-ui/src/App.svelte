<script lang="ts">
  import { onMount } from 'svelte';
  // Every word this component shows. Nothing below spells copy of its own.
  import { LOCALE_TAG, copy, type LaunchEntry } from './copy';
  import { declaresBrowserOnly, handoffQuery, LAUNCHER_QUERY_PARAM, launcherReturn, withLauncherHandoff, type LauncherMode } from './mode';
  import { createFileBridge, tauriInvoke, tauriListen, saveTextVerifiably } from './file-bridge';
  import { orphanPill, orphanDownloadNote, type OrphanDownloadState } from './orphan-download';
  import { isScratchFileName, isHtmlMonolithName, tracksUnsavedEdits, resolveMountName, resolveScratchKind, type ScratchKind } from './scratch-editor';
  import { pwaInstall, promptPwaInstall } from './pwa-install';
  import { bootLegacyWiki, bootLegacyHtml, writeHandoff, type RemoteTarget } from './legacy-launcher-runtime';
  import { EMOJI_LIST, uploadInstanceIcon, clearInstanceIcon, emojiFaviconUrl, applyFavicon, bustIconCache, readInstanceEmoji, readServerEmoji, saveInstanceEmoji, clearInstanceEmoji, instanceMarkUrl } from './instance-icon';
  import { getRecentFiles, addRecentFile, removeRecentFile, addBrowserOnlyRecent, removeBrowserOnlyRecent, clearAllRecentFiles, purgeOldestCachesIfNeeded, saveSearchCache, forgetWikiCache, cachedWikiNames, idb, getSearchCacheText, readFetchedLith, rememberFetchedLith, listWikiVersions, wikiHasHistory, downloadWikiVersion, getDirtyState, clearDirtyState, listDirtyRecoveries, isWikiDriftedFromHead, isInstallDismissed, setInstallDismissed, recentDiskPath, type RecentEntry } from './storage';
  import { rememberRowKind, resolveStorageMode, storageModeOverride, browserOnlyMarkTitle, type StorageMode } from './browser-storage';
  import { readBookmarkEntries, saveBookmark, removeBookmark, setBookmarkIcon, refreshBookmarkIcon, verifyInstanceUrl, normalizeInstanceUrl, instanceLabel, type BookmarkEntry, type InstanceVerification } from './bookmarks';
  import { LOGIN_CHECK_LABELS, askInstanceAboutLogin, loginVerdict, loginVerdictFromError, typedLoginCheck, type LoginCheckState, type LoginVerdict } from './login-check';
  import { copyDropNote, forgetInstanceCopy } from './instance-copy';
  import { offlineMode, looksUnreachable } from './offline-mode';
  import PinEntry from './PinEntry.svelte';
  import { deleteRemoteFile, fetchRemoteFiles, fetchRemoteWiki, fetchRemoteWikiMeta, probePatchApi, createLockHeartbeat, readRemoteLock, uploadRemoteFile, webdavUrl, resolveSessionId, lithUploadName, type WebdavFile } from './webdav';
  import { normalizeLithName } from './legacy-saver';
  import { searchCachedWikis } from './cache-search';
  import { matchMarkup, showsForQuery, titleMatches, titleMarkup } from './name-match';
  import { topHits, type InstanceCacheRead, type InstanceReads } from './instance-search';
  import { computeBackupCoverage, folderOf, hasBackedUpRepo, orphanedEntries, reindexFolders, syncedDirFor, type CoverageRow, type RebuildOrphan } from './backup-coverage';
  import { parseDeviceCode, parseDevicePoll, pollDelayMs, formatUserCode, generateRepoName, partitionRepos } from './github-device';
  import { syncIndicator, shouldHeartbeat, healthFailure, verifiedAge, SYNC_PULSE_MS, type SyncIndicator, type HealthState } from './git-sync-health';
  import { gapCount, versionGap } from './history-gap';
  import { createServerRepo, disconnectServerSync, fetchServerSyncStatus, listServerRepos, pollServerDeviceToken, requestServerDeviceCode, serverSyncIndicator, setupServerSync, type ServerSyncStatus } from './server-git-sync';
  import { serializeJsonToLith, parseLithToJSON } from './lithic-format';
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
    ephemeralIntegrationTiddlers,
    isPayloadShareUrl,
    pinCachedTiddler,
    type PendingTiddler
  } from './pending-imports';

  export let mode: LauncherMode;
  const files = createFileBridge();
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
  const storageMode: StorageMode = resolveStorageMode(
    mode,
    typeof window === 'undefined' ? undefined : (window as unknown as { showSaveFilePicker?: unknown }),
    typeof window === 'undefined' ? null : storageModeOverride(window.location.search),
    browserOnly
  );
  /**
   * The index-db-only fallback: no Lith mounted here has a file behind it, so
   * its cached copy in this browser *is* the document.
   */
  const indexDbOnly = storageMode === 'index-db';
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
  let busy = false;
  let pendingImports: PendingTiddler[] = [];
  let introBusy = false;
  let dragCounter = 0;
  let showRecent = false;
  let recentFiles: Array<RecentEntry | { name: string; path?: string; text?: string; handle?: any }> = [];
  let search = '';
  let mountError = '';
  let bookmarks: BookmarkEntry[] = [];
  let showBookmarkModal = false;

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
  let activeRemote: { name: string; digest: string; api: boolean } | null = null;
  // Set when the server reports a live lock held by someone else: the open is
  // paused on a choice (read-only / ignore / cancel) instead of guessing.
  let remoteCollision: { name: string; who: string } | null = null;
  let lockHeartbeat: ReturnType<typeof createLockHeartbeat> | null = null;

  // --- Instance icon (emoji favicon) ---
  let brandEmoji = '';
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
  let installOffer: 'desktop' | 'pwa' | null = null;
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

  async function refreshInstallState() {
    if (mode !== 'tauri') {
      installDismissed = await isInstallDismissed();
      // A browser's install prompt is what the webapp offer waits on, and that
      // arrives when it arrives; this only stops the footer guessing in the meantime.
      installOfferReady = true;
      return;
    }
    let launchedFromInstall = false;
    try {
      const capabilities = await tauriInvoke<{ install: boolean; launch_entry: LaunchEntry | null }>('platform_capabilities');
      platformInstallable = capabilities.install;
      platformEntry = capabilities.launch_entry;
    } catch {
      // A capability report that could not be read is not an install. The offer stays
      // hidden rather than promising something this platform may not do.
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
   * Ask whether the release this build was cut from is still the newest.
   *
   * Read-only, and all it can do is relabel the offer: the app never downloads a
   * file, never runs one and never writes to the install location. The user
   * fetches the new exe in their browser and launches it themselves, then presses
   * Update Install, which is the same manual step a portable copy makes.
   */
  async function checkForInstallUpdate() {
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
   * and the user is mid-update.
   */
  $: installOffer =
    installOfferReady && !(installDismissed && installState !== 'stale')
      ? mode === 'tauri'
        ? installState === 'current' || !platformInstallable
          ? null
          : 'desktop'
        : $pwaInstall.installable
          ? 'pwa'
          : null
      : null;

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
      ? copy.install.label.install
      : installState === 'update'
        ? copy.install.label.updateAvailable
        : installState === 'stale'
          ? copy.install.label.updateInstall
          : copy.install.label.plain;
  $: installOfferTitle =
    installStatus ||
    (installOffer === 'pwa'
      ? copy.install.offer.browser
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
    if (installState === 'update') {
      try {
        await tauriInvoke('open_external', { url: updateUrl });
      } catch (error) {
        status = copy.install.openFailed(error instanceof Error ? error.message : String(error));
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
    }
    showGitSyncModal = true;
    gitSyncHealthApplies = healthAppliesToActive();
    void refreshGitSyncStatus(true);
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
    if (mode !== 'tauri') {
      gitSyncPreferredFolder = null;
      return;
    }
    let answer: { folder: string | null; overridden: boolean } | null = null;
    try {
      answer = await tauriInvoke<{ folder: string | null; overridden: boolean } | null>('git_sync_folder', { derived });
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
  $: gitSyncNoTarget = mode === 'tauri' && !(gitSyncPreferredFolder ?? gitSyncSubject);

  /**
   * Whether the folder line is the control or the answer.
   *
   * The folder is decided while the backup is being set up, so the picker is drawn on the
   * screens that end at the commit (the Connect screen, the device-code step it rides on
   * while GitHub is waited on, and the repository choice after it) and the connected
   * dialog names the folder instead. Variables rather than conditions asked in the markup,
   * for the usual reason: Svelte only re-runs a block when a variable it *names* changes.
   */
  $: gitSyncFolderEditable = mode === 'tauri' && gitSyncView !== 'connected';
  /** The other half of that line: connected, so the folder is named rather than offered. */
  $: gitSyncFolderLive = mode === 'tauri' && gitSyncView === 'connected';

  /**
   * Ask the OS for the folder to back up, instead of the one Lithic worked out.
   *
   * The line in the dialog named a folder nobody chose: it came from the open Lith, else
   * the newest recent row, else a folder Lithic already had a repository in. That is right
   * until it is not, and until now moving a backup meant disconnecting first.
   *
   * Rust keeps the choice in the recents sidecar beside the exe, spelled relative to the
   * bundle when it lives under it, so a thumb drive keeps backing up its own folder on a
   * machine that gives the drive another letter.
   */
  async function chooseSyncFolder(): Promise<void> {
    if (gitSyncPicking || gitSyncBusy) return;
    gitSyncPicking = true;
    gitSyncFolderError = '';
    try {
      const picked = await tauriInvoke<string | null>('pick_sync_folder', { current: gitSyncFolder || null });
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

  /** Put the folder Lithic works out back, dropping the recorded choice. */
  async function clearSyncFolderOverride(): Promise<void> {
    if (gitSyncBusy) return;
    gitSyncFolderError = '';
    try {
      await tauriInvoke('clear_sync_folder_override');
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
      await tauriInvoke('git_sync_cancel');
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
    if (mode !== 'tauri') return;
    const paths = recentRows().map((row) => row.path).filter((path): path is string => Boolean(path));
    if (paths.length === 0) {
      backupRoots = {};
      return;
    }
    try {
      backupRoots = await tauriInvoke<Record<string, string>>('git_sync_coverage', { paths });
    } catch {
      backupRoots = {};
    }
  }

  $: backupCoverage = computeBackupCoverage(recentRows(), backupRoots);
  $: localOnlyPaths = new Set(backupCoverage.localOnlyPaths);
  // Coverage only means something once something is backed up: with nothing,
  // every row is un-backed-up and the marks would say nothing about any of them.
  $: showBackupStatus = mode === 'tauri' && hasBackedUpRepo(backupRoots);
  // Where the list is derived rather than authored (the desktop app's synced folders,
  // and self-host's server) rebuilding beats clearing. The desktop app only learns its
  // own list is a view rather than a catalogue once a folder is backed up; on an instance
  // there was never any doubt, the server is the only list there is.
  $: showRebuildControl = showBackupStatus || isSelfHost();
  // Whether the recent panel is on screen at all. Named because two places now ask: the
  // panel itself, and the install offer, which waits in a launcher with no panel to hold
  // it rather than in one that does (see the offer's two homes in the markup).
  $: recentPanelShown =
    bookmarks.length > 0 ||
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
      const status = await tauriInvoke<GitSyncStatus | null>('git_sync_status', { path: target });
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
          : parseDevicePoll(await tauriInvoke<unknown>('github_device_poll', { deviceCode }));
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
        : partitionRepos(await tauriInvoke<Array<{ full_name: string }>>('github_list_repos', { token: gitDeviceToken }));
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
        const created = await tauriInvoke<{ full_name: string }>('github_create_repo', { token: gitDeviceToken, name: repo });
        targetRepo = created.full_name;
        gitSyncMessage = copy.dialogs.gitSync.created(created.full_name);
      }
      const result = await tauriInvoke<GitSyncSetupResult>('git_sync_setup', { path: target, repo: targetRepo, token: gitDeviceToken });
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
      const result = await tauriInvoke<GitSyncSetupResult>('git_sync_setup', { path: target, repo: gitRepoInput, token: gitTokenInput });
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
      await tauriInvoke('git_sync_disconnect', { path: target });
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
    const parsed = parseDeviceCode(await tauriInvoke<unknown>('github_device_code'));
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
      await tauriInvoke('git_sync_reauth', { path: target, repo, token });
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
    if (mode !== 'tauri') return;
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
      const health = await tauriInvoke<{ state: HealthState; repo: string; detail: string; last_commit_error?: string | null }>('git_sync_heartbeat', { path: target });
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
    if (mode !== 'tauri') return;
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
    tauriInvoke<GitSyncStatus | null>('git_sync_status', { path: target })
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
      const result = await tauriInvoke<{ path: string; entry: string | null }>('install_monolith');
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
    } catch (error) {
      installStatus = copy.install.failed(error instanceof Error ? error.message : String(error));
      status = installStatus;
    } finally {
      installBusy = false;
    }
  }
  type CacheSearchEntry = { name: string; text: string; sizeBytes: number };
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
   * The rows an offline launcher lists: the Liths this device already holds a copy of,
   * which are the only ones that can be opened without the instance.
   *
   * By name rather than by date: with no server there is nothing to order by, and the
   * server's order would change under the reader the moment it answered. Every row is a
   * copy this device took, so the set is `cachedEntries` (the same store the online
   * list already reads for its sizes and its search) and nothing new is fetched to
   * build it, which is the whole point of a mode with no network.
   */
  $: offlineRows = offlineLauncher
    ? Object.values(cachedEntries)
        .filter((entry) => showsForQuery(entry.name, search) || Boolean(cacheSearchMatches[entry.name]?.preview))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

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
          const cache = await idb.get<{ text?: string }>('search_cache_' + name);
          if (typeof cache?.text === 'string') {
            entries[name] = { name, text: cache.text, sizeBytes: new Blob([cache.text]).size };
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
    try {
      const idbList = await getRecentFiles();
      if (idbList && idbList.length > 0) {
        recentFiles = idbList;
      } else {
        const ls = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
        recentFiles = ls;
      }
    } catch {
      recentFiles = [];
    }
    if (mode === 'tauri') {
      await mergeRecentsSidecar();
      await refreshBackupCoverage();
    }
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
    const rows = recentFiles.map(({ name, path, text }) => ({
      name,
      path,
      ...(text && !path && text.length <= RECENT_TEXT_LIMIT ? { text } : {})
    }));
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
    if (kind === 'browser-only') {
      // Nothing here has a file to remember and nothing can, so the row says so,
      // and is stored in the store the Lith's content is stored in. An HTML
      // monolith has no tiddler snapshot to read its page back from, so its
      // text travels in the row; a Lith's is already in the search cache the
      // mount's own saver writes.
      recentFiles = await addBrowserOnlyRecent(
        file.name,
        isHtmlMonolithName(file.name) ? file.text ?? '' : ''
      );
      persistRecentsSidecar();
    } else if (kind === 'handle') {
      recentFiles = await addRecentFile(file.handle, file.path ?? null);
      persistRecentsSidecar();
    } else {
      const name = file.name;
      recentFiles = [file, ...recentFiles.filter((item) => getEntryName(item) !== name)].slice(0, 20);
      persistRecentRows();
      persistRecentsSidecar();
    }
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
  async function prepareDirtyRecovery(safeName: string): Promise<'merge' | 'discard' | 'later'> {
    const dirty = await getDirtyState(safeName);
    if (!dirty) return 'merge'; // Nothing to recover; proceed.
    const decision = await promptDirtyRecovery(safeName, dirty);
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
    remote: RemoteTarget | null = null
  ) {
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
    await remember({ name: safeName, path, text: contents, handle });
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
    const driftedFromHead = !isHtmlMonolith && !isScratch && !indexDbOnly && await isWikiDriftedFromHead(safeName, contents);
    if (tracksUnsavedEdits(name)) {
      if ((await prepareDirtyRecovery(safeName)) === 'later') {
        busy = false;
        status = copy.status.editsKept;
        return;
      }
    }
    if (typeof window !== 'undefined') {
      if (handle) {
        (window as any).__LITHIC_FILE_HANDLE__ = handle;
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
      await bootLegacyHtml(contents, safeName, path, indexDbOnly);
      return;
    }
    const handoff = { name: safeName, path, text: contents };
    // The legacy `?mount` handoff, offered to the session store rather than forced on it: this
    // line used to put the whole document into a key with a few megabytes to spend, which is what
    // made a 10 MB Lith fail its own mount with `QuotaExceededError`. See writeHandoff.
    writeHandoff(handoff);
    const scratchKind: ScratchKind | null = resolveScratchKind(safeName);
    const scratchMode = isScratch && scratchKind ? scratchKind : undefined;
    // Inject the Ephemeral integration on every wiki mount, then drain
    // whatever the user queued via drop / share URL / intro.
    // The engine boots in place (document.open/write/close), keeping the
    // launcher URL in the address bar and preserving window globals; the
    // globals are also injected defensively so the Ephemeral widget
    // (__EPHEMERAL_MODE__) works regardless of the boot path.
    await bootLegacyWiki(handoff, [...pendingImports, ...ephemeralIntegrationTiddlers(), ...extraTiddlers], {
      __EPHEMERAL_MODE__: mode === 'self-host' ? 'self-host' : 'paper-light',
      __LITHIC_LAUNCHER_MODE__: mode
    }, { driftedFromHead, scratchMode, remote, browserOnly: indexDbOnly });
    pendingImports = [];
  }

  async function blankLith() {
    busy = true;
    status = copy.status.loadingBlank;
    try {
      await mountWiki('', 'new.lith');
    } catch (error) {
      mountError = error instanceof Error ? error.message : String(error);
      status = copy.status.blankLithFailed;
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
    const siteTitle = safeName.replace(/\.lith$/i, '');
    showNewLithModal = false;
    busy = true;
    status = copy.status.loadingBlank;
    try {
      await mountWiki('', safeName, undefined, undefined, [{ title: '$:/SiteTitle', text: siteTitle }]);
    } catch (error) {
      mountError = error instanceof Error ? error.message : String(error);
      status = copy.status.blankLithFailed;
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
    } catch (error) { status = copy.status.openFailed(error instanceof Error ? error.message : String(error)); }
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
      if (picks.length === 0) { status = ''; return; }
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
      remoteError = copy.status.uploadFailed(error instanceof Error ? error.message : String(error));
      busy = false;
    }
  }

  async function openRecent(recent: RecentEntry | { name?: string; path?: string; text?: string; handle?: any }) {
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
        await mountWiki(text, name);
        status = copy.status.mounted(name);
        return;
      }
      if (mode === 'tauri') {
        if (tauriPath) {
          await mountTauriPath(tauriPath);
          return;
        }
        // A handle-less or pseudo-handle row with no path can't be opened:
        // browser handles don't exist in this WebView.
        if (!rawHandle?.getFile) {
          status = copy.status.noPath;
          return;
        }
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
        await mountWiki(text, file.name, recentDiskPath(recent) ?? undefined, handle);
        status = copy.status.mounted(file.name);
        return;
      }
      if ((recent as any).text !== undefined) {
        lithText = (recent as any).text;
        fileName = (recent as any).name || 'untitled.lith';
        filePath = recentDiskPath(recent) ?? undefined;
        status = copy.status.mounted(fileName);
        await mountWiki(lithText, fileName, filePath);
      } else if (recentDiskPath(recent) && mode === 'tauri') {
        // Tauri recents opened through the save dialog carry only a disk
        // path (no cached text). Read fresh from disk so in-place edits
        // made outside the app are picked up.
        await mountTauriPath(recentDiskPath(recent) as string);
        return;
      } else {
        // Nothing left to open it from: the row has no path this build can read and
        // no body to mount. The case a store too small to mirror a large Lith leaves
        // behind (`persistRecentRows`). Said out loud rather than left as a click that
        // does nothing, which is what it looked like from the outside.
        status = copy.status.noPath;
      }
    } catch (error) {
      status = copy.status.openFailed(error instanceof Error ? error.message : String(error));
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
      await mountTauriPath(path);
    } finally {
      busy = false;
    }
  }

  /** Shared body of openTauriPath; callable while a mount is already in flight. */
  async function mountTauriPath(path: string) {
    try {
      const result = await tauriInvoke<{ name: string; path: string; text: string }>('read_lith_path', { path });
      lithText = result.text;
      fileName = result.name;
      filePath = result.path;
      await mountWiki(result.text, result.name, result.path);
      status = copy.status.mounted(result.name);
    } catch (error) {
      status = copy.status.openFailed(error instanceof Error ? error.message : String(error));
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
          pendingImports = mergePendingImports(pendingImports, payload);
          return;
        }
      } catch {
        // Not a payload URL after all. Treat as a file drop below.
      }
    }

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    const lowerName = file.name.toLowerCase();
    if (/\.(?:lith|json)$/.test(lowerName)) {
      try {
        const contents = await file.text();
        const parsed = parseDroppedData(contents, lowerName.endsWith('.lith'));
        if (parsed.length > 0) {
          pendingImports = mergePendingImports(pendingImports, parsed);
        }
      } catch {
        mountError = copy.status.droppedInvalid;
      }
    } else if (/\.(?:html?|htm)$/.test(lowerName)) {
      try {
        await mountWiki(await file.text(), file.name);
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
      status = `${payload.length} shared tiddler${payload.length === 1 ? '' : 's'} ready to import`;
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

  function openEmojiPicker(): void {
    if (!isSelfHost()) return;
    emojiChoice = brandEmoji;
    emojiStatus = '';
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
  $: emojiGrid = emojiChoice && !EMOJI_LIST.includes(emojiChoice) ? [emojiChoice, ...EMOJI_LIST] : EMOJI_LIST;

  function closeEmojiPicker(): void {
    showEmojiPicker = false;
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
      status = copy.dialogs.bookmark.saved;
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
    if (note) status = note;
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
   * Open the per-wiki version history modal. The history icon no longer
   * downloads a single cache blob. It lists every timestamped version
   * (deltas materialized on demand) and lets the user download any of them
   * as a non-destructive `<stem>_recover_<stamp>.lith` copy.
   */
  async function openHistoryModal(name: string, browserOnly = false) {
    historyName = name;
    historyEntries = [];
    historyBrowserOnly = browserOnly;
    historyError = '';
    showHistoryModal = true;
    historyBusy = true;
    try {
      historyEntries = await listWikiVersions(name);
      if (historyEntries.length === 0) historyError = copy.status.noHistory;
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
  }

  /** Download one materialized version; history is never modified. */
  async function downloadHistoryVersion(id: string) {
    try {
      const version = await downloadWikiVersion(historyName, id);
      if (!version) {
        historyError = copy.status.noHistoryVersion;
        return;
      }
      saveBlobAs(version.fileName, version.text);
      status = copy.status.recovered(version.fileName);
    } catch (error) {
      historyError = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Write cached tiddler text out as a `.lith` the user can keep. Cached text is
   * the serialized tiddler array, not the on-disk format, so it is converted
   * back the same way a version download is.
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
  async function downloadCachedSnapshot(name: string): Promise<void> {
    setOrphanDownload(name, 'saving');
    try {
      const cached = await getSearchCacheText(name);
      if (!cached) {
        setOrphanDownload(name, 'failed');
        status = copy.status.noCachedCopy(name);
        return;
      }
      const fileName = `${name.replace(/\.lith$/i, '')}_cached.lith`;
      const outcome = await saveTextVerifiably(fileName, cached);
      if (outcome === 'cancelled') {
        // The user backed out of the save dialog: leave the row as they found it.
        setOrphanDownload(name, 'idle');
        return;
      }
      setOrphanDownload(name, outcome === 'saved' ? 'saved' : 'unverified');
      status = outcome === 'saved' ? copy.status.savedFile(fileName) : copy.status.downloadingFile(fileName);
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

  async function clearRecent() {
    await clearAllRecentFiles();
    recentFiles = [];
    cachedEntries = {};
    cacheSearchMatches = {};
    localStorage.removeItem(RECENT_KEY);
    persistRecentsSidecar();
    void refreshBackupCoverage();
  }

  /** The on-disk text of one wiki, read through Rust. */
  async function readDiskWikiText(path: string): Promise<string> {
    const result = await tauriInvoke<{ name: string; path: string; text: string }>('read_lith_path', { path });
    return result?.text ?? '';
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
        const text = remote
          ? remote.text
          : entry.path
            ? mode === 'tauri' ? await readDiskWikiText(entry.path) : ''
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
    status = indexed > 0
      ? copy.status.indexedHere(indexed)
      : copy.status.nothingToIndex;
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
      const folders = mode === 'tauri' ? reindexFolders(recentRows(), backupRoots) : [];
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
      } else if (mode === 'tauri') {
        // Backed-up roots first, then each known row's own folder, so a Lith
        // that isn't backed up yet still finds its siblings.
        for (const folder of folders) {
          const found = await tauriInvoke<string[]>('list_folder_liths', { path: folder }).catch(() => [] as string[]);
          for (const path of found) discovered.push({ name: path.split(/[\\/]/).pop() || path, path });
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

      if (mode === 'tauri') {
        recentFiles = discovered;
        localStorage.setItem(RECENT_KEY, JSON.stringify(discovered.map(({ name, path }) => ({ name, path }))));
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
  async function mountCachedReadOnly(name: string, cacheText: string) {
    let parsed: Array<Record<string, string>> = [];
    try {
      const json = JSON.parse(cacheText);
      if (Array.isArray(json)) parsed = json as Array<Record<string, string>>;
    } catch { /* mount with whatever parsed */ }
    // Offer unsaved edits captured since the last real save; merged on top
    // of the cache snapshot when accepted.
    const dirty = await getDirtyState(name);
    if (dirty) {
      const decision = await promptDirtyRecovery(name, dirty);
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
      { title: '$:/state/DisableAutoSaver', text: 'yes' },
      ...ephemeralIntegrationTiddlers()
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
   */
  async function removeRecent(file: RecentEntry | { name?: string; handle?: any }) {
    const name = getEntryName(file);
    if ((file as any).browserOnly === true) {
      // No handle to compare against, and no localStorage copy either: this row
      // is one of the fallback's own, in the store the handle rows live in.
      recentFiles = await removeBrowserOnlyRecent(name);
    } else if ((file as any).handle) {
      recentFiles = await removeRecentFile((file as any).handle);
    } else {
      recentFiles = recentFiles.filter((item) => item !== file);
      persistRecentRows();
    }
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
      void refreshRemoteList();
      // Whether this instance is backed up, which is a question only the instance
      // can answer, and one that keeps changing on its own, because the server
      // commits and pushes without this page doing anything at all.
      void refreshServerSyncStatus(false);
      startServerSyncPolling();
    } else {
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
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
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
        closeEmojiPicker();
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
      void refreshInstallState();
      // The vault does not stay unlocked between visits: an instance load asks for
      // the secret again, every time. Opening the launcher is therefore the moment
      // to drop whatever the last load was holding, and the status that comes back
      // is what the rows and the manager control show.
      void tauriInvoke('lock_credentials')
        .catch(() => { /* a build without the vault: nothing to lock */ })
        .then(() => Promise.all([refreshVaultStatus(), refreshVaultCoverage()]));
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
      if (gitSyncPollTimer) clearInterval(gitSyncPollTimer);
      if (gitSyncBackupTimer) clearInterval(gitSyncBackupTimer);
      stopGitSyncProgressEvents?.();
      stopGitSyncProgressTimer();
      window.removeEventListener('lithic-git-sync-saved', onGitSyncSaved);
      document.removeEventListener('visibilitychange', onVisibilityChange);
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
    : filteredRecent.length === 0 && filteredCached.length === 0 && filteredRemote.length === 0 && filteredBookmarks.length === 0;
  $: emptyMessage = mode === 'self-host'
    ? (offlineLauncher
        ? (search.trim() ? copy.recent.empty.noMatch : copy.recent.empty.instanceHere)
        : (search.trim() ? copy.recent.empty.noMatch : copy.recent.empty.server))
    : (search.trim() ? copy.recent.empty.noMatch : copy.recent.empty.recents);

  async function openBookmarkedInstance(url: string, query = '') {
    const origin = vaultOriginOf(url);
    if (mode === 'tauri' && vaultStatus && origin) {
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
    window.location.href = withLauncherHandoff(url, window.location.href, query);
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
</script>

<svelte:head><title>{copy.app.title}</title></svelte:head>

<main class="container" data-mode={mode}>
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
    {#if isSelfHost()}
      <!-- A <button> only here, where the mark sets this deployment's own icon:
           that is the one job the mark has, and it only exists for an instance. -->
      <button
        type="button"
        class="brand-icon-wrap pickable"
        class:brand-emoji-wrap={Boolean(brandEmoji)}
        aria-label={copy.app.setInstanceIcon}
        title={copy.app.setInstanceIcon}
        on:click={() => openEmojiPicker()}
      >
        {#if brandEmoji}
          <!-- The instance's recorded choice, drawn here rather than fetched: it is the
               same picture the published renders hold, and it is an answer an instance
               that cannot be asked still has. -->
          <span class="brand-emoji" aria-hidden="true">{brandEmoji}</span>
        {:else if instanceMark && !instanceMarkMissing}
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
    {:else}
      <!-- Everywhere else there is no instance icon to set, so the mark carries
           the project link instead of sitting inert. That is also what lets the
           footer's Github button go on mobile without losing the way there. -->
      <a
        class="brand-icon-wrap brand-github"
        href={PROJECT_URL}
        target="_blank"
        rel="noreferrer"
        on:click={(event) => openExternalLink(event, PROJECT_URL)}
        aria-label={copy.app.githubLink}
        title={copy.app.githubLink}
      >
        <img class="brand-icon" src={mstile150} alt={copy.app.brandAlt} />
      </a>
    {/if}
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
      {#if status}<div class="status-line" role="status"><span class="status-label">{status.replace(/[…\.\s]+$/, '')}</span><span class="activity-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>{/if}
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
    {#if mode === 'webapp'}<button class="help-button" aria-label={copy.app.viewIntro} title={copy.app.viewIntro} on:click={openIntro}>{introBusy ? '…' : '?'}</button>{:else if mode === 'tauri' || isSelfHost()}<button class="sync-button {headingSyncState}" aria-label={copy.dialogs.gitSync.title} title={headingSyncTitle} on:click={openGitSyncModal}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 17.6A5 5 0 0 0 18 8h-1.3A8 8 0 1 0 4 16.3"/><path d="M12 12v9"/><path d="m8.5 15.5 3.5-3.5 3.5 3.5"/></svg>{#if headingSyncState === 'checking'}<span class="sync-glyph ring" aria-hidden="true"></span>{:else if headingSyncState === 'error'}<span class="sync-glyph alert" aria-hidden="true">!</span>{:else if headingSyncState === 'connected'}<span class="sync-glyph dot" aria-hidden="true"></span>{/if}</button>{/if}
    </div>
  </header>
  <!--
    Offline mode's global line, above everything the mode changes rather than inside the
    list it replaces: "the rows below are this device's copies, not the server's" is a fact
    about the launcher, and one line covering the whole screen is what stops it having to
    be said again on every row. The rows still carry their own mark (the exclamation
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
  {#if pendingImports.length > 0}
    <div class="pending-imports" role="status" aria-label={copy.pending.aria}>
      <div class="pending-imports-header">
        <span>{copy.pending.heading}</span>
        <button type="button" aria-label={copy.pending.clear} title={copy.pending.clear} on:click={() => pendingImports = []}>✕</button>
      </div>
      <ul>
        {#each pendingImports as tiddler, index (tiddler.title ?? index)}
          <li class={/^\d{14}-\d{3,4}$/.test(tiddler.title ?? '') || Boolean(tiddler['stream-type']) ? 'tiddler-list' : ''}>{tiddler.title || copy.pending.untitled}</li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if showGitSyncModal}
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeGitSyncModal()}>
      <div class="launcher-modal git-sync-modal" role="dialog" aria-modal="true" aria-labelledby="gitsync-title">          <button class="modal-close" aria-label={copy.dialogs.gitSync.closeAria} on:click={closeGitSyncModal}>×</button>
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
          {#if gitSyncBusy}<p class="sync-progress" role="status"><span class="sync-spinner" aria-hidden="true"></span><span>{gitSyncStage || copy.dialogs.gitSync.working}</span><span class="sync-elapsed">{gitSyncElapsed}s</span>{#if !gitAuthActive && mode === 'tauri'}<button type="button" class="sync-cancel" on:click={cancelGitSync}>{gitSyncCancelling ? copy.dialogs.gitSync.stopping : copy.dialogs.gitSync.stopSyncing}</button>{/if}</p>{/if}
          <div class="modal-actions"><button class="modal-action" disabled={gitSyncBusy} on:click={startDeviceAuth}>{gitSyncBusy ? '…' : copy.dialogs.gitSync.connect}</button></div>
          <details class="git-sync-advanced">
            <summary>{copy.dialogs.gitSync.tokenSummary}</summary>
            <input bind:value={gitRepoInput} aria-label={copy.dialogs.gitSync.repoAria} placeholder={copy.dialogs.gitSync.repoPlaceholder} on:keydown={(event) => event.key === 'Enter' && connectGitSync()} />
            <input bind:value={gitTokenInput} type="password" aria-label={copy.dialogs.gitSync.tokenAria} placeholder={copy.dialogs.gitSync.tokenPlaceholder} on:keydown={(event) => event.key === 'Enter' && connectGitSync()} />
            {#if gitSyncBusy}<p class="sync-progress" role="status"><span class="sync-spinner" aria-hidden="true"></span><span>{gitSyncStage || copy.dialogs.gitSync.working}</span><span class="sync-elapsed">{gitSyncElapsed}s</span>{#if !gitAuthActive && mode === 'tauri'}<button type="button" class="sync-cancel" on:click={cancelGitSync}>{gitSyncCancelling ? copy.dialogs.gitSync.stopping : copy.dialogs.gitSync.stopSyncing}</button>{/if}</p>{/if}
            <div class="modal-actions"><button class="modal-action" disabled={!gitRepoInput || !gitTokenInput || gitSyncBusy} on:click={connectGitSync}>{gitSyncBusy ? copy.dialogs.gitSync.connecting : copy.dialogs.gitSync.connectPush}</button></div>
          </details>
        {:else if gitSyncView === 'connecting'}
          <p>{copy.dialogs.gitSync.stepOne} <a href="https://github.com/login/device" target="_blank" rel="noreferrer" on:click={(event) => openExternalLink(event, 'https://github.com/login/device')}>github.com/login/device</a></p>
          <p>{copy.dialogs.gitSync.stepTwo}</p>
          {#if gitUserCode}
            <div class="user-code-display">{formatUserCode(gitUserCode)}</div>
            <p class="git-sync-note">{copy.dialogs.gitSync.waiting}</p>
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
          {#if gitSyncBusy}<p class="sync-progress" role="status"><span class="sync-spinner" aria-hidden="true"></span><span>{gitSyncStage || copy.dialogs.gitSync.working}</span><span class="sync-elapsed">{gitSyncElapsed}s</span>{#if !gitAuthActive && mode === 'tauri'}<button type="button" class="sync-cancel" on:click={cancelGitSync}>{gitSyncCancelling ? copy.dialogs.gitSync.stopping : copy.dialogs.gitSync.stopSyncing}</button>{/if}</p>{/if}
          <div class="modal-actions">
            <button class="modal-action" disabled={gitSyncBusy || !gitRepoSelection()} on:click={finalizeGitSync}>{gitSyncBusy ? copy.dialogs.gitSync.syncing : copy.dialogs.gitSync.startSync}</button>
            <button class="modal-action secondary" on:click={resetGitSyncFlow}>{copy.common.back}</button>
          </div>
        {:else}
          <p>{copy.dialogs.gitSync.connectedRepo}</p>
          <p class="user-code-display" style="font-size:1.05rem; letter-spacing:0.02em;">{gitSyncConnectedRepo || copy.dialogs.gitSync.notRecorded}</p>
          {#if isSelfHost()}
            <!--
              The server's own clock, not this device's opinion of it: the sync happens
              there, and the only thing the page knows is when the server said it last did.
            -->
            <p class="git-sync-note">{serverSyncAge ? copy.dialogs.gitSync.lastSynced(serverSyncAge) : copy.dialogs.gitSync.noSyncYet}</p>
          {:else if gitSyncHealthNote}
            <p class="status-line {gitSyncHealthBroken ? 'error' : ''}" role={gitSyncHealthBroken ? 'alert' : 'status'}>{gitSyncHealthNote}</p>
          {:else}
            <p class="git-sync-note">{copy.dialogs.gitSync.savesHere}</p>
          {/if}
          {#if gitSyncError}<p class="status-line error" role="alert">{gitSyncError}</p>{/if}
          {#if gitSyncMessage}<p class="status-line" role="status">{gitSyncMessage}</p>{/if}
          {#if gitSyncBusy}<p class="sync-progress" role="status"><span class="sync-spinner" aria-hidden="true"></span><span>{gitSyncStage || copy.dialogs.gitSync.working}</span><span class="sync-elapsed">{gitSyncElapsed}s</span>{#if !gitAuthActive && mode === 'tauri'}<button type="button" class="sync-cancel" on:click={cancelGitSync}>{gitSyncCancelling ? copy.dialogs.gitSync.stopping : copy.dialogs.gitSync.stopSyncing}</button>{/if}</p>{/if}
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
            <button class="modal-action secondary" disabled={gitSyncBusy} on:click={disconnectGitSync}>{copy.dialogs.gitSync.disconnect}</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
  {#if showBookmarkModal}
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeBookmarkModal()}>
      <div class="launcher-modal bookmark-modal" role="dialog" aria-modal="true" aria-labelledby="bookmark-title">
        <button class="modal-close" aria-label={copy.dialogs.bookmark.closeAria} on:click={closeBookmarkModal}>×</button>
        <h2 id="bookmark-title">{copy.dialogs.bookmark.title}</h2>
        <p>{copy.dialogs.bookmark.intro}</p>
        <input bind:this={bookmarkInputElement} bind:value={bookmarkInput} aria-label={copy.dialogs.bookmark.urlAria} placeholder={copy.dialogs.bookmark.urlPlaceholder} on:keydown={(event) => event.key === 'Enter' && addInstanceBookmark()} />
        {#if bookmarkError}<p class="status-line error" role="alert">{bookmarkError}</p>{/if}
        <div class="modal-actions">
          <button class="modal-action" on:click={addInstanceBookmark}>{copy.dialogs.bookmark.save}</button>
          {#if mode === 'tauri' && vaultStatus}
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
            The band word, in the empty end of the boxes' own row: it is about the PIN
            those boxes hold, and it is the whole of what this dialog says about it. The
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
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeEmojiPicker()}>
      <div class="launcher-modal emoji-modal" role="dialog" aria-modal="true" aria-labelledby="emoji-title">
        <button class="modal-close" aria-label={copy.dialogs.icon.closeAria} on:click={closeEmojiPicker}>×</button>
        <h2 id="emoji-title">{copy.dialogs.icon.title}</h2>
        <!-- The icon is saved on the instance, not in this browser: saying so is what
             makes the choice read as a setting rather than a theme. -->
        <p>{copy.dialogs.icon.intro}</p>
        <div class="emoji-preview" aria-hidden="true">{emojiChoice || '🎨'}</div>
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
                <button class="recent-icon-button" type="button" aria-label={copy.row.downloadAria(row.orphan.name)} title={copy.row.downloadTitle} on:click={() => downloadCachedSnapshot(row.orphan.name)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"></path><path d="m7.5 10.5 4.5 4.5 4.5-4.5"></path><path d="M5 19h14"></path></svg>
                </button>
                {#if row.pill}<span class="orphan-pill {row.pill.tone}" role="status" title={row.pill.title}>{row.pill.label}</span>{/if}
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
        {#if historyLocalOnlyPath && historySyncedFolder}
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
        {:else if historyEntries.length === 0}
          <p class="history-empty">{historyError || copy.dialogs.history.none}</p>
        {:else}
          <ul class="history-list">
            {#each historyEntries as entry, index (entry.id)}
              {@const newer = historyEntries[index - 1]}
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
              <li class="history-entry">
                {#if entry.isBase && entry.external}<span class="history-badge sync" title={copy.dialogs.history.badgeSyncTitle}>{copy.dialogs.history.badgeSync}</span>{:else if entry.isBase}<span class="history-badge" title={copy.dialogs.history.badgeFullTitle}>{copy.dialogs.history.badgeFull}</span>{:else}<span class="history-badge delta" title={copy.dialogs.history.badgeStepTitle}>{copy.dialogs.history.badgeStep}</span>{/if}
                <span class="history-time">{entry.lastModified}</span>
                <span class="history-size">{formatCacheSize(entry.sizeBytes)}</span>
                <button class="recent-icon-button history-download-button" type="button" aria-label={copy.dialogs.history.downloadAria(entry.lastModified)} title={copy.row.downloadTitle} on:click={() => downloadHistoryVersion(entry.id)}>
                  <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
                </button>
              </li>
            {/each}
          </ul>
          {#if historyError}<p class="status-line error" role="alert">{historyError}</p>{/if}
          <p class="history-note">{copy.dialogs.history.note}</p>
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
          <button class="modal-action secondary" on:click={() => resolveDirtyModal('discard')}>{copy.dialogs.dirty.discard}</button>
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
              {#if newLithError}<span class="new-lith-error" role="alert">{newLithError}</span>{/if}
              <input bind:this={newLithInputElement} bind:value={newLithName} aria-label={copy.newLith.nameAria} placeholder={copy.newLith.placeholder} spellcheck="false" on:keydown={(event) => { if (event.key === 'Enter') submitNewLith(); else if (event.key === 'Escape') closeNewLithModal(); }} on:input={() => (newLithError = '')} />
              <button type="button" class="new-lith-check" class:invalid={newLithTaken} aria-label={newLithTaken ? copy.newLith.taken : copy.newLith.create} title={newLithTaken ? copy.newLith.taken : copy.newLith.create} on:click={submitNewLith}>{#if newLithTaken}<svg class="new-lith-warn" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20Z"/><path d="M12 10v4.5"/><path d="M12 17.3v.2"/></svg>{:else}✓{/if}</button>
            </div>
            <button type="button" class="recent-icon-button remove-recent new-lith-close" aria-label={copy.newLith.closeAria} title={copy.common.cancel} on:click={closeNewLithModal}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button>
          </div>
        </div>
      {:else}
        <button class="action-button" on:click={openNewLithModal} disabled={busy}>{copy.actions.newBlank}</button>
      {/if}
      <button class="action-button mount-button" on:click={mountFromDisk} disabled={busy}>{mode === 'self-host' ? copy.actions.upload : copy.actions.mount}</button>
      {#if mode !== 'self-host'}
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
              <div class="recent-row offline-row">
                <button class="recent-name" title={copy.offline.rowOpenTitle} on:click={() => void openCachedEntry(entry)}>{@html titleMarkup(entry.name, search)}<span class="cached-size">{formatCacheSize(entry.sizeBytes)}</span></button>
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
                  thing a name cannot tell you about a Lith you are about to open. Absent
                  when the store does not report it, rather than shown as a zero.
                -->
                <button class="recent-name" title={copy.row.openFromServer} on:click={() => openRemoteFile(file.name)}>{@html titleMarkup(file.name, search)}{#if file.sizeBytes !== null}<span class="cached-size">{formatLithSize(file.sizeBytes)}</span>{/if}</button>
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
            {#if mode === 'tauri' && vaultStatus}
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
        {#each filteredRecent as file}
          {@const name = getEntryName(file)}
          {@const diskPath = recentDiskPath(file as any)}
          {@const browserOnlyRow = (file as any).browserOnly === true}
          {@const unsavedRow = Boolean(dirtyEntries[name])}
          {@const localOnlyRow = showBackupStatus && Boolean(diskPath) && localOnlyPaths.has(diskPath as string)}
          {@const markedRow = browserOnlyRow || localOnlyRow || unsavedRow}
          <div class="recent-row">
            <!--
              The hover answers the one question a row cannot show: where this Lith lives
              on disk. Only a row with a path can answer it (a browser's picker hands over a
              handle, which is a permission rather than an address) and a Lith that has never
              been saved has no path at all, so those rows name no place rather than the wrong
              one. The path is what the app would open, unshortened: `~` or an ellipsis would
              be a second thing to decode on the one line that exists to be exact.
            -->
            <button class="recent-name" title={diskPath ?? undefined} on:click={() => openRecent(file)}>{@html titleMarkup(name, search)}{#if cachedEntries[name]}<span class="cached-size">{formatCacheSize(cachedEntries[name].sizeBytes)}</span>{/if}</button>
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
            <button class="recent-icon-button remove-recent" type="button" aria-label={copy.row.removeAria(name)} on:click={() => removeRecent(file)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button>
          </div>
        {/each}
        {#each filteredCached as entry}
          <div class="recent-row cached-only-row">
            <div class="recent-name cached-result" role="note">{@html titleMarkup(entry.name, search)}<span class="cached-size">{formatCacheSize(entry.sizeBytes)}</span><span class="cached-label">{copy.row.cachedLocally}</span></div>
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
        One mode has neither control: in the index-db-only fallback neither means what it
        says. Nothing on disk can be re-listed, and "Reset" there is not "clear a list,
        your files stay". The cache *is* the files, so one click would take every Lith on
        the device with it. Site data is the browser's own way to do that, and its friction
        is the point: it is worth requiring a deliberate trip through the browser's
        settings to erase everything the launcher holds.

        Self-host keeps the rebuild, because the caches it repairs are this device's even
        though the list is the server's: re-reading the store is also what indexes each of
        its Liths here, and that index is what search reads. Reset is not kept. The list
        is not this device's to clear, and re-reading it is the rebuild it already has.

        Offline mode gets neither, and there the rebuild is not merely unhelpful: reading
        the server again is the very thing that just failed, so a click could only repaint
        an error beside the banner that already explains it. The rows it would index are
        the ones on screen, which is the whole of what this mode is.
      -->
      <!--
        The panel's foot row, and with it the phone layout's answer to horizontal space.
        The control the panel's list is rebuilt from ends the panel, and at phone width the
        install offer joins it here instead of hovering in the window's corner: the corner
        is width taken from the panel's own rows (a phone's window is barely wider than the
        column), while the row the rebuild control already has is one button wide and has
        room for a second. Anything wider than a phone the offer goes back to that corner,
        which is where it is pinned. See `.install-offer`.

        The row is the panel's last element and exists whether or not it has anything in
        it, so a launcher that rebuilds nothing (offline mode, the browser-only store)
        simply draws an empty row of no height rather than a second layout.
      -->
      <div class="recent-foot">
        {#if !indexDbOnly && !offlineLauncher}
          {#if showRebuildControl}
            <button class="reset-cache" on:click={rebuildRecents} disabled={rebuildBusy} title={isSelfHost() ? copy.foot.rebuildServerTitle : copy.foot.rebuildDiskTitle}>{
              rebuildBusy ? copy.foot.reindexing : copy.foot.rebuild
            }</button>
          {:else}
            <button class="reset-cache" on:click={clearRecent} title={copy.foot.resetTitle}>{copy.foot.reset}</button>
          {/if}
        {/if}
        {#if installOffer}{@render installOfferControl()}{/if}
      </div>
    </section>
  {/if}
  <!--
    The footer band is the one control this launcher keeps in the window's corner, and it
    is the browser-only half of the mark above: the launcher a deployment serves shows the
    link here, and the desktop app has never had it (it syncs from the header instead). On
    a phone it goes, because the mark carries the same link.

    The install offer waits here only when there is no panel foot row to hold it. The
    launcher with nothing listed yet. Everything else about it, including where it is
    drawn, is the offer's own business; the two sites are mutually exclusive, which is why
    the markup for it is written once, above.
  -->
  <footer>{#if mode === 'webapp'}<a class="github-link" href={PROJECT_URL} target="_blank" rel="noreferrer">{copy.app.footerLink}</a>{/if}{#if installOffer && !recentPanelShown}{@render installOfferControl()}{/if}</footer>
</main>
