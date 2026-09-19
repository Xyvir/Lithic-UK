export type LauncherFragment = {
  id: string;
  source: string;
  responsibility: string;
  status: 'extracted' | 'migrated' | 'pending';
};

/**
 * The legacy launcher is treated as an ordered collection of small runtime
 * fragments, similar to TiddlyWiki tiddlers. Keep this registry in dependency
 * order so each migration can be tested independently.
 *
 * Status notes:
 * - Self-host parity landed: runtime.webdav and ui.emoji are migrated, with
 *   two deliberate departures from the legacy launcher — saves send a git
 *   patch instead of re-serializing the whole wiki, and the instance icon is
 *   rendered client-side into the pre-sized favicon set (legacy needed the
 *   same PUTs, so the ordering contract is unchanged).
 * - document.bootstrap (original-path rewrite) is deployment glue and stays
 *   'extracted'.
 */
export const launcherFragments: LauncherFragment[] = [
  { id: 'document.bootstrap', source: 'document-head.html', responsibility: 'Document metadata and original-path setup', status: 'extracted' },
  { id: 'runtime.state', source: 'runtime.js', responsibility: 'Global pending imports, session, and mode state', status: 'migrated' },
  { id: 'runtime.storage', source: 'runtime.js', responsibility: 'IndexedDB storage and cache lifecycle', status: 'migrated' },
  { id: 'runtime.format', source: 'runtime.js', responsibility: 'Lith parser and serializer', status: 'migrated' },
  { id: 'runtime.engine', source: 'runtime.js', responsibility: 'Core lithic.html loading and HTML mounting', status: 'migrated' },
  { id: 'runtime.local-saver', source: 'runtime.js', responsibility: 'File System Access API saver and Save As behavior', status: 'migrated' },
  { id: 'runtime.pending-imports', source: 'runtime.js', responsibility: 'Pending imports queue, drag-and-drop parsing, and ?json=/?lith=/?url= payload injection', status: 'migrated' },
  { id: 'runtime.webdav', source: 'runtime.js', responsibility: 'WebDAV listing, presence locks, patch-first remote saver with whole-file fallback, and the read-only collision path', status: 'migrated' },
  { id: 'runtime.launch', source: 'runtime.js', responsibility: 'Blank, file, URL, and startup handoffs', status: 'migrated' },
  { id: 'ui.launcher', source: 'document-body.html', responsibility: 'Launcher actions and status UI', status: 'migrated' },
  { id: 'ui.recent', source: 'document-body.html', responsibility: 'Recent files list, search, and cache controls', status: 'migrated' },
  { id: 'ui.intro', source: 'document-body.html', responsibility: 'Intro payload link and offline fallback', status: 'migrated' },
  { id: 'ui.pending-imports', source: 'document-body.html', responsibility: 'Pending imports window', status: 'migrated' },
  { id: 'ui.modals', source: 'document-body.html', responsibility: 'Bookmark and active-session (lock collision) dialogs', status: 'migrated' },
  { id: 'ui.offline', source: 'document-body.html', responsibility: 'Offline cache browsing UI', status: 'migrated' },
  { id: 'ui.emoji', source: 'document-body.html', responsibility: 'Emoji instance-icon picker, favicon rendering, and persistence', status: 'migrated' },
  { id: 'ui.pwa', source: 'document-tail.html', responsibility: 'Service worker registration, manifest, and install prompt wiring', status: 'migrated' },
];
