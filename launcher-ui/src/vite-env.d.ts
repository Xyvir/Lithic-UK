/// <reference types="vite/client" />

declare global {
  interface Window {
    __TAURI__?: unknown;
    __LITHIC_LAUNCHER_MODE__?: import('./mode').LauncherMode;
    /** The desktop app injected its API but served this document from elsewhere. */
    __LITHIC_HOSTED_IN_APP__?: boolean;
  }

  /**
   * Vite's own environment, narrowed to the one variable this project reads.
   *
   * Vite types these as `any` (`[key: string]: any`), which would let a typo in a variable
   * name silently read `undefined` for ever. Naming the one that exists gives it a real
   * type and makes the launcher's build-time inputs countable: a new one is a line here.
   */
  interface ImportMetaEnv {
    /** The locale a language build ships, e.g. `es`. See `copy.ts`. */
    readonly VITE_LAUNCHER_LOCALE?: string;
  }
}

export {};
