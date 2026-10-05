/**
 * What sync this launcher build speaks, decided when it is built.
 *
 * A launcher is one artifact shipped to every distribution (`deploy/autoupdate.sh` pulls the
 * same file into an instance that the PWA serves), so what it can draw is a fact about the
 * build rather than about the page. Two prongs hang off this:
 *
 * - GitHub sync, the repository a folder is backed up into. In the app and in shim-served
 *   pages the work is done by a process behind the page (the app's `gitcore`, the shim's
 *   `git.rs`); on an instance it is the server's own sync, over the instance's API.
 * - Device sync, the engine that pairs two machines and moves a Lith between them. The
 *   browser's is a wasm module served beside the launcher, the app's is native.
 *
 * The pin is the *build's* half of the answer and the host's report is the other half
 * (`sync_capabilities`, read in `App.svelte`): a pinned build knows what it can draw, and
 * the process serving the page says what it can actually do. Both are needed because the
 * desktop app bundles this same artifact while its own Rust is feature-gated separately.
 *
 * The four pins, and what each is for:
 *
 * - `auto` (the default, and what the main repository always publishes): both prongs are
 *   compiled in, and the page narrows them at runtime. The app it ships inside reports
 *   which prong its Rust has; an instance, whose launcher is served by a server rather
 *   than by a process, keeps the GitHub circle (its own sync) and gains the device one.
 *   This is the only pin where one artifact has to be right in more than one place, which
 *   is why it is the one that asks.
 * - `github`: only the repository prong. Device sync is dropped from the bundle at build
 *   time rather than hidden, so a `github` build carries neither the wasm glue nor a
 *   control that could never work.
 * - `iroh`: only the device prong, the opposite shedding. GitHub sync's controls are not
 *   drawn on any page, whatever the host can do.
 * - `both`: both drawn everywhere they are supported, GitHub still never in the PWA, whose
 *   pages reach no repository of their own.
 *
 * A pin is forced, not preferred, exactly like the language pin (`VITE_LAUNCHER_LOCALE`):
 * `?lang=` is a language pin's escape hatch because a query is a request a page can answer;
 * there is no query-string equivalent here, because a prong that was never compiled in is
 * not something a URL can ask for.
 *
 * A scratch build pins with `--sync=iroh`; the published artifact stays `auto`, which the
 * freshness gate enforces by rebuilding with no pin at all.
 */

/** The prongs a build can be pinned to speak. */
export type SyncPin = 'auto' | 'github' | 'iroh' | 'both';

/** Every pin, in the order the build flag's help and the README list them. */
export const SYNC_PINS: readonly SyncPin[] = ['auto', 'github', 'iroh', 'both'];

/** What a pin says a build contains: which prongs are *compiled in*. */
export interface SyncSurface {
  /** GitHub sync, the git-backed folder. */
  github: boolean;
  /** Device sync, the engine that pairs two machines. */
  device: boolean;
}

/**
 * Whether a value names a pin.
 *
 * The build flag rejects anything else, so this is for the artifact read back from a
 * page or a test rather than for the flag itself: an unknown string is not a pin.
 */
export function isSyncPin(value: unknown): value is SyncPin {
  return typeof value === 'string' && (SYNC_PINS as readonly string[]).includes(value);
}

/**
 * The pin a build was asked for, with `auto` for anything that names no pin.
 *
 * A value that names nothing (`undefined`, an empty string, whitespace) is the default
 * rather than an error, because that is how the freshness gate and CI call the build. A
 * value that names something else is refused by `build-launcher.mjs` before Vite ever runs,
 * so a typo cannot quietly become an `auto` artifact.
 */
export function resolveSyncPin(value: string | null | undefined): SyncPin {
  const pin = value?.trim();
  return isSyncPin(pin) ? pin : 'auto';
}

/**
 * What a pin compiles in.
 *
 * `auto` contains both, because which one a page may draw is not knowable until the page
 * asks the process behind it. The other three are the whole answer, and they are what the
 * bundle is shaken against.
 */
export function pinSurface(pin: SyncPin): SyncSurface {
  return {
    github: pin !== 'iroh',
    device: pin !== 'github'
  };
}

/**
 * The pin this artifact was built with (`VITE_LITHIC_SYNC`).
 *
 * Read the way `copy.ts` reads its own pin, and for the same reason: Vite substitutes
 * `import.meta.env.VITE_LITHIC_SYNC` only where it appears literally, and this module is
 * imported by unit tests that run in Node, where there is no `location` and no build. The
 * guard is what keeps the default in one place, and `auto` is the right answer in a test.
 */
export const SYNC_PIN: SyncPin =
  typeof location === 'undefined' ? 'auto' : resolveSyncPin(import.meta.env.VITE_LITHIC_SYNC);

/**
 * A build-time literal, substituted by `define` in `vite.config.ts`.
 *
 * Declared rather than imported because it has to stay an identifier: Vite replaces the text
 * `__LITHIC_SYNC_GITHUB__` wherever it appears, and the reason the flag is worth having as a
 * literal is that the bundle can then *fold* every branch that reads it. In Node, where the
 * unit tests run and no build has happened, the global is simply absent and the fallback below
 * answers with the default pin's value.
 */
declare const __LITHIC_SYNC_GITHUB__: boolean | undefined;

/**
 * Whether this build compiled GitHub sync in. The host may still be unable to do it.
 *
 * Folded to a literal in a pinned build (`--sync=iroh`), which is what takes the repository
 * dialogs, their setup screens and the modules only they import out of the artifact. A runtime
 * check that says no would hide the same controls while still shipping every line of them, and
 * what a pin is about is the artifact rather than the screen.
 */
export const SHOWS_GITHUB_SYNC: boolean =
  typeof __LITHIC_SYNC_GITHUB__ === 'undefined' ? pinSurface(SYNC_PIN).github : __LITHIC_SYNC_GITHUB__;

/**
 * Whether this build compiled device sync in.
 *
 * Not a substituted literal like the flag above, because this prong is shed by *resolution*:
 * `vite.config.ts` aliases `device-sync` and its panel to stand-ins when the pin leaves them
 * out, so there is no branch to fold. Both flags answer the same question for the code that
 * reads them, and neither depends on the other.
 */
export const SHOWS_DEVICE_SYNC: boolean = pinSurface(SYNC_PIN).device;
