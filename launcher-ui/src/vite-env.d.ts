/// <reference types="vite/client" />

declare global {
  interface Window {
    __TAURI__?: unknown;
    __LITHIC_LAUNCHER_MODE__?: import('./mode').LauncherMode;
    /** The desktop app injected its API but served this document from elsewhere. */
    __LITHIC_HOSTED_IN_APP__?: boolean;
  }
}

export {};
