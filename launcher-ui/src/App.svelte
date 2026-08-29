<script lang="ts">
  import { onMount } from 'svelte';
  import type { LauncherMode } from './mode';
  import { createFileBridge } from './file-bridge';
  import { bootLegacyWiki } from './legacy-launcher-runtime';
  import { getRecentFiles, addRecentFile, removeRecentFile, clearAllRecentFiles, idb, type RecentEntry } from './storage';

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
  let recentFiles: Array<RecentEntry | { name: string; path?: string; text?: string; handle?: any }> = [];
  let search = '';
  let mountError = '';

  function getEntryName(entry: RecentEntry | { name?: string; handle?: any }): string {
    if (entry.handle && entry.handle.name) return entry.handle.name;
    return (entry as any).name || 'untitled.lith';
  }

  $: filteredRecent = recentFiles.filter((file) => getEntryName(file).toLowerCase().includes(search.toLowerCase()));

  async function loadRecent() {
    try {
      const idbList = await getRecentFiles();
      if (idbList && idbList.length > 0) {
        recentFiles = idbList;
      } else {
        const ls = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
        recentFiles = ls;
      }
    } catch {
      recentFiles = [];
    }
  }

  async function remember(file: { name: string; path?: string; text?: string; handle?: any }) {
    if (file.handle) {
      recentFiles = await addRecentFile(file.handle, file.path ?? null);
    } else {
      const name = file.name;
      recentFiles = [file, ...recentFiles.filter((item) => getEntryName(item) !== name)].slice(0, 20);
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentFiles.map(({ name, path, text }) => ({ name, path, text }))));
    }
  }

  function normalizeLithName(name: string): string {
    const withoutKnownExtension = name.replace(/\.(?:html?|lith|json)$/i, '');
    return `${withoutKnownExtension || 'untitled'}.lith`;
  }

  async function mountWiki(contents: string, name: string, path?: string, handle?: any) {
    mountError = '';
    const safeName = normalizeLithName(name);
    const handoff = { name: safeName, path, text: contents };
    await remember({ ...handoff, handle });
    sessionStorage.setItem('lithic-launcher-file', JSON.stringify(handoff));
    if (typeof window !== 'undefined') {
      if (handle) {
        (window as any).__LITHIC_FILE_HANDLE__ = handle;
      } else {
        delete (window as any).__LITHIC_FILE_HANDLE__;
      }
    }
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
      lithText = result.text; fileName = result.name; filePath = result.path;
      await mountWiki(result.text, result.name, result.path, result.handle);
      status = `Mounted ${result.name}`;
    } catch (error) { status = `Open failed: ${error instanceof Error ? error.message : String(error)}`; }
    finally { busy = false; }
  }

  async function openRecent(recent: RecentEntry | { name?: string; path?: string; text?: string; handle?: any }) {
    busy = true;
    status = 'Opening recent Lith…';
    try {
      const handle = (recent as any).handle;
      if (handle) {
        if (handle.queryPermission) {
          const options = { mode: 'read' };
          if ((await handle.queryPermission(options)) !== 'granted') {
            await handle.requestPermission(options);
          }
        }
        const file = await handle.getFile();
        const text = await file.text();
        await mountWiki(text, file.name, (recent as any).tauriPath ?? undefined, handle);
        status = `Mounted ${file.name}`;
        return;
      }
      if ((recent as any).text !== undefined) {
        lithText = (recent as any).text;
        fileName = (recent as any).name || 'untitled.lith';
        filePath = (recent as any).path;
        status = `Mounted ${fileName}`;
        await mountWiki(lithText, fileName, filePath);
      }
    } catch (error) {
      status = `Open failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      busy = false;
      showRecent = false;
    }
  }

  async function clearRecent() {
    await clearAllRecentFiles();
    recentFiles = [];
    localStorage.removeItem(RECENT_KEY);
  }

  async function removeRecent(file: RecentEntry | { name?: string; handle?: any }) {
    if ((file as any).handle) {
      recentFiles = await removeRecentFile((file as any).handle);
      const name = (file as any).handle.name;
      await idb.del('search_cache_' + name);
      await idb.del('search_cache_bk1_' + name);
      await idb.del('search_cache_bk2_' + name);
    } else {
      recentFiles = recentFiles.filter((item) => item !== file);
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentFiles.map((f: any) => ({ name: f.name, path: f.path, text: f.text }))));
    }
  }

  onMount(() => { loadRecent(); });
</script>

<svelte:head><title>Lithic - Launcher</title></svelte:head>

<main class="container" data-mode={mode}>
  <header class="heading">
    <div class="brand-icon" aria-hidden="true"><span>◒</span></div>
    <div class="heading-copy">
      <h1>Lithic - Launcher</h1>
      {#if status}<div class="status-line" role="status">{status}<span class="activity-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>{/if}
      {#if mountError}<div class="status-line error" role="alert">{mountError}</div>{/if}
    </div>
    <button class="help-button" aria-label="Help" on:click={() => showHelp = !showHelp}>?</button>
  </header>
  {#if showHelp}<div class="help-panel">Create a blank <code>.lith</code> or mount one from disk. Saved files appear in Recent Liths.</div>{/if}
  <section class="launcher-actions" aria-label="Launcher actions">
    <div class="action-card"><button class="action-button" on:click={blankLith} disabled={busy}>New Blank Lith</button></div>
    <div class="action-card mount-card"><button class="action-button" on:click={mountFromDisk} disabled={busy}>Mount a Lith (or HTML) from Disk</button><button class="bookmark-button" aria-label="Bookmark a remote instance" title="Bookmark a Remote Instance" on:click={() => alert('Remote bookmarks will be available when sync is configured.')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5A2.5 2.5 0 0 1 8.5 1h7A2.5 2.5 0 0 1 18 3.5V22l-6-4-6 4z" /></svg></button></div>
  </section>
  {#if recentFiles.length > 0 || showRecent}
    <section class="recent-section" aria-label="Recent Liths">
      <input class="recent-search" aria-label="Search recent Liths" placeholder="Search recent liths…" bind:value={search} />
      <div class="recent-list">
        {#if filteredRecent.length === 0}<p class="empty">No matching Liths.</p>{/if}
        {#each filteredRecent as file}
          <div class="recent-row">
            <button class="recent-name" on:click={() => openRecent(file)}>
              {getEntryName(file)}
            </button>
            <button class="remove-recent" aria-label={`Remove ${getEntryName(file)}`} on:click={() => removeRecent(file)}>×</button>
          </div>
        {/each}
      </div>
      <button class="reset-cache" on:click={clearRecent}>Clear All Recent Files</button>
    </section>
  {/if}
  <footer><a class="github-link" href="https://github.com/Lithic-UK/Lithic" target="_blank" rel="noreferrer">Github</a><button class="install-button" on:click={() => alert('Install is available from the browser menu.')} hidden={mode === 'tauri'}>Install</button></footer>
</main>
