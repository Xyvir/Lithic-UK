/**
 * PWA install state for the webapp launcher, mirroring the legacy
 * document-tail wiring: the install affordance only exists while the
 * browser reports an installable-but-not-installed app.
 *
 * The browser drives everything: `beforeinstallprompt` fires only when the
 * PWA criteria are met and the app is not already installed, and
 * `appinstalled` fires once the user accepts. A `display-mode: standalone`
 * check covers browsers where the launch already runs as an installed app
 * without firing those events. Listening starts at module import (not
 * component mount) so early-fired events are never missed.
 */
import { readable } from 'svelte/store';

export type PwaInstallState = {
  /** Browser offered installation (not currently installed). */
  installable: boolean;
  /** Running as an installed/standalone app right now. */
  installed: boolean;
};

/** Native prompt handle captured from beforeinstallprompt. */
let deferredPrompt: (Event & { prompt: () => Promise<void> }) | null = null;

function initialState(): PwaInstallState {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return { installable: false, installed: false };
  }
  return {
    installable: false,
    installed: window.matchMedia('(display-mode: standalone)').matches
  };
}

export const pwaInstall = readable(initialState(), function start(set) {
  if (typeof window === 'undefined') return () => {};

  const update = (patch: Partial<PwaInstallState>) => {
    set({ ...initialState(), ...patch, installed: window.matchMedia('(display-mode: standalone)').matches });
  };

  const onBeforeInstallPrompt = (event: Event) => {
    if (window.__TAURI__ || (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return;
    event.preventDefault();
    deferredPrompt = event as Event & { prompt: () => Promise<void> };
    update({ installable: true });
  };

  const onInstalled = () => {
    deferredPrompt = null;
    update({ installable: false });
  };

  window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  window.addEventListener('appinstalled', onInstalled);

  return () => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.removeEventListener('appinstalled', onInstalled);
  };
});

/**
 * Trigger the native install prompt; resolves to the user's choice.
 * Returns 'unavailable' when no prompt was captured (not installable).
 */
export async function promptPwaInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredPrompt) return 'unavailable';
  const prompt = deferredPrompt.prompt;
  const choice = (deferredPrompt as { userChoice?: Promise<{ outcome: string }> }).userChoice;
  deferredPrompt = null;
  await prompt();
  try {
    return (await choice)?.outcome === 'dismissed' ? 'dismissed' : 'accepted';
  } catch {
    return 'accepted';
  }
}
