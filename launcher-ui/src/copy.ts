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
    /** Why the button is worth pressing, per platform. */
    offer: {
      browser: 'Add the launcher to this device',
      update: 'Download the new version, then press Update Install',
      desktop: 'Copy to Documents and add a Start Menu shortcut'
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
      closeAria: 'Close version history dialog',
      title: (name: string) => `${name} Version History`,
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
    pinAria: (name: string, title: string) => `Open ${name} and pin “${title}” to top`,
    openAria: (name: string) => `Open ${name}`,
    pinTitle: 'Open and pin this tiddler',
    removeAria: (name: string) => `Remove ${name}`,
    cachedLocally: 'Cached locally',
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
    resetTitle: 'Clears this list and its local history. Your files stay.'
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
      desktop: 'Copia a Documentos y crea un acceso en el menú Inicio'
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
      closeAria: 'Cerrar el diálogo del historial',
      title: (name: string) => `Historial de ${name}`,
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
    pinAria: (name: string, title: string) => `Abrir ${name} y fijar “${title}” arriba`,
    openAria: (name: string) => `Abrir ${name}`,
    pinTitle: 'Abrir y fijar este tiddler',
    removeAria: (name: string) => `Quitar ${name}`,
    cachedLocally: 'Guardado localmente',
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
    resetTitle: 'Borra esta lista y su historial local. Tus archivos se quedan.'
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

/** Every locale this build can ship: one object per language, shaped like `en`. */
const locales = { en, es };

/** The languages the launcher can be read in. */
export type LocaleId = keyof typeof locales;

/**
 * Which locale a page uses.
 *
 * `asked` is a request, and a request nobody carries is refused rather than trusted: an
 * unknown or misspelled language falls back to English, so a bad link reads as the
 * shipped language instead of a page with no words in it.
 */
export function resolveLocale(search: string, built?: string | null): LocaleId {
  const asked = new URLSearchParams(search).get('lang') || built || '';
  return asked in locales ? (asked as LocaleId) : 'en';
}

/**
 * The locale this deployment ships, in two steps.
 *
 * `?lang=es` is the review path: the gallery and anybody with the shipped artifact can see
 * another language without a second build. `VITE_LAUNCHER_LOCALE=es` is the deployment path,
 * and the one a real language site uses: one environment variable at build time produces an
 * artifact that is Spanish everywhere, including in the places a query string cannot reach
 * (a bookmark, a launcher an instance serves, a wiki opened from the app).
 *
 * The `typeof location` test is not decoration: this module is imported by the unit tests,
 * which run in Node with no `location` and no Vite env, and English is the right answer
 * there. Reading the build's own locale is skipped rather than guarded, because Vite can
 * only substitute `import.meta.env.VITE_LAUNCHER_LOCALE` where it appears literally.
 */
export const LOCALE: LocaleId = resolveLocale(
  typeof location === 'undefined' ? '' : location.search,
  typeof location === 'undefined' ? undefined : import.meta.env.VITE_LAUNCHER_LOCALE
);

/** The deck the rest of the launcher reads. */
export const copy = locales[LOCALE];
