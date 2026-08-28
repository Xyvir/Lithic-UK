/// <reference types="vite/client" />

declare global {
  interface Window {
    __TAURI__?: unknown;
    __LITHIC_LAUNCHER_MODE__?: import('./mode').LauncherMode;
  }
}

export {};
