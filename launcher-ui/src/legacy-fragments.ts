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
 */
export const launcherFragments: LauncherFragment[] = [
  { id: 'document.bootstrap', source: 'document-head.html', responsibility: 'Document metadata and original-path setup', status: 'extracted' },
  { id: 'runtime.state', source: 'runtime.js', responsibility: 'Global pending imports, session, and mode state', status: 'migrated' },
  { id: 'runtime.storage', source: 'runtime.js', responsibility: 'IndexedDB storage and cache lifecycle', status: 'migrated' },
  { id: 'runtime.format', source: 'runtime.js', responsibility: 'Lith parser and serializer', status: 'migrated' },
  { id: 'runtime.engine', source: 'runtime.js', responsibility: 'Core lithic.html loading and HTML mounting', status: 'migrated' },
  { id: 'runtime.local-saver', source: 'runtime.js', responsibility: 'File System Access API saver and Save As behavior', status: 'migrated' },
  { id: 'runtime.webdav', source: 'runtime.js', responsibility: 'WebDAV listing, locks, upload, and saver', status: 'pending' },
  { id: 'runtime.launch', source: 'runtime.js', responsibility: 'Blank, file, URL, and startup handoffs', status: 'migrated' },
  { id: 'ui.launcher', source: 'document-body.html', responsibility: 'Launcher actions and status UI', status: 'migrated' },
  { id: 'ui.recent', source: 'document-body.html', responsibility: 'Recent files list and cache controls', status: 'migrated' },
  { id: 'ui.modals', source: 'document-body.html', responsibility: 'Collision, bookmark, help, and sync dialogs', status: 'migrated' },
  { id: 'ui.offline', source: 'document-body.html', responsibility: 'Offline cache browsing UI', status: 'migrated' },
  { id: 'ui.emoji', source: 'document-body.html', responsibility: 'Emoji icon picker and persistence', status: 'migrated' },
  { id: 'ui.pwa', source: 'document-tail.html', responsibility: 'Service worker and install prompt wiring', status: 'migrated' },
];
