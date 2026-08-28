import { mount } from 'svelte';
import App from './App.svelte';
import { resolveMode } from './mode';
import './styles.css';

const mode = resolveMode(window.location);

// Preserve the legacy globals expected by the existing launcher integrations.
window.__LITHIC_LAUNCHER_MODE__ = mode;

mount(App, {
  target: document.getElementById('app')!,
  props: { mode }
});
