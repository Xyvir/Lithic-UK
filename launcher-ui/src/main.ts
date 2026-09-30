import { mount } from 'svelte';
import App from './App.svelte';
import { LOCALE_TAG } from './copy';
import { declaresBrowserOnly, hostedInApp, resolveMode } from './mode';
import './styles.css';

const mode = resolveMode(window.location);
// A page the shim served declares itself browser-only (see `mode.ts`). Read from
// the document rather than from the mode, since the shim's loopback address alone
// cannot say what answered it.
const browserOnly = declaresBrowserOnly(document);

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

// PWA offline support (the legacy launcher registers the same worker), and its
// deliberate absence on a page the shim served: that server runs on the same
// machine as the browser it opened, so it has no offline mode to keep and no
// cache that could answer a navigation with a launcher older than itself.
if (!browserOnly && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/offline-service-worker.js').catch(() => {
    // Registration is best-effort; the launcher works without it.
  });
}
