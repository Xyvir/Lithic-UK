/**
 * The shim's command wire, from the launcher page's side.
 *
 * The shim serves this page, so the page is the only caller the wire wants: it holds
 * the per-launch secret the shim wrote into the document it handed over, and it is at
 * the one origin the wire accepts. Everything the shim can do that a browser cannot
 * (write a real path, run git, hold a credential) will arrive here as a command, which
 * is why the transport is written before any command is. See `handle_command` in
 * `shim/src/lib.rs` for the checks on the other end.
 *
 * The shape is the codebase's own: a pure `read...` for the declaration, a function that
 * takes its `fetch` so it can be tested without a network, and a failure returned as a
 * value rather than thrown, exactly as `server-git-sync.ts` and `update-notice.ts` do.
 *
 * A page with no token makes no request at all. That is the honest answer for the three
 * distributions this module also ships to (the desktop app, a published deployment, an
 * instance): none of them serves the tag, so none of them has a wire to reach.
 */

/**
 * The meta tag carrying this launch's secret.
 *
 * The name is `TOKEN_META_NAME` in `shim/src/lib.rs`, and the two have to agree, so a
 * change there is a change here.
 */
export const SHIM_TOKEN_META = 'lithic-shim-token';

/** The endpoint the shim answers commands on. `COMMAND_PATH` in `shim/src/lib.rs`. */
export const SHIM_COMMAND_PATH = '/__lithic/command';

/** The header the secret rides in. `TOKEN_HEADER` in `shim/src/lib.rs`. */
export const SHIM_TOKEN_HEADER = 'x-lithic-token';

/**
 * This launch's secret, or null on a page no shim served.
 *
 * Read once at boot and never again: what served the page cannot change while the page
 * lives, and a secret that outlived its server would be useless anyway.
 */
export function readShimToken(doc: Pick<Document, 'querySelector'> | null): string | null {
  const content = doc?.querySelector(`meta[name="${SHIM_TOKEN_META}"]`)?.getAttribute('content')?.trim();
  return content ? content : null;
}

/**
 * What a command answered, or why it did not.
 *
 * `detail` is the sentence a failure can carry beside its code: a call that reached GitHub is
 * refused by GitHub and the shim passes its own wording through, because that text is what the
 * user is shown (the same split the desktop app's commands make). A failure that came from the
 * wire itself has no detail, so the code is all there is.
 */
export type ShimAnswer =
  | { ok: true; result: unknown }
  | { ok: false; error: string; detail?: string; status?: number };

/** Where the call reads its secret and its transport from, for tests and for boot. */
export interface ShimCall {
  fetcher?: typeof fetch;
  /** The secret; `undefined` reads the document, `null` says there is none. */
  token?: string | null;
  path?: string;
}

/**
 * Ask the shim's backend to do something, and never throw while asking.
 *
 * `no-shim` is the ordinary answer everywhere but a shim: with no token there is no
 * wire, and no request is made. Every other failure is one value too, because a command
 * that could not be delivered is a state the caller renders, not an exception to catch.
 */
export async function shimCommand(
  command: string,
  args: Record<string, unknown> = {},
  options: ShimCall = {}
): Promise<ShimAnswer> {
  const token =
    options.token !== undefined
      ? options.token
      : readShimToken(typeof document === 'undefined' ? null : document);
  if (!token) return { ok: false, error: 'no-shim' };
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(options.path ?? SHIM_COMMAND_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', [SHIM_TOKEN_HEADER]: token },
      body: JSON.stringify({ command, args })
    });
    if (!response.ok) return { ok: false, error: 'refused', status: response.status };
    const payload = (await response.json().catch(() => null)) as
      | { ok?: unknown; result?: unknown; error?: unknown; detail?: unknown }
      | null;
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'unreadable' };
    if (payload.ok === true) return { ok: true, result: payload.result };
    const detail = typeof payload.detail === 'string' && payload.detail ? payload.detail : undefined;
    return {
      ok: false,
      error: typeof payload.error === 'string' && payload.error ? payload.error : 'refused',
      ...(detail ? { detail } : {})
    };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
}
