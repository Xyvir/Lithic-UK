/**
 * PWA install state for the browser launcher: the install affordance exists
 * only while the browser reports an installable-but-not-installed app.
 *
 * The browser drives everything: `beforeinstallprompt` fires only when the
 * PWA criteria are met and the app is not already installed, and
 * `appinstalled` fires once the user accepts. Listening starts at module import
 * so an early Android Chrome event cannot beat Svelte's first subscription.
 */
import { writable } from 'svelte/store';

export type PwaInstallState = {
  /** Browser offered installation (not currently installed). */
  installable: boolean;
  /** Running as an installed/standalone app right now. */
  installed: boolean;
};

type InstallPromptResult = { outcome: 'accepted' | 'dismissed' };
type DeferredInstallPrompt = Event & {
  prompt: () => Promise<void | InstallPromptResult>;
  userChoice?: Promise<InstallPromptResult>;
};

function initialState(): PwaInstallState {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return { installable: false, installed: false };
  }
  return {
    installable: false,
    installed: window.matchMedia('(display-mode: standalone)').matches
  };
}

export const pwaInstall = writable<PwaInstallState>(initialState());

/** Browser recents reset also restores the install offer; Tauri stores it in recents.txt. */
export function shouldRestoreInstallOfferOnReset(mode: 'webapp' | 'self-host' | 'tauri'): boolean {
  return mode !== 'tauri';
}

/** Native prompt handle captured from beforeinstallprompt. */
let deferredPrompt: DeferredInstallPrompt | null = null;

function update(patch: Partial<PwaInstallState>): void {
  pwaInstall.update((state) => ({ ...state, ...patch, installed: patch.installed ?? initialState().installed }));
}

/** Capture an offered browser prompt without relying on a component subscription. */
export function captureInstallPrompt(event: Event, tauri = false): boolean {
  if (tauri) return false;
  event.preventDefault();
  deferredPrompt = event as DeferredInstallPrompt;
  update({ installable: true });
  return true;
}

export function listenForPwaInstallEvents(
  target: EventTarget & { __TAURI__?: unknown; __TAURI_INTERNALS__?: unknown }
): () => void {
  const onBeforeInstallPrompt = (event: Event) => {
    captureInstallPrompt(event, Boolean(target.__TAURI__ || target.__TAURI_INTERNALS__));
  };
  const onInstalled = () => {
    deferredPrompt = null;
    update({ installable: false, installed: true });
  };

  target.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
  target.addEventListener('appinstalled', onInstalled);
  return () => {
    target.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    target.removeEventListener('appinstalled', onInstalled);
  };
}

if (typeof window !== 'undefined') listenForPwaInstallEvents(window);

/**
 * Trigger the native PWA prompt during the button's user activation.
 * Returns 'unavailable' when no prompt was captured or the browser rejects it.
 */
export async function promptPwaInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const promptEvent = deferredPrompt;
  if (!promptEvent) return 'unavailable';

  // Each event is one-use. Drop it before calling into the browser, but do not
  // await anything first: Android Chrome requires prompt() inside the click.
  deferredPrompt = null;
  let promptResult: ReturnType<DeferredInstallPrompt['prompt']>;
  try {
    // Start the native prompt before notifying subscribers that this one-use offer is gone.
    promptResult = promptEvent.prompt();
  } catch {
    update({ installable: false });
    return 'unavailable';
  }
  update({ installable: false });
  try {
    const result = await promptResult;
    if (result?.outcome === 'accepted' || result?.outcome === 'dismissed') return result.outcome;
    const choice = await promptEvent.userChoice;
    return choice?.outcome === 'dismissed' ? 'dismissed' : 'accepted';
  } catch {
    return 'unavailable';
  }
}
