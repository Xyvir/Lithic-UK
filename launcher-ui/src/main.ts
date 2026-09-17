import { mount } from 'svelte';
import App from './App.svelte';
import { resolveMode } from './mode';
import './styles.css';

const mode = resolveMode(window.location);

// Preserve the legacy globals expected by the existing launcher integrations.
window.__LITHIC_LAUNCHER_MODE__ = mode;
// Ephemeral code-runner resolution: self-host instances post to the same-origin
// /ephemeral API; the webapp discovers a paper-light bastion from swarm.json.
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
