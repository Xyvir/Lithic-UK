import { mount } from 'svelte';
import App from './App.svelte';
import { LOCALE_TAG } from './copy';
import { hostedInApp, resolveMode } from './mode';
import './styles.css';

const mode = resolveMode(window.location);

/*
 * The page's own language declaration, which is not decoration: a screen reader picks its
 * voice from it, the browser hyphenates and spell-checks by it, and a Spanish page that says
 * `lang="en"` is wrong about itself in all three. A locale that reads right to left would
 * set `document.documentElement.dir` here as well.
 */
document.documentElement.lang = LOCALE_TAG;

// Preserve the legacy globals expected by the existing launcher integrations.
window.__LITHIC_LAUNCHER_MODE__ = mode;
// The app injected its global but did not serve this document, so the page in
// this window came from somewhere else (a bookmarked instance). Published for
// integrations that need the same distinction `resolveMode` now makes.
window.__LITHIC_HOSTED_IN_APP__ = hostedInApp(window.location);
// Ephemeral code-runner resolution: self-host instances post to the same-origin
// /ephemeral API; webapp and Tauri use the paper-light public swarm.
(window as any).__EPHEMERAL_MODE__ = mode === 'self-host' ? 'self-host' : 'paper-light';

mount(App, {
  target: document.getElementById('app')!,
  props: { mode }
});

// PWA offline support (legacy launcher registers the same worker).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/offline-service-worker.js').catch(() => {
    // Registration is best-effort; the launcher works without it.
  });
}
