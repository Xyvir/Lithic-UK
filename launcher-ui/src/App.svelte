<script lang="ts">
  import { onMount } from 'svelte';
  import type { LauncherMode } from './mode';
  import { createFileBridge } from './file-bridge';
  import { bootLegacyWiki } from './legacy-launcher-runtime';

  export let mode: LauncherMode;
  const files = createFileBridge();
  const RECENT_KEY = 'lithic-recent-liths';
  let lithText = '';
  let fileName = 'untitled.lith';
  let filePath: string | undefined;
  let status = '';
  let busy = false;
  let showHelp = false;
  let showRecent = false;
  let recentFiles: Array<{ name: string; path?: string; text?: string }> = [];
  let search = '';
  let mountError = '';

  $: filteredRecent = recentFiles.filter((file) => file.name.toLowerCase().includes(search.toLowerCase()));

  function loadRecent() {
    try { recentFiles = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]'); } catch { recentFiles = []; }
  }
  function remember(file: { name: string; path?: string; text?: string }) {
    recentFiles = [file, ...recentFiles.filter((item) => item.path !== file.path && item.name !== file.name)].slice(0, 20);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentFiles));
  }
  function normalizeLithName(name: string): string {
    const withoutKnownExtension = name.replace(/\.(?:html?|lith)$/i, '');
    return `${withoutKnownExtension || 'untitled'}.lith`;
  }
  async function mountWiki(contents: string, name: string, path?: string) {
    mountError = '';
    const safeName = normalizeLithName(name);
    const handoff = { name: safeName, path, text: contents };
    remember(handoff);
    sessionStorage.setItem('lithic-launcher-file', JSON.stringify(handoff));
    await bootLegacyWiki(handoff);
  }

  async function blankLith() {
    busy = true;
    status = 'Loading blank Lith…';
    try {
      await mountWiki('', 'new.lith');
    } catch (error) {
      mountError = error instanceof Error ? error.message : String(error);
      status = 'Unable to load the local wiki';
      busy = false;
    }
  }
  async function mountFromDisk() {
    busy = true; status = 'Opening…';
    try {
      const result = await files.open();
      if (!result) { status = ''; return; }
      lithText = result.text; fileName = result.name; filePath = result.path; remember(result); await mountWiki(result.text, result.name, result.path); status = `Mounted ${result.name}`;
    } catch (error) { status = `Open failed: ${error instanceof Error ? error.message : String(error)}`; }
    finally { busy = false; }
  }
  async function openRecent(file: { name: string; path?: string; text?: string }) {
    if (file.text !== undefined) {
      lithText = file.text;
      fileName = file.name;
      filePath = file.path;
      status = `Mounted ${file.name}`;
      await mountWiki(file.text, file.name, file.path);
    }
    showRecent = false;
  }
  function clearRecent() { recentFiles = []; localStorage.removeItem(RECENT_KEY); }
  function removeRecent(file: { name: string; path?: string; text?: string }) {
    recentFiles = recentFiles.filter((item) => item !== file);
    localStorage.setItem(RECENT_KEY, JSON.stringify(recentFiles));
  }

  onMount(() => { loadRecent(); });
</script>

<svelte:head><title>Lithic - Launcher</title></svelte:head>

<main class="container" data-mode={mode}>
  <header class="heading">
    <div class="brand-icon" aria-hidden="true"><span>◒</span></div>
    <h1>Lithic - Launcher</h1>
    <button class="help-button" aria-label="Help" on:click={() => showHelp = !showHelp}>?</button>
  </header>
  {#if showHelp}<div class="help-panel">Create a blank <code>.lith</code> or mount one from disk. Saved files appear in Recent Liths.</div>{/if}
  <section class="launcher-actions" aria-label="Launcher actions">
    <div class="action-card"><button class="action-button" on:click={blankLith} disabled={busy}>New Blank Lith</button></div>
    <div class="action-card mount-card"><button class="action-button" on:click={mountFromDisk} disabled={busy}>Mount a Lith (or HTML) from Disk</button><button class="bookmark-button" aria-label="Bookmark a remote instance" title="Bookmark a Remote Instance" on:click={() => alert('Remote bookmarks will be available when sync is configured.')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5A2.5 2.5 0 0 1 8.5 1h7A2.5 2.5 0 0 1 18 3.5V22l-6-4-6 4z" /></svg></button></div>
  </section>
  {#if recentFiles.length > 0 || showRecent}
    <section class="recent-section" aria-label="Recent Liths">
      <div class="recent-heading"><h2>Recent Liths</h2><button class="recent-refresh" aria-label="Close recent liths" on:click={() => showRecent = false}>×</button></div>
      <input class="recent-search" placeholder="Search recent liths…" bind:value={search} />
      <div class="recent-list">
        {#if filteredRecent.length === 0}<p class="empty">No matching Liths.</p>{/if}
        {#each filteredRecent as file}<div class="recent-row"><button class="recent-name" on:click={() => openRecent(file)}>{file.name}</button><button class="remove-recent" aria-label={`Remove ${file.name}`} on:click={() => removeRecent(file)}>×</button></div>{/each}
      </div>
      <button class="reset-cache" on:click={clearRecent}>Clear All Recent Files</button>
    </section>
  {/if}
  {#if status}<div class="status" role="status">{status}</div>{/if}
  {#if mountError}<div class="status error" role="alert">{mountError}</div>{/if}
  <footer><a class="github-link" href="https://github.com/Lithic-UK/Lithic" target="_blank" rel="noreferrer">View on GitHub</a><button class="install-button" on:click={() => alert('Install is available from the browser menu.')} hidden={mode === 'tauri'}>Install App</button></footer>
</main>

