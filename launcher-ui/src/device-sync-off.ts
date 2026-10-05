/**
 * Device sync, on a launcher built without it (`--sync=github`).
 *
 * This is a build-time stand-in, not a runtime fallback: `vite.config.ts` aliases
 * `device-sync` here whenever the pin leaves device sync out, so the real module is never
 * resolved, its dynamic import of the wasm glue (`./lithic-sync/lithic_sync.js`) is never
 * written into the bundle, and a `github` build carries none of it. The names below are
 * the ones `App.svelte` reads at module scope, answered the way a page that has no engine
 * answers: unsupported, and no session to drive.
 *
 * The surface is deliberately smaller than the real module's. `svelte-check` still resolves
 * the real `device-sync.ts` (aliases are a bundler fact, not a language one), so the types
 * App draws against are the real ones under the type checker, and the tests import the real
 * module too: what this file has to satisfy is the bundler and nothing else.
 */
import type { SyncBackend } from './device-sync';

/** No engine on this page: a pinned build cannot run one, so this is `file`'s answer. */
export function deviceSyncSupport(): { ok: true; kind: SyncBackend } | { ok: false; reason: 'file' } {
  return { ok: false, reason: 'file' };
}

/**
 * No session. Never reached: with `deviceSyncSupport()` refusing, `App.svelte` draws no
 * control that could open the panel, so nothing asks this for its state or its buttons.
 */
export function deviceSyncSession(): never {
  throw new Error('device sync is not in this build');
}
