/**
 * Every word the launcher shows, declared once.
 *
 * The launcher used to spell its copy where it was drawn: a dialog's heading in the
 * markup, its subtitle a line below, a row's tooltip inside a `title` attribute, and the
 * status lines a function or two away in the script. Reading one dialog therefore meant
 * reading a third of what the launcher says, which is fine until you want to weigh the
 * whole deck against the copy rules in `agents.md`, or say the same things in another
 * language.
 *
 * So the words live here and nowhere else, and the components call them by name:
 *
 *     <h2>{copy.dialogs.gitSync.title}</h2>
 *
 * Four rules keep this file worth having:
 *
 * - One leaf is one string, or one function when the sentence has to carry data
 *   (`folderLabel(path)`), because a name in the middle of a sentence is exactly what a
 *   parameter is for. Nothing here reads launcher state, so any leaf can be read anywhere.
 * - Keys are named for where the words are read, never for what they happen to say now.
 *   `row.removeAria` survives a rewording. `deleteFromRemote` does not.
 * - `en` is a locale and `copy` is the locale this build ships. A language deployment is
 *   another object of the same shape, added to `locales` at the foot of this file and
 *   selected by `LOCALE`. Nothing else changes, since every component already reads
 *   `copy.*`.
 * - The copy rules in `agents.md` apply in here as much as anywhere: one short sentence,
 *   nothing restated, and no em dashes or en dashes. `scripts/check-launcher-copy.mjs`
 *   scans this file like every other launcher source.
 */

/**
 * What a row's mark claims about a Lith this browser holds and nothing else does.
 *
 * Declared above the deck rather than inside it because two leaves read the same words:
 * the mark's title (`row.browserOnly`), and the older of the two constants the storage
 * mode has always exported.
 */
const BROWSER_ONLY_TOOLTIP =
  'Browser storage only. This Lith is kept in this browser’s cache, and nothing here is written back to a file. ' +
  'That copy is intrinsically volatile. Clearing site data, or the browser reclaiming space, will lose it. ' +
  'Download your own hard copies from its version history.';

/**
 * Where installing puts the app, as the desktop app reports it.
 *
 * A token rather than a noun, because the noun is a translation: Rust knows the platform
 * and this file knows the language, and neither can spell the other's half. `platform`
 * sends this in its capability report, and `install.offer.desktop` turns it into the
 * sentence the offer shows.
 */
export type LaunchEntry = 'start-menu' | 'application-menu';

const en = {
  app: {
    /** The window title and the heading, which are the same words on purpose. */
    title: 'Lithic - Launcher',
    brandAlt: 'Lithic',
    githubLink: 'Lithic on GitHub',
    footerLink: 'Github',
    backToLauncher: 'Back to the main launcher',
    setInstanceIcon: 'Set this instance’s icon',
    viewIntro: 'View Introduction'
  },

  /**
   * The install offer, which has two homes (the panel's foot row and the footer band)
   * and so is written once and rendered in whichever one is in play.
   */
  install: {
    label: {
      installing: 'Installing…',
      install: 'Install App',
      /** The word before any status has been read, for a button that only installs. */
      plain: 'Install',
      updateAvailable: 'Update Available',
      updateInstall: 'Update Install'
    },
    /**
     * Why the button is worth pressing, per platform. `desktop` reads the platform's own
     * answer about where installing puts the app, because a Start Menu is not what Linux
     * calls it and a Mac installs by being dragged out of a disk image.
     */
    offer: {
      browser: 'Add the launcher to this device',
      update: 'Download the new version, then press Update Install',
      /**
       * The shim's notice, which has no step after it: this file cannot update itself, so
       * the reader fetches the new AppImage and replaces the old one by hand. The sentence
       * the desktop app uses cannot be borrowed here, since there is no Install to press.
       */
      notice: 'Get the newest version from the releases page',
      desktop: (entry: LaunchEntry | null): string =>
        entry === 'application-menu'
          ? 'Copy to Documents and add it to the application menu'
          : entry === 'start-menu'
            ? 'Copy to Documents and add a Start Menu shortcut'
            : 'Copy the app somewhere permanent'
    },
    dismissTitle: 'Hide the install offer',
    dismissAria: 'Dismiss install offer',
    dismissText: 'dismiss',
    /** A browser that will not show a prompt still has a menu item. */
    unavailable: 'Install is available from the browser menu.',
    openFailed: (detail: string) => `Could not open your browser: ${detail}`,
    /** Confirmation for copying a local-only Lith into the covered folder. */
    copyToSyncedDir: 'Copy to Synced Dir',
    copyToSyncedDirBody: (name: string, folder: string) => `${name} is not backed up. Copy it into ${folder}?`,
    copyConfirm: 'Copy',
    copied: (name: string, folder: string) => `Copied ${name} to ${folder}`,
    /** Kept beside `copied` and `installed` below so the two cannot drift. */
    installedPrefix: 'Installed to ',
    installed: (path: string) => `Installed to ${path}`,
    failed: (detail: string) => `Install failed: ${detail}`
  },

  pending: {
    aria: 'Pending imports',
    heading: 'Pending Imports',
    clear: 'Clear pending imports',
    untitled: 'Untitled Payload'
  },

  common: {
    cancel: 'Cancel',
    back: 'Back',
    open: 'Open',
    show: 'Show',
    pin: 'PIN',
    /** How a screen reader addresses one box of the PIN entry. */
    characterAria: (label: string, position: number, total: number) =>
      `${label}, character ${position} of ${total}`,
    choosePin: 'Choose a PIN',
    repeatPin: 'Repeat the PIN'
  },

  /**
   * Device sync: the panel, the pairing steps, and the sentences its events read as.
   *
   * Named for what the reader is doing rather than for what the engine calls it: no
   * `iroh`, no `doc`, no `entry` anywhere in here. A ticket is a ticket because that is
   * the word the panel shows, and the activity lines are the four things a person can
   * actually observe (a file arrived, a file left, a device came, a device went).
   */
  deviceSync: {
    title: 'Device Sync',
    openAria: 'Open device sync',
    closeAria: 'Close device sync',
    loading: 'Starting the sync engine…',
    /** Why this page cannot run the engine at all, one sentence per reason. */
    unavailable: {
      file: 'Device sync needs a page served by a web server. This launcher was opened from a file, so there is nothing for it to fetch its engine from.',
      'no-wasm': 'This browser cannot run the piece of Lithic that device sync is built on.',
      'no-crypto': 'This browser does not offer the randomness device sync needs.',
      engine: 'The sync engine could not be loaded here. Everything else works as usual, and your Liths stay on this device.'
    },
    /** The engine's own id for this device, shown shortened rather than in full. */
    nodeLabel: 'This device',
    folderCount: (count: number): string =>
      count === 1 ? 'One Lith in this folder' : `${count} Liths in this folder`,
    peers: (count: number): string =>
      count === 1 ? 'Paired with one device' : `Paired with ${count} devices`,
    activity: {
      idle: 'Nothing has synced yet.',
      update: (name: string): string => `Updated by another device: ${name}`,
      seeded: (name: string): string => `Added from this device: ${name}`,
      drift: (name: string): string => `Changed outside this device: ${name}`,
      peerUp: 'A device joined.',
      peerDown: 'A device left.',
      failed: (name: string, reason: string): string => `${name} did not sync: ${reason}`
    },
    ticketTitle: 'Your ticket',
    ticketShow: 'Show this device’s ticket',
    unpair: 'Unpair this device',
    unpairing: 'Unpairing…',
    paired: 'Paired',
    liveStatus: 'Device sync has a live connection to another device right now.',
    waitingStatus: 'Device sync is paired, but no other devices are online right now.',
    busyStatus: 'Device sync is exchanging changes with your other devices right now.',
    errorStatus: 'Device sync could not finish its last operation on this device.',
    idleStatus: 'Device sync has no active pairing on this device right now.',
    ticketBusy: 'Waiting for the network…',
    ticketBody: 'Paste this into the other device. Anyone who has it can write to this folder.',
    ticketHint: 'A ticket is how two devices find each other. No account, and no server of ours.',
    ticketCopy: 'Copy',
    ticketCopied: 'Copied',
    joinTitle: 'Pair another device',
    joinPlaceholder: 'Paste the ticket from the other device',
    join: 'Pair',
    joining: 'Pairing…',
    joinHint: 'Pairing brings that device’s Liths into this folder.',
    joinEmpty: 'That is not a ticket. Paste the whole text from the other device.',
    alreadyPaired: 'Unpair this device before joining another folder.',
    recentsHint: 'Every Lith in this folder is a row in your recent list, whether this device has it or not. A row without the device mark is one your devices do not have yet, and its mark is what sends it.',
    error: (detail: string): string => `Device sync hit a problem: ${detail}`
  },

  dialogs: {
    gitSync: {
      title: 'GitHub Sync',
      closeAria: 'Close GitHub sync dialog',
      folder: {
        label: 'Folder',
        none: 'No folder yet',
        choosing: 'Choosing…',
        change: 'Change',
        choose: 'Choose',
        changeTitle: 'Change the folder GitHub Sync backs up',
        chooseTitle: 'Choose the folder GitHub Sync backs up',
        changeAria: (folder: string) => `Change the folder GitHub Sync backs up: ${folder}`,
        chooseAria: 'Choose the folder GitHub Sync backs up',
        automatic: 'Use the automatic folder'
      },
      backedUp: (backedUp: number, tracked: number) => `${backedUp} of ${tracked} recent liths backed up`,
      noTarget: 'Save a Lith to disk first, since sync backs up its folder.',
      serverIntro: 'Back up this server to GitHub. Its saves push automatically.',
      serverNoAnswer: 'This instance did not answer about GitHub backups.',
      folderIntro: 'Back up this folder to GitHub. Saves push automatically.',
      working: 'Working…',
      stopping: 'Stopping…',
      stopSyncing: 'Stop syncing',
      connect: 'Connect to GitHub',
      tokenSummary: 'Advanced: connect with a personal access token',
      repoAria: 'GitHub repository (owner/name)',
      repoPlaceholder: 'owner/repository',
      tokenAria: 'GitHub token',
      tokenPlaceholder: 'Fine-grained or classic token with push access',
      connecting: 'Connecting…',
      connectPush: 'Connect & Push',
      /** The two steps of the device flow. The address between them is a link, not copy. */
      stepOne: '1. Open',
      stepTwo: '2. Enter this code (installs Lithic Sync on first use):',
      /** The code is a button: pressing it copies, which is what the hint and the label say. */
      codeCopyTitle: 'Copy the code to the clipboard',
      codeCopyAria: (code: string) => `Copy the code ${code} to the clipboard`,
      codeCopied: 'Code copied to the clipboard.',
      codeCopyFailed: 'Could not copy the code. Select it and copy it yourself.',
      waiting: 'Waiting for authorization…',
      requesting: 'Requesting a code from GitHub…',
      stopWaiting: 'Stop waiting',
      createAndSync: (name: string) => `+ Create ${name} and sync`,
      foundRepos: 'Found existing Lithic sync repos',
      otherReposSummary: 'Advanced: your other repositories',
      customRepoAria: 'Custom repository (owner/name)',
      customRepoPlaceholder: 'owner/name',
      syncing: 'Syncing…',
      startSync: 'Start Sync',
      connectedRepo: 'Connected repository',
      notRecorded: 'Not recorded',
      /** The repository name is a link to the repository on github.com. */
      openRepoTitle: (repo: string) => `Open github.com/${repo} in your browser`,
      openRepoAria: (repo: string) => `Open the repository github.com/${repo} in your browser`,
      lastSynced: (age: string) => `Last synced ${age} ago.`,
      noSyncYet: 'No sync yet.',
      savesHere: 'Saves in this folder push to GitHub automatically.',
      waitingForGitHub: 'Waiting for GitHub…',
      reconnect: 'Reconnect',
      disconnect: 'Disconnect',
      /** Progress stages, in the order a setup runs them. */
      starting: 'Starting…',
      creatingRepo: 'Creating the repository…',
      settingUp: 'Setting up the backup…',
      backingUp: (repo: string) => `Backing up github.com/${repo}.`,
      created: (repo: string) => `Created ${repo}. `,
      /** What a setup reports when the app itself has nothing more to say. */
      synced: 'Synced',
      /** The one stage a person can produce by pressing Stop, on the shim's job model. */
      cancelled: 'Sync stopped.',
      reconnected: (repo: string) => `Reconnected github.com/${repo}`,
      lastSaveFailed: (detail: string) => `Last save did not upload: ${detail}`,
      instanceNoDisconnect: 'The instance did not confirm the disconnect.',
      noFolder: 'Could not resolve the folder or repository to reconnect.',
      noDeviceCode: 'GitHub did not return a device code',
      disconnectConfirm: {
        server: 'Saves on this server stop syncing to GitHub.',
        desktop: 'Saves in this folder stop syncing to GitHub.',
        label: 'Disconnect'
      },
      disconnectTitle: 'Disconnect GitHub Sync?'
    },

    bookmark: {
      closeAria: 'Close bookmark dialog',
      title: 'Bookmark Remote Instance',
      intro: 'Save a self-hosted instance for quick access.',
      urlAria: 'Self-hosted instance URL',
      urlPlaceholder: 'https://...',
      save: 'Save Bookmark',
      manage: 'Manage Credentials',
      manageSaved: (count: number) => `Saved instance logins. ${count} saved.`,
      manageEmpty: 'Saved instance logins. None saved yet.',
      unverifiedTitle: 'Bookmark this instance?',
      unverifiedBody: 'Lithic could not verify this address.',
      unverifiedConfirm: 'Bookmark Anyway',
      unreachable: 'Could not reach this address.',
      notInstance: 'That address is not a Lithic instance.',
      saved: 'Self-hosted instance bookmarked'
    },

    unlock: {
      closeAria: 'Close unlock dialog',
      title: (label: string) => `Open ${label}`,
      sub: 'Saved login. Please enter your PIN.'
    },

    credential: {
      closeAria: 'Close the save-a-login dialog',
      title: 'Add a saved credential?',
      forInstance: (label: string) => `For ${label}.`,
      username: 'Username',
      password: 'Password',
      saving: 'Saving…',
      save: 'Save Credential',
      openWithoutSaving: 'Open without saving',
      notSaved: 'Not saved: this instance refuses that login.',
      notOpened: 'Not opened: this instance refuses that login.',
      checking: 'Asking the instance…'
    },

    vault: {
      closeAria: 'Close saved logins dialog',
      title: 'Saved Instance Logins',
      empty: 'Nothing saved yet.',
      forgetAll: 'Forget Everything',
      intro: 'Self-host instance credentials are listed here once saved.',
      pinPrompt: 'Enter your PIN to read these logins.',
      count: (saved: number) => (saved === 1 ? '1 login saved.' : `${saved} logins saved.`),
      checkAria: (origin: string) => `Check the login for ${origin} against the instance`,
      checkTitle: 'Ask this instance whether the saved login still works',
      forgetAria: (origin: string) => `Forget the login for ${origin}`,
      forgetTitle: 'Forget this login',
      storedIn: 'Stored in',
      forgot: (origin: string) => `Forgot the login for ${origin}.`,
      forgetAllTitle: 'Forget every saved login?',
      forgetAllBody:
        'The vault file is deleted, and the PIN with it. The next login you save chooses a new PIN. ' +
        'Until then, instances will ask for a password.',
      everyLoginGone: 'Every saved login is gone.'
    },

    collision: {
      closeAria: 'Close the active-session dialog',
      title: 'Active Session Detected',
      someone: 'Someone else',
      /** The open Lith's name is bold between these two halves, so the sentence is split. */
      hasOpenBefore: 'has',
      hasOpenAfter: 'open on this server. Last writer wins.',
      note: 'Open read-only, or ignore the lock.',
      openReadOnly: 'Open Read-Only',
      ignoreLock: 'Ignore Lock and Open'
    },

    icon: {
      closeAria: 'Close icon picker',
      title: 'Instance Icon',
      intro: 'This icon belongs to the instance. Everyone who opens this address sees it.',
      chooseAria: 'Choose an instance icon',
      saving: 'Saving…',
      savingProgress: (saved: number, total: number) => `Saving… (${saved} of ${total})`,
      savedInstance: (name: string) => `✓ Saved. This instance now uses ${name}.`,
      save: 'Save Icon',
      restoreTitle: 'Use the shipped Lithic icon',
      restore: 'Restore Default',
      savedHere: (detail: string) => `Saved on this device only. The server write failed (${detail}).`,
      canvasFailed: 'Could not render the icon (no canvas).',
      savedServer: '✓ Default icon restored server-wide.',
      restoredHere: 'Restored on this device only.'
    },

    rebuild: {
      titleServer: 'Not on this server',
      titleDisk: 'Not found on disk',
      bodyServer: (count: number) =>
        `${count} cached ${count === 1 ? 'copy is' : 'copies are'} missing from the server, ` +
        `so rebuilding deletes ${count === 1 ? 'it' : 'them'} from this device.`,
      bodyDisk: (count: number) =>
        `${count} ${count === 1 ? 'lith has' : 'liths have'} no file on disk, ` +
        `so rebuilding deletes ${count === 1 ? 'its' : 'their'} cached copies and history.`,
      unsavedWarning: (count: number) =>
        `${count} of them have unsaved edits, which no download can recover.`,
      noFile: 'No file on disk',
      cachedOnly: 'cached only',
      unsavedTag: 'unsaved edits',
      unsavedCaptured: (when: string) => `Unsaved edits captured ${when}`,
      proceed: 'Proceed Anyway'
    },

    history: {
      closeAria: 'Close history trail dialog',
      title: (name: string) => `${name} History Trail`,
      backupGroupAria: 'Back up this Lith',
      localOnly: (folder: string) => `Not backed up. Copy it into ${folder} to have it synced.`,
      copy: 'Copy',
      loading: 'Loading versions…',
      none: 'No versions saved yet.',
      badgeSync: 'sync',
      badgeSyncTitle: 'Saved after a change outside this device.',
      badgeFull: 'full',
      badgeFullTitle: 'Complete copy from this save.',
      badgeStep: 'step',
      badgeStepTitle: 'Edits since the previous save.',
      downloadAria: (when: string) => `Download a copy of the version from ${when}`,
      /**
       * The grey distance the trail draws between two versions, as the newer row's own
       * sentence. `count` arrives as this locale already writes a number, so only the unit
       * word and its plural live here.
       */
      later: {
        seconds: (count: string) => `${count} second${count === '1' ? '' : 's'} later`,
        minutes: (count: string) => `${count} minute${count === '1' ? '' : 's'} later`,
        hours: (count: string) => `${count} hour${count === '1' ? '' : 's'} later`,
        days: (count: string) => `${count} day${count === '1' ? '' : 's'} later`
      },
      note: 'Reverting is manual. Download a version, then replace the wiki with it.'
    },

    dirty: {
      title: 'Unsaved edits found',
      body: (name: string, edits: number, when: string) =>
        `${name} has ${edits} edit${edits === 1 ? '' : 's'} never saved to disk, captured ${when}.`,
      more: (count: number) => `… and ${count} more`,
      recover: 'Recover edits',
      later: 'Decide later',
      discard: 'Discard'
    }
  },

  actions: {
    aria: 'Launcher actions',
    newBlank: 'New Blank Lith',
    upload: 'Upload a Lith',
    mount: 'Mount a Lith',
    bookmarkAria: 'Bookmark a self-hosted instance',
    bookmarkTitle: 'Bookmark a Remote Instance'
  },

  newLith: {
    placeholder: 'Enter a title',
    nameAria: 'Lith file name',
    taken: 'Name already in use',
    takenError: 'Name already in use.',
    create: 'Create lith',
    closeAria: 'Close new lith entry'
  },

  offline: {
    /** The banner a cached self-host launcher wears when the instance cannot be reached. */
    title: 'Server unreachable',
    body: 'Showing this device’s saved copies. Liths open read-only.',
    rowMarkTitle: 'Only on this device while offline.',
    rowOpenTitle: 'Open this device’s copy read-only'
  },

  recent: {
    aria: 'Recent Liths',
    searchAria: 'Search recent Liths',
    searchPlaceholder: 'Search recent liths…',
    clearSearch: 'Clear recent Lith search',
    readingServer: 'Reading this server’s Liths…',
    empty: {
      noMatch: 'No matching Liths.',
      instanceHere: 'No Liths from this instance on this device yet.',
      server: 'No Liths on this server yet.',
      recents: 'No recent Liths.'
    }
  },

  row: {
    downloadAria: (name: string) => `Download a copy of ${name}`,
    downloadTitle: 'Download a copy',
    historyAria: (name: string) => `Show version history for ${name}`,
    olderVersions: 'Older versions',
    showHistory: 'Show version history',
    noHistory: 'No cached history',
    unsavedAria: (name: string) => `${name} has unsaved edits; open to recover`,
    unsavedFrom: (when: string) => `Unsaved edits from ${when}`,
    localOnlyAria: (name: string) => `Open history and backup options for ${name}`,
    localOnlyTitle: 'Not in a backed-up folder. Open for the copy offer.',
    openFromServer: 'Open from this server',
    deleteFromServerAria: (name: string) => `Delete ${name} from this server`,
    deleteFromServerTitle: 'Delete from remote storage',
    openUrl: (url: string) => `Open ${url}`,
    noAddressAria: (url: string) => `No address to save a login for on ${url}`,
    noAddress: 'No address to save a login for',
    vaultSaved: (origin: string) => `A login is saved for ${origin}. Manage it.`,
    vaultSave: (origin: string) => `Save a login for ${origin} so it stops asking`,
    openSearchingAria: (label: string, query: string) => `Open ${label} searching for “${query}”`,
    openSearchingTitle: (label: string) => `Open ${label} and search for this`,
    removeBookmarkAria: (url: string) => `Remove bookmark ${url}`,
    // A search into an instance reads a bounded amount of its cache, and an instance
    // bigger than that would otherwise answer with a silently shorter list.
    instanceTruncated: 'Only the newest Liths here were searched',
    pinAria: (name: string, title: string) => `Open ${name} and pin “${title}” to top`,
    openAria: (name: string) => `Open ${name}`,
    pinTitle: 'Open and pin this tiddler',
    removeAria: (name: string) => `Remove ${name}`,
    cachedLocally: 'Cached locally',
    /** The device-sync mark: one control per row, which sends or says it is already there. */
    deviceUnsyncedTitle: 'Not on your devices yet. Open to send this Lith.',
    deviceUnsyncedAria: (name: string) => `Open history and send ${name} to your devices`,
    deviceSendTitle: 'Send to your devices',
    deviceSendAria: (name: string) => `Send ${name} to your devices`,
    deviceSharedTitle: 'On your devices. Sending this copy makes a new version of it.',
    deviceSharedAria: (name: string) => `${name} is on your devices. Send this copy as a new version.`,
    /** The row for a Lith only the devices have: a copy to load, and no local file to open. */
    deviceOnlyLabel: 'On your devices',
    deviceOnlyAria: (name: string) => `${name} is on your devices but not on this device.`,
    deviceLoad: 'Load',
    deviceLoading: 'Fetching…',
    deviceLoadAria: (name: string) => `Load ${name} from your devices`,
    /** What a row's own mark claims about a Lith this browser holds and nothing else does. */
    browserOnly: (name: string) => `${name}. ${BROWSER_ONLY_TOOLTIP}`,
    browserOnlyClaim: BROWSER_ONLY_TOOLTIP,
    browserOnlyNote:
      'Browser storage only. This Lith has no file, so what this browser holds is the only copy there is. ' +
      'Download a version to keep one you can mount again.'
  },

  foot: {
    rebuild: 'Rebuild Recents',
    reindexing: 'Re-indexing…',
    rebuildServerTitle: 'Read this server again and index its Liths here',
    rebuildDiskTitle: 'Rebuild this list from the files on disk',
    reset: 'Reset Recents',
    resetTitle: 'Clears this list and its local history. Your files stay.',
    rebuildDeviceTitle: 'Rebuild this list and its search history from your paired devices'
  },

  /** One line per row state, from the download of an orphaned cached copy. */
  orphan: {
    saving: { label: 'saving…', title: 'Saving a copy now.' },
    saved: { label: '✓ saved', title: 'The copy is on this device.' },
    unverified: {
      label: '✓ check downloads',
      title: 'The browser cannot confirm downloads. Check your Downloads folder.'
    },
    failed: { label: 'failed', title: 'This copy could not be saved.' },
    noteOneSaved: 'Saved. Safe to proceed.',
    noteOneUnconfirmed: 'Saved, but unconfirmed.',
    noteAllSaved: (total: number) => `All ${total} saved. Safe to proceed.`,
    noteAllUnconfirmed: (total: number, unconfirmed: number) =>
      `All ${total} saved, but ${unconfirmed} unconfirmed.`,
    notePartial: (done: number, total: number) => `${done} of ${total} saved.`
  },

  /** What the header's sync icon says, and the states behind it. */
  sync: {
    syncing: 'GitHub Sync: syncing…',
    checking: 'GitHub Sync: checking…',
    verifying: 'GitHub Sync: verifying the connection…',
    lastSaveFailed: (detail: string) => `GitHub Sync: the last save did not upload (${detail})`,
    failure: (detail: string) => `GitHub Sync: ${detail}`,
    connected: (target: string, age: string | null) =>
      `GitHub Sync: ${target}${age ? `, verified ${age} ago` : ''}`,
    connectedLabel: 'connected',
    serverFailed: 'GitHub Sync: this instance did not answer',
    serverSyncing: (target: string) => `GitHub Sync: syncing to ${target}…`,
    serverConnected: (target: string, age: string | null) =>
      `GitHub Sync: ${target}${age ? `, last synced ${age} ago` : ''}`,
    /** Why a verdict reads as a broken backup, in the icon and in the dialog alike. */
    readonly: 'this token can only read the repository. Reconnect to allow pushes.',
    auth: 'GitHub rejected this token. Reconnect to sign in again.',
    missing: 'the repository is missing or not shared with this token.',
    throttled: 'GitHub is rate-limiting this device. Saves stay local for now.',
    offline: 'cannot reach github.com. Saves stay on this device.',
    malformed: "this folder's saved remote is unreadable. Reconnect to repair it.",
    /** A save that reached the page but never got an answer from the backend behind it. */
    backendSilent: 'the sync backend did not answer'
  },

  /** Labels for asking an instance whether a stored login still works. */
  loginCheck: {
    busy: 'Checking…',
    accepted: 'Signs in',
    refused: 'Refused',
    notRequired: 'Not asked',
    unclear: 'Unclear',
    unreachable: 'No answer'
  },

  /** The one line the × on a bookmarked instance adds when the copy would not drop. */
  instanceCopy: {
    failed: (label: string) => `Could not clear the cached copy of ${label}`
  },

  /** Refusals from the bookmark address field, raised while the address is typed. */
  bookmarkErrors: {
    needUrl: 'Enter a self-hosted Lithic instance URL.',
    needHttp: 'Use an HTTP or HTTPS instance URL.'
  },

  /** What the GitHub device flow reports when it will not produce one. */
  deviceFlow: {
    unexpected: 'Unexpected response from GitHub',
    denied: 'Authorization denied on GitHub.',
    expired: 'That code expired. Start again for a new one.',
    failed: 'Authorization failed or expired. Generate a new code.'
  },

  /** Progress and progress failures from the server-side sync setup. */
  serverSync: {
    noCode: 'GitHub did not answer with a code.',
    unreachableForCode: 'Could not reach this server for a code.',
    noRepos: 'Could not list your repositories.',
    noCreate: 'Could not create the repository.',
    unreachableForSetup: 'Could not reach this server to set the backup up.',
    setupFailed: 'Setup failed.',
    setupFailedDetail: (detail: string) => `Setup failed: ${detail}`
  },

  /** Everything the launcher says in passing: a status line, a failure, a count. */
  status: {
    opening: 'Opening…',
    openingRecent: 'Opening recent Lith…',
    loadingBlank: 'Loading blank Lith…',
    openFailed: (detail: string) => `Open failed: ${detail}`,
    mounted: (name: string) => `Mounted ${name}`,
    mountedReadOnly: (name: string) => `Mounted ${name} read-only`,
    mountedPatched: (name: string) => `Mounted ${name}. Saves send only the changes.`,
    noPath: 'No file path recorded. Open it once via Mount to re-link it.',
    added: (count: number) => `Added ${count} Liths to Recents`,
    uploading: (names: readonly string[]) =>
      names.length === 1 ? `Uploading ${names[0]}…` : `Uploading ${names.length} Liths…`,
    uploaded: (count: number) => `Uploaded ${count} Liths`,
    uploadFailed: (detail: string) => `Could not upload: ${detail}`,
    replaceOne: 'Replace this Lith?',
    replaceMany: 'Replace these Liths?',
    replaceBodyOne: (name: string) => `${name} is already on this server. Uploading replaces it.`,
    replaceBodyMany: (names: string) => `${names} are already on this server. Uploading replaces them.`,
    replaceConfirm: 'Replace',
    listingFailed: (detail: string) => `Could not list this server’s Liths (${detail}).`,
    openingName: (name: string) => `Opening ${name}…`,
    openNameFailed: (name: string, detail: string) => `Could not open ${name}: ${detail}`,
    creating: (name: string) => `Creating ${name}…`,
    createFailed: (name: string, detail: string) => `Could not create ${name}: ${detail}`,
    deleteTitle: 'Delete this Lith?',
    deleteConfirm: 'Delete',
    deleting: (name: string) => `Deleting ${name}…`,
    deleteFailed: (name: string, detail: string) => `Could not delete ${name}: ${detail}`,
    deleteBody: (name: string) => `${name} is deleted from the server, not just this device.`,
    recovering: (edits: number, name: string) =>
      `Recovering ${edits} unsaved edit${edits === 1 ? '' : 's'} for ${name}`,
    editsKept: 'Unsaved edits kept for later',
    recovered: (name: string) => `Recovered ${name}`,
    savedFile: (name: string) => `Saved ${name}`,
    downloadingFile: (name: string) => `Downloading ${name}`,
    downloadFailed: (detail: string) => `Download failed: ${detail}`,
    noCachedCopy: (name: string) => `No cached copy of ${name} to download`,
    deviceSent: (name: string) => `Sent ${name} to your devices`,
    deviceSendFailed: (detail: string) => `Could not send that Lith: ${detail}`,
    deviceHistoryFailed: (detail: string) => `Could not save the received version: ${detail}`,
    deviceLoaded: (name: string) => `Loaded ${name} from your devices`,
    deviceLoadFailed: (detail: string) => `Could not load that Lith: ${detail}`,
    reindexing: 'Re-indexing recent liths…',
    reindexed: (count: number) => `Re-indexed ${count} lith${count === 1 ? '' : 's'}`,
    indexedHere: (count: number) => `Indexed ${count} lith${count === 1 ? '' : 's'} for search here`,
    nothingToIndex: 'Nothing new to index',
    reindexFailed: (detail: string) => `Re-index failed: ${detail}`,
    rebuildCancelled: 'Rebuild cancelled',
    // Indexing reports itself as one line per Lith, since reading a store is slow enough
    // that a person watches it happen.
    indexingLabel: 'Indexing',
    reindexingLabel: 'Re-indexing',
    indexProgress: (label: string, position: number, total: number, name: string) =>
      `${label} ${position} of ${total} · ${name}`,
    scratchSaveFailed: 'Scratch serialization failed; file left unchanged.',
    monolithSaveFailed: 'Page serialization failed; the stored copy is unchanged.',
    noHistory: 'No versioned history is available for this wiki yet.',
    noHistoryVersion: 'That version could not be materialized from the history chain.',
    introFailed: 'Could not load the introduction.',
    droppedInvalid: 'Dropped file is not valid data format.',
    payloadFailed: 'Unable to load the shared payload',
    blankLithFailed: 'Unable to load the local wiki',
    engineUnavailable: (status: string) => `Unable to load the wiki engine (${status})`,
    engineMissing: 'Could not load the Lithic engine locally, from the offline cache, or online.'
  },

  /** Names the OS file picker shows for each kind of document this app opens or saves. */
  fileTypes: {
    monolith: 'Lithic Monolith',
    html: 'Lithic HTML File',
    htmlMany: 'Lithic HTML Files',
    json: 'Lithic JSON Backups',
    text: 'Editable text files',
    notebook: 'Jupyter Notebooks',
    /** The picker that offers a notebook beside a monolith says it in the singular. */
    notebookOne: 'Jupyter Notebook'
  }
};

/**
 * The shape of a locale, so a translation's completeness is a compile error.
 *
 * `const es: Copy = {...}` is the whole test a new language gets: the compiler names
evry leaf that is missing, and nothing about the launcher changes to accept it.
 */
export type Copy = typeof en;

/**
 * What a row's mark claims about a Lith this browser holds and nothing else does, in
 * Spanish. Separate from the deck below because two leaves read the same words.
 */
const BROWSER_ONLY_TOOLTIP_ES =
  'Solo almacenamiento del navegador. Este Lith se guarda en la caché de este navegador y nada se escribe de vuelta a un archivo. ' +
  'Esa copia es intrínsecamente volátil. Borrar los datos del sitio, o que el navegador reclame espacio, la perderá. ' +
  'Descarga tus propias copias desde su historial de versiones.';

/**
 * Spanish.
 *
 * A translation, not a transliteration: the sentences are the same claims, phrased as
 * Spanish would put them. Three things deliberately do NOT move. `Lith` and `PIN` are the
 * product's own words. Anything the reader acts on keeps its literal spelling (`github.com`,
 * `owner/repository`, `.lith`, `Lithic Sync`), because a translated button that opens a real
 * page has to name it. And the copy rules still hold here: one short sentence, nothing
 * restated, no em dashes or en dashes.
 */
const es: Copy = {
  app: {
    title: 'Lithic - Lanzador',
    brandAlt: 'Lithic',
    githubLink: 'Lithic en GitHub',
    footerLink: 'Github',
    backToLauncher: 'Volver al lanzador principal',
    setInstanceIcon: 'Elegir el icono de esta instancia',
    viewIntro: 'Ver la introducción'
  },

  install: {
    label: {
      installing: 'Instalando…',
      install: 'Instalar app',
      plain: 'Instalar',
      updateAvailable: 'Actualización disponible',
      updateInstall: 'Instalar actualización'
    },
    offer: {
      browser: 'Añade el lanzador a este dispositivo',
      update: 'Descarga la nueva versión y pulsa Instalar actualización',
      notice: 'Consigue la versión más reciente en la página de versiones',
      desktop: (entry: LaunchEntry | null): string =>
        entry === 'application-menu'
          ? 'Copia a Documentos y añádelo al menú de aplicaciones'
          : entry === 'start-menu'
            ? 'Copia a Documentos y crea un acceso en el menú Inicio'
            : 'Copia la app en un sitio permanente'
    },
    dismissTitle: 'Ocultar la oferta de instalación',
    dismissAria: 'Descartar la oferta de instalación',
    dismissText: 'cerrar',
    unavailable: 'La instalación está en el menú del navegador.',
    openFailed: (detail: string) => `No se pudo abrir tu navegador: ${detail}`,
    copyToSyncedDir: 'Copiar a la carpeta sincronizada',
    copyToSyncedDirBody: (name: string, folder: string) => `${name} no está respaldado. ¿Copiarlo a ${folder}?`,
    copyConfirm: 'Copiar',
    copied: (name: string, folder: string) => `${name} copiado a ${folder}`,
    installedPrefix: 'Instalado en ',
    installed: (path: string) => `Instalado en ${path}`,
    failed: (detail: string) => `Falló la instalación: ${detail}`
  },

  pending: {
    aria: 'Importaciones pendientes',
    heading: 'Importaciones pendientes',
    clear: 'Borrar las importaciones pendientes',
    untitled: 'Contenido sin título'
  },

  common: {
    cancel: 'Cancelar',
    back: 'Atrás',
    open: 'Abrir',
    show: 'Mostrar',
    pin: 'PIN',
    characterAria: (label: string, position: number, total: number) =>
      `${label}, carácter ${position} de ${total}`,
    choosePin: 'Elige un PIN',
    repeatPin: 'Repite el PIN'
  },

  /**
   * La sincronización de dispositivos: el panel, los pasos de emparejamiento y lo que
   * dicen sus eventos.
   */
  deviceSync: {
    title: 'Sincronización de dispositivos',
    openAria: 'Abrir la sincronización de dispositivos',
    closeAria: 'Cerrar la sincronización de dispositivos',
    loading: 'Iniciando el motor de sincronización…',
    unavailable: {
      file: 'La sincronización de dispositivos necesita una página servida por un servidor web. Este launcher se abrió desde un archivo, así que no hay de dónde descargar su motor.',
      'no-wasm': 'Este navegador no puede ejecutar la parte de Lithic sobre la que se construye la sincronización de dispositivos.',
      'no-crypto': 'Este navegador no ofrece la aleatoriedad que la sincronización de dispositivos necesita.',
      engine: 'El motor de sincronización no se pudo cargar aquí. Todo lo demás funciona igual, y tus Liths se quedan en este dispositivo.'
    },
    nodeLabel: 'Este dispositivo',
    folderCount: (count: number): string =>
      count === 1 ? 'Un Lith en esta carpeta' : `${count} Liths en esta carpeta`,
    peers: (count: number): string =>
      count === 1 ? 'Emparejado con un dispositivo' : `Emparejado con ${count} dispositivos`,
    activity: {
      idle: 'Todavía no se ha sincronizado nada.',
      update: (name: string): string => `Actualizado por otro dispositivo: ${name}`,
      seeded: (name: string): string => `Añadido desde este dispositivo: ${name}`,
      drift: (name: string): string => `Cambiado fuera de este dispositivo: ${name}`,
      peerUp: 'Se ha unido un dispositivo.',
      peerDown: 'Se ha ido un dispositivo.',
      failed: (name: string, reason: string): string => `${name} no se sincronizó: ${reason}`
    },
    ticketTitle: 'Tu ticket',
    ticketShow: 'Mostrar el ticket de este dispositivo',
    unpair: 'Desemparejar este dispositivo',
    unpairing: 'Desemparejando…',
    paired: 'Emparejado',
    liveStatus: 'La sincronización está conectada con otro dispositivo ahora mismo.',
    waitingStatus: 'La sincronización está emparejada, pero no hay otros dispositivos conectados.',
    busyStatus: 'La sincronización está intercambiando cambios con tus otros dispositivos.',
    errorStatus: 'La sincronización no pudo completar la última operación en este dispositivo.',
    idleStatus: 'Este dispositivo no tiene un emparejamiento activo ahora mismo.',
    ticketBusy: 'Esperando a la red…',
    ticketBody: 'Pégalo en el otro dispositivo. Quien lo tenga puede escribir en esta carpeta.',
    ticketHint: 'Un ticket es como dos dispositivos se encuentran. Sin cuenta y sin servidor nuestro.',
    ticketCopy: 'Copiar',
    ticketCopied: 'Copiado',
    joinTitle: 'Emparejar otro dispositivo',
    joinPlaceholder: 'Pega el ticket del otro dispositivo',
    join: 'Emparejar',
    joining: 'Emparejando…',
    joinHint: 'Emparejar trae los Liths de ese dispositivo a esta carpeta.',
    joinEmpty: 'Eso no es un ticket. Pega el texto completo del otro dispositivo.',
    alreadyPaired: 'Desempareja este dispositivo antes de unirte a otra carpeta.',
    recentsHint: 'Cada Lith de esta carpeta es una fila en tu lista de recientes, tenga este dispositivo una copia o no. Una fila sin la marca de dispositivos es una que tus dispositivos aún no tienen, y su marca es la que la envía.',
    error: (detail: string): string => `La sincronización de dispositivos falló: ${detail}`
  },

  dialogs: {
    gitSync: {
      title: 'GitHub Sync',
      closeAria: 'Cerrar el diálogo de GitHub Sync',
      folder: {
        label: 'Carpeta',
        none: 'Sin carpeta todavía',
        choosing: 'Eligiendo…',
        change: 'Cambiar',
        choose: 'Elegir',
        changeTitle: 'Cambiar la carpeta que respalda GitHub Sync',
        chooseTitle: 'Elegir la carpeta que respalda GitHub Sync',
        changeAria: (folder: string) => `Cambiar la carpeta que respalda GitHub Sync: ${folder}`,
        chooseAria: 'Elegir la carpeta que respalda GitHub Sync',
        automatic: 'Usar la carpeta automática'
      },
      backedUp: (backedUp: number, tracked: number) => `${backedUp} de ${tracked} liths recientes con copia`,
      noTarget: 'Guarda un Lith en disco primero, porque la sincronización respalda su carpeta.',
      serverIntro: 'Respalda este servidor en GitHub. Sus guardados se suben solos.',
      serverNoAnswer: 'Esta instancia no respondió sobre las copias en GitHub.',
      folderIntro: 'Respalda esta carpeta en GitHub. Los guardados se suben solos.',
      working: 'Trabajando…',
      stopping: 'Deteniendo…',
      stopSyncing: 'Detener la sincronización',
      connect: 'Conectar con GitHub',
      tokenSummary: 'Avanzado: conectar con un token de acceso personal',
      repoAria: 'Repositorio de GitHub (propietario/nombre)',
      repoPlaceholder: 'propietario/repositorio',
      tokenAria: 'Token de GitHub',
      tokenPlaceholder: 'Token clásico o de grano fino con permiso de escritura',
      connecting: 'Conectando…',
      connectPush: 'Conectar y subir',
      stepOne: '1. Abre',
      stepTwo: '2. Introduce este código (instala Lithic Sync la primera vez):',
      /** The code is a button: pressing it copies, which is what the hint and the label say. */
      codeCopyTitle: 'Copiar el código al portapapeles',
      codeCopyAria: (code: string) => `Copiar el código ${code} al portapapeles`,
      codeCopied: 'Código copiado al portapapeles.',
      codeCopyFailed: 'No se pudo copiar el código. Selecciónalo y cópialo tú.',
      waiting: 'Esperando la autorización…',
      requesting: 'Pidiendo un código a GitHub…',
      stopWaiting: 'Dejar de esperar',
      createAndSync: (name: string) => `+ Crear ${name} y sincronizar`,
      foundRepos: 'Repositorios de sincronización de Lithic encontrados',
      otherReposSummary: 'Avanzado: tus otros repositorios',
      customRepoAria: 'Repositorio propio (propietario/nombre)',
      customRepoPlaceholder: 'propietario/nombre',
      syncing: 'Sincronizando…',
      startSync: 'Empezar a sincronizar',
      connectedRepo: 'Repositorio conectado',
      notRecorded: 'Sin registrar',
      /** The repository name is a link to the repository on github.com. */
      openRepoTitle: (repo: string) => `Abrir github.com/${repo} en el navegador`,
      openRepoAria: (repo: string) => `Abrir el repositorio github.com/${repo} en el navegador`,
      lastSynced: (age: string) => `Última sincronización hace ${age}.`,
      noSyncYet: 'Todavía sin sincronizar.',
      savesHere: 'Los guardados de esta carpeta se suben a GitHub solos.',
      waitingForGitHub: 'Esperando a GitHub…',
      reconnect: 'Reconectar',
      disconnect: 'Desconectar',
      starting: 'Empezando…',
      creatingRepo: 'Creando el repositorio…',
      settingUp: 'Preparando la copia de seguridad…',
      backingUp: (repo: string) => `Respaldando github.com/${repo}.`,
      created: (repo: string) => `Creado ${repo}. `,
      synced: 'Sincronizado',
      cancelled: 'Sincronización detenida.',
      reconnected: (repo: string) => `Reconectado github.com/${repo}`,
      lastSaveFailed: (detail: string) => `El último guardado no se subió: ${detail}`,
      instanceNoDisconnect: 'La instancia no confirmó la desconexión.',
      noFolder: 'No se pudo resolver la carpeta o el repositorio para reconectar.',
      noDeviceCode: 'GitHub no devolvió un código de dispositivo',
      disconnectConfirm: {
        server: 'Los guardados de este servidor dejan de subirse a GitHub.',
        desktop: 'Los guardados de esta carpeta dejan de subirse a GitHub.',
        label: 'Desconectar'
      },
      disconnectTitle: '¿Desconectar GitHub Sync?'
    },

    bookmark: {
      closeAria: 'Cerrar el diálogo de marcadores',
      title: 'Marcar una instancia remota',
      intro: 'Guarda una instancia autoalojada para abrirla rápido.',
      urlAria: 'URL de la instancia autoalojada',
      urlPlaceholder: 'https://...',
      save: 'Guardar marcador',
      manage: 'Gestionar accesos',
      manageSaved: (count: number) => `Accesos de instancias guardados. ${count} en total.`,
      manageEmpty: 'Accesos de instancias guardados. Ninguno todavía.',
      unverifiedTitle: '¿Marcar esta instancia?',
      unverifiedBody: 'Lithic no pudo verificar esta dirección.',
      unverifiedConfirm: 'Marcar igualmente',
      unreachable: 'No se pudo alcanzar esta dirección.',
      notInstance: 'Esa dirección no es una instancia de Lithic.',
      saved: 'Instancia autoalojada marcada'
    },

    unlock: {
      closeAria: 'Cerrar el diálogo de desbloqueo',
      title: (label: string) => `Abrir ${label}`,
      sub: 'Acceso guardado. Introduce tu PIN.'
    },

    credential: {
      closeAria: 'Cerrar el diálogo de guardar acceso',
      title: '¿Guardar este acceso?',
      forInstance: (label: string) => `Para ${label}.`,
      username: 'Usuario',
      password: 'Contraseña',
      saving: 'Guardando…',
      save: 'Guardar acceso',
      openWithoutSaving: 'Abrir sin guardar',
      notSaved: 'Sin guardar: la instancia rechaza este acceso.',
      notOpened: 'Sin abrir: la instancia rechaza este acceso.',
      checking: 'Preguntando a la instancia…'
    },

    vault: {
      closeAria: 'Cerrar el diálogo de accesos guardados',
      title: 'Accesos de instancias',
      empty: 'Nada guardado todavía.',
      forgetAll: 'Olvidar todo',
      intro: 'Los accesos de instancias autoalojadas aparecen aquí al guardarse.',
      pinPrompt: 'Introduce tu PIN para leer estos accesos.',
      count: (saved: number) => (saved === 1 ? '1 acceso guardado.' : `${saved} accesos guardados.`),
      checkAria: (origin: string) => `Comprobar el acceso de ${origin} contra la instancia`,
      checkTitle: 'Preguntar a esta instancia si el acceso guardado sigue sirviendo',
      forgetAria: (origin: string) => `Olvidar el acceso de ${origin}`,
      forgetTitle: 'Olvidar este acceso',
      storedIn: 'Guardado en',
      forgot: (origin: string) => `Acceso de ${origin} olvidado.`,
      forgetAllTitle: '¿Olvidar todos los accesos guardados?',
      forgetAllBody:
        'Se borra el archivo de accesos y el PIN con él. El próximo acceso que guardes elegirá un PIN nuevo. ' +
        'Hasta entonces, las instancias pedirán la contraseña.',
      everyLoginGone: 'Todos los accesos guardados se han borrado.'
    },

    collision: {
      closeAria: 'Cerrar el diálogo de sesión activa',
      title: 'Sesión activa detectada',
      someone: 'Otra persona',
      hasOpenBefore: 'tiene',
      hasOpenAfter: 'abierto en este servidor. Gana el último que escribe.',
      note: 'Abrir en solo lectura, o ignorar el bloqueo.',
      openReadOnly: 'Abrir en solo lectura',
      ignoreLock: 'Ignorar el bloqueo y abrir'
    },

    icon: {
      closeAria: 'Cerrar el selector de iconos',
      title: 'Icono de la instancia',
      intro: 'Este icono es de la instancia. Todo el que abra esta dirección lo ve.',
      chooseAria: 'Elegir un icono de instancia',
      saving: 'Guardando…',
      savingProgress: (saved: number, total: number) => `Guardando… (${saved} de ${total})`,
      savedInstance: (name: string) => `✓ Guardado. Esta instancia usa ${name}.`,
      save: 'Guardar icono',
      restoreTitle: 'Usar el icono de Lithic incluido',
      restore: 'Restaurar el original',
      savedHere: (detail: string) => `Guardado solo en este dispositivo. La escritura en el servidor falló (${detail}).`,
      canvasFailed: 'No se pudo dibujar el icono (sin canvas).',
      savedServer: '✓ Icono original restaurado en todo el servidor.',
      restoredHere: 'Restaurado solo en este dispositivo.'
    },

    rebuild: {
      titleServer: 'No está en este servidor',
      titleDisk: 'No se encuentra en el disco',
      bodyServer: (count: number) =>
        `${count} ${count === 1 ? 'copia guardada falta' : 'copias guardadas faltan'} del servidor, ` +
        `así que reconstruir ${count === 1 ? 'la borra' : 'las borra'} de este dispositivo.`,
      bodyDisk: (count: number) =>
        `${count} ${count === 1 ? 'lith no tiene' : 'liths no tienen'} archivo en disco, ` +
        `así que reconstruir ${count === 1 ? 'borra su copia guardada' : 'borra sus copias guardadas'} y su historial.`,
      unsavedWarning: (count: number) =>
        `${count} de ellos tienen ediciones sin guardar, que ninguna descarga puede recuperar.`,
      noFile: 'Sin archivo en disco',
      cachedOnly: 'solo en caché',
      unsavedTag: 'ediciones sin guardar',
      unsavedCaptured: (when: string) => `Ediciones sin guardar capturadas el ${when}`,
      proceed: 'Continuar igualmente'
    },

    history: {
      closeAria: 'Cerrar el sendero del historial',
      title: (name: string) => `Sendero del historial de ${name}`,
      backupGroupAria: 'Respaldar este Lith',
      localOnly: (folder: string) => `Sin respaldo. Cópialo a ${folder} para que se sincronice.`,
      copy: 'Copiar',
      loading: 'Cargando versiones…',
      none: 'Todavía sin versiones guardadas.',
      badgeSync: 'sinc',
      badgeSyncTitle: 'Guardado tras un cambio fuera de este dispositivo.',
      badgeFull: 'completa',
      badgeFullTitle: 'Copia completa de este guardado.',
      badgeStep: 'paso',
      badgeStepTitle: 'Ediciones desde el guardado anterior.',
      downloadAria: (when: string) => `Descargar una copia de la versión del ${when}`,
      later: {
        seconds: (count: string) => `${count} segundo${count === '1' ? '' : 's'} después`,
        minutes: (count: string) => `${count} minuto${count === '1' ? '' : 's'} después`,
        hours: (count: string) => `${count} hora${count === '1' ? '' : 's'} después`,
        days: (count: string) => `${count} día${count === '1' ? '' : 's'} después`
      },
      note: 'Revertir es manual. Descarga una versión y sustituye el wiki con ella.'
    },

    dirty: {
      title: 'Ediciones sin guardar',
      body: (name: string, edits: number, when: string) =>
        `${name} tiene ${edits} ${edits === 1 ? 'edición' : 'ediciones'} sin guardar en disco, capturadas el ${when}.`,
      more: (count: number) => `… y ${count} más`,
      recover: 'Recuperar ediciones',
      later: 'Decidir luego',
      discard: 'Descartar'
    }
  },

  actions: {
    aria: 'Acciones del lanzador',
    newBlank: 'Lith en blanco',
    upload: 'Subir un Lith',
    mount: 'Montar un Lith',
    bookmarkAria: 'Marcar una instancia autoalojada',
    bookmarkTitle: 'Marcar una instancia remota'
  },

  newLith: {
    placeholder: 'Escribe un título',
    nameAria: 'Nombre del archivo Lith',
    taken: 'Nombre ya en uso',
    takenError: 'Nombre ya en uso.',
    create: 'Crear lith',
    closeAria: 'Cerrar la entrada de nuevo lith'
  },

  offline: {
    title: 'Servidor inalcanzable',
    body: 'Mostrando las copias guardadas de este dispositivo. Los Liths se abren en solo lectura.',
    rowMarkTitle: 'Solo en este dispositivo mientras esté sin conexión.',
    rowOpenTitle: 'Abrir la copia de este dispositivo en solo lectura'
  },

  recent: {
    aria: 'Liths recientes',
    searchAria: 'Buscar en los Liths recientes',
    searchPlaceholder: 'Buscar liths recientes…',
    clearSearch: 'Borrar la búsqueda de Liths recientes',
    readingServer: 'Leyendo los Liths de este servidor…',
    empty: {
      noMatch: 'Ningún Lith coincide.',
      instanceHere: 'Todavía no hay Liths de esta instancia en este dispositivo.',
      server: 'Todavía no hay Liths en este servidor.',
      recents: 'No hay Liths recientes.'
    }
  },

  row: {
    downloadAria: (name: string) => `Descargar una copia de ${name}`,
    downloadTitle: 'Descargar una copia',
    historyAria: (name: string) => `Ver el historial de ${name}`,
    olderVersions: 'Versiones anteriores',
    showHistory: 'Ver el historial',
    noHistory: 'Sin historial guardado',
    unsavedAria: (name: string) => `${name} tiene ediciones sin guardar; abre para recuperarlas`,
    unsavedFrom: (when: string) => `Ediciones sin guardar del ${when}`,
    localOnlyAria: (name: string) => `Abrir el historial y las opciones de respaldo de ${name}`,
    localOnlyTitle: 'Fuera de una carpeta respaldada. Abre para copiarlo.',
    openFromServer: 'Abrir desde este servidor',
    deleteFromServerAria: (name: string) => `Borrar ${name} de este servidor`,
    deleteFromServerTitle: 'Borrar del almacenamiento remoto',
    openUrl: (url: string) => `Abrir ${url}`,
    noAddressAria: (url: string) => `No hay dirección para guardar un acceso en ${url}`,
    noAddress: 'No hay dirección para guardar un acceso',
    vaultSaved: (origin: string) => `Hay un acceso guardado para ${origin}. Gestiónalo.`,
    vaultSave: (origin: string) => `Guarda un acceso para ${origin} y dejará de pedirlo`,
    openSearchingAria: (label: string, query: string) => `Abrir ${label} buscando “${query}”`,
    openSearchingTitle: (label: string) => `Abrir ${label} y buscar esto`,
    removeBookmarkAria: (url: string) => `Quitar el marcador ${url}`,
    instanceTruncated: 'Solo se buscó en los Liths más recientes',
    pinAria: (name: string, title: string) => `Abrir ${name} y fijar “${title}” arriba`,
    openAria: (name: string) => `Abrir ${name}`,
    pinTitle: 'Abrir y fijar este tiddler',
    removeAria: (name: string) => `Quitar ${name}`,
    cachedLocally: 'Guardado localmente',
    deviceUnsyncedTitle: 'Aún no está en tus dispositivos. Abre para enviar este Lith.',
    deviceUnsyncedAria: (name: string) => `Abrir el historial y enviar ${name} a tus dispositivos`,
    deviceSendTitle: 'Enviar a tus dispositivos',
    deviceSendAria: (name: string) => `Enviar ${name} a tus dispositivos`,
    deviceSharedTitle: 'Está en tus dispositivos. Enviar esta copia crea una versión nueva.',
    deviceSharedAria: (name: string) => `${name} está en tus dispositivos. Envía esta copia como versión nueva.`,
    deviceOnlyLabel: 'En tus dispositivos',
    deviceOnlyAria: (name: string) => `${name} está en tus dispositivos, pero no en este dispositivo.`,
    deviceLoad: 'Cargar',
    deviceLoading: 'Descargando…',
    deviceLoadAria: (name: string) => `Cargar ${name} desde tus dispositivos`,
    browserOnly: (name: string) => `${name}. ${BROWSER_ONLY_TOOLTIP_ES}`,
    browserOnlyClaim: BROWSER_ONLY_TOOLTIP_ES,
    browserOnlyNote:
      'Solo almacenamiento del navegador. Este Lith no tiene archivo, así que lo que guarda este navegador es la única copia que hay. ' +
      'Descarga una versión para conservar una que puedas volver a montar.'
  },

  foot: {
    rebuild: 'Reconstruir recientes',
    reindexing: 'Reindexando…',
    rebuildServerTitle: 'Leer este servidor otra vez e indexar sus Liths aquí',
    rebuildDiskTitle: 'Reconstruir esta lista desde los archivos en disco',
    reset: 'Reiniciar recientes',
    resetTitle: 'Borra esta lista y su historial local. Tus archivos se quedan.',
    rebuildDeviceTitle: 'Reconstruir esta lista y su historial desde tus dispositivos emparejados'
  },

  orphan: {
    saving: { label: 'guardando…', title: 'Guardando una copia ahora.' },
    saved: { label: '✓ guardado', title: 'La copia está en este dispositivo.' },
    unverified: {
      label: '✓ revisa las descargas',
      title: 'El navegador no puede confirmar las descargas. Revisa tu carpeta de Descargas.'
    },
    failed: { label: 'falló', title: 'No se pudo guardar esta copia.' },
    noteOneSaved: 'Guardado. Puedes continuar.',
    noteOneUnconfirmed: 'Guardado, pero sin confirmar.',
    noteAllSaved: (total: number) => `Los ${total} guardados. Puedes continuar.`,
    noteAllUnconfirmed: (total: number, unconfirmed: number) =>
      `Los ${total} guardados, pero ${unconfirmed} sin confirmar.`,
    notePartial: (done: number, total: number) => `${done} de ${total} guardados.`
  },

  sync: {
    syncing: 'GitHub Sync: sincronizando…',
    checking: 'GitHub Sync: comprobando…',
    verifying: 'GitHub Sync: verificando la conexión…',
    lastSaveFailed: (detail: string) => `GitHub Sync: el último guardado no se subió (${detail})`,
    failure: (detail: string) => `GitHub Sync: ${detail}`,
    connected: (target: string, age: string | null) =>
      `GitHub Sync: ${target}${age ? `, verificado hace ${age}` : ''}`,
    connectedLabel: 'conectado',
    serverFailed: 'GitHub Sync: esta instancia no respondió',
    serverSyncing: (target: string) => `GitHub Sync: sincronizando con ${target}…`,
    serverConnected: (target: string, age: string | null) =>
      `GitHub Sync: ${target}${age ? `, última sincronización hace ${age}` : ''}`,
    readonly: 'este token solo puede leer el repositorio. Reconecta para permitir subidas.',
    auth: 'GitHub rechazó este token. Reconecta para volver a entrar.',
    missing: 'falta el repositorio o este token no lo tiene compartido.',
    throttled: 'GitHub está limitando este dispositivo. Los guardados se quedan locales por ahora.',
    offline: 'no se puede alcanzar github.com. Los guardados se quedan en este dispositivo.',
    malformed: 'el remoto guardado de esta carpeta no se puede leer. Reconecta para repararlo.',
    backendSilent: 'el servicio de sincronización no respondió'
  },

  loginCheck: {
    busy: 'Comprobando…',
    accepted: 'Entra',
    refused: 'Rechazado',
    notRequired: 'No lo pide',
    unclear: 'Sin veredicto',
    unreachable: 'Sin respuesta'
  },

  instanceCopy: {
    failed: (label: string) => `No se pudo borrar la copia guardada de ${label}`
  },

  bookmarkErrors: {
    needUrl: 'Escribe la URL de una instancia Lithic autoalojada.',
    needHttp: 'Usa una URL HTTP o HTTPS.'
  },

  deviceFlow: {
    unexpected: 'Respuesta inesperada de GitHub',
    denied: 'Autorización denegada en GitHub.',
    expired: 'Ese código caducó. Empieza de nuevo para tener otro.',
    failed: 'La autorización falló o caducó. Genera un código nuevo.'
  },

  serverSync: {
    noCode: 'GitHub no respondió con un código.',
    unreachableForCode: 'No se pudo alcanzar este servidor para obtener un código.',
    noRepos: 'No se pudieron listar tus repositorios.',
    noCreate: 'No se pudo crear el repositorio.',
    unreachableForSetup: 'No se pudo alcanzar este servidor para preparar la copia.',
    setupFailed: 'Falló la configuración.',
    setupFailedDetail: (detail: string) => `Falló la configuración: ${detail}`
  },

  status: {
    opening: 'Abriendo…',
    openingRecent: 'Abriendo un Lith reciente…',
    loadingBlank: 'Cargando un Lith en blanco…',
    openFailed: (detail: string) => `No se pudo abrir: ${detail}`,
    mounted: (name: string) => `${name} montado`,
    mountedReadOnly: (name: string) => `${name} montado en solo lectura`,
    mountedPatched: (name: string) => `${name} montado. Los guardados envían solo los cambios.`,
    noPath: 'Sin ruta de archivo registrada. Ábrelo una vez con Montar para volver a enlazarlo.',
    added: (count: number) => `${count} Liths añadidos a recientes`,
    uploading: (names: readonly string[]) =>
      names.length === 1 ? `Subiendo ${names[0]}…` : `Subiendo ${names.length} Liths…`,
    uploaded: (count: number) => `${count} Liths subidos`,
    uploadFailed: (detail: string) => `No se pudo subir: ${detail}`,
    replaceOne: '¿Sustituir este Lith?',
    replaceMany: '¿Sustituir estos Liths?',
    replaceBodyOne: (name: string) => `${name} ya está en este servidor. Subirlo lo sustituye.`,
    replaceBodyMany: (names: string) => `${names} ya están en este servidor. Subirlos los sustituye.`,
    replaceConfirm: 'Sustituir',
    listingFailed: (detail: string) => `No se pudieron listar los Liths de este servidor (${detail}).`,
    openingName: (name: string) => `Abriendo ${name}…`,
    openNameFailed: (name: string, detail: string) => `No se pudo abrir ${name}: ${detail}`,
    creating: (name: string) => `Creando ${name}…`,
    createFailed: (name: string, detail: string) => `No se pudo crear ${name}: ${detail}`,
    deleteTitle: '¿Borrar este Lith?',
    deleteConfirm: 'Borrar',
    deleting: (name: string) => `Borrando ${name}…`,
    deleteFailed: (name: string, detail: string) => `No se pudo borrar ${name}: ${detail}`,
    deleteBody: (name: string) => `${name} se borra del servidor, no solo de este dispositivo.`,
    recovering: (edits: number, name: string) =>
      `Recuperando ${edits} ${edits === 1 ? 'edición' : 'ediciones'} sin guardar de ${name}`,
    editsKept: 'Ediciones sin guardar para más tarde',
    recovered: (name: string) => `${name} recuperado`,
    savedFile: (name: string) => `${name} guardado`,
    downloadingFile: (name: string) => `Descargando ${name}`,
    downloadFailed: (detail: string) => `Falló la descarga: ${detail}`,
    noCachedCopy: (name: string) => `No hay copia guardada de ${name} para descargar`,
    deviceSent: (name: string) => `Enviado ${name} a tus dispositivos`,
    deviceSendFailed: (detail: string) => `No se pudo enviar ese Lith: ${detail}`,
    deviceHistoryFailed: (detail: string) => `No se pudo guardar la versión recibida: ${detail}`,
    deviceLoaded: (name: string) => `Cargado ${name} desde tus dispositivos`,
    deviceLoadFailed: (detail: string) => `No se pudo cargar ese Lith: ${detail}`,
    reindexing: 'Reindexando los liths recientes…',
    reindexed: (count: number) => `${count} lith${count === 1 ? '' : 's'} reindexado${count === 1 ? '' : 's'}`,
    indexedHere: (count: number) => `${count} lith${count === 1 ? '' : 's'} indexado${count === 1 ? '' : 's'} aquí para la búsqueda`,
    nothingToIndex: 'Nada nuevo que indexar',
    reindexFailed: (detail: string) => `Falló la reindexación: ${detail}`,
    rebuildCancelled: 'Reconstrucción cancelada',
    indexingLabel: 'Indexando',
    reindexingLabel: 'Reindexando',
    indexProgress: (label: string, position: number, total: number, name: string) =>
      `${label} ${position} de ${total} · ${name}`,
    scratchSaveFailed: 'Falló la serialización del borrador; el archivo no se tocó.',
    monolithSaveFailed: 'Falló la serialización de la página; la copia guardada no se tocó.',
    noHistory: 'Todavía no hay historial de versiones para este wiki.',
    noHistoryVersion: 'Esa versión no se pudo reconstruir desde la cadena del historial.',
    introFailed: 'No se pudo cargar la introducción.',
    droppedInvalid: 'El archivo soltado no tiene un formato de datos válido.',
    payloadFailed: 'No se pudo cargar el contenido compartido',
    blankLithFailed: 'No se pudo cargar el wiki local',
    engineUnavailable: (status: string) => `No se pudo cargar el motor del wiki (${status})`,
    engineMissing: 'No se pudo cargar el motor de Lithic localmente, desde la caché sin conexión ni en línea.'
  },

  fileTypes: {
    monolith: 'Monolito Lithic',
    html: 'Archivo HTML de Lithic',
    htmlMany: 'Archivos HTML de Lithic',
    json: 'Copias JSON de Lithic',
    text: 'Archivos de texto editables',
    notebook: 'Cuadernos de Jupyter',
    notebookOne: 'Cuaderno de Jupyter'
  }
};

/**
 * What a row's mark claims about a Lith this browser holds and nothing else does, in French.
 * Separate from the deck below for the same reason the Spanish one is.
 */
const BROWSER_ONLY_TOOLTIP_FR =
  'Stockage du navigateur uniquement. Ce Lith est gardé dans le cache de ce navigateur, et rien n’est réécrit dans un fichier. ' +
  'Cette copie est intrinsèquement volatile. Effacer les données du site, ou un navigateur qui reprend de l’espace, la fera perdre. ' +
  'Téléchargez vos propres copies depuis son historique de versions.';

/**
 * French.
 *
 * Written to the same rule as the Spanish deck above: a translation, not a transliteration, so
 * a sentence is the claim English makes rather than the shape of the English sentence. `Lith`,
 * `PIN` and `GitHub Sync` are the product's own words and do not move, and neither does
 * anything the reader acts on (`github.com`, `owner/repository`, `.lith`), because a button
 * that opens a real page has to name it. The copy rules hold here too: one short sentence,
 * nothing restated, no em dashes or en dashes.
 *
 * French punctuation is written with plain spaces (`Dossier : `), not the narrow no-break
 * space the typography asks for. An invisible character in a string this file is reviewed as
 * prose is a worse trade than a break in a two-word dialog label.
 */
const fr: Copy = {
  app: {
    title: 'Lithic - Lanceur',
    brandAlt: 'Lithic',
    githubLink: 'Lithic sur GitHub',
    footerLink: 'Github',
    backToLauncher: 'Revenir au lanceur principal',
    setInstanceIcon: 'Choisir l’icône de cette instance',
    viewIntro: 'Voir l’introduction'
  },

  install: {
    label: {
      installing: 'Installation…',
      install: 'Installer l’app',
      plain: 'Installer',
      updateAvailable: 'Mise à jour disponible',
      updateInstall: 'Installer la mise à jour'
    },
    offer: {
      browser: 'Ajouter le lanceur à cet appareil',
      update: 'Téléchargez la nouvelle version, puis appuyez sur Installer la mise à jour',
      notice: 'Récupérez la dernière version sur la page des versions',
      desktop: (entry: LaunchEntry | null): string =>
        entry === 'application-menu'
          ? 'Copier dans Documents et l’ajouter au menu des applications'
          : entry === 'start-menu'
            ? 'Copier dans Documents et créer un raccourci dans le menu Démarrer'
            : 'Copier l’application dans un dossier permanent'
    },
    dismissTitle: 'Masquer la proposition d’installation',
    dismissAria: 'Fermer la proposition d’installation',
    dismissText: 'fermer',
    unavailable: 'L’installation est dans le menu du navigateur.',
    openFailed: (detail: string) => `Impossible d’ouvrir votre navigateur : ${detail}`,
    copyToSyncedDir: 'Copier dans le dossier synchronisé',
    copyToSyncedDirBody: (name: string, folder: string) => `${name} n’est pas sauvegardé. Le copier dans ${folder} ?`,
    copyConfirm: 'Copier',
    copied: (name: string, folder: string) => `${name} copié dans ${folder}`,
    installedPrefix: 'Installé dans ',
    installed: (path: string) => `Installé dans ${path}`,
    failed: (detail: string) => `Échec de l’installation : ${detail}`
  },

  pending: {
    aria: 'Importations en attente',
    heading: 'Importations en attente',
    clear: 'Effacer les importations en attente',
    untitled: 'Contenu sans titre'
  },

  common: {
    cancel: 'Annuler',
    back: 'Retour',
    open: 'Ouvrir',
    show: 'Afficher',
    pin: 'PIN',
    characterAria: (label: string, position: number, total: number) =>
      `${label}, caractère ${position} sur ${total}`,
    choosePin: 'Choisir un PIN',
    repeatPin: 'Répéter le PIN'
  },

  /**
   * La synchronisation entre appareils : le panneau, les étapes d’appairage et ce que
   * disent ses événements.
   */
  deviceSync: {
    title: 'Synchronisation entre appareils',
    openAria: 'Ouvrir la synchronisation entre appareils',
    closeAria: 'Fermer la synchronisation entre appareils',
    loading: 'Démarrage du moteur de synchronisation…',
    unavailable: {
      file: 'La synchronisation entre appareils a besoin d’une page servie par un serveur web. Ce launcher a été ouvert depuis un fichier, il n’a donc nulle part où charger son moteur.',
      'no-wasm': 'Ce navigateur ne peut pas exécuter la partie de Lithic sur laquelle repose la synchronisation entre appareils.',
      'no-crypto': 'Ce navigateur ne fournit pas le hasard dont la synchronisation entre appareils a besoin.',
      engine: 'Le moteur de synchronisation n’a pas pu être chargé ici. Tout le reste fonctionne comme d’habitude, et vos Liths restent sur cet appareil.'
    },
    nodeLabel: 'Cet appareil',
    folderCount: (count: number): string =>
      count === 1 ? 'Un Lith dans ce dossier' : `${count} Liths dans ce dossier`,
    peers: (count: number): string =>
      count === 1 ? 'Appairé avec un appareil' : `Appairé avec ${count} appareils`,
    activity: {
      idle: 'Rien ne s’est encore synchronisé.',
      update: (name: string): string => `Mis à jour par un autre appareil : ${name}`,
      seeded: (name: string): string => `Ajouté depuis cet appareil : ${name}`,
      drift: (name: string): string => `Modifié en dehors de cet appareil : ${name}`,
      peerUp: 'Un appareil a rejoint.',
      peerDown: 'Un appareil est parti.',
      failed: (name: string, reason: string): string => `${name} ne s’est pas synchronisé : ${reason}`
    },
    ticketTitle: 'Votre ticket',
    ticketShow: 'Afficher le ticket de cet appareil',
    unpair: 'Dissocier cet appareil',
    unpairing: 'Dissociation…',
    paired: 'Associé',
    liveStatus: 'La synchronisation est connectée à un autre appareil en ce moment.',
    waitingStatus: 'La synchronisation est associée, mais aucun autre appareil n’est connecté.',
    busyStatus: 'La synchronisation échange des modifications avec vos autres appareils.',
    errorStatus: 'La synchronisation n’a pas terminé sa dernière opération sur cet appareil.',
    idleStatus: 'Cet appareil n’a pas d’association active pour le moment.',
    ticketBusy: 'En attente du réseau…',
    ticketBody: 'Collez-le dans l’autre appareil. Quiconque l’a peut écrire dans ce dossier.',
    ticketHint: 'Un ticket est la façon dont deux appareils se trouvent. Sans compte et sans serveur à nous.',
    ticketCopy: 'Copier',
    ticketCopied: 'Copié',
    joinTitle: 'Appairer un autre appareil',
    joinPlaceholder: 'Collez le ticket de l’autre appareil',
    join: 'Appairer',
    joining: 'Appairage…',
    joinHint: 'L’appairage amène les Liths de cet appareil dans ce dossier.',
    joinEmpty: 'Ce n’est pas un ticket. Collez le texte complet de l’autre appareil.',
    alreadyPaired: 'Dissociez cet appareil avant de rejoindre un autre dossier.',
    recentsHint: 'Chaque Lith de ce dossier est une ligne dans votre liste récente, que cet appareil en ait une copie ou non. Une ligne sans la marque des appareils est un Lith que vos appareils n’ont pas encore, et sa marque est ce qui l’envoie.',
    error: (detail: string): string => `La synchronisation entre appareils a rencontré un problème : ${detail}`
  },

  dialogs: {
    gitSync: {
      title: 'GitHub Sync',
      closeAria: 'Fermer le dialogue GitHub Sync',
      folder: {
        label: 'Dossier',
        none: 'Pas encore de dossier',
        choosing: 'Choix…',
        change: 'Modifier',
        choose: 'Choisir',
        changeTitle: 'Modifier le dossier sauvegardé par GitHub Sync',
        chooseTitle: 'Choisir le dossier sauvegardé par GitHub Sync',
        changeAria: (folder: string) => `Modifier le dossier sauvegardé par GitHub Sync : ${folder}`,
        chooseAria: 'Choisir le dossier sauvegardé par GitHub Sync',
        automatic: 'Utiliser le dossier automatique'
      },
      backedUp: (backedUp: number, tracked: number) => `${backedUp} liths récents sauvegardés sur ${tracked}`,
      noTarget: 'Enregistrez d’abord un Lith sur le disque, car la synchronisation sauvegarde son dossier.',
      serverIntro: 'Sauvegardez ce serveur sur GitHub. Ses enregistrements sont envoyés automatiquement.',
      serverNoAnswer: 'Cette instance n’a pas répondu au sujet des sauvegardes GitHub.',
      folderIntro: 'Sauvegardez ce dossier sur GitHub. Les enregistrements sont envoyés automatiquement.',
      working: 'En cours…',
      stopping: 'Arrêt…',
      stopSyncing: 'Arrêter la synchronisation',
      connect: 'Connecter à GitHub',
      tokenSummary: 'Avancé : se connecter avec un jeton d’accès personnel',
      repoAria: 'Dépôt GitHub (propriétaire/nom)',
      repoPlaceholder: 'propriétaire/dépôt',
      tokenAria: 'Jeton GitHub',
      tokenPlaceholder: 'Jeton fin ou classique avec droit d’écriture',
      connecting: 'Connexion…',
      connectPush: 'Connecter et envoyer',
      stepOne: '1. Ouvrez',
      stepTwo: '2. Saisissez ce code (installe Lithic Sync à la première utilisation) :',
      /** The code is a button: pressing it copies, which is what the hint and the label say. */
      codeCopyTitle: 'Copier le code dans le presse-papiers',
      codeCopyAria: (code: string) => `Copier le code ${code} dans le presse-papiers`,
      codeCopied: 'Code copié dans le presse-papiers.',
      codeCopyFailed: 'Impossible de copier le code. Sélectionnez-le et copiez-le vous-même.',
      waiting: 'En attente de l’autorisation…',
      requesting: 'Demande d’un code à GitHub…',
      stopWaiting: 'Arrêter d’attendre',
      createAndSync: (name: string) => `+ Créer ${name} et synchroniser`,
      foundRepos: 'Dépôts de synchronisation Lithic trouvés',
      otherReposSummary: 'Avancé : vos autres dépôts',
      customRepoAria: 'Dépôt personnalisé (propriétaire/nom)',
      customRepoPlaceholder: 'propriétaire/nom',
      syncing: 'Synchronisation…',
      startSync: 'Démarrer la synchronisation',
      connectedRepo: 'Dépôt connecté',
      notRecorded: 'Non enregistré',
      /** The repository name is a link to the repository on github.com. */
      openRepoTitle: (repo: string) => `Ouvrir github.com/${repo} dans votre navigateur`,
      openRepoAria: (repo: string) => `Ouvrir le dépôt github.com/${repo} dans votre navigateur`,
      lastSynced: (age: string) => `Dernière synchronisation il y a ${age}.`,
      noSyncYet: 'Pas encore de synchronisation.',
      savesHere: 'Les enregistrements de ce dossier sont envoyés à GitHub automatiquement.',
      waitingForGitHub: 'En attente de GitHub…',
      reconnect: 'Reconnecter',
      disconnect: 'Déconnecter',
      starting: 'Démarrage…',
      creatingRepo: 'Création du dépôt…',
      settingUp: 'Préparation de la sauvegarde…',
      backingUp: (repo: string) => `Sauvegarde de github.com/${repo}.`,
      created: (repo: string) => `${repo} créé. `,
      synced: 'Synchronisé',
      cancelled: 'Synchronisation arrêtée.',
      reconnected: (repo: string) => `github.com/${repo} reconnecté`,
      lastSaveFailed: (detail: string) => `Le dernier enregistrement n’a pas été envoyé : ${detail}`,
      instanceNoDisconnect: 'L’instance n’a pas confirmé la déconnexion.',
      noFolder: 'Impossible de déterminer le dossier ou le dépôt à reconnecter.',
      noDeviceCode: 'GitHub n’a pas renvoyé de code d’appareil',
      disconnectConfirm: {
        server: 'Les enregistrements de ce serveur ne sont plus envoyés à GitHub.',
        desktop: 'Les enregistrements de ce dossier ne sont plus envoyés à GitHub.',
        label: 'Déconnecter'
      },
      disconnectTitle: 'Déconnecter GitHub Sync ?'
    },

    bookmark: {
      closeAria: 'Fermer le dialogue des marque-pages',
      title: 'Marquer une instance distante',
      intro: 'Enregistrer une instance auto-hébergée pour y accéder vite.',
      urlAria: 'URL de l’instance auto-hébergée',
      urlPlaceholder: 'https://...',
      save: 'Enregistrer le marque-page',
      manage: 'Gérer les identifiants',
      manageSaved: (count: number) => `Identifiants d’instances enregistrés. ${count} enregistrés.`,
      manageEmpty: 'Identifiants d’instances enregistrés. Aucun pour l’instant.',
      unverifiedTitle: 'Marquer cette instance ?',
      unverifiedBody: 'Lithic n’a pas pu vérifier cette adresse.',
      unverifiedConfirm: 'Marquer quand même',
      unreachable: 'Cette adresse est injoignable.',
      notInstance: 'Cette adresse n’est pas une instance Lithic.',
      saved: 'Instance auto-hébergée marquée'
    },

    unlock: {
      closeAria: 'Fermer le dialogue de déverrouillage',
      title: (label: string) => `Ouvrir ${label}`,
      sub: 'Identifiant enregistré. Saisissez votre PIN.'
    },

    credential: {
      closeAria: 'Fermer le dialogue d’enregistrement',
      title: 'Enregistrer cet identifiant ?',
      forInstance: (label: string) => `Pour ${label}.`,
      username: 'Nom d’utilisateur',
      password: 'Mot de passe',
      saving: 'Enregistrement…',
      save: 'Enregistrer l’identifiant',
      openWithoutSaving: 'Ouvrir sans enregistrer',
      notSaved: 'Non enregistré : cette instance refuse cet identifiant.',
      notOpened: 'Non ouvert : cette instance refuse cet identifiant.',
      checking: 'Interrogation de l’instance…'
    },

    vault: {
      closeAria: 'Fermer le dialogue des identifiants',
      title: 'Identifiants d’instances',
      empty: 'Rien d’enregistré pour l’instant.',
      forgetAll: 'Tout oublier',
      intro: 'Les identifiants des instances auto-hébergées apparaissent ici une fois enregistrés.',
      pinPrompt: 'Saisissez votre PIN pour lire ces identifiants.',
      count: (saved: number) => (saved === 1 ? '1 identifiant enregistré.' : `${saved} identifiants enregistrés.`),
      checkAria: (origin: string) => `Vérifier l’identifiant de ${origin} auprès de l’instance`,
      checkTitle: 'Demander à cette instance si l’identifiant enregistré fonctionne encore',
      forgetAria: (origin: string) => `Oublier l’identifiant de ${origin}`,
      forgetTitle: 'Oublier cet identifiant',
      storedIn: 'Stocké dans',
      forgot: (origin: string) => `Identifiant de ${origin} oublié.`,
      forgetAllTitle: 'Oublier tous les identifiants enregistrés ?',
      forgetAllBody:
        'Le fichier du coffre est supprimé, et le PIN avec lui. Le prochain identifiant enregistré choisira un PIN neuf. ' +
        'D’ici là, les instances demanderont un mot de passe.',
      everyLoginGone: 'Tous les identifiants enregistrés ont disparu.'
    },

    collision: {
      closeAria: 'Fermer le dialogue de session active',
      title: 'Session active détectée',
      someone: 'Quelqu’un d’autre',
      hasOpenBefore: 'a',
      hasOpenAfter: 'ouvert sur ce serveur. Le dernier qui écrit gagne.',
      note: 'Ouvrir en lecture seule, ou ignorer le verrou.',
      openReadOnly: 'Ouvrir en lecture seule',
      ignoreLock: 'Ignorer le verrou et ouvrir'
    },

    icon: {
      closeAria: 'Fermer le sélecteur d’icône',
      title: 'Icône de l’instance',
      intro: 'Cette icône appartient à l’instance. Toute personne qui ouvre cette adresse la voit.',
      chooseAria: 'Choisir une icône d’instance',
      saving: 'Enregistrement…',
      savingProgress: (saved: number, total: number) => `Enregistrement… (${saved} sur ${total})`,
      savedInstance: (name: string) => `✓ Enregistré. Cette instance utilise ${name}.`,
      save: 'Enregistrer l’icône',
      restoreTitle: 'Utiliser l’icône Lithic fournie',
      restore: 'Rétablir l’icône d’origine',
      savedHere: (detail: string) => `Enregistré sur cet appareil seulement. L’écriture sur le serveur a échoué (${detail}).`,
      canvasFailed: 'Impossible de dessiner l’icône (pas de canvas).',
      savedServer: '✓ Icône d’origine rétablie sur tout le serveur.',
      restoredHere: 'Rétabli sur cet appareil seulement.'
    },

    rebuild: {
      titleServer: 'Pas sur ce serveur',
      titleDisk: 'Introuvable sur le disque',
      bodyServer: (count: number) =>
        `${count} ${count === 1 ? 'copie en cache manque' : 'copies en cache manquent'} sur le serveur, ` +
        `donc reconstruire ${count === 1 ? 'la supprime' : 'les supprime'} de cet appareil.`,
      bodyDisk: (count: number) =>
        `${count} ${count === 1 ? 'lith n’a pas' : 'liths n’ont pas'} de fichier sur le disque, ` +
        `donc reconstruire ${count === 1 ? 'sa copie en cache et son historique' : 'leurs copies en cache et leur historique'}.`,
      unsavedWarning: (count: number) =>
        `${count} d’entre eux ont des modifications non enregistrées, qu’aucun téléchargement ne peut récupérer.`,
      noFile: 'Aucun fichier sur le disque',
      cachedOnly: 'en cache seulement',
      unsavedTag: 'modifications non enregistrées',
      unsavedCaptured: (when: string) => `Modifications non enregistrées capturées ${when}`,
      proceed: 'Continuer quand même'
    },

    history: {
      closeAria: 'Fermer le sentier de l’historique',
      title: (name: string) => `Sentier de l’historique de ${name}`,
      backupGroupAria: 'Sauvegarder ce Lith',
      localOnly: (folder: string) => `Pas sauvegardé. Copiez-le dans ${folder} pour le synchroniser.`,
      copy: 'Copier',
      loading: 'Chargement des versions…',
      none: 'Aucune version enregistrée pour l’instant.',
      badgeSync: 'synchro',
      badgeSyncTitle: 'Enregistré après une modification hors de cet appareil.',
      badgeFull: 'complète',
      badgeFullTitle: 'Copie complète de cet enregistrement.',
      badgeStep: 'étape',
      badgeStepTitle: 'Modifications depuis l’enregistrement précédent.',
      downloadAria: (when: string) => `Télécharger une copie de la version du ${when}`,
      later: {
        seconds: (count: string) => `${count} seconde${count === '1' ? '' : 's'} plus tard`,
        minutes: (count: string) => `${count} minute${count === '1' ? '' : 's'} plus tard`,
        hours: (count: string) => `${count} heure${count === '1' ? '' : 's'} plus tard`,
        days: (count: string) => `${count} jour${count === '1' ? '' : 's'} plus tard`
      },
      note: 'Le retour en arrière est manuel. Téléchargez une version, puis remplacez le wiki par celle-ci.'
    },

    dirty: {
      title: 'Modifications non enregistrées',
      body: (name: string, edits: number, when: string) =>
        `${name} a ${edits} ${edits === 1 ? 'modification' : 'modifications'} jamais enregistrée${edits === 1 ? '' : 's'} sur le disque, capturée${edits === 1 ? '' : 's'} ${when}.`,
      more: (count: number) => `… et ${count} de plus`,
      recover: 'Récupérer les modifications',
      later: 'Décider plus tard',
      discard: 'Abandonner'
    }
  },

  actions: {
    aria: 'Actions du lanceur',
    newBlank: 'Nouveau Lith vierge',
    upload: 'Téléverser un Lith',
    mount: 'Monter un Lith',
    bookmarkAria: 'Marquer une instance auto-hébergée',
    bookmarkTitle: 'Marquer une instance distante'
  },

  newLith: {
    placeholder: 'Saisir un titre',
    nameAria: 'Nom du fichier Lith',
    taken: 'Nom déjà utilisé',
    takenError: 'Nom déjà utilisé.',
    create: 'Créer le lith',
    closeAria: 'Fermer la saisie du nouveau lith'
  },

  offline: {
    title: 'Serveur injoignable',
    body: 'Affichage des copies gardées par cet appareil. Les Liths s’ouvrent en lecture seule.',
    rowMarkTitle: 'Sur cet appareil seulement, hors ligne.',
    rowOpenTitle: 'Ouvrir la copie de cet appareil en lecture seule'
  },

  recent: {
    aria: 'Liths récents',
    searchAria: 'Rechercher dans les Liths récents',
    searchPlaceholder: 'Rechercher des liths récents…',
    clearSearch: 'Effacer la recherche de Liths récents',
    readingServer: 'Lecture des Liths de ce serveur…',
    empty: {
      noMatch: 'Aucun Lith ne correspond.',
      instanceHere: 'Aucun Lith de cette instance sur cet appareil pour l’instant.',
      server: 'Aucun Lith sur ce serveur pour l’instant.',
      recents: 'Aucun Lith récent.'
    }
  },

  row: {
    downloadAria: (name: string) => `Télécharger une copie de ${name}`,
    downloadTitle: 'Télécharger une copie',
    historyAria: (name: string) => `Afficher l’historique de ${name}`,
    olderVersions: 'Versions précédentes',
    showHistory: 'Afficher l’historique',
    noHistory: 'Aucun historique en cache',
    unsavedAria: (name: string) => `${name} a des modifications non enregistrées ; ouvrez pour les récupérer`,
    unsavedFrom: (when: string) => `Modifications non enregistrées du ${when}`,
    localOnlyAria: (name: string) => `Ouvrir l’historique et les options de sauvegarde de ${name}`,
    localOnlyTitle: 'Hors d’un dossier sauvegardé. Ouvrez pour proposer la copie.',
    openFromServer: 'Ouvrir depuis ce serveur',
    deleteFromServerAria: (name: string) => `Supprimer ${name} de ce serveur`,
    deleteFromServerTitle: 'Supprimer du stockage distant',
    openUrl: (url: string) => `Ouvrir ${url}`,
    noAddressAria: (url: string) => `Aucune adresse où enregistrer un identifiant sur ${url}`,
    noAddress: 'Aucune adresse où enregistrer un identifiant',
    vaultSaved: (origin: string) => `Un identifiant est enregistré pour ${origin}. Le gérer.`,
    vaultSave: (origin: string) => `Enregistrer un identifiant pour ${origin} pour qu’il arrête de demander`,
    openSearchingAria: (label: string, query: string) => `Ouvrir ${label} en cherchant « ${query} »`,
    openSearchingTitle: (label: string) => `Ouvrir ${label} et chercher ceci`,
    removeBookmarkAria: (url: string) => `Retirer le marque-page ${url}`,
    instanceTruncated: 'Seuls les Liths les plus récents ont été cherchés',
    pinAria: (name: string, title: string) => `Ouvrir ${name} et épingler « ${title} » en haut`,
    openAria: (name: string) => `Ouvrir ${name}`,
    pinTitle: 'Ouvrir et épingler ce tiddler',
    removeAria: (name: string) => `Retirer ${name}`,
    cachedLocally: 'En cache local',
    deviceUnsyncedTitle: 'Pas encore sur vos appareils. Ouvrez pour envoyer ce Lith.',
    deviceUnsyncedAria: (name: string) => `Ouvrir l’historique et envoyer ${name} à vos appareils`,
    deviceSendTitle: 'Envoyer à vos appareils',
    deviceSendAria: (name: string) => `Envoyer ${name} à vos appareils`,
    deviceSharedTitle: 'Sur vos appareils. Envoyer cette copie en fait une nouvelle version.',
    deviceSharedAria: (name: string) => `${name} est sur vos appareils. Envoyez cette copie comme nouvelle version.`,
    deviceOnlyLabel: 'Sur vos appareils',
    deviceOnlyAria: (name: string) => `${name} est sur vos appareils mais pas sur cet appareil.`,
    deviceLoad: 'Charger',
    deviceLoading: 'Téléchargement…',
    deviceLoadAria: (name: string) => `Charger ${name} depuis vos appareils`,
    browserOnly: (name: string) => `${name}. ${BROWSER_ONLY_TOOLTIP_FR}`,
    browserOnlyClaim: BROWSER_ONLY_TOOLTIP_FR,
    browserOnlyNote:
      'Stockage du navigateur uniquement. Ce Lith n’a pas de fichier, donc ce que ce navigateur garde est la seule copie qui existe. ' +
      'Téléchargez une version pour en garder une que vous pourrez remonter.'
  },

  foot: {
    rebuild: 'Reconstruire les récents',
    reindexing: 'Réindexation…',
    rebuildServerTitle: 'Relire ce serveur et indexer ses Liths ici',
    rebuildDiskTitle: 'Reconstruire cette liste depuis les fichiers du disque',
    reset: 'Réinitialiser les récents',
    resetTitle: 'Efface cette liste et son historique local. Vos fichiers restent.',
    rebuildDeviceTitle: 'Reconstruire cette liste et son historique depuis vos appareils associés'
  },

  orphan: {
    saving: { label: 'enregistrement…', title: 'Enregistrement d’une copie en cours.' },
    saved: { label: '✓ enregistré', title: 'La copie est sur cet appareil.' },
    unverified: {
      label: '✓ vérifiez les téléchargements',
      title: 'Le navigateur ne peut pas confirmer les téléchargements. Vérifiez votre dossier Téléchargements.'
    },
    failed: { label: 'échec', title: 'Cette copie n’a pas pu être enregistrée.' },
    noteOneSaved: 'Enregistré. Vous pouvez continuer.',
    noteOneUnconfirmed: 'Enregistré, mais non confirmé.',
    noteAllSaved: (total: number) => `Les ${total} enregistrés. Vous pouvez continuer.`,
    noteAllUnconfirmed: (total: number, unconfirmed: number) =>
      `Les ${total} enregistrés, mais ${unconfirmed} non confirmés.`,
    notePartial: (done: number, total: number) => `${done} sur ${total} enregistrés.`
  },

  sync: {
    syncing: 'GitHub Sync : synchronisation…',
    checking: 'GitHub Sync : vérification…',
    verifying: 'GitHub Sync : vérification de la connexion…',
    lastSaveFailed: (detail: string) => `GitHub Sync : le dernier enregistrement n’a pas été envoyé (${detail})`,
    failure: (detail: string) => `GitHub Sync : ${detail}`,
    connected: (target: string, age: string | null) =>
      `GitHub Sync : ${target}${age ? `, vérifié il y a ${age}` : ''}`,
    connectedLabel: 'connecté',
    serverFailed: 'GitHub Sync : cette instance n’a pas répondu',
    serverSyncing: (target: string) => `GitHub Sync : synchronisation vers ${target}…`,
    serverConnected: (target: string, age: string | null) =>
      `GitHub Sync : ${target}${age ? `, dernière synchronisation il y a ${age}` : ''}`,
    readonly: 'ce jeton ne peut que lire le dépôt. Reconnectez-vous pour autoriser les envois.',
    auth: 'GitHub a refusé ce jeton. Reconnectez-vous pour vous identifier à nouveau.',
    missing: 'le dépôt est absent ou n’est pas partagé avec ce jeton.',
    throttled: 'GitHub limite cet appareil. Les enregistrements restent locaux pour l’instant.',
    offline: 'github.com est injoignable. Les enregistrements restent sur cet appareil.',
    malformed: 'le dépôt distant enregistré pour ce dossier est illisible. Reconnectez-vous pour le réparer.',
    backendSilent: 'le service de synchronisation n’a pas répondu'
  },

  loginCheck: {
    busy: 'Vérification…',
    accepted: 'Fonctionne',
    refused: 'Refusé',
    notRequired: 'Non demandé',
    unclear: 'Incertain',
    unreachable: 'Sans réponse'
  },

  instanceCopy: {
    failed: (label: string) => `Impossible d’effacer la copie en cache de ${label}`
  },

  bookmarkErrors: {
    needUrl: 'Saisissez l’URL d’une instance Lithic auto-hébergée.',
    needHttp: 'Utilisez une URL HTTP ou HTTPS.'
  },

  deviceFlow: {
    unexpected: 'Réponse inattendue de GitHub',
    denied: 'Autorisation refusée sur GitHub.',
    expired: 'Ce code a expiré. Recommencez pour en obtenir un nouveau.',
    failed: 'L’autorisation a échoué ou expiré. Générez un nouveau code.'
  },

  serverSync: {
    noCode: 'GitHub n’a pas répondu avec un code.',
    unreachableForCode: 'Impossible d’atteindre ce serveur pour obtenir un code.',
    noRepos: 'Impossible de lister vos dépôts.',
    noCreate: 'Impossible de créer le dépôt.',
    unreachableForSetup: 'Impossible d’atteindre ce serveur pour préparer la sauvegarde.',
    setupFailed: 'Échec de la configuration.',
    setupFailedDetail: (detail: string) => `Échec de la configuration : ${detail}`
  },

  status: {
    opening: 'Ouverture…',
    openingRecent: 'Ouverture d’un Lith récent…',
    loadingBlank: 'Chargement d’un Lith vierge…',
    openFailed: (detail: string) => `Échec de l’ouverture : ${detail}`,
    mounted: (name: string) => `${name} monté`,
    mountedReadOnly: (name: string) => `${name} monté en lecture seule`,
    mountedPatched: (name: string) => `${name} monté. Les enregistrements n’envoient que les changements.`,
    noPath: 'Aucun chemin de fichier enregistré. Ouvrez-le une fois avec Monter pour le relier.',
    added: (count: number) => `${count} Liths ajoutés aux récents`,
    uploading: (names: readonly string[]) =>
      names.length === 1 ? `Envoi de ${names[0]}…` : `Envoi de ${names.length} Liths…`,
    uploaded: (count: number) => `${count} Liths envoyés`,
    uploadFailed: (detail: string) => `Impossible d’envoyer : ${detail}`,
    replaceOne: 'Remplacer ce Lith ?',
    replaceMany: 'Remplacer ces Liths ?',
    replaceBodyOne: (name: string) => `${name} est déjà sur ce serveur. L’envoyer le remplace.`,
    replaceBodyMany: (names: string) => `${names} sont déjà sur ce serveur. Les envoyer les remplace.`,
    replaceConfirm: 'Remplacer',
    listingFailed: (detail: string) => `Impossible de lister les Liths de ce serveur (${detail}).`,
    openingName: (name: string) => `Ouverture de ${name}…`,
    openNameFailed: (name: string, detail: string) => `Impossible d’ouvrir ${name} : ${detail}`,
    creating: (name: string) => `Création de ${name}…`,
    createFailed: (name: string, detail: string) => `Impossible de créer ${name} : ${detail}`,
    deleteTitle: 'Supprimer ce Lith ?',
    deleteConfirm: 'Supprimer',
    deleting: (name: string) => `Suppression de ${name}…`,
    deleteFailed: (name: string, detail: string) => `Impossible de supprimer ${name} : ${detail}`,
    deleteBody: (name: string) => `${name} est supprimé du serveur, pas seulement de cet appareil.`,
    recovering: (edits: number, name: string) =>
      `Récupération de ${edits} ${edits === 1 ? 'modification' : 'modifications'} non enregistrée${edits === 1 ? '' : 's'} pour ${name}`,
    editsKept: 'Modifications non enregistrées gardées pour plus tard',
    recovered: (name: string) => `${name} récupéré`,
    savedFile: (name: string) => `${name} enregistré`,
    downloadingFile: (name: string) => `Téléchargement de ${name}`,
    downloadFailed: (detail: string) => `Échec du téléchargement : ${detail}`,
    noCachedCopy: (name: string) => `Aucune copie en cache de ${name} à télécharger`,
    deviceSent: (name: string) => `${name} envoyé à vos appareils`,
    deviceSendFailed: (detail: string) => `Impossible d’envoyer ce Lith : ${detail}`,
    deviceHistoryFailed: (detail: string) => `Impossible d’enregistrer la version reçue : ${detail}`,
    deviceLoaded: (name: string) => `${name} chargé depuis vos appareils`,
    deviceLoadFailed: (detail: string) => `Impossible de charger ce Lith : ${detail}`,
    reindexing: 'Réindexation des liths récents…',
    reindexed: (count: number) => `${count} lith${count === 1 ? '' : 's'} réindexé${count === 1 ? '' : 's'}`,
    indexedHere: (count: number) => `${count} lith${count === 1 ? '' : 's'} indexé${count === 1 ? '' : 's'} ici pour la recherche`,
    nothingToIndex: 'Rien de neuf à indexer',
    reindexFailed: (detail: string) => `Échec de la réindexation : ${detail}`,
    rebuildCancelled: 'Reconstruction annulée',
    indexingLabel: 'Indexation',
    reindexingLabel: 'Réindexation',
    indexProgress: (label: string, position: number, total: number, name: string) =>
      `${label} ${position} sur ${total} · ${name}`,
    scratchSaveFailed: 'Échec de la sérialisation du brouillon ; le fichier n’a pas été touché.',
    monolithSaveFailed: 'Échec de la sérialisation de la page ; la copie enregistrée n’a pas été touchée.',
    noHistory: 'Aucun historique de versions n’est encore disponible pour ce wiki.',
    noHistoryVersion: 'Cette version n’a pas pu être reconstruite depuis l’historique.',
    introFailed: 'Impossible de charger l’introduction.',
    droppedInvalid: 'Le fichier déposé n’a pas un format de données valide.',
    payloadFailed: 'Impossible de charger le contenu partagé',
    blankLithFailed: 'Impossible de charger le wiki local',
    engineUnavailable: (status: string) => `Impossible de charger le moteur du wiki (${status})`,
    engineMissing: 'Impossible de charger le moteur Lithic en local, depuis le cache hors ligne ou en ligne.'
  },

  fileTypes: {
    monolith: 'Monolithe Lithic',
    html: 'Fichier HTML Lithic',
    htmlMany: 'Fichiers HTML Lithic',
    json: 'Sauvegardes JSON Lithic',
    text: 'Fichiers texte modifiables',
    notebook: 'Carnets Jupyter',
    notebookOne: 'Carnet Jupyter'
  }
};

/**
 * What a row's mark claims about a Lith this browser holds and nothing else does, in German.
 * Separate from the deck below for the same reason the Spanish one is.
 */
const BROWSER_ONLY_TOOLTIP_DE =
  'Nur Browser-Speicher. Dieser Lith wird im Cache dieses Browsers gehalten, und nichts wird in eine Datei zurückgeschrieben. ' +
  'Diese Kopie ist von Natur aus flüchtig. Werden die Websitedaten gelöscht oder holt sich der Browser Speicher zurück, ist sie weg. ' +
  'Lade deine eigenen Kopien über ihren Versionsverlauf herunter.';

/**
 * German.
 *
 * Written to the same rule as the two decks above. One word deliberately does not move: the
 * window title keeps the English `Launcher`, because that is what German software calls this
 * window and a literal translation would read as a translation. `Lith`, `PIN` and `GitHub Sync`
 * stay for the same reason, and anything the reader acts on keeps its literal spelling
 * (`github.com`, `eigentümer/repository`, `.lith`). The copy rules hold here too: one short
 * sentence, nothing restated, no em dashes or en dashes. Compounds are joined with a plain
 * hyphen (`Lithic-Monolith`), which is the one the rule leaves alone.
 */
const de: Copy = {
  app: {
    title: 'Lithic - Launcher',
    brandAlt: 'Lithic',
    githubLink: 'Lithic auf GitHub',
    footerLink: 'Github',
    backToLauncher: 'Zurück zum Haupt-Launcher',
    setInstanceIcon: 'Icon dieser Instanz wählen',
    viewIntro: 'Einführung ansehen'
  },

  install: {
    label: {
      installing: 'Wird installiert…',
      install: 'App installieren',
      plain: 'Installieren',
      updateAvailable: 'Update verfügbar',
      updateInstall: 'Update installieren'
    },
    offer: {
      browser: 'Launcher zu diesem Gerät hinzufügen',
      update: 'Lade die neue Version herunter und tippe auf Update installieren',
      notice: 'Hole die neueste Version von der Releases-Seite',
      desktop: (entry: LaunchEntry | null): string =>
        entry === 'application-menu'
          ? 'Nach Dokumente kopieren und dem Anwendungsmenü hinzufügen'
          : entry === 'start-menu'
            ? 'Nach Dokumente kopieren und eine Verknüpfung im Startmenü anlegen'
            : 'Die App an einen festen Ort kopieren'
    },
    dismissTitle: 'Installationsangebot ausblenden',
    dismissAria: 'Installationsangebot schließen',
    dismissText: 'ausblenden',
    unavailable: 'Installation ist über das Browsermenü möglich.',
    openFailed: (detail: string) => `Browser konnte nicht geöffnet werden: ${detail}`,
    copyToSyncedDir: 'In den synchronisierten Ordner kopieren',
    copyToSyncedDirBody: (name: string, folder: string) => `${name} ist nicht gesichert. Nach ${folder} kopieren?`,
    copyConfirm: 'Kopieren',
    copied: (name: string, folder: string) => `${name} nach ${folder} kopiert`,
    installedPrefix: 'Installiert unter ',
    installed: (path: string) => `Installiert unter ${path}`,
    failed: (detail: string) => `Installation fehlgeschlagen: ${detail}`
  },

  pending: {
    aria: 'Ausstehende Importe',
    heading: 'Ausstehende Importe',
    clear: 'Ausstehende Importe verwerfen',
    untitled: 'Inhalt ohne Titel'
  },

  common: {
    cancel: 'Abbrechen',
    back: 'Zurück',
    open: 'Öffnen',
    show: 'Anzeigen',
    pin: 'PIN',
    characterAria: (label: string, position: number, total: number) =>
      `${label}, Zeichen ${position} von ${total}`,
    choosePin: 'PIN wählen',
    repeatPin: 'PIN wiederholen'
  },

  /**
   * Die Gerätesynchronisierung: das Panel, die Kopplungsschritte und was ihre Ereignisse
   * sagen.
   */
  deviceSync: {
    title: 'Gerätesynchronisierung',
    openAria: 'Gerätesynchronisierung öffnen',
    closeAria: 'Gerätesynchronisierung schließen',
    loading: 'Synchronisierungsmodul wird gestartet…',
    unavailable: {
      file: 'Die Gerätesynchronisierung braucht eine Seite, die von einem Webserver ausgeliefert wird. Dieser Launcher wurde aus einer Datei geöffnet, es gibt also nichts, woraus er sein Modul laden könnte.',
      'no-wasm': 'Dieser Browser kann den Teil von Lithic nicht ausführen, auf dem die Gerätesynchronisierung aufbaut.',
      'no-crypto': 'Dieser Browser bietet nicht den Zufall, den die Gerätesynchronisierung braucht.',
      engine: 'Das Synchronisierungsmodul konnte hier nicht geladen werden. Alles andere funktioniert wie gewohnt, und Ihre Liths bleiben auf diesem Gerät.'
    },
    nodeLabel: 'Dieses Gerät',
    folderCount: (count: number): string =>
      count === 1 ? 'Ein Lith in diesem Ordner' : `${count} Liths in diesem Ordner`,
    peers: (count: number): string =>
      count === 1 ? 'Mit einem Gerät gekoppelt' : `Mit ${count} Geräten gekoppelt`,
    activity: {
      idle: 'Bisher wurde nichts synchronisiert.',
      update: (name: string): string => `Von einem anderen Gerät aktualisiert: ${name}`,
      seeded: (name: string): string => `Von diesem Gerät hinzugefügt: ${name}`,
      drift: (name: string): string => `Außerhalb dieses Geräts geändert: ${name}`,
      peerUp: 'Ein Gerät ist beigetreten.',
      peerDown: 'Ein Gerät ist gegangen.',
      failed: (name: string, reason: string): string => `${name} wurde nicht synchronisiert: ${reason}`
    },
    ticketTitle: 'Ihr Ticket',
    ticketShow: 'Ticket dieses Geräts anzeigen',
    unpair: 'Dieses Gerät entkoppeln',
    unpairing: 'Wird entkoppelt…',
    paired: 'Gekoppelt',
    liveStatus: 'Die Synchronisierung ist gerade mit einem anderen Gerät verbunden.',
    waitingStatus: 'Die Synchronisierung ist gekoppelt, aber kein anderes Gerät ist online.',
    busyStatus: 'Die Synchronisierung tauscht gerade Änderungen mit Ihren Geräten aus.',
    errorStatus: 'Die Synchronisierung konnte den letzten Vorgang auf diesem Gerät nicht abschließen.',
    idleStatus: 'Dieses Gerät hat gerade keine aktive Kopplung.',
    ticketBusy: 'Warten auf das Netzwerk…',
    ticketBody: 'Fügen Sie es auf dem anderen Gerät ein. Wer es hat, kann in diesen Ordner schreiben.',
    ticketHint: 'Ein Ticket ist die Art, wie zwei Geräte zueinander finden. Kein Konto und kein Server von uns.',
    ticketCopy: 'Kopieren',
    ticketCopied: 'Kopiert',
    joinTitle: 'Ein anderes Gerät koppeln',
    joinPlaceholder: 'Fügen Sie das Ticket des anderen Geräts ein',
    join: 'Koppeln',
    joining: 'Wird gekoppelt…',
    joinHint: 'Beim Koppeln kommen die Liths dieses Geräts in diesen Ordner.',
    joinEmpty: 'Das ist kein Ticket. Fügen Sie den ganzen Text vom anderen Gerät ein.',
    alreadyPaired: 'Entkoppeln Sie dieses Gerät, bevor Sie einen anderen Ordner koppeln.',
    recentsHint: 'Jedes Lith in diesem Ordner ist eine Zeile in Ihrer Liste, ob dieses Gerät eine Kopie hat oder nicht. Eine Zeile ohne Gerätemarke hat Ihre Geräte noch nicht, und ihre Marke ist es, die sie sendet.',
    error: (detail: string): string => `Gerätesynchronisierung hat ein Problem: ${detail}`
  },

  dialogs: {
    gitSync: {
      title: 'GitHub Sync',
      closeAria: 'Dialog GitHub Sync schließen',
      folder: {
        label: 'Ordner',
        none: 'Noch kein Ordner',
        choosing: 'Auswahl…',
        change: 'Ändern',
        choose: 'Auswählen',
        changeTitle: 'Ordner ändern, den GitHub Sync sichert',
        chooseTitle: 'Ordner auswählen, den GitHub Sync sichert',
        changeAria: (folder: string) => `Ordner ändern, den GitHub Sync sichert: ${folder}`,
        chooseAria: 'Ordner auswählen, den GitHub Sync sichert',
        automatic: 'Automatischen Ordner verwenden'
      },
      backedUp: (backedUp: number, tracked: number) => `${backedUp} von ${tracked} letzten Liths gesichert`,
      noTarget: 'Speichere zuerst einen Lith auf der Festplatte, da die Synchronisierung seinen Ordner sichert.',
      serverIntro: 'Diesen Server auf GitHub sichern. Seine Speicherungen werden automatisch hochgeladen.',
      serverNoAnswer: 'Diese Instanz hat nicht zu GitHub-Sicherungen geantwortet.',
      folderIntro: 'Diesen Ordner auf GitHub sichern. Speicherungen werden automatisch hochgeladen.',
      working: 'Läuft…',
      stopping: 'Wird gestoppt…',
      stopSyncing: 'Synchronisierung stoppen',
      connect: 'Mit GitHub verbinden',
      tokenSummary: 'Erweitert: mit einem persönlichen Zugriffstoken verbinden',
      repoAria: 'GitHub-Repository (Eigentümer/Name)',
      repoPlaceholder: 'eigentümer/repository',
      tokenAria: 'GitHub-Token',
      tokenPlaceholder: 'Fein abgestuftes oder klassisches Token mit Push-Zugriff',
      connecting: 'Verbindung…',
      connectPush: 'Verbinden und hochladen',
      stepOne: '1. Öffne',
      stepTwo: '2. Diesen Code eingeben (installiert Lithic Sync bei der ersten Verwendung):',
      /** The code is a button: pressing it copies, which is what the hint and the label say. */
      codeCopyTitle: 'Den Code in die Zwischenablage kopieren',
      codeCopyAria: (code: string) => `Den Code ${code} in die Zwischenablage kopieren`,
      codeCopied: 'Code in die Zwischenablage kopiert.',
      codeCopyFailed: 'Der Code konnte nicht kopiert werden. Markieren Sie ihn und kopieren Sie ihn selbst.',
      waiting: 'Warte auf die Autorisierung…',
      requesting: 'Fordere einen Code von GitHub an…',
      stopWaiting: 'Nicht mehr warten',
      createAndSync: (name: string) => `+ ${name} erstellen und synchronisieren`,
      foundRepos: 'Vorhandene Lithic-Sync-Repositories gefunden',
      otherReposSummary: 'Erweitert: deine anderen Repositories',
      customRepoAria: 'Eigenes Repository (Eigentümer/Name)',
      customRepoPlaceholder: 'eigentümer/name',
      syncing: 'Synchronisierung…',
      startSync: 'Synchronisierung starten',
      connectedRepo: 'Verbundenes Repository',
      notRecorded: 'Nicht erfasst',
      /** The repository name is a link to the repository on github.com. */
      openRepoTitle: (repo: string) => `github.com/${repo} im Browser öffnen`,
      openRepoAria: (repo: string) => `Das Repository github.com/${repo} im Browser öffnen`,
      lastSynced: (age: string) => `Zuletzt synchronisiert vor ${age}.`,
      noSyncYet: 'Noch nicht synchronisiert.',
      savesHere: 'Speicherungen in diesem Ordner werden automatisch zu GitHub hochgeladen.',
      waitingForGitHub: 'Warte auf GitHub…',
      reconnect: 'Neu verbinden',
      disconnect: 'Trennen',
      starting: 'Startet…',
      creatingRepo: 'Repository wird erstellt…',
      settingUp: 'Sicherung wird eingerichtet…',
      backingUp: (repo: string) => `Sichere github.com/${repo}.`,
      created: (repo: string) => `${repo} erstellt. `,
      synced: 'Synchronisiert',
      cancelled: 'Synchronisierung gestoppt.',
      reconnected: (repo: string) => `github.com/${repo} neu verbunden`,
      lastSaveFailed: (detail: string) => `Die letzte Speicherung wurde nicht hochgeladen: ${detail}`,
      instanceNoDisconnect: 'Die Instanz hat das Trennen nicht bestätigt.',
      noFolder: 'Ordner oder Repository zum Neuverbinden nicht gefunden.',
      noDeviceCode: 'GitHub hat keinen Gerätecode zurückgegeben',
      disconnectConfirm: {
        server: 'Speicherungen auf diesem Server werden nicht mehr zu GitHub hochgeladen.',
        desktop: 'Speicherungen in diesem Ordner werden nicht mehr zu GitHub hochgeladen.',
        label: 'Trennen'
      },
      disconnectTitle: 'GitHub Sync trennen?'
    },

    bookmark: {
      closeAria: 'Dialog der Lesezeichen schließen',
      title: 'Entfernte Instanz als Lesezeichen',
      intro: 'Eine selbst gehostete Instanz für den schnellen Zugriff speichern.',
      urlAria: 'URL der selbst gehosteten Instanz',
      urlPlaceholder: 'https://...',
      save: 'Lesezeichen speichern',
      manage: 'Zugangsdaten verwalten',
      manageSaved: (count: number) => `Gespeicherte Instanz-Zugänge. ${count} gespeichert.`,
      manageEmpty: 'Gespeicherte Instanz-Zugänge. Noch keine.',
      unverifiedTitle: 'Diese Instanz als Lesezeichen speichern?',
      unverifiedBody: 'Lithic konnte diese Adresse nicht prüfen.',
      unverifiedConfirm: 'Trotzdem speichern',
      unreachable: 'Diese Adresse ist nicht erreichbar.',
      notInstance: 'Diese Adresse ist keine Lithic-Instanz.',
      saved: 'Selbst gehostete Instanz gemerkt'
    },

    unlock: {
      closeAria: 'Entsperr-Dialog schließen',
      title: (label: string) => `${label} öffnen`,
      sub: 'Gespeicherter Zugang. Bitte PIN eingeben.'
    },

    credential: {
      closeAria: 'Dialog zum Speichern schließen',
      title: 'Zugang speichern?',
      forInstance: (label: string) => `Für ${label}.`,
      username: 'Benutzername',
      password: 'Passwort',
      saving: 'Wird gespeichert…',
      save: 'Zugang speichern',
      openWithoutSaving: 'Ohne Speichern öffnen',
      notSaved: 'Nicht gespeichert: diese Instanz lehnt den Zugang ab.',
      notOpened: 'Nicht geöffnet: diese Instanz lehnt den Zugang ab.',
      checking: 'Instanz wird gefragt…'
    },

    vault: {
      closeAria: 'Dialog der gespeicherten Zugänge schließen',
      title: 'Gespeicherte Instanz-Zugänge',
      empty: 'Noch nichts gespeichert.',
      forgetAll: 'Alles vergessen',
      intro: 'Zugangsdaten selbst gehosteter Instanzen erscheinen hier nach dem Speichern.',
      pinPrompt: 'PIN eingeben, um diese Zugänge zu lesen.',
      count: (saved: number) => (saved === 1 ? '1 Zugang gespeichert.' : `${saved} Zugänge gespeichert.`),
      checkAria: (origin: string) => `Zugang für ${origin} bei der Instanz prüfen`,
      checkTitle: 'Diese Instanz fragen, ob der gespeicherte Zugang noch funktioniert',
      forgetAria: (origin: string) => `Zugang für ${origin} vergessen`,
      forgetTitle: 'Diesen Zugang vergessen',
      storedIn: 'Gespeichert in',
      forgot: (origin: string) => `Zugang für ${origin} vergessen.`,
      forgetAllTitle: 'Alle gespeicherten Zugänge vergessen?',
      forgetAllBody:
        'Die Tresordatei wird gelöscht, und der PIN mit ihr. Der nächste gespeicherte Zugang wählt einen neuen PIN. ' +
        'Bis dahin fragen Instanzen nach einem Passwort.',
      everyLoginGone: 'Alle gespeicherten Zugänge sind weg.'
    },

    collision: {
      closeAria: 'Dialog der aktiven Sitzung schließen',
      title: 'Aktive Sitzung erkannt',
      someone: 'Jemand anderes',
      hasOpenBefore: 'hat',
      hasOpenAfter: 'auf diesem Server geöffnet. Wer zuletzt schreibt, gewinnt.',
      note: 'Schreibgeschützt öffnen oder die Sperre ignorieren.',
      openReadOnly: 'Schreibgeschützt öffnen',
      ignoreLock: 'Sperre ignorieren und öffnen'
    },

    icon: {
      closeAria: 'Icon-Auswahl schließen',
      title: 'Instanz-Icon',
      intro: 'Dieses Icon gehört zur Instanz. Jeder, der diese Adresse öffnet, sieht es.',
      chooseAria: 'Instanz-Icon auswählen',
      saving: 'Wird gespeichert…',
      savingProgress: (saved: number, total: number) => `Wird gespeichert… (${saved} von ${total})`,
      savedInstance: (name: string) => `✓ Gespeichert. Diese Instanz verwendet jetzt ${name}.`,
      save: 'Icon speichern',
      restoreTitle: 'Das mitgelieferte Lithic-Icon verwenden',
      restore: 'Standard wiederherstellen',
      savedHere: (detail: string) => `Nur auf diesem Gerät gespeichert. Das Schreiben auf den Server ist fehlgeschlagen (${detail}).`,
      canvasFailed: 'Icon konnte nicht gezeichnet werden (kein Canvas).',
      savedServer: '✓ Standard-Icon serverweit wiederhergestellt.',
      restoredHere: 'Nur auf diesem Gerät wiederhergestellt.'
    },

    rebuild: {
      titleServer: 'Nicht auf diesem Server',
      titleDisk: 'Nicht auf der Festplatte gefunden',
      bodyServer: (count: number) =>
        `${count} ${count === 1 ? 'zwischengespeicherte Kopie fehlt' : 'zwischengespeicherte Kopien fehlen'} auf dem Server, ` +
        `deshalb löscht ein Neuaufbau sie von diesem Gerät.`,
      bodyDisk: (count: number) =>
        `${count} ${count === 1 ? 'Lith hat' : 'Liths haben'} keine Datei auf der Festplatte, ` +
        `deshalb löscht ein Neuaufbau ${count === 1 ? 'seine Kopie im Cache und seinen Verlauf' : 'ihre Kopien im Cache und ihren Verlauf'}.`,
      unsavedWarning: (count: number) =>
        `${count} davon haben ungespeicherte Änderungen, die kein Download retten kann.`,
      noFile: 'Keine Datei auf der Festplatte',
      cachedOnly: 'nur im Cache',
      unsavedTag: 'ungespeicherte Änderungen',
      unsavedCaptured: (when: string) => `Ungespeicherte Änderungen erfasst ${when}`,
      proceed: 'Trotzdem fortfahren'
    },

    history: {
      closeAria: 'Spur des Verlaufs schließen',
      title: (name: string) => `Spur des Verlaufs von ${name}`,
      backupGroupAria: 'Diesen Lith sichern',
      localOnly: (folder: string) => `Nicht gesichert. Kopiere ihn nach ${folder}, damit er synchronisiert wird.`,
      copy: 'Kopieren',
      loading: 'Versionen werden geladen…',
      none: 'Noch keine Versionen gespeichert.',
      badgeSync: 'sync',
      badgeSyncTitle: 'Gespeichert nach einer Änderung außerhalb dieses Geräts.',
      badgeFull: 'voll',
      badgeFullTitle: 'Vollständige Kopie dieser Speicherung.',
      badgeStep: 'Schritt',
      badgeStepTitle: 'Änderungen seit der letzten Speicherung.',
      downloadAria: (when: string) => `Eine Kopie der Version von ${when} herunterladen`,
      later: {
        seconds: (count: string) => `${count} Sekunde${count === '1' ? '' : 'n'} später`,
        minutes: (count: string) => `${count} Minute${count === '1' ? '' : 'n'} später`,
        hours: (count: string) => `${count} Stunde${count === '1' ? '' : 'n'} später`,
        days: (count: string) => `${count} Tag${count === '1' ? '' : 'e'} später`
      },
      note: 'Zurücksetzen ist manuell. Lade eine Version herunter und ersetze das Wiki damit.'
    },

    dirty: {
      title: 'Ungespeicherte Änderungen',
      body: (name: string, edits: number, when: string) =>
        `${name} hat ${edits} ${edits === 1 ? 'Änderung' : 'Änderungen'}, die nie auf der Festplatte gespeichert ${edits === 1 ? 'wurde' : 'wurden'}, erfasst ${when}.`,
      more: (count: number) => `… und ${count} weitere`,
      recover: 'Änderungen wiederherstellen',
      later: 'Später entscheiden',
      discard: 'Verwerfen'
    }
  },

  actions: {
    aria: 'Aktionen des Launchers',
    newBlank: 'Neuer leerer Lith',
    upload: 'Lith hochladen',
    mount: 'Lith einbinden',
    bookmarkAria: 'Selbst gehostete Instanz merken',
    bookmarkTitle: 'Entfernte Instanz als Lesezeichen'
  },

  newLith: {
    placeholder: 'Titel eingeben',
    nameAria: 'Dateiname des Lith',
    taken: 'Name bereits vergeben',
    takenError: 'Name bereits vergeben.',
    create: 'Lith erstellen',
    closeAria: 'Eingabe des neuen Lith schließen'
  },

  offline: {
    title: 'Server nicht erreichbar',
    body: 'Es werden die gespeicherten Kopien dieses Geräts gezeigt. Liths öffnen schreibgeschützt.',
    rowMarkTitle: 'Nur auf diesem Gerät, solange offline.',
    rowOpenTitle: 'Die Kopie dieses Geräts schreibgeschützt öffnen'
  },

  recent: {
    aria: 'Zuletzt verwendete Liths',
    searchAria: 'Zuletzt verwendete Liths durchsuchen',
    searchPlaceholder: 'Zuletzt verwendete Liths suchen…',
    clearSearch: 'Suche in den letzten Liths leeren',
    readingServer: 'Liths dieses Servers werden gelesen…',
    empty: {
      noMatch: 'Kein passender Lith.',
      instanceHere: 'Noch keine Liths dieser Instanz auf diesem Gerät.',
      server: 'Noch keine Liths auf diesem Server.',
      recents: 'Keine letzten Liths.'
    }
  },

  row: {
    downloadAria: (name: string) => `Eine Kopie von ${name} herunterladen`,
    downloadTitle: 'Eine Kopie herunterladen',
    historyAria: (name: string) => `Versionsverlauf von ${name} anzeigen`,
    olderVersions: 'Ältere Versionen',
    showHistory: 'Versionsverlauf anzeigen',
    noHistory: 'Kein Verlauf im Cache',
    unsavedAria: (name: string) => `${name} hat ungespeicherte Änderungen; zum Wiederherstellen öffnen`,
    unsavedFrom: (when: string) => `Ungespeicherte Änderungen vom ${when}`,
    localOnlyAria: (name: string) => `Verlauf und Sicherungsoptionen für ${name} öffnen`,
    localOnlyTitle: 'Nicht in einem gesicherten Ordner. Zum Kopieren öffnen.',
    openFromServer: 'Von diesem Server öffnen',
    deleteFromServerAria: (name: string) => `${name} von diesem Server löschen`,
    deleteFromServerTitle: 'Aus dem Remote-Speicher löschen',
    openUrl: (url: string) => `${url} öffnen`,
    noAddressAria: (url: string) => `Keine Adresse, um einen Zugang für ${url} zu speichern`,
    noAddress: 'Keine Adresse für einen Zugang',
    vaultSaved: (origin: string) => `Für ${origin} ist ein Zugang gespeichert. Verwalten.`,
    vaultSave: (origin: string) => `Einen Zugang für ${origin} speichern, damit die Abfrage aufhört`,
    openSearchingAria: (label: string, query: string) => `${label} öffnen und nach „${query}“ suchen`,
    openSearchingTitle: (label: string) => `${label} öffnen und danach suchen`,
    removeBookmarkAria: (url: string) => `Lesezeichen ${url} entfernen`,
    instanceTruncated: 'Nur die neuesten Liths wurden durchsucht',
    pinAria: (name: string, title: string) => `${name} öffnen und „${title}“ oben anheften`,
    openAria: (name: string) => `${name} öffnen`,
    pinTitle: 'Diesen Tiddler öffnen und anheften',
    removeAria: (name: string) => `${name} entfernen`,
    cachedLocally: 'Lokal zwischengespeichert',
    deviceUnsyncedTitle: 'Noch nicht auf Ihren Geräten. Öffnen, um diesen Lith zu senden.',
    deviceUnsyncedAria: (name: string) => `Verlauf öffnen und ${name} an Ihre Geräte senden`,
    deviceSendTitle: 'An Ihre Geräte senden',
    deviceSendAria: (name: string) => `${name} an Ihre Geräte senden`,
    deviceSharedTitle: 'Auf Ihren Geräten. Senden Sie diese Kopie, wird daraus eine neue Version.',
    deviceSharedAria: (name: string) => `${name} ist auf Ihren Geräten. Senden Sie diese Kopie als neue Version.`,
    deviceOnlyLabel: 'Auf Ihren Geräten',
    deviceOnlyAria: (name: string) => `${name} ist auf Ihren Geräten, aber nicht auf diesem Gerät.`,
    deviceLoad: 'Laden',
    deviceLoading: 'Wird geholt…',
    deviceLoadAria: (name: string) => `${name} von Ihren Geräten laden`,
    browserOnly: (name: string) => `${name}. ${BROWSER_ONLY_TOOLTIP_DE}`,
    browserOnlyClaim: BROWSER_ONLY_TOOLTIP_DE,
    browserOnlyNote:
      'Nur Browser-Speicher. Dieser Lith hat keine Datei, deshalb ist das, was dieser Browser hält, die einzige Kopie. ' +
      'Lade eine Version herunter, um eine zu behalten, die du wieder einbinden kannst.'
  },

  foot: {
    rebuild: 'Zuletzt verwendete neu aufbauen',
    reindexing: 'Wird neu indexiert…',
    rebuildServerTitle: 'Diesen Server erneut lesen und seine Liths hier indexieren',
    rebuildDiskTitle: 'Diese Liste aus den Dateien auf der Festplatte neu aufbauen',
    reset: 'Zuletzt verwendete zurücksetzen',
    resetTitle: 'Leert diese Liste und ihren lokalen Verlauf. Deine Dateien bleiben.',
    rebuildDeviceTitle: 'Diese Liste und den Suchverlauf von Ihren gekoppelten Geräten neu aufbauen'
  },

  orphan: {
    saving: { label: 'speichert…', title: 'Eine Kopie wird gerade gespeichert.' },
    saved: { label: '✓ gespeichert', title: 'Die Kopie ist auf diesem Gerät.' },
    unverified: {
      label: '✓ Downloads prüfen',
      title: 'Der Browser kann Downloads nicht bestätigen. Prüfe deinen Downloads-Ordner.'
    },
    failed: { label: 'fehlgeschlagen', title: 'Diese Kopie konnte nicht gespeichert werden.' },
    noteOneSaved: 'Gespeichert. Du kannst fortfahren.',
    noteOneUnconfirmed: 'Gespeichert, aber unbestätigt.',
    noteAllSaved: (total: number) => `Alle ${total} gespeichert. Du kannst fortfahren.`,
    noteAllUnconfirmed: (total: number, unconfirmed: number) =>
      `Alle ${total} gespeichert, aber ${unconfirmed} unbestätigt.`,
    notePartial: (done: number, total: number) => `${done} von ${total} gespeichert.`
  },

  sync: {
    syncing: 'GitHub Sync: wird synchronisiert…',
    checking: 'GitHub Sync: wird geprüft…',
    verifying: 'GitHub Sync: Verbindung wird geprüft…',
    lastSaveFailed: (detail: string) => `GitHub Sync: die letzte Speicherung wurde nicht hochgeladen (${detail})`,
    failure: (detail: string) => `GitHub Sync: ${detail}`,
    connected: (target: string, age: string | null) =>
      `GitHub Sync: ${target}${age ? `, geprüft vor ${age}` : ''}`,
    connectedLabel: 'verbunden',
    serverFailed: 'GitHub Sync: diese Instanz hat nicht geantwortet',
    serverSyncing: (target: string) => `GitHub Sync: wird zu ${target} synchronisiert…`,
    serverConnected: (target: string, age: string | null) =>
      `GitHub Sync: ${target}${age ? `, zuletzt synchronisiert vor ${age}` : ''}`,
    readonly: 'dieses Token kann das Repository nur lesen. Neu verbinden, um Uploads zu erlauben.',
    auth: 'GitHub hat dieses Token abgelehnt. Neu verbinden, um dich wieder anzumelden.',
    missing: 'das Repository fehlt oder ist für dieses Token nicht freigegeben.',
    throttled: 'GitHub begrenzt dieses Gerät. Speicherungen bleiben vorerst lokal.',
    offline: 'github.com ist nicht erreichbar. Speicherungen bleiben auf diesem Gerät.',
    malformed: 'das gespeicherte Remote dieses Ordners ist unlesbar. Neu verbinden, um es zu reparieren.',
    backendSilent: 'der Sync-Dienst hat nicht geantwortet'
  },

  loginCheck: {
    busy: 'Wird geprüft…',
    accepted: 'Funktioniert',
    refused: 'Abgelehnt',
    notRequired: 'Nicht gefragt',
    unclear: 'Unklar',
    unreachable: 'Keine Antwort'
  },

  instanceCopy: {
    failed: (label: string) => `Die zwischengespeicherte Kopie von ${label} konnte nicht gelöscht werden`
  },

  bookmarkErrors: {
    needUrl: 'Gib die URL einer selbst gehosteten Lithic-Instanz ein.',
    needHttp: 'Verwende eine HTTP- oder HTTPS-URL.'
  },

  deviceFlow: {
    unexpected: 'Unerwartete Antwort von GitHub',
    denied: 'Autorisierung auf GitHub abgelehnt.',
    expired: 'Dieser Code ist abgelaufen. Starte neu für einen neuen.',
    failed: 'Autorisierung fehlgeschlagen oder abgelaufen. Erzeuge einen neuen Code.'
  },

  serverSync: {
    noCode: 'GitHub hat nicht mit einem Code geantwortet.',
    unreachableForCode: 'Dieser Server war für einen Code nicht erreichbar.',
    noRepos: 'Deine Repositories konnten nicht aufgelistet werden.',
    noCreate: 'Das Repository konnte nicht erstellt werden.',
    unreachableForSetup: 'Dieser Server war zum Einrichten der Sicherung nicht erreichbar.',
    setupFailed: 'Einrichtung fehlgeschlagen.',
    setupFailedDetail: (detail: string) => `Einrichtung fehlgeschlagen: ${detail}`
  },

  status: {
    opening: 'Öffnet…',
    openingRecent: 'Ein letzter Lith wird geöffnet…',
    loadingBlank: 'Ein leerer Lith wird geladen…',
    openFailed: (detail: string) => `Öffnen fehlgeschlagen: ${detail}`,
    mounted: (name: string) => `${name} eingebunden`,
    mountedReadOnly: (name: string) => `${name} schreibgeschützt eingebunden`,
    mountedPatched: (name: string) => `${name} eingebunden. Speicherungen senden nur die Änderungen.`,
    noPath: 'Kein Dateipfad erfasst. Öffne ihn einmal über Einbinden, um ihn wieder zu verknüpfen.',
    added: (count: number) => `${count} Liths zu den letzten hinzugefügt`,
    uploading: (names: readonly string[]) =>
      names.length === 1 ? `Lade ${names[0]} hoch…` : `Lade ${names.length} Liths hoch…`,
    uploaded: (count: number) => `${count} Liths hochgeladen`,
    uploadFailed: (detail: string) => `Hochladen fehlgeschlagen: ${detail}`,
    replaceOne: 'Diesen Lith ersetzen?',
    replaceMany: 'Diese Liths ersetzen?',
    replaceBodyOne: (name: string) => `${name} ist bereits auf diesem Server. Hochladen ersetzt ihn.`,
    replaceBodyMany: (names: string) => `${names} sind bereits auf diesem Server. Hochladen ersetzt sie.`,
    replaceConfirm: 'Ersetzen',
    listingFailed: (detail: string) => `Die Liths dieses Servers konnten nicht aufgelistet werden (${detail}).`,
    openingName: (name: string) => `${name} wird geöffnet…`,
    openNameFailed: (name: string, detail: string) => `${name} konnte nicht geöffnet werden: ${detail}`,
    creating: (name: string) => `${name} wird erstellt…`,
    createFailed: (name: string, detail: string) => `${name} konnte nicht erstellt werden: ${detail}`,
    deleteTitle: 'Diesen Lith löschen?',
    deleteConfirm: 'Löschen',
    deleting: (name: string) => `${name} wird gelöscht…`,
    deleteFailed: (name: string, detail: string) => `${name} konnte nicht gelöscht werden: ${detail}`,
    deleteBody: (name: string) => `${name} wird vom Server gelöscht, nicht nur von diesem Gerät.`,
    recovering: (edits: number, name: string) =>
      `Rufe ${edits} ${edits === 1 ? 'ungespeicherte Änderung' : 'ungespeicherte Änderungen'} für ${name} wieder her`,
    editsKept: 'Ungespeicherte Änderungen für später behalten',
    recovered: (name: string) => `${name} wiederhergestellt`,
    savedFile: (name: string) => `${name} gespeichert`,
    downloadingFile: (name: string) => `${name} wird heruntergeladen`,
    downloadFailed: (detail: string) => `Download fehlgeschlagen: ${detail}`,
    noCachedCopy: (name: string) => `Keine zwischengespeicherte Kopie von ${name} zum Herunterladen`,
    deviceSent: (name: string) => `${name} an Ihre Geräte gesendet`,
    deviceSendFailed: (detail: string) => `Dieses Lith konnte nicht gesendet werden: ${detail}`,
    deviceHistoryFailed: (detail: string) => `Die empfangene Version konnte nicht gespeichert werden: ${detail}`,
    deviceLoaded: (name: string) => `${name} von Ihren Geräten geladen`,
    deviceLoadFailed: (detail: string) => `Dieses Lith konnte nicht geladen werden: ${detail}`,
    reindexing: 'Zuletzt verwendete Liths werden neu indexiert…',
    reindexed: (count: number) => `${count} ${count === 1 ? 'Lith' : 'Liths'} neu indexiert`,
    indexedHere: (count: number) => `${count} ${count === 1 ? 'Lith' : 'Liths'} hier für die Suche indexiert`,
    nothingToIndex: 'Nichts Neues zu indexieren',
    reindexFailed: (detail: string) => `Neuindexierung fehlgeschlagen: ${detail}`,
    rebuildCancelled: 'Neuaufbau abgebrochen',
    indexingLabel: 'Indexiere',
    reindexingLabel: 'Indexiere neu',
    indexProgress: (label: string, position: number, total: number, name: string) =>
      `${label} ${position} von ${total} · ${name}`,
    scratchSaveFailed: 'Serialisieren des Entwurfs fehlgeschlagen; die Datei blieb unverändert.',
    monolithSaveFailed: 'Serialisieren der Seite fehlgeschlagen; die gespeicherte Kopie blieb unverändert.',
    noHistory: 'Für dieses Wiki gibt es noch keinen Versionsverlauf.',
    noHistoryVersion: 'Diese Version konnte nicht aus dem Verlauf erzeugt werden.',
    introFailed: 'Die Einführung konnte nicht geladen werden.',
    droppedInvalid: 'Die abgelegte Datei hat kein gültiges Datenformat.',
    payloadFailed: 'Der geteilte Inhalt konnte nicht geladen werden',
    blankLithFailed: 'Das lokale Wiki konnte nicht geladen werden',
    engineUnavailable: (status: string) => `Die Wiki-Engine konnte nicht geladen werden (${status})`,
    engineMissing: 'Die Lithic-Engine konnte weder lokal noch aus dem Offline-Cache noch online geladen werden.'
  },

  fileTypes: {
    monolith: 'Lithic-Monolith',
    html: 'Lithic-HTML-Datei',
    htmlMany: 'Lithic-HTML-Dateien',
    json: 'Lithic-JSON-Sicherungen',
    text: 'Bearbeitbare Textdateien',
    notebook: 'Jupyter-Notebooks',
    notebookOne: 'Jupyter-Notebook'
  }
};

/** Every locale this build can ship: one object per language, shaped like `en`. */
const locales = { en, es, fr, de };

/** The languages the launcher can be read in. */
export type LocaleId = keyof typeof locales;

/**
 * The BCP-47 tag for each locale, for the places a two-letter key will not do.
 *
 * A deck is keyed by the short name a URL carries (`es`); a document and a date want the tag
 * (`es-ES`). Typed as a `Record` over `LocaleId` so a language added to the deck without a
 * tag is a compile error rather than an English document claiming to be Spanish.
 */
const LOCALE_TAGS: Record<LocaleId, string> = { en: 'en-GB', es: 'es-ES', fr: 'fr-FR', de: 'de-DE' };

/**
 * Every deck this build carries, keyed by the name a URL uses.
 *
 * Exported for the unit tests, which walk all of them rather than only the one this process
 * happens to read: a leaf that is empty in a deck nobody here is reading is still a blank line
 * in front of somebody who reads that language.
 */
export const decks = locales;

/** The key for a language somebody wrote down, or nothing if this build cannot say it. */
function asLocale(value: string | null | undefined): LocaleId | undefined {
  const wanted = value?.trim().toLowerCase();
  if (!wanted) return undefined;
  return (Object.keys(locales) as LocaleId[]).find((key) => key.toLowerCase() === wanted);
}

/**
 * The best locale for a person's own language list, if this build can say any of it.
 *
 * Browsers hand over tags rather than languages (`es-419`, `es-MX`, `zh-Hant-TW`), so a tag is
 * matched by dropping subtags from the right until one lands on a locale this build ships.
 * Longest first, which is what would let a future `zh-Hant` answer a `zh-Hant-TW` reader
 * differently from a `zh-CN` one. The caller's order is the person's order and is never
 * sorted: somebody who lists French before English means it.
 */
export function matchLanguage(
  languages: readonly string[] | null | undefined
): LocaleId | undefined {
  const keys = Object.keys(locales) as LocaleId[];
  for (const asked of languages ?? []) {
    const subtags = asked.trim().toLowerCase().replace(/_/g, '-').split('-').filter(Boolean);
    for (let take = subtags.length; take > 0; take -= 1) {
      const found = keys.find((key) => key.toLowerCase() === subtags.slice(0, take).join('-'));
      if (found) return found;
    }
  }
  return undefined;
}

/** Everywhere a page's language can come from, strongest first. */
export type LocaleSources = {
  /**
   * The page's own query string. `?lang=es` is a request, and it is answered first. It is
   * also how a self-hosted instance pins its language: the redirector that sends `/` on to
   * the launcher brings `?lang=es` for a visit that brought no query of its own.
   */
  search?: string;
  /** The pin this artifact was built with (`VITE_LAUNCHER_LOCALE`). */
  built?: string | null;
  /** The person's own languages, in their own order. */
  languages?: readonly string[] | null;
};

/**
 * Which locale a page is read in, in three steps.
 *
 *   1. `?lang=es` on the URL. A request rather than a setting, so it outranks everything
 *      below it: it is how the gallery reviews a translation, how a self-hosted instance
 *      pins one (its redirector brings the query for a visit that brought none), and how
 *      anybody overrides a deployment without rebuilding it. A language this build cannot
 *      say is refused here and the search carries on, so a misspelled link still reads as
 *      the shipped language.
 *   2. The build's own pin, which is what a language site uses: one variable at build time
 *      speaks that language everywhere, including the places a query string cannot reach,
 *      such as a bookmark, a launcher an instance serves, or a wiki opened from the app.
 *   3. The person's own languages, which is the environment in every mode at once: the PWA
 *      reads the browser, an instance's launcher reads the same browser, and the desktop app
 *      reads the machine, since the webview it runs in is the machine's own.
 *
 * The pin outranks detection because that is what a pin is for: a deployment that was built
 * to speak Spanish says so to everybody, and the query string is the escape hatch rather than
 * the other way round.
 *
 * The sources are passed in rather than read here, so the whole order is a pure function the
 * unit tests can walk without a browser.
 */
export function resolveLocale(sources: LocaleSources = {}): LocaleId {
  return (
    asLocale(new URLSearchParams(sources.search ?? '').get('lang')) ??
    asLocale(sources.built) ??
    matchLanguage(sources.languages) ??
    'en'
  );
}

/**
 * The locale this page is read in, assembled from its environment once, at import.
 *
 * Every branch is guarded rather than assumed: this module is imported by the unit tests,
 * which run in Node with no `location`, no `window` and no `navigator`, and English is the
 * right answer there. The build's own pin is skipped rather than defaulted, because Vite can
 * only substitute `import.meta.env.VITE_LAUNCHER_LOCALE` where it appears literally.
 *
 * `navigator.language` leads the list it already belongs to. In every real browser the two
 * agree, since `language` is the first entry of `languages`, so nothing is decided
 * differently, and a locale a reviewer forced with a browser's own tools, which moves
 * `language` alone, is heard instead of ignored. The desktop app needs no separate reading:
 * WebView2 and WKWebView report the machine's language here, which is the one a packaged app
 * is expected to follow.
 */
export const LOCALE: LocaleId = resolveLocale({
  search: typeof location === 'undefined' ? '' : location.search,
  built: typeof location === 'undefined' ? undefined : import.meta.env.VITE_LAUNCHER_LOCALE,
  languages:
    typeof navigator === 'undefined' ? undefined : [navigator.language, ...navigator.languages]
});

/** The tag this page declares itself in: `document.documentElement.lang`, and every date it draws. */
export const LOCALE_TAG = LOCALE_TAGS[LOCALE];

/** The deck the rest of the launcher reads. */
export const copy = locales[LOCALE];
