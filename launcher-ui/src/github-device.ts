/**
 * GitHub OAuth device-flow response handling for the Tauri sync modal,
 * mirroring the legacy launcher's flow (launcher-fragments/runtime.js):
 * install app → github.com/login/device code → poll → pick/create repo.
 *
 * The raw HTTP calls live in Rust (github_device_code / github_device_poll);
 * this module keeps the parsing + poll-loop timing logic testable in plain TS.
 */

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri?: string;
  interval?: number;
  expires_in?: number;
}

export type DevicePollResult =
  | { kind: 'authorized'; token: string }
  | { kind: 'pending'; slowDown?: boolean }
  | { kind: 'failed'; message: string };

/** Parse a raw device-code request result (Rust already surfaces GitHub errors as rejections). */
export function parseDeviceCode(raw: unknown): DeviceCodeResponse | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const deviceCode = typeof record.device_code === 'string' ? record.device_code : null;
  const userCode = typeof record.user_code === 'string' ? record.user_code : null;
  if (!deviceCode || !userCode) return null;
  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: typeof record.verification_uri === 'string' ? record.verification_uri : undefined,
    interval: typeof record.interval === 'number' ? record.interval : undefined,
    expires_in: typeof record.expires_in === 'number' ? record.expires_in : undefined
  };
}

/** Parse one poll result into a decision the poll loop can act on. */
export function parseDevicePoll(raw: unknown): DevicePollResult {
  if (!raw || typeof raw !== 'object') return { kind: 'failed', message: 'Unexpected response from GitHub' };
  const record = raw as Record<string, unknown>;
  if (typeof record.access_token === 'string' && record.access_token) {
    return { kind: 'authorized', token: record.access_token };
  }
  if (record.pending === true) {
    return { kind: 'pending', slowDown: record.slow_down === true };
  }
  return { kind: 'failed', message: 'Authorization failed or expired. Generate a new code.' };
}

/**
 * Parse one poll result from the *server's* CGI, which relays GitHub raw.
 *
 * The desktop app's polls are normalized in Rust (`{pending: true}`), so
 * `parseDevicePoll` above is the shape Rust hands back. A self-hosted instance
 * has no normalization step: the JSON here is GitHub's own, error codes and all,
 * which is why the codes are named rather than collapsed into one failure —
 * `expired_token` is not the same answer as `access_denied`, and only the second
 * one means somebody said no.
 */
export function parseServerDevicePoll(raw: unknown): DevicePollResult {
  if (!raw || typeof raw !== 'object') return { kind: 'failed', message: 'Unexpected response from GitHub' };
  const record = raw as Record<string, unknown>;
  if (typeof record.access_token === 'string' && record.access_token) {
    return { kind: 'authorized', token: record.access_token };
  }
  switch (record.error) {
    case 'authorization_pending':
      return { kind: 'pending', slowDown: false };
    case 'slow_down':
      return { kind: 'pending', slowDown: true };
    case 'expired_token':
      return { kind: 'failed', message: 'That code expired. Start again for a new one.' };
    case 'access_denied':
      return { kind: 'failed', message: 'Authorization denied on GitHub.' };
    default:
      return { kind: 'failed', message: 'Authorization failed or expired. Generate a new code.' };
  }
}

/** GitHub's slow_down directive adds 5 seconds to every subsequent interval (RFC 8628 §3.5). */
export function pollDelayMs(intervalSeconds: number | undefined, slowDown: boolean): number {
  const base = Math.max(1, Math.floor(intervalSeconds ?? 5));
  return (base + (slowDown ? 5 : 0)) * 1000;
}

/**
 * User codes read better in groups of four (ABCD-1234), matching GitHub's
 * own device page presentation.
 */
export function formatUserCode(userCode: string): string {
  const code = userCode.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (code.length <= 4) return code;
  return `${code.slice(0, 4)}-${code.slice(4, 8) || ''}`.replace(/-$/, '');
}

/** Default name for a freshly created sync repo (legacy parity: lithic-sync-xxxx). */
export function generateRepoName(random: () => number = Math.random): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous 0/O/1/I
  let id = '';
  for (let i = 0; i < 4; i++) id += chars.charAt(Math.floor(random() * chars.length));
  return `lithic-sync-${id.toLowerCase()}`;
}

/**
 * Repos the UI offers for linking: Lithic-created sync repos first, then
 * everything else the user owns (legacy filtered hard; the desktop user may
 * legitimately want any of their repos).
 */
export function partitionRepos(repos: Array<{ full_name: string }>): { managed: string[]; other: string[] } {
  const managed: string[] = [];
  const other: string[] = [];
  for (const repo of repos) {
    const name = String(repo.full_name || '');
    if (!name) continue;
    if (name.split('/').pop()?.startsWith('lithic-')) managed.push(name);
    else other.push(name);
  }
  return { managed, other };
}
