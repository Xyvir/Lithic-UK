<script lang="ts">
  import { onMount } from 'svelte';
  import { launcherReturn, withLauncherHandoff, type LauncherMode } from './mode';
  import { createFileBridge, tauriInvoke, tauriListen, saveTextVerifiably } from './file-bridge';
  import { orphanPill, orphanDownloadNote, type OrphanDownloadState } from './orphan-download';
  import { isScratchFileName, isHtmlMonolithName, tracksUnsavedEdits, resolveMountName, resolveScratchKind, type ScratchKind } from './scratch-editor';
  import { pwaInstall, promptPwaInstall } from './pwa-install';
  import { bootLegacyWiki, bootLegacyHtml, type RemoteTarget } from './legacy-launcher-runtime';
  import { EMOJI_LIST, uploadInstanceIcon, clearInstanceIcon, emojiFaviconUrl, applyFavicon, bustIconCache, readInstanceEmoji, saveInstanceEmoji, clearInstanceEmoji } from './instance-icon';
  import { getRecentFiles, addRecentFile, removeRecentFile, clearAllRecentFiles, purgeOldestCachesIfNeeded, saveSearchCache, forgetWikiCache, cachedWikiNames, idb, getSearchCacheText, listWikiVersions, wikiHasHistory, downloadWikiVersion, getDirtyState, clearDirtyState, listDirtyRecoveries, isWikiDriftedFromHead, isInstallDismissed, setInstallDismissed, recentDiskPath, type RecentEntry } from './storage';
  import { readBookmarkEntries, saveBookmark, removeBookmark, setBookmarkIcon, refreshBookmarkIcon, verifyInstanceUrl, normalizeInstanceUrl, instanceLabel, type BookmarkEntry, type InstanceVerification } from './bookmarks';
  import { fetchRemoteFiles, fetchRemoteWiki, probePatchApi, createLockHeartbeat, readRemoteLock, uploadRemoteFile, webdavUrl, resolveSessionId, lithUploadName, type WebdavFile } from './webdav';
  import { normalizeLithName } from './legacy-saver';
  import { searchCachedWikis } from './cache-search';
  import { computeBackupCoverage, folderOf, hasBackedUpRepo, orphanedEntries, reindexFolders, syncedDirFor, type CoverageRow, type RebuildOrphan } from './backup-coverage';
  import { parseDeviceCode, parseDevicePoll, pollDelayMs, formatUserCode, generateRepoName, partitionRepos } from './github-device';
  import { syncIndicator, shouldHeartbeat, healthFailure, SYNC_PULSE_MS, type SyncIndicator, type HealthState } from './git-sync-health';
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
  const RECENT_KEY = 'lithic-recent-liths';
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
  let installState: 'uninstalled' | 'current' | 'stale' = 'uninstalled';
  // "Dismiss" on the install offer: hides the button until manually restored
  // (clear site data in webapp mode; delete recents.txt beside the exe in
  // tauri mode). Once installed, dismissal no longer hides the update button.
  let installDismissed = false;

  async function refreshInstallState() {
    if (mode === 'tauri') {
      try {
        const result = await tauriInvoke<{ installed: boolean; up_to_date: boolean }>('install_status');
        installState = result.installed ? (result.up_to_date ? 'current' : 'stale') : 'uninstalled';
      } catch {
        installState = 'uninstalled';
      }
      try {
        const offer = await tauriInvoke<{ installed: boolean; dismissed: boolean }>('install_offer_status');
        installDismissed = offer.dismissed;
      } catch {
        installDismissed = false;
      }
    } else {
      installDismissed = await isInstallDismissed();
    }
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
      status = 'Install is available from the browser menu.';
    }
  }

  // GitHub sync (Tauri): the legacy launcher's slick flow, server-free —
  // install the Lithic Sync GitHub App, authorize via OAuth device flow
  // (github.com/login/device + user code), pick or create a lithic-sync-*
  // repo, then the folder auto-commits on every save. Rust proxies the two
  // GitHub OAuth endpoints; a PAT form stays as the advanced fallback.
  type GitSyncView = 'disconnected' | 'connecting' | 'selecting' | 'connected';
  let showGitSyncModal = false;
  let gitSyncView: GitSyncView = 'disconnected';
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
   * at boot is not evidence that nothing is synced — it is evidence that the
   * question cannot be asked yet.
   */
  let gitSyncRecentsReady = false;
  /**
   * Rust has a backup of the focused folder running right now — usually the exit
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
   * and the work ends at its next checkpoint, so this is a request, not a fact —
   * the modal keeps its progress line until `git_sync_setup` itself returns.
   */
  let gitSyncCancelling = false;

  function startGitSyncProgress(): void {
    stopGitSyncProgressTimer();
    gitSyncStage = 'Starting…';
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
   * the moment the connection lands — the point of connecting a folder is to
   * have its wikis in front of you, not to go hunting for them through Mount.
   * Rust returns them newest-first and `remember` unshifts, so walk backwards.
   */
  async function adoptSyncedWikis(paths: string[] | undefined): Promise<void> {
    if (!paths || paths.length === 0) return;
    for (const path of [...paths].reverse()) {
      await remember({ name: path.split(/[\\/]/).pop() || path, path });
    }
  }

  function openGitSyncModal() {
    gitSyncMessage = '';
    gitSyncError = '';
    if (gitSyncView === 'connecting') {
      // The poll loop was aborted when the dialog last closed; start fresh
      // rather than showing a dead "waiting for authorization" screen.
      gitPollAborted = true;
      gitAuthActive = false;
      gitSyncView = 'disconnected';
      gitUserCode = '';
    }
    showGitSyncModal = true;
    gitSyncHealthApplies = healthAppliesToActive();
    void refreshGitSyncStatus(true);
    // Opening the dialog is the user asking "is this working?" — worth a check
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
    gitSyncView = 'disconnected';
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
   * all — a Lith saved from inside the wiki records its path as `tauriPath`, so
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
   * opened — or, when a folder Lithic already backs up outranks both, that folder.
   */
  function gitSyncActivePath(): string | null {
    return gitSyncPreferredFolder ?? gitSyncTargetPath();
  }

  /**
   * The folder Rust prefers: one a previous attachment already left a repository
   * in, which outranks the folder the derived path implies.
   *
   * Only Rust can answer it — the question is a `.git` sitting in a folder on disk
   * — and only the launcher knows what to fall back on, so the two halves meet
   * here.
   */
  let gitSyncPreferredFolder: string | null = null;
  /** The derived path the resolution already ran for; undefined before any. */
  let gitSyncResolvedFor: string | null | undefined = undefined;
  let gitSyncResolveToken = 0;

  /**
   * The derived subject, written where Svelte can see what it depends on: a
   * reactive statement tracks the variables it *names*, and `filePath`/
   * `recentFiles` are read inside a helper that names neither — so through
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
    let folder: string | null = null;
    try {
      folder = await tauriInvoke<string | null>('git_sync_folder', { derived });
    } catch {
      folder = null;
    }
    // A newer subject is already being resolved, and its answer is the one to
    // keep: this one describes a file nobody is looking at any more.
    if (token !== gitSyncResolveToken) return;
    gitSyncPreferredFolder = folder;
    // The icon, the heartbeat and the dialog all read the resolved folder, so the
    // answers that depend on it are only now knowable.
    refreshGitSyncIcon();
  }

  /**
   * The folder the modal's actions act on, named in the dialog itself.
   *
   * The target is *derived* — the open Lith, else the newest recent row — and a
   * recent row can live anywhere, so the folder is not something the user chose at
   * the moment they connect. Saying which one it is, before they press anything, is
   * the difference between "back up these notes" and involuntarily committing a
   * Downloads folder. Both halves are named directly here, because Svelte only
   * tracks the variables a reactive statement reads.
   */
  $: gitSyncFolder = (gitSyncPreferredFolder ?? folderOf(gitSyncSubject ?? '')).replace(/[\\/]+$/, '');

  /**
   * Ask the running connect to stop. The outcome arrives as `git_sync_setup`
   * failing, so there is nothing to report here — an unreachable backend means
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
  // Where the list is derived rather than authored — the desktop app's synced
  // folders, and self-host's server — rebuilding beats clearing.
  $: showRebuildControl = isSelfHost() || showBackupStatus;

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
      title: 'Copy to Synced Dir',
      body: `${name} is not backed up. Copy it into ${folder}?`,
      confirmLabel: 'Copy',
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
      status = `Copied ${copied.name} to ${folder}`;
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
    // Ask for a verdict the moment one is missing and the folder is there — on
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
      foldGitSyncStatus(await tauriInvoke<GitSyncStatus | null>('git_sync_status', { path: target }));
    } catch (error) {
      foldGitSyncStatus(null, true);
      noteGitSyncStatusFailure(error);
    }
    if (applyView && gitSyncView !== 'connecting' && gitSyncView !== 'selecting') {
      gitSyncView = gitSyncConnectedRepo ? 'connected' : 'disconnected';
    }
  }

  let gitSyncConnectedRepo = '';

  /** Legacy flow, step 1: device code + user code display, then poll. */
  async function startDeviceAuth() {
    if (gitSyncBusy || gitAuthActive) return;
    gitSyncBusy = true;
    gitAuthActive = true;
    gitSyncError = '';
    gitSyncView = 'connecting';
    gitPollAborted = false;
    try {
      const raw = await tauriInvoke<unknown>('github_device_code');
      const parsed = parseDeviceCode(raw);
      if (!parsed) throw new Error('GitHub did not return a device code');
      gitUserCode = parsed.user_code;
      void pollDeviceToken(parsed.device_code, parsed.interval);
    } catch (error) {
      gitSyncError = error instanceof Error ? error.message : String(error);
      gitSyncView = 'disconnected';
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
        const decision = parseDevicePoll(await tauriInvoke<unknown>('github_device_poll', { deviceCode }));
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
        gitSyncView = 'disconnected';
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
      const repos = await tauriInvoke<Array<{ full_name: string }>>('github_list_repos', { token: gitDeviceToken });
      const partitioned = partitionRepos(Array.isArray(repos) ? repos : []);
      gitManagedRepos = partitioned.managed;
      gitOtherRepos = partitioned.other;
      gitRepoNamePending = generateRepoName();
      gitRepoChoice = gitManagedRepos[0] ?? '';
      gitCustomRepoInput = '';
      gitSyncView = 'selecting';
    } catch (error) {
      gitSyncError = error instanceof Error ? error.message : String(error);
      gitSyncView = 'disconnected';
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
    if (!target || !repo || !gitDeviceToken || gitSyncBusy) return;
    gitSyncBusy = true;
    gitSyncError = '';
    gitSyncMessage = '';
    startGitSyncProgress();
    try {
      if (gitRepoChoice === '__create__') {
        const created = await tauriInvoke<{ full_name: string }>('github_create_repo', { token: gitDeviceToken, name: repo });
        gitSyncMessage = `Created ${created.full_name}. `;
      }
      const result = await tauriInvoke<GitSyncSetupResult>('git_sync_setup', { path: target, repo, token: gitDeviceToken });
      gitSyncMessage += result?.summary || 'Synced';
      gitDeviceToken = null;
      gitSyncView = 'connected';
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
    if (!target || gitSyncBusy) return;
    gitSyncBusy = true;
    gitSyncError = '';
    gitSyncMessage = '';
    startGitSyncProgress();
    try {
      const result = await tauriInvoke<GitSyncSetupResult>('git_sync_setup', { path: target, repo: gitRepoInput, token: gitTokenInput });
      gitSyncMessage = result?.summary || 'Synced';
      gitTokenInput = '';
      gitSyncView = 'connected';
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
    if (!target || gitSyncBusy) return;
    const confirmed = await askConfirmation({
      title: 'Disconnect GitHub Sync?',
      body: 'Saves in this folder stop syncing to GitHub.',
      confirmLabel: 'Disconnect'
    });
    if (!confirmed) return;
    gitSyncBusy = true;
    try {
      await tauriInvoke('git_sync_disconnect', { path: target });
      gitSyncConnectedRepo = '';
      gitSyncView = 'disconnected';
      void refreshBackupCoverage();
      // That folder is no longer attached, so what Rust prefers may have moved.
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

  /** The last step of a reconnect: land the token on the existing remote. */
  async function finishGitReconnect(): Promise<void> {
    const target = gitSyncActivePath();
    const repo = gitSyncConnectedRepo;
    const token = gitDeviceToken;
    gitReconnectMode = false;
    if (!target || !repo || !token) {
      gitSyncError = 'Could not resolve the folder or repository to reconnect.';
      gitSyncView = 'disconnected';
      return;
    }
    gitSyncBusy = true;
    gitSyncError = '';
    startGitSyncProgress();
    try {
      await tauriInvoke('git_sync_reauth', { path: target, repo, token });
      gitDeviceToken = null;
      gitSyncMessage = `Reconnected github.com/${repo}`;
      gitSyncView = 'connected';
      // Proven by construction: the token that just authenticated is the one
      // now sitting in the remote, so the next save has somewhere to go.
      markGitSyncVerified();
      void runGitSyncHeartbeat(true);
    } catch (error) {
      gitSyncError = error instanceof Error ? error.message : String(error);
      gitSyncView = 'disconnected';
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
  let gitSyncIconTitle = 'GitHub Sync';
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

  /** Whether the dialog should offer a way out of the current state. */
  $: gitSyncHealthBroken =
    gitSyncHealthApplies &&
    (Boolean(gitSyncLastPushError) || healthFailure(gitSyncHealth) !== null);

  /** The dialog's one line about health, matching the icon's tooltip. */
  $: gitSyncHealthNote = !gitSyncHealthApplies
    ? ''
    : gitSyncLastPushError
      ? `Last save did not upload: ${gitSyncLastPushError}`
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
      const result = await tauriInvoke<{ path: string; start_menu: string | null }>('install_monolith');
      // The Start Menu entry is the part worth mentioning: it is what makes the
      // app launchable (and pinnable) instead of a file in Documents.
      installStatus = result.start_menu ? `${result.path}. Start Menu shortcut added.` : result.path;
      installState = 'current';
      status = `Installed to ${result.path}`;
      // The status line animates while it has text; retire the message
      // once it has had a moment to be read.
      setTimeout(() => { if (status.startsWith('Installed to ')) status = ''; }, 6000);
    } catch (error) {
      installStatus = `Install failed: ${error instanceof Error ? error.message : String(error)}`;
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
  let cachedEntries: Record<string, CacheSearchEntry> = {};
  let cacheSearchMatches: Record<string, CacheSearchMatch> = {};
  let cacheSearchRequest = 0;
  type HistoryEntry = { id: string; ts: number; sizeBytes: number; isBase?: boolean; external?: boolean; lastModified: string };
  let showHistoryModal = false;
  let historyName = '';
  let historyEntries: HistoryEntry[] = [];
  let historyBusy = false;
  let historyError = '';
  // Per-wiki version-history availability keys the history affordance:
  // wikis with no recorded versions (never saved, scratch-before-save)
  // hide the button instead of opening an empty modal.
  let historyAvailable: Record<string, boolean> = {};

  async function refreshHistoryAvailability(names: string[]) {
    const wanted = names.filter((name) => !(name in historyAvailable));
    if (wanted.length > 0) {
      const availability = await wikiHasHistory(wanted);
      historyAvailable = { ...historyAvailable, ...availability };
    }
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
  interface ConfirmationRequest { title: string; body: string; confirmLabel: string }
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

  function getEntryName(entry: RecentEntry | { name?: string; handle?: any }): string {
    if (entry.handle && entry.handle.name) return entry.handle.name;
    return (entry as any).name || 'untitled.lith';
  }

  // Esc deselects (blurs) the search while preserving the active query —
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

  $: filteredRecent = recentFiles.filter((file) => {
    const name = getEntryName(file);
    return name.toLowerCase().includes(search.toLowerCase()) || Boolean(cacheSearchMatches[name]?.preview);
  });

  // Self-host: the server's own Liths are the primary list, filtered by the
  // same search box as the local recents.
  $: filteredRemote = remoteFiles.filter((file) => file.name.toLowerCase().includes(search.toLowerCase()));

  $: filteredCached = Object.values(cachedEntries).filter((entry) => {
    const isRecent = recentFiles.some((file) => getEntryName(file) === entry.name);
    const query = search.trim().toLowerCase();
    if (!query) return false;
    const nameMatches = entry.name.toLowerCase().includes(query);
    return !isRecent && (nameMatches || Boolean(cacheSearchMatches[entry.name]?.preview));
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
      // `base_recipes.lith_3f2a` — enough to keep the panel on screen with
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
    ...filteredCached.map((entry) => entry.name)
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
    // the unsaved-edit indicator once recents are known — a blank lith edited
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
      // No sidecar support (browser/dev) — ignore.
    }
  }

  /**
   * Mirror the current recents into the sidecar (fire-and-forget). The command
   * takes `paths` and `dismissed` together — the flag rides the same file — so
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

  async function remember(file: { name: string; path?: string; text?: string; handle?: any }) {
    if (file.handle) {
      recentFiles = await addRecentFile(file.handle, file.path ?? null);
      persistRecentsSidecar();
    } else {
      const name = file.name;
      recentFiles = [file, ...recentFiles.filter((item) => getEntryName(item) !== name)].slice(0, 20);
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentFiles.map(({ name, path, text }) => ({ name, path, text }))));
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
      status = `Recovering ${dirty.tiddlers.length} unsaved edit${dirty.tiddlers.length === 1 ? '' : 's'} for ${safeName}`;
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
   * Nothing on disk is touched — the cached copy and the version history both
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
    // dirty-state key — see resolveMountName for why they must not diverge.
    const safeName = resolveMountName(name, { scratch: isScratch, htmlMonolith: isHtmlMonolith });
    await remember({ name: safeName, path, text: contents, handle });
    // Drift compares the file against the tiddler chain, and only a .lith file
    // holds a tiddler store to compare — a scratch document is flat text and a
    // monolith is a page — so the SYNC marker stays lith-only. Unsaved-edit
    // recovery is the one thing a monolith opts out of: it may already keep its
    // own recovery through add-ons or plugins, and the launcher must not
    // interpose on what the page does with its own edits. Saved history is not
    // interposition, so monoliths keep it like every other mount.
    const driftedFromHead = !isHtmlMonolith && !isScratch && await isWikiDriftedFromHead(safeName, contents);
    if (tracksUnsavedEdits(name)) {
      if ((await prepareDirtyRecovery(safeName)) === 'later') {
        busy = false;
        status = 'Unsaved edits kept for later';
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
      // HTML monoliths are complete wiki pages — serve them as-is, with an
      // HTML-mode saver injected that writes the page back (legacy parity).
      // The path travels with it so the saver targets the file the user
      // actually opened, not a handoff left behind by an earlier mount.
      await bootLegacyHtml(contents, safeName, path);
      return;
    }
    const handoff = { name: safeName, path, text: contents };
    sessionStorage.setItem('lithic-launcher-file', JSON.stringify(handoff));
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
    }, { driftedFromHead, scratchMode, remote });
    pendingImports = [];
  }

  async function blankLith() {
    busy = true;
    status = 'Loading blank Lith…';
    try {
      await mountWiki('', 'new.lith');
    } catch (error) {
      mountError = error instanceof Error ? error.message : String(error);
      status = 'Unable to load the local wiki';
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
      newLithError = 'Name already in use.';
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
    status = 'Loading blank Lith…';
    try {
      await mountWiki('', safeName, undefined, undefined, [{ title: '$:/SiteTitle', text: siteTitle }]);
    } catch (error) {
      mountError = error instanceof Error ? error.message : String(error);
      status = 'Unable to load the local wiki';
      busy = false;
    }
  }

  async function mountFromDisk() {
    busy = true; status = 'Opening…';
    try {
      const result = await files.open();
      if (!result) { status = ''; return; }
      lithText = result.text; fileName = result.name; filePath = result.path;
      await mountWiki(result.text, result.name, result.path, result.handle);
      status = `Mounted ${result.name}`;
    } catch (error) { status = `Open failed: ${error instanceof Error ? error.message : String(error)}`; }
    finally { busy = false; }
  }

  async function openRecent(recent: RecentEntry | { name?: string; path?: string; text?: string; handle?: any }) {
    busy = true;
    status = 'Opening recent Lith…';
    try {
      const rawHandle = (recent as any).handle;
      const tauriPath = recentDiskPath(recent);
      if (mode === 'tauri') {
        if (tauriPath) {
          await mountTauriPath(tauriPath);
          return;
        }
        // A handle-less or pseudo-handle row with no path can't be opened:
        // browser handles don't exist in this WebView.
        if (!rawHandle?.getFile) {
          status = 'No file path recorded. Open it once via Mount to re-link it.';
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
        status = `Mounted ${file.name}`;
        return;
      }
      if ((recent as any).text !== undefined) {
        lithText = (recent as any).text;
        fileName = (recent as any).name || 'untitled.lith';
        filePath = recentDiskPath(recent) ?? undefined;
        status = `Mounted ${fileName}`;
        await mountWiki(lithText, fileName, filePath);
      } else if (recentDiskPath(recent) && mode === 'tauri') {
        // Tauri recents opened through the save dialog carry only a disk
        // path (no cached text) — read fresh from disk so in-place edits
        // made outside the app are picked up.
        await mountTauriPath(recentDiskPath(recent) as string);
        return;
      }
    } catch (error) {
      status = `Open failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
      showRecent = false;
    }
  }

  /**
   * Open a file by absolute disk path — the Tauri startup-file handoff
   * (CLI arg or "Open with" association) and the recents list both land
   * here. Reads through the Rust bridge, then mounts as lith or scratch.
   */
  async function openTauriPath(path: string) {
    if (busy) return;
    busy = true;
    status = 'Opening…';
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
      status = `Mounted ${result.name}`;
    } catch (error) {
      status = `Open failed: ${error instanceof Error ? error.message : String(error)}`;
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
        window.open('https://lithic.uk/intro.html', '_blank');
      } else {
        mountError = 'Could not load the introduction.';
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
        // Not a payload URL after all — treat as a file drop below.
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
        mountError = 'Dropped file is not valid data format.';
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
      mountError = 'Unable to load the shared payload';
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
    } catch (error) {
      remoteFiles = [];
      remoteError = `Could not list this server’s Liths (${error instanceof Error ? error.message : String(error)}).`;
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
    status = `Opening ${name}…`;
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
   * can write over their copy — the legacy "Open Read-Only" path.
   */
  async function mountRemoteFile(name: string, readOnly = false): Promise<void> {
    busy = true;
    remoteError = '';
    status = `Opening ${name}…`;
    try {
      let text: string;
      let digest = '';
      if (patchApiAvailable) {
        const remote = await fetchRemoteWiki(name);
        text = remote.text;
        digest = remote.digest;
      } else {
        const response = await fetch(webdavUrl(name));
        if (!response.ok) throw new Error(`GET failed: ${response.status}`);
        text = await response.text();
      }

      activeRemote = { name, digest, api: patchApiAvailable && Boolean(digest) };
      if (readOnly) {
        stopLockHeartbeat();
        status = `Mounted ${name} read-only`;
      } else {
        await startLockHeartbeat(name);
        status = activeRemote.api ? `Mounted ${name}. Saves send only the changes.` : `Mounted ${name}`;
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
      remoteError = `Could not open ${name}: ${error instanceof Error ? error.message : String(error)}`;
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
    status = `Creating ${name}…`;
    try {
      await uploadRemoteFile(name, '');
      await refreshRemoteList();
      busy = false;
      await openRemoteFile(name);
    } catch (error) {
      remoteError = `Could not create ${name}: ${error instanceof Error ? error.message : String(error)}`;
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

  /** Apply the remembered emoji to the launcher header and the tab favicon. */
  function restoreInstanceIcon(): void {
    brandEmoji = readInstanceEmoji();
    applyFavicon(brandEmoji ? emojiFaviconUrl(brandEmoji) : null);
  }

  function openEmojiPicker(): void {
    if (!isSelfHost()) return;
    emojiChoice = brandEmoji;
    emojiStatus = '';
    showEmojiPicker = true;
  }

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
    emojiStatus = 'Saving…';
    const result = await uploadInstanceIcon(emojiChoice, {
      onProgress: (saved, total) => {
        emojiStatus = `Saving… (${saved} of ${total})`;
      }
    });
    if (result.ok) {
      emojiStatus = `✓ Saved. This instance now uses ${emojiChoice}.`;
      bustIconCache();
    } else {
      emojiStatus = `Saved on this device only. The server write failed (${result.error ?? 'unknown error'}).`;
    }
    emojiBusy = false;
  }

  async function restoreDefaultInstanceIcon(): Promise<void> {
    clearInstanceEmoji();
    brandEmoji = '';
    applyFavicon(null);
    emojiStatus = (await clearInstanceIcon()) ? '✓ Default icon restored server-wide.' : 'Restored on this device only.';
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
      // is the point of the list — it is what tells a personal instance from a
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
          ? 'Could not reach this address.'
          : 'That address is not a Lithic instance.';
        return;
      }
      if (result.requiresManualConfirm) {
        const confirmed = await askConfirmation({
          title: 'Bookmark this instance?',
          body: 'Lithic could not verify this address.',
          confirmLabel: 'Bookmark Anyway'
        });
        if (!confirmed) return;
      }
      bookmarks = saveBookmark(normalized);
      // Cache the instance's own icon so the meta-launcher list can tell
      // instances apart at a glance — and keep doing so offline.
      void refreshBookmarkIcons();
      closeBookmarkModal();
      status = 'Self-hosted instance bookmarked';
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
   * how to get back here — see `withLauncherHandoff` in mode.ts.
   */
  function openBookmarkedInstance(url: string) {
    window.location.href = withLauncherHandoff(url, window.location.href);
  }

  function backToLauncher() {
    if (!launcherReturnTarget) return;
    // Prefer the address we were handed; a marked page may have been reached
    // without ever visiting the launcher in this window (`history.back()` would
    // then leave the app entirely).
    if (launcherReturnTarget.kind === 'url') window.location.href = launcherReturnTarget.url;
    else window.history.back();
  }

  function removeInstanceBookmark(url: string) {
    bookmarks = removeBookmark(url);
  }

  /**
   * Open the per-wiki version history modal. The history icon no longer
   * downloads a single cache blob — it lists every timestamped version
   * (deltas materialized on demand) and lets the user download any of them
   * as a non-destructive `<stem>_recover_<stamp>.lith` copy.
   */
  async function openHistoryModal(name: string) {
    historyName = name;
    historyEntries = [];
    historyError = '';
    showHistoryModal = true;
    historyBusy = true;
    try {
      historyEntries = await listWikiVersions(name);
      if (historyEntries.length === 0) historyError = 'No versioned history is available for this wiki yet.';
    } catch (error) {
      historyError = error instanceof Error ? error.message : String(error);
    } finally {
      historyBusy = false;
    }
  }

  function closeHistoryModal() {
    showHistoryModal = false;
    historyError = '';
  }

  /** Download one materialized version; history is never modified. */
  async function downloadHistoryVersion(id: string) {
    try {
      const version = await downloadWikiVersion(historyName, id);
      if (!version) {
        historyError = 'That version could not be materialized from the history chain.';
        return;
      }
      saveBlobAs(version.fileName, version.text);
      status = `Recovered ${version.fileName}`;
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
        status = `No cached copy of ${name} to download`;
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
      status = outcome === 'saved' ? `Saved ${fileName}` : `Downloading ${fileName}`;
    } catch (error) {
      setOrphanDownload(name, 'failed');
      mountError = `Download failed: ${error instanceof Error ? error.message : String(error)}`;
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
   * Re-index instead of forgetting.
   *
   * Where the recent list is derived rather than authored — the desktop app's
   * backed-up folders, and self-host's server — clearing it throws away a
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
    status = 'Re-indexing recent liths…';
    try {
      // Pass 1: re-list, replacing the list rather than patching it. That is
      // what lets one button do the job: the recent list is a *view* of what
      // is really there, so a stale row is removed by rebuilding instead of by
      // a separate destructive control.
      const folders = mode === 'tauri' ? reindexFolders(recentRows(), backupRoots) : [];
      const discovered: Array<{ name: string; path?: string }> = [];
      let orphans: RebuildOrphan[] = [];

      if (isSelfHost()) {
        // The server *is* the list here, so rebuilding means re-reading it.
        // Writing the server's names into the local recents would list every
        // wiki twice.
        patchApiAvailable = await probePatchApi();
        remoteFiles = await fetchRemoteFiles();
        // The server is the source of truth here, so a cached copy it doesn't
        // hold — and that no local row can open either — is a ghost. Local rows
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
        status = 'Rebuild cancelled';
        return;
      }
      // Confirmed: nothing about them is kept — not the row, not the cached
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
      // Sequential on purpose: each read is small and awaiting between them is
      // what keeps the window responsive.
      const targets: CoverageRow[] = [];
      const seen = new Set<string>();
      const addTarget = (entry: CoverageRow) => {
        const key = entry.name.toLowerCase();
        if (!entry.name || seen.has(key)) return;
        seen.add(key);
        targets.push(entry);
      };
      if (isSelfHost()) for (const file of remoteFiles) addTarget({ name: file.name, path: null });
      else for (const row of recentRows()) if (row.path) addTarget(row);

      let indexed = 0;
      for (const [position, entry] of targets.entries()) {
        status = `Re-indexing ${position + 1} of ${targets.length} · ${entry.name}`;
        try {
          const text = entry.path
            ? mode === 'tauri' ? await readDiskWikiText(entry.path) : ''
            : mode === 'self-host' ? await readRemoteWikiText(entry.name) : '';
          if (text) {
            await saveSearchCache(entry.name, JSON.stringify(parseLithToJSON(text)));
            indexed += 1;
          }
        } catch {
          // One unreadable Lith must not abort the rest of the rebuild.
        }
      }

      await updateCacheMatches(search);
      await refreshBackupCoverage();
      status = indexed > 0
        ? `Re-indexed ${indexed} lith${indexed === 1 ? '' : 's'}`
        : 'Nothing new to index';
    } catch (error) {
      status = '';
      mountError = `Re-index failed: ${error instanceof Error ? error.message : String(error)}`;
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
        status = `Recovering ${dirty.tiddlers.length} unsaved edit${dirty.tiddlers.length === 1 ? '' : 's'} for ${name}`;
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
   * Pin the tiddler matched by a cache preview to the top of the story river
   * (Dogear tag) and open the file. The payload must be queued before the
   * mount — after the engine boots the launcher component is torn down.
   */
  async function pinFromPreview(name: string) {
    const match = cacheSearchMatches[name];
    if (!match?.title) return;
    const cacheText = await getCacheHistoryText(name);
    if (!cacheText) return;
    const payload = pinCachedTiddler(cacheText, match.title);
    if (!payload) return;
    pendingImports = mergePendingImports(pendingImports, payload);

    const recent = recentFiles.find((file) => getEntryName(file) === name);
    if (recent) {
      await openRecent(recent);
    } else {
      await openCachedEntry({ name, text: cacheText, sizeBytes: new Blob([cacheText]).size });
    }
  }

  /**
   * Drop one row and everything remembered about its wiki.
   *
   * Removing a row while keeping its cache left an entry only a search could
   * find, and the two branches disagreed about it: handle rows were cleaned up,
   * path rows — which is every row the desktop app writes — were not.
   */
  async function removeRecent(file: RecentEntry | { name?: string; handle?: any }) {
    const name = getEntryName(file);
    if ((file as any).handle) {
      recentFiles = await removeRecentFile((file as any).handle);
    } else {
      recentFiles = recentFiles.filter((item) => item !== file);
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentFiles.map((f: any) => ({ name: f.name, path: f.path, text: f.text }))));
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
    loadRecent();
    bookmarks = readBookmarkEntries();
    // The emoji favicon is the instance's identity in the tab, so restore it
    // (and the tab icon) before anything else renders.
    restoreInstanceIcon();
    if (mode === 'self-host') {
      void refreshRemoteList();
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
    void purgeOldestCachesIfNeeded().catch(() => { /* best effort */ });
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
        closeBookmarkModal();
        closeEmojiPicker();
        closeGitSyncModal();
      }
    };
    window.addEventListener('keydown', closeOnEscape);

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

    // Webapp/PWA mode: honor a previously dismissed install offer.
    if (mode === 'webapp') {
      void refreshInstallState();
    }

    // --- Tauri startup file (CLI arg / "Open with" association) ---
    if (mode === 'tauri') {
      void refreshInstallState();
      void tauriInvoke<string | null>('get_startup_file')
        .then((startupPath) => { if (startupPath) void openTauriPath(startupPath); })
        .catch(() => { /* command missing or no startup file; stay on launcher */ });
    }

    return () => {
      window.removeEventListener('keydown', closeOnEscape);
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
</script>

<svelte:head><title>Lithic - Launcher</title></svelte:head>

<main class="container" data-mode={mode}>
  <header class="heading">
    <button
      type="button"
      class="brand-icon-wrap"
      class:brand-emoji-wrap={Boolean(brandEmoji)}
      class:pickable={isSelfHost()}
      disabled={!isSelfHost()}
      aria-label={isSelfHost() ? 'Set this instance’s icon' : undefined}
      title={isSelfHost() ? 'Set this instance’s icon' : undefined}
      on:click={() => openEmojiPicker()}
    >
      {#if brandEmoji}
        <span class="brand-emoji" aria-hidden="true">{brandEmoji}</span>
      {:else}
        <img class="brand-icon" src={mstile150} alt="Lithic" />
      {/if}
    </button>
    <div class="heading-copy">
      <h1>Lithic - Launcher</h1>
      {#if isSelfHost()}
        <!-- No mode badge here: which launcher you are in is evident from the
             thing itself, and a pill announcing it was troubleshooting.
             The open Lith is named instead, and its title is where the cost of
             saving shows up — the patch API is not universal, and a server
             without it uploads the whole wiki. -->
        <div class="remote-line">
          {#if activeRemote}<span class="remote-file" title={patchApiAvailable ? 'Saves send only the lines that changed; the server applies them with git.' : 'This server has no patch API, so saves upload the whole wiki.'}>{activeRemote.name}</span>{/if}
          <button class="remote-refresh" type="button" on:click={refreshRemoteList} disabled={remoteBusy} title="Re-list this server’s Liths" aria-label="Refresh the server’s Lith list">{remoteBusy ? '…' : '⟳'}</button>
        </div>
      {/if}
      {#if remoteNotice}<div class="status-line">{remoteNotice}</div>{/if}
      {#if remoteError}<div class="status-line error" role="alert">{remoteError}</div>{/if}
      {#if status}<div class="status-line" role="status"><span class="status-label">{status.replace(/[…\.\s]+$/, '')}</span><span class="activity-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>{/if}
      {#if mountError}<div class="status-line error" role="alert">{mountError}</div>{/if}
    </div>
    <div class="heading-actions">
    {#if launcherReturnTarget}<button class="back-to-launcher" type="button" data-target={launcherReturnTarget.kind === 'url' ? launcherReturnTarget.url : 'history'} aria-label="Back to the main launcher" title="Back to the main launcher" on:click={backToLauncher}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5"/><path d="m11 18-6-6 6-6"/></svg></button>{/if}
    {#if mode === 'webapp'}<button class="help-button" aria-label="View Introduction" title="View Introduction" on:click={openIntro}>{introBusy ? '…' : '?'}</button>{:else if mode === 'tauri'}<button class="sync-button {gitSyncIconState}" aria-label="GitHub Sync" title={gitSyncIconTitle} on:click={openGitSyncModal}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 17.6A5 5 0 0 0 18 8h-1.3A8 8 0 1 0 4 16.3"/><path d="M12 12v9"/><path d="m8.5 15.5 3.5-3.5 3.5 3.5"/></svg>{#if gitSyncIconState === 'checking'}<span class="sync-glyph ring" aria-hidden="true"></span>{:else if gitSyncIconState === 'error'}<span class="sync-glyph alert" aria-hidden="true">!</span>{:else if gitSyncIconState === 'connected'}<span class="sync-glyph dot" aria-hidden="true"></span>{/if}</button>{/if}
    </div>
  </header>
  {#if pendingImports.length > 0}
    <div class="pending-imports" role="status" aria-label="Pending imports">
      <div class="pending-imports-header">
        <span>Pending Imports</span>
        <button type="button" aria-label="Clear pending imports" title="Clear pending imports" on:click={() => pendingImports = []}>✕</button>
      </div>
      <ul>
        {#each pendingImports as tiddler, index (tiddler.title ?? index)}
          <li class={/^\d{14}-\d{3,4}$/.test(tiddler.title ?? '') || Boolean(tiddler['stream-type']) ? 'tiddler-list' : ''}>{tiddler.title || 'Untitled Payload'}</li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if showGitSyncModal}
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeGitSyncModal()}>
      <div class="launcher-modal" role="dialog" aria-modal="true" aria-labelledby="gitsync-title">          <button class="modal-close" aria-label="Close GitHub sync dialog" on:click={closeGitSyncModal}>×</button>
        <h2 id="gitsync-title">GitHub Sync</h2>
        {#if gitSyncFolder}
          <p class="sync-folder" title={gitSyncFolder}><span class="sync-folder-label">Folder</span> {gitSyncFolder}</p>
        {/if}
        {#if showBackupStatus && backupCoverage.localOnlyPaths.length > 0}
          <p class="backup-status" role="status">{backupCoverage.backedUp} of {backupCoverage.tracked} recent liths backed up</p>
        {/if}
        {#if !gitSyncActivePath()}
          <p class="status-line error" role="alert">Save a Lith to disk first, since sync backs up its folder.</p>
        {:else if gitSyncView === 'disconnected'}
          <p>Back up this folder to GitHub. Saves push automatically.</p>
          {#if gitSyncError}<p class="status-line error" role="alert">{gitSyncError}</p>{/if}
          {#if gitSyncBusy}<p class="sync-progress" role="status"><span class="sync-spinner" aria-hidden="true"></span><span>{gitSyncStage || 'Working…'}</span><span class="sync-elapsed">{gitSyncElapsed}s</span>{#if !gitAuthActive}<button type="button" class="sync-cancel" on:click={cancelGitSync}>{gitSyncCancelling ? 'Cancelling…' : 'Cancel'}</button>{/if}</p>{/if}
          <div class="modal-actions"><button class="modal-action" disabled={gitSyncBusy} on:click={startDeviceAuth}>{gitSyncBusy ? '…' : 'Connect to GitHub'}</button></div>
          <details class="git-sync-advanced">
            <summary>Advanced: connect with a personal access token</summary>
            <input bind:value={gitRepoInput} aria-label="GitHub repository (owner/name)" placeholder="owner/repository" on:keydown={(event) => event.key === 'Enter' && connectGitSync()} />
            <input bind:value={gitTokenInput} type="password" aria-label="GitHub token" placeholder="Fine-grained or classic token with push access" on:keydown={(event) => event.key === 'Enter' && connectGitSync()} />
            {#if gitSyncBusy}<p class="sync-progress" role="status"><span class="sync-spinner" aria-hidden="true"></span><span>{gitSyncStage || 'Working…'}</span><span class="sync-elapsed">{gitSyncElapsed}s</span>{#if !gitAuthActive}<button type="button" class="sync-cancel" on:click={cancelGitSync}>{gitSyncCancelling ? 'Cancelling…' : 'Cancel'}</button>{/if}</p>{/if}
            <div class="modal-actions"><button class="modal-action" disabled={!gitRepoInput || !gitTokenInput || gitSyncBusy} on:click={connectGitSync}>{gitSyncBusy ? 'Connecting…' : 'Connect & Push'}</button></div>
          </details>
        {:else if gitSyncView === 'connecting'}
          <p>1. Open <a href="https://github.com/login/device" target="_blank" rel="noreferrer">github.com/login/device</a></p>
          <p>2. Enter this code (installs Lithic Sync on first use):</p>
          {#if gitUserCode}
            <div class="user-code-display">{formatUserCode(gitUserCode)}</div>
            <p class="git-sync-note">Waiting for authorization…</p>
          {:else}
            <p class="git-sync-note">Requesting a code from GitHub…</p>
          {/if}
          {#if gitSyncError}<p class="status-line error" role="alert">{gitSyncError}</p>{/if}
          <div class="modal-actions"><button class="modal-action secondary" on:click={resetGitSyncFlow}>Cancel</button></div>
        {:else if gitSyncView === 'selecting'}
          <button class="repo-card create" class:selected={gitRepoChoice === '__create__'} type="button" on:click={() => (gitRepoChoice = '__create__')}>
            <input type="radio" name="git-repo-choice" checked={gitRepoChoice === '__create__'} tabindex={-1} />
            <span>+ Create {gitRepoNamePending} and sync</span>
          </button>
          {#if gitManagedRepos.length > 0}
            <p class="repo-group-label">Found existing Lithic sync repos</p>
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
          <p class="repo-group-label">Advanced: your other repositories</p>
          <input bind:value={gitCustomRepoInput} class="repo-filter" aria-label="Custom repository (owner/name)" placeholder="owner/name" on:input={() => (gitRepoChoice = gitCustomRepoInput.trim() ? '__custom__' : gitRepoChoice)} />
          {#if gitOtherRepos.length > 0}
            <ul class="repo-list">
              {#each gitOtherRepos.filter((repo) => !gitCustomRepoInput || repo.toLowerCase().includes(gitCustomRepoInput.toLowerCase())) as repo (repo)}
                <li><button type="button" class="repo-card" class:selected={gitRepoChoice === repo} on:click={() => { gitCustomRepoInput = repo; gitRepoChoice = repo; }}>{repo}</button></li>
              {/each}
            </ul>
          {/if}
          {#if gitSyncError}<p class="status-line error" role="alert">{gitSyncError}</p>{/if}
          {#if gitSyncMessage}<p class="status-line" role="status">{gitSyncMessage}</p>{/if}
          {#if gitSyncBusy}<p class="sync-progress" role="status"><span class="sync-spinner" aria-hidden="true"></span><span>{gitSyncStage || 'Working…'}</span><span class="sync-elapsed">{gitSyncElapsed}s</span>{#if !gitAuthActive}<button type="button" class="sync-cancel" on:click={cancelGitSync}>{gitSyncCancelling ? 'Cancelling…' : 'Cancel'}</button>{/if}</p>{/if}
          <div class="modal-actions">
            <button class="modal-action" disabled={gitSyncBusy || !gitRepoSelection()} on:click={finalizeGitSync}>{gitSyncBusy ? 'Syncing…' : 'Start Sync'}</button>
            <button class="modal-action secondary" on:click={resetGitSyncFlow}>Back</button>
          </div>
        {:else}
          <p>Connected repository</p>
          <p class="user-code-display" style="font-size:1.05rem; letter-spacing:0.02em;">{gitSyncConnectedRepo || '—'}</p>
          {#if gitSyncHealthNote}
            <p class="status-line {gitSyncHealthBroken ? 'error' : ''}" role={gitSyncHealthBroken ? 'alert' : 'status'}>{gitSyncHealthNote}</p>
          {:else}
            <p class="git-sync-note">Saves in this folder push to GitHub automatically.</p>
          {/if}
          {#if gitSyncError}<p class="status-line error" role="alert">{gitSyncError}</p>{/if}
          {#if gitSyncMessage}<p class="status-line" role="status">{gitSyncMessage}</p>{/if}
          {#if gitSyncBusy}<p class="sync-progress" role="status"><span class="sync-spinner" aria-hidden="true"></span><span>{gitSyncStage || 'Working…'}</span><span class="sync-elapsed">{gitSyncElapsed}s</span>{#if !gitAuthActive}<button type="button" class="sync-cancel" on:click={cancelGitSync}>{gitSyncCancelling ? 'Cancelling…' : 'Cancel'}</button>{/if}</p>{/if}
          <div class="modal-actions">
            {#if gitSyncHealthBroken}
              <button class="modal-action" disabled={gitSyncBusy || gitAuthActive} on:click={reconnectGitSync}>{gitAuthActive ? 'Waiting for GitHub…' : 'Reconnect'}</button>
            {/if}
            <button class="modal-action secondary" disabled={gitSyncBusy} on:click={disconnectGitSync}>Disconnect</button>
            <button class="modal-action secondary" on:click={closeGitSyncModal}>Done</button>
          </div>
        {/if}
      </div>
    </div>
  {/if}
  {#if showBookmarkModal}
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeBookmarkModal()}>
      <div class="launcher-modal" role="dialog" aria-modal="true" aria-labelledby="bookmark-title">
        <button class="modal-close" aria-label="Close bookmark dialog" on:click={closeBookmarkModal}>×</button>
        <h2 id="bookmark-title">Bookmark Remote Instance</h2>
        <p>Save a self-hosted instance for quick access.</p>
        <input bind:this={bookmarkInputElement} bind:value={bookmarkInput} aria-label="Self-hosted instance URL" placeholder="https://..." on:keydown={(event) => event.key === 'Enter' && addInstanceBookmark()} />
        {#if bookmarkError}<p class="status-line error" role="alert">{bookmarkError}</p>{/if}
        <div class="modal-actions"><button class="modal-action" on:click={addInstanceBookmark}>Save Bookmark</button><button class="modal-action secondary" on:click={closeBookmarkModal}>Cancel</button></div>      </div>
    </div>
  {/if}
  {#if remoteCollision}
    <div class="modal-overlay" role="presentation">
      <div class="launcher-modal" role="dialog" aria-modal="true" aria-labelledby="collision-title">
        <h2 id="collision-title">Active Session Detected</h2>
        <p>{remoteCollision.who || 'Someone else'} has <strong>{remoteCollision.name}</strong> open on this server. Last writer wins.</p>
        <p class="git-sync-note">Open read-only, or ignore the lock.</p>
        <div class="modal-actions">
          <button class="modal-action" on:click={() => resolveRemoteCollision('read-only')}>Open Read-Only</button>
          <button class="modal-action secondary" on:click={() => resolveRemoteCollision('ignore')}>Ignore Lock and Open</button>
          <button class="modal-action secondary" on:click={() => (remoteCollision = null)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}
  {#if showEmojiPicker}
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeEmojiPicker()}>
      <div class="launcher-modal emoji-modal" role="dialog" aria-modal="true" aria-labelledby="emoji-title">
        <button class="modal-close" aria-label="Close icon picker" on:click={closeEmojiPicker}>×</button>
        <h2 id="emoji-title">Instance Icon</h2>
        <p>This icon identifies the instance in your tab and taskbar.</p>
        <div class="emoji-preview" aria-hidden="true">{emojiChoice || '🎨'}</div>
        <div class="emoji-grid" role="listbox" aria-label="Choose an instance icon">
          {#each EMOJI_LIST as emoji}
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
          <button class="modal-action" disabled={emojiBusy || !emojiChoice} on:click={confirmEmojiIcon}>{emojiBusy ? 'Saving…' : 'Save Icon'}</button>
          <button class="modal-action secondary" disabled={emojiBusy} on:click={restoreDefaultInstanceIcon} title="Use the shipped Lithic icon">Restore Default</button>
        </div>
      </div>
    </div>
  {/if}
  {#if rebuildOrphans.length > 0}
    <div class="modal-overlay" role="presentation">
      <div class="launcher-modal orphan-modal" role="dialog" aria-modal="true" aria-labelledby="orphan-title">
        <h2 id="orphan-title">{isSelfHost() ? 'Not on this server' : 'Not found on disk'}</h2>
        <p>
          {#if isSelfHost()}
            {rebuildOrphans.length} cached {rebuildOrphans.length === 1 ? 'copy is' : 'copies are'} missing from the server, so rebuilding deletes {rebuildOrphans.length === 1 ? 'it' : 'them'} from this device.
          {:else}
            {rebuildOrphans.length} {rebuildOrphans.length === 1 ? 'lith has' : 'liths have'} no file on disk, so rebuilding deletes {rebuildOrphans.length === 1 ? 'its' : 'their'} cached copies and history.
          {/if}
        </p>
        {#if rebuildOrphans.some((orphan) => dirtyEntries[orphan.name])}
          <p class="orphan-warning" role="alert">
            {rebuildOrphans.filter((orphan) => dirtyEntries[orphan.name]).length} of them have unsaved edits, which no download can recover.
          </p>
        {/if}
        <ul class="orphan-list">
          {#each orphanRows as row (row.orphan.name)}
            <li class="orphan-row">
              <span class="orphan-name" title={row.orphan.path ?? 'No file on disk'}>{row.orphan.name}</span>
              {#if !row.orphan.path}<span class="orphan-tag">cached only</span>{/if}
              {#if dirtyEntries[row.orphan.name]}<span class="orphan-tag dirty" title={`Unsaved edits captured ${new Date(dirtyEntries[row.orphan.name]).toLocaleString()}`}>unsaved edits</span>{/if}
              {#if cachedEntries[row.orphan.name]}
                <button class="recent-icon-button" type="button" aria-label={`Download a copy of ${row.orphan.name}`} title="Download a copy" on:click={() => downloadCachedSnapshot(row.orphan.name)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v11"></path><path d="m7.5 10.5 4.5 4.5 4.5-4.5"></path><path d="M5 19h14"></path></svg>
                </button>
                {#if row.pill}<span class="orphan-pill {row.pill.tone}" role="status" title={row.pill.title}>{row.pill.label}</span>{/if}
              {/if}
              {#if historyAvailable[row.orphan.name]}
              <button class="recent-icon-button cache-history-button" type="button" aria-label={`Show version history for ${row.orphan.name}`} title="Older versions" on:click={() => openHistoryModal(row.orphan.name)}>
                <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
              </button>
              {/if}
            </li>
          {/each}
        </ul>
        {#if orphanNote}<p class="orphan-progress" role="status">{orphanNote}</p>{/if}
        <div class="modal-actions">
          <button class="modal-action secondary" on:click={() => resolveRebuildOrphans(false)}>Cancel</button>
          <button class="modal-action" on:click={() => resolveRebuildOrphans(true)}>Proceed Anyway</button>
        </div>
      </div>
    </div>
  {/if}
  {#if showHistoryModal}
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeHistoryModal()}>
      <div class="launcher-modal history-modal" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <button class="modal-close" aria-label="Close version history dialog" on:click={closeHistoryModal}>×</button>
        <h2 id="history-title" title={historyName}>{clipFilename(historyName)} Version History</h2>
        {#if historyBusy}
          <p class="history-empty">Loading versions…</p>
        {:else if historyEntries.length === 0}
          <p class="history-empty">{historyError || 'No versions saved yet.'}</p>
        {:else}
          <ul class="history-list">
            {#each historyEntries as entry (entry.id)}
              <li class="history-entry">
                {#if entry.isBase && entry.external}<span class="history-badge sync" title="Saved after a change outside this device.">sync</span>{:else if entry.isBase}<span class="history-badge" title="Complete copy from this save.">full</span>{:else}<span class="history-badge delta" title="Edits since the previous save.">step</span>{/if}
                <span class="history-time">{entry.lastModified}</span>
                <span class="history-size">{formatCacheSize(entry.sizeBytes)}</span>
                <button class="recent-icon-button history-download-button" type="button" aria-label={`Download a copy of the version from ${entry.lastModified}`} title="Download a copy" on:click={() => downloadHistoryVersion(entry.id)}>
                  <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
                </button>
              </li>
            {/each}
          </ul>
          {#if historyError}<p class="status-line error" role="alert">{historyError}</p>{/if}
          <p class="history-note">Reverting is manual. Download a version, then replace the wiki with it.</p>
        {/if}
      </div>
    </div>
  {/if}
  {#if showDirtyModal && dirtyInfo}
    <div class="modal-overlay" role="presentation">
      <div class="launcher-modal dirty-modal" role="dialog" aria-modal="true" aria-labelledby="dirty-title">
        <h2 id="dirty-title">Unsaved edits found</h2>
        <p>
          {dirtyInfo.name} has {dirtyInfo.tiddlers.length} edit{dirtyInfo.tiddlers.length === 1 ? '' : 's'} never saved to disk, captured {new Date(dirtyInfo.ts).toLocaleString()}.
        </p>
        <ul class="dirty-tiddler-list">
          {#each dirtyInfo.tiddlers.slice(0, 8) as tiddler (tiddler.title)}
            <li>{tiddler.title}</li>
          {/each}
          {#if dirtyInfo.tiddlers.length > 8}<li class="dirty-more">… and {dirtyInfo.tiddlers.length - 8} more</li>{/if}
        </ul>
        <div class="modal-actions">
          <button class="modal-action" on:click={() => resolveDirtyModal('merge')}>Recover edits</button>
          <button class="modal-action secondary" on:click={() => resolveDirtyModal('later')}>Decide later</button>
          <button class="modal-action secondary" on:click={() => resolveDirtyModal('discard')}>Discard</button>
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
          <button bind:this={confirmationButton} class="modal-action" on:click={() => resolveConfirmation(true)}>{confirmation.confirmLabel}</button>
          <button class="modal-action secondary" on:click={() => resolveConfirmation(false)}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}
  <section class="launcher-actions" aria-label="Launcher actions">
    <div class="action-card action-pair">
      {#if showNewLithModal}
        <div class="new-lith-inline" role="dialog" aria-label="Enter a title">
          <div class="new-lith-row">
            <div class="new-lith-field">
              {#if newLithError}<span class="new-lith-error" role="alert">{newLithError}</span>{/if}
              <input bind:this={newLithInputElement} bind:value={newLithName} aria-label="Lith file name" placeholder="Enter a title" spellcheck="false" on:keydown={(event) => { if (event.key === 'Enter') submitNewLith(); else if (event.key === 'Escape') closeNewLithModal(); }} on:input={() => (newLithError = '')} />
              <button type="button" class="new-lith-check" class:invalid={newLithTaken} aria-label={newLithTaken ? 'Name already in use' : 'Create lith'} title={newLithTaken ? 'Name already in use' : 'Create lith'} on:click={submitNewLith}>{#if newLithTaken}<svg class="new-lith-warn" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2 20h20Z"/><path d="M12 10v4.5"/><path d="M12 17.3v.2"/></svg>{:else}✓{/if}</button>
            </div>
            <button type="button" class="recent-icon-button remove-recent new-lith-close" aria-label="Close new lith entry" title="Cancel" on:click={closeNewLithModal}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button>
          </div>
        </div>
      {:else}
        <button class="action-button" on:click={openNewLithModal} disabled={busy}>New Blank Lith</button>
      {/if}
      <button class="action-button mount-button" on:click={mountFromDisk} disabled={busy}>Mount a Lith</button>
      {#if mode !== 'self-host'}
      <button class="bookmark-button" aria-label="Bookmark a self-hosted instance" title="Bookmark a Remote Instance" on:click={openBookmarkModal}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16l-6-4z" /></svg></button>
      {/if}
    </div>
  </section>
  {#if bookmarks.length > 0 || recentFiles.length > 0 || remoteFiles.length > 0 || isSelfHost() || Object.keys(cachedEntries).length > 0 || showRecent}
    <section class="recent-section" aria-label="Recent Liths">
      <div class="recent-search-wrap">
        <svg class="recent-search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7.5"></circle><path d="m16.5 16.5 4 4"></path></svg>
        <input class="recent-search" aria-label="Search recent Liths" placeholder="Search recent liths…" bind:value={search} on:keydown={handleSearchKeydown} />
        {#if search}<button class="recent-search-clear" type="button" aria-label="Clear recent Lith search" on:click={() => search = ''}>×</button>{/if}
      </div>
      <div class="recent-list">
        {#if isSelfHost()}
          {#if remoteBusy && remoteFiles.length === 0}
            <p class="empty">Reading this server’s Liths…</p>
          {:else if filteredRemote.length > 0}
            <p class="recent-group-label">On this server</p>
          {/if}
          {#each filteredRemote as file (file.name)}
            <div class="recent-row remote-row">
              <span class="remote-dot" aria-hidden="true"></span>
              <button class="recent-name" title="Open from this server" on:click={() => openRemoteFile(file.name)}>{file.name}{#if file.lastModified}<span class="cached-size">{file.lastModified.toLocaleDateString()}</span>{/if}</button>
            </div>
          {/each}
        {/if}
        {#each bookmarks.filter((entry) => entry.label.toLowerCase().includes(search.toLowerCase()) || entry.url.toLowerCase().includes(search.toLowerCase())) as entry (entry.url)}
          <div class="recent-row bookmark-row">
            {#if entry.icon}
              <img class="bookmark-icon" src={entry.icon} alt="" aria-hidden="true" />
            {:else}
              <span class="bookmark-icon bookmark-icon-empty" aria-hidden="true"></span>
            {/if}
            <button class="recent-name" title="Open {entry.url}" on:click={() => openBookmarkedInstance(entry.url)}>{entry.label}</button>
            <button class="recent-icon-button remove-recent" type="button" aria-label={`Remove bookmark ${entry.url}`} on:click={() => removeInstanceBookmark(entry.url)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button>
          </div>
        {/each}
        {#if filteredRecent.length === 0 && filteredCached.length === 0 && filteredRemote.length === 0 && bookmarks.filter((entry) => entry.label.toLowerCase().includes(search.toLowerCase()) || entry.url.toLowerCase().includes(search.toLowerCase())).length === 0}<p class="empty">{isSelfHost() && remoteFiles.length === 0 ? 'No Liths on this server yet.' : (search.trim() ? 'No matching Liths.' : 'No recent Liths.')}</p>{/if}
        {#each filteredRecent as file}
          {@const name = getEntryName(file)}
          <div class="recent-row">
            <button class="recent-name" on:click={() => openRecent(file)}>{name}{#if cachedEntries[name]}<span class="cached-size">{formatCacheSize(cachedEntries[name].sizeBytes)}</span>{/if}</button>
            {#if dirtyEntries[name] || historyAvailable[name]}<button class="recent-icon-button cache-history-button" class:dirty={dirtyEntries[name]} type="button" disabled={!cachedEntries[name] && !dirtyEntries[name]} aria-label={dirtyEntries[name] ? `${name} has unsaved edits; open to recover` : `Show version history for ${name}`} title={dirtyEntries[name] ? `Unsaved edits from ${new Date(dirtyEntries[name]).toLocaleString()}` : (cachedEntries[name] ? 'Show version history' : 'No cached history')} on:click={() => openHistoryModal(name)}>
              <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
            </button>
            {/if}
            <!--
              The condition is written out rather than asked of a helper: Svelte
              re-evaluates a template condition when the variables it names
              change, and a function call names none of them. Through a helper
              the mark only appeared once something else rebuilt the row — which
              is after the coverage answer landed, so a fresh list showed no
              marks at all and the copy offer was unreachable.
            -->
            {#if showBackupStatus && localOnlyPaths.has(recentDiskPath(file as any) ?? '')}
              <button class="recent-icon-button local-only-button" type="button" aria-label={`Copy ${name} to the synced folder`} title={`Local only. Copy ${name} into the backed-up folder.`} on:click={() => offerCopyToSyncedDir(name, recentDiskPath(file as any) as string)}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5v5.5"></path><path d="M12 16.2h.01"></path></svg>
              </button>
            {/if}
            {#if cacheSearchMatches[name]?.preview}
              <div
                use:positionCachePreview
                class="cache-preview"
                role="button"
                tabindex="0"
                aria-label={cacheSearchMatches[name].title ? `Open ${name} and pin “${cacheSearchMatches[name].title}” to top` : `Open ${name}`}
                title="Open and pin this tiddler"
                on:click={() => pinFromPreview(name)}
                on:keydown={(event) => (event.key === 'Enter' || event.key === ' ') && pinFromPreview(name)}
              >{@html cacheSearchMatches[name].preview}</div>
            {/if}
            <button class="recent-icon-button remove-recent" type="button" aria-label={`Remove ${name}`} on:click={() => removeRecent(file)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button>
          </div>
        {/each}
        {#each filteredCached as entry}
          <div class="recent-row cached-only-row">
            <div class="recent-name cached-result" role="note">{entry.name}<span class="cached-size">{formatCacheSize(entry.sizeBytes)}</span><span class="cached-label">Cached locally</span></div>
            {#if dirtyEntries[entry.name] || historyAvailable[entry.name]}<button class="recent-icon-button cache-history-button" class:dirty={dirtyEntries[entry.name]} type="button" aria-label={`Show version history for ${entry.name}`} title={dirtyEntries[entry.name] ? `Unsaved edits from ${new Date(dirtyEntries[entry.name]).toLocaleString()}` : 'Show version history'} on:click={() => openHistoryModal(entry.name)}>
              <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
            </button>
            {/if}
            {#if cacheSearchMatches[entry.name]?.preview}
              <div
                use:positionCachePreview
                class="cache-preview"
                role="button"
                tabindex="0"
                aria-label={cacheSearchMatches[entry.name].title ? `Open ${entry.name} and pin “${cacheSearchMatches[entry.name].title}” to top` : `Open ${entry.name}`}
                title="Open and pin this tiddler"
                on:click={() => pinFromPreview(entry.name)}
                on:keydown={(event) => (event.key === 'Enter' || event.key === ' ') && pinFromPreview(entry.name)}
              >{@html cacheSearchMatches[entry.name].preview}</div>
            {/if}
          </div>
        {/each}
      </div>
      {#if showRebuildControl}
        <button class="reset-cache" on:click={rebuildRecents} disabled={rebuildBusy} title={isSelfHost()
          ? 'Rebuild this list from the server'
          : 'Rebuild this list from the files on disk'}>{
          rebuildBusy ? 'Re-indexing…' : 'Rebuild Recents'
        }</button>
      {:else}
        <button class="reset-cache" on:click={clearRecent} title="Clears this list and its local history. Your files stay.">Reset Recents</button>
      {/if}
    </section>
  {/if}
  <footer>{#if mode === 'webapp'}<a class="github-link" href="https://github.com/Lithic-UK/Lithic" target="_blank" rel="noreferrer">Github</a>{#if $pwaInstall.installable && !(installDismissed && installState !== 'stale')}<span class="install-offer"><button class="install-button" on:click={installPwa}>Install App</button><button class="install-dismiss" on:click={dismissInstallOffer} title="Hide the install offer" aria-label="Dismiss install offer"><span class="install-dismiss-label">dismiss</span>✕</button></span>{/if}{:else if mode === 'tauri' && installState !== 'current' && !(installDismissed && installState === 'uninstalled')}<span class="install-offer"><button class="install-button" on:click={installMonolith} disabled={installBusy} title={installStatus || 'Copy to Documents and add a Start Menu shortcut'}>{installBusy ? 'Installing…' : installState === 'stale' ? 'Update Install' : 'Install'}</button><button class="install-dismiss" on:click={dismissInstallOffer} title="Hide the install offer" aria-label="Dismiss install offer"><span class="install-dismiss-label">dismiss</span>✕</button></span>{/if}</footer>
</main>
