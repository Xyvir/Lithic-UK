<script lang="ts">
  import type { LauncherMode } from './mode';

  export let mode: LauncherMode;

  const modeDescription: Record<LauncherMode, string> = {
    webapp: 'Browser web app',
    tauri: 'Tauri desktop app',
    'self-host': 'Self-hosted sync app'
  };
</script>

<svelte:head>
  <link rel="manifest" href="/manifest.json" />
  <link rel="shortcut icon" type="image/x-icon" href="/favicon.ico" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous" />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Vollkorn:ital,wght@0,400;0,600;1,400&display=swap" />
</svelte:head>

<main class="container" data-mode={mode}>
  <header class="heading">
    <div class="fallback-icon" aria-hidden="true">L</div>
    <h1>Lithic</h1>
    <span class="mode-pill">{mode}</span>
  </header>

  <section class="section" aria-labelledby="scaffold-title">
    <h2 id="scaffold-title">Launcher modularization</h2>
    <p>This is the Svelte migration shell. Existing launcher behavior remains in <code>src/launcher.html</code> until each feature is migrated and covered by tests.</p>
    <p class="mode-description">Running as: {modeDescription[mode]}</p>
  </section>
</main>
