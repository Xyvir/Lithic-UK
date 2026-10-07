/// <reference types="vite/client" />

declare global {
  interface Window {
    __TAURI__?: unknown;
    __LITHIC_LAUNCHER_MODE__?: import('./mode').LauncherMode;
    /** The desktop app injected its API but served this document from elsewhere. */
    __LITHIC_HOSTED_IN_APP__?: boolean;
  }

  /**
   * Vite's own environment, narrowed to the variables this project reads.
   *
   * Vite types these as `any` (`[key: string]: any`), which would let a typo in a variable
   * name silently read `undefined` for ever. Naming the ones that exist gives them real
   * types and makes the launcher's build-time inputs countable: a new one is a line here.
   */
  interface ImportMetaEnv {
    /** The locale a language build ships, e.g. `es`. See `copy.ts`. */
    readonly VITE_LAUNCHER_LOCALE?: string;
    /**
     * The plugin roots the base ships, as a JSON array of `publisher/name`. See
     * `resolveDefaultPlugins` in `legacy-saver.ts`. `scripts/build-launcher.mjs` generates it
     * through `scripts/generate-default-plugins.mjs`, and the list is the *fallback*: a mount
     * reads the roots out of the base it is mounting first.
     */
    readonly VITE_LITHIC_BASE_PLUGINS?: string;
    /**
     * The document format a distribution writes and advertises: `lith`, `html` or `both`.
     * See `document-format.ts`, and `--document-format=` on `scripts/build-launcher.mjs`,
     * which sets it. It governs what the launcher produces, never what it can open.
     */
    readonly VITE_LITHIC_DOCUMENT_FORMAT?: string;
  }
}

export {};
