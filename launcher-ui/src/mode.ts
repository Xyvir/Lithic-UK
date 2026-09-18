export const MODES = ['webapp', 'tauri', 'self-host'] as const;
export type LauncherMode = (typeof MODES)[number];

/**
 * How the Ephemeral code-runner reaches an execution backend:
 *   'self-host'   -> same-origin /ephemeral/api/v1/* (the WebDAV backend proxies it)
 *   'paper-light' -> discover a bastion from docs/swarm.json and POST over https
 */
const MODE_QUERY_KEYS = ['mode', 'launcher-mode', 'launcher_mode'];

export function resolveMode(location: Location): LauncherMode {
  const params = new URLSearchParams(location.search);
  const forced = MODE_QUERY_KEYS
    .map((key) => params.get(key)?.trim().toLowerCase())
    .find((value): value is LauncherMode => MODES.includes(value as LauncherMode));

  if (forced) return forced;
  if (typeof window !== 'undefined' && '__TAURI__' in window) return 'tauri';

  const isSelfHost = location.pathname.startsWith('/sync/')
    || location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || location.hostname.endsWith('.local');

  return isSelfHost ? 'self-host' : 'webapp';
}
