<script lang="ts">
  import { onMount } from 'svelte';
  import type { LauncherMode } from './mode';
  import { createFileBridge } from './file-bridge';
  import { bootLegacyWiki, bootLegacyHtml } from './legacy-launcher-runtime';
  import { getRecentFiles, addRecentFile, removeRecentFile, clearAllRecentFiles, idb, type RecentEntry } from './storage';
  import { readBookmarks, saveBookmark, removeBookmark, verifyInstanceUrl, normalizeInstanceUrl } from './bookmarks';
  import { searchCachedWikis } from './cache-search';
  import { serializeJsonToLith } from './lithic-format';
  // Inlined as a base64 data URL (assetsInlineLimit: Infinity) so the brand
  // mark survives when pre-launcher.html is bundled into the Tauri app.
  import mstile150 from './mstile-150x150.png';
  import {
    parsePayloadText,
    tagRootDogear,
    parseDroppedData,
    decodePayloadParam,
    fetchRemotePayload,
    mergePendingImports,
    ephemeralIntegrationTiddlers,
    isPayloadShareUrl,
    type PendingTiddler
  } from './pending-imports';

  export let mode: LauncherMode;
  const files = createFileBridge();
  const RECENT_KEY = 'lithic-recent-liths';
  let lithText = '';
  let fileName = 'untitled.lith';
  let filePath: string | undefined;
  let status = '';
  let busy = false;
  let pendingImports: PendingTiddler[] = [];
  let introBusy = false;
  let dragCounter = 0;
  let showRecent = false;
  let recentFiles: Array<RecentEntry | { name: string; path?: string; text?: string; handle?: any }> = [];
  let search = '';
  let mountError = '';
  let bookmarks: string[] = [];
  let showBookmarkModal = false;
  let bookmarkInput = '';
  let bookmarkError = '';
  let bookmarkInputElement: HTMLInputElement;
  type CacheSearchEntry = { name: string; text: string; sizeBytes: number };
  type CacheSearchMatch = { preview: string; title?: string };

  function formatCacheSize(bytes: number): string {
    if (bytes <= 0) return '0 MB';
    const megabytes = bytes / (1024 * 1024);
    if (megabytes < 0.01) return '<0.01 MB';
    return `${megabytes.toFixed(2).replace(/\.?(0+)$/, '')} MB`;
  }
  let cachedEntries: Record<string, CacheSearchEntry> = {};
  let cacheSearchMatches: Record<string, CacheSearchMatch> = {};
  let cacheSearchRequest = 0;

  function positionCachePreview(node: HTMLElement) {
    let frame = 0;
    const list = node.closest('.recent-list');

    const update = () => {
      frame = 0;
      if (window.matchMedia('(max-width: 950px)').matches) {
        node.style.display = 'none';
        return;
      }

      const row = node.closest('.recent-row');
      const listRect = list?.getBoundingClientRect();
      const rowRect = row?.getBoundingClientRect();
      if (!rowRect || !listRect || rowRect.bottom < listRect.top || rowRect.top > listRect.bottom) {
        node.style.opacity = '0';
        return;
      }

      const containerRect = document.querySelector('.container')?.getBoundingClientRect();
      if (!containerRect) return;
      node.style.display = 'block';
      node.style.maxWidth = `${Math.min(430, Math.max(120, window.innerWidth - containerRect.right - 20))}px`;
      node.style.left = `${containerRect.right + 10}px`;
      node.style.top = `${rowRect.top + rowRect.height / 2}px`;
      node.style.transform = 'translateY(-50%)';
      node.style.opacity = '1';
    };

    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };

    schedule();
    window.addEventListener('resize', schedule);
    list?.addEventListener('scroll', schedule, { passive: true });
    return {
      destroy() {
        if (frame) cancelAnimationFrame(frame);
        window.removeEventListener('resize', schedule);
        list?.removeEventListener('scroll', schedule);
      }
    };
  }

  function getEntryName(entry: RecentEntry | { name?: string; handle?: any }): string {
    if (entry.handle && entry.handle.name) return entry.handle.name;
    return (entry as any).name || 'untitled.lith';
  }

  function deselectRecentSearch(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    (event.currentTarget as HTMLInputElement).blur();
  }

  $: filteredRecent = recentFiles.filter((file) => {
    const name = getEntryName(file);
    return name.toLowerCase().includes(search.toLowerCase()) || Boolean(cacheSearchMatches[name]?.preview);
  });

  $: filteredCached = Object.values(cachedEntries).filter((entry) => {
    const isRecent = recentFiles.some((file) => getEntryName(file) === entry.name);
    const query = search.trim().toLowerCase();
    if (!query) return false;
    const nameMatches = entry.name.toLowerCase().includes(query);
    return !isRecent && (nameMatches || Boolean(cacheSearchMatches[entry.name]?.preview));
  });

  async function updateCacheMatches(query: string) {
    const request = ++cacheSearchRequest;
    const entries: Record<string, CacheSearchEntry> = {};
    try {
      const keys = await idb.keys();
      const cacheKeys = keys.filter((key): key is string =>
        typeof key === 'string' && key.startsWith('search_cache_') && !key.startsWith('search_cache_bk')
      );
      await Promise.all(cacheKeys.map(async (key) => {
        try {
          const cache = await idb.get<{ text?: string }>(key);
          if (typeof cache?.text === 'string') {
            const name = key.slice('search_cache_'.length);
            entries[name] = { name, text: cache.text, sizeBytes: new Blob([cache.text]).size };
          }
        } catch { /* cached search is best effort */ }
      }));
    } catch { /* IndexedDB may be unavailable */ }

    if (request !== cacheSearchRequest) return;
    cachedEntries = entries;
    const matches = searchCachedWikis(Object.values(entries), query);
    const next: Record<string, CacheSearchMatch> = {};
    for (const [name, result] of Object.entries(matches)) {
      next[name] = { preview: result.preview, title: result.title };
    }
    cacheSearchMatches = next;
  }

  $: void updateCacheMatches(search);

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
    const isHtmlMonolith = /\.(?:html?|htm)$/i.test(name);
    const safeName = normalizeLithName(name);
    await remember({ name: isHtmlMonolith ? name : safeName, path, text: contents, handle });
    if (typeof window !== 'undefined') {
      if (handle) {
        (window as any).__LITHIC_FILE_HANDLE__ = handle;
      } else {
        delete (window as any).__LITHIC_FILE_HANDLE__;
      }
    }
    if (isHtmlMonolith) {
      // HTML monoliths are complete wiki pages — serve them as-is.
      await bootLegacyHtml(contents);
      return;
    }
    const handoff = { name: safeName, path, text: contents };
    sessionStorage.setItem('lithic-launcher-file', JSON.stringify(handoff));
    // Local mode always injects the Ephemeral integration on every mount,
    // then drains whatever the user queued via drop / share URL / intro.
    // The engine boots in place (document.open/write/close), keeping the
    // launcher URL in the address bar and preserving window globals; the
    // globals are also injected defensively so the Ephemeral widget
    // (__EPHEMERAL_MODE__) works regardless of the boot path.
    await bootLegacyWiki(handoff, [...pendingImports, ...ephemeralIntegrationTiddlers()], {
      __EPHEMERAL_MODE__: mode === 'self-host' ? 'self-host' : 'paper-light',
      __LITHIC_LAUNCHER_MODE__: mode
    });
    pendingImports = [];
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

  async function openIntro() {
    if (busy || introBusy) return;
    introBusy = true;
    try {
      try {
        const target = window.location.protocol === 'file:'
          ? 'https://raw.githubusercontent.com/Xyvir/Lithic-UK/refs/heads/main/intro.lith'
          : '/intro.lith';
        const response = await fetch(target);
        if (response.ok) {
          const text = await response.text();
          const parsed = parsePayloadText(text);
          if (parsed.length > 0) {
            pendingImports = tagRootDogear(parsed);
            await blankLith();
            return;
          }
        }
      } catch {
        // Fall through to the online introduction below.
      }
      if (navigator.onLine) {
        window.open('https://lithic.uk/intro.html', '_blank');
      } else {
        mountError = 'Could not load introduction. You appear to be offline and the local intro file is missing.';
      }
    } finally {
      introBusy = false;
    }
  }

  async function handleDrop(event: DragEvent) {
    const droppedText = event.dataTransfer?.getData('URL') || event.dataTransfer?.getData('text/plain') || '';
    if (droppedText && isPayloadShareUrl(droppedText)) {
      try {
        const urlObj = new URL(droppedText);
        const b64Json = urlObj.searchParams.get('json') ?? urlObj.searchParams.get('lith');
        const remoteUrl = urlObj.searchParams.get('url');
        let payload: PendingTiddler[] | null = null;
        if (remoteUrl) payload = await fetchRemotePayload(remoteUrl);
        else if (b64Json) payload = decodePayloadParam(b64Json);
        if (payload && payload.length > 0) {
          pendingImports = mergePendingImports(pendingImports, payload);
          return;
        }
      } catch {
        // Not a payload URL after all — treat as a file drop below.
      }
    }

    const files = event.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    const lowerName = file.name.toLowerCase();
    if (/\.(?:lith|json)$/.test(lowerName)) {
      try {
        const contents = await file.text();
        const parsed = parseDroppedData(contents, lowerName.endsWith('.lith'));
        if (parsed.length > 0) {
          pendingImports = mergePendingImports(pendingImports, parsed);
        }
      } catch {
        mountError = 'Dropped file is not valid data format.';
      }
    } else if (/\.(?:html?|htm)$/.test(lowerName)) {
      try {
        await mountWiki(await file.text(), file.name);
      } catch (error) {
        mountError = error instanceof Error ? error.message : String(error);
      }
    }
  }

  async function processUrlPayload() {
    const params = new URLSearchParams(window.location.search);
    const b64Json = params.get('json') ?? params.get('lith');
    const remoteUrl = params.get('url');
    if (!remoteUrl && !b64Json) return;
    let payload: PendingTiddler[] | null = null;
    try {
      payload = remoteUrl ? await fetchRemotePayload(remoteUrl) : decodePayloadParam(b64Json!);
    } catch {
      payload = null;
    }
    if (payload && payload.length > 0) {
      // Clear the query params to prevent a reload loop, then boot a fresh
      // wiki with the shared payload queued for injection.
      window.history.replaceState({}, document.title, window.location.pathname);
      pendingImports = payload;
      status = `${payload.length} shared tiddler${payload.length === 1 ? '' : 's'} ready to import`;
      await blankLith();
    } else {
      mountError = 'Unable to load the shared payload';
      status = '';
    }
  }

  function openBookmarkModal() {
    bookmarkInput = '';
    bookmarkError = '';
    showBookmarkModal = true;
    setTimeout(() => bookmarkInputElement?.focus(), 0);
  }

  function closeBookmarkModal() {
    showBookmarkModal = false;
    bookmarkError = '';
  }

  async function addInstanceBookmark() {
    let normalized: string;
    try {
      normalized = normalizeInstanceUrl(bookmarkInput);
    } catch (error) {
      bookmarkError = error instanceof Error ? error.message : String(error);
      return;
    }
    try {
      const result = await verifyInstanceUrl(normalized);
      if (!result.verified) {
        bookmarkError = 'The provided URL could not be verified as a Lithic instance.';
        return;
      }
      if (result.requiresManualConfirm && !window.confirm(`We couldn't verify the manifest (it appears to be protected by Basic Authentication or Forbidden).\n\nAre you sure you want to bookmark ${normalized}?`)) {
        return;
      }
      bookmarks = saveBookmark(normalized);
      closeBookmarkModal();
      status = 'Self-hosted instance bookmarked';
    } catch (error) {
      bookmarkError = error instanceof Error ? error.message : String(error);
    }
  }

  function openInstance(url: string) {
    window.location.href = url;
  }

  function removeInstanceBookmark(url: string) {
    bookmarks = removeBookmark(url);
  }

  async function downloadCachedFile(name: string) {
    try {
      const cache = await idb.get<{ text?: string }>('search_cache_' + name);
      if (!cache?.text) return;
      const text = cache.text.trim().startsWith('[') ? serializeJsonToLith(cache.text) : cache.text;
      const blob = new Blob([text], { type: 'application/x-lith' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name.replace(/\.(?:html?|lith|json)$/i, '') + '_recovered.lith';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) {
      mountError = error instanceof Error ? error.message : String(error);
    }
  }

  async function clearRecent() {
    await clearAllRecentFiles();
    recentFiles = [];
    cachedEntries = {};
    cacheSearchMatches = {};
    localStorage.removeItem(RECENT_KEY);
  }

  async function removeRecent(file: RecentEntry | { name?: string; handle?: any }) {
    if ((file as any).handle) {
      recentFiles = await removeRecentFile((file as any).handle);
      const name = (file as any).handle.name;
      await idb.del('search_cache_' + name);
      await idb.del('search_cache_bk1_' + name);
      await idb.del('search_cache_bk2_' + name);
      delete cachedEntries[name];
      delete cacheSearchMatches[name];
      cachedEntries = cachedEntries;
      cacheSearchMatches = cacheSearchMatches;
    } else {
      recentFiles = recentFiles.filter((item) => item !== file);
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentFiles.map((f: any) => ({ name: f.name, path: f.path, text: f.text }))));
    }
  }

  onMount(() => {
    loadRecent();
    bookmarks = readBookmarks();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeBookmarkModal();
    };
    window.addEventListener('keydown', closeOnEscape);

    // --- Drag and drop (legacy parity) ---
    const onDragOver = (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const onDragEnter = (event: DragEvent) => {
      event.preventDefault();
      dragCounter++;
      if (dragCounter === 1) document.body.classList.add('drag-over');
    };
    const onDragLeave = (event: DragEvent) => {
      event.preventDefault();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        document.body.classList.remove('drag-over');
      }
    };
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      dragCounter = 0;
      document.body.classList.remove('drag-over');
      void handleDrop(event);
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    // --- URL payload injection (?json= / ?lith= / ?url=) ---
    void processUrlPayload();

    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  });
</script>

<svelte:head><title>Lithic - Launcher</title></svelte:head>

<main class="container" data-mode={mode}>
  <header class="heading">
    <span class="brand-icon-wrap">
      <img class="brand-icon" src={mstile150} alt="Lithic" />
    </span>
    <div class="heading-copy">
      <h1>Lithic - Launcher</h1>
      {#if status}<div class="status-line" role="status"><span class="status-label">{status.replace(/[…\.\s]+$/, '')}</span><span class="activity-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>{/if}
      {#if mountError}<div class="status-line error" role="alert">{mountError}</div>{/if}
    </div>
    <button class="help-button" aria-label="View Introduction" title="View Introduction" on:click={openIntro}>{introBusy ? '…' : '?'}</button>
  </header>
  {#if pendingImports.length > 0}
    <div class="pending-imports" role="status" aria-label="Pending imports">
      <div class="pending-imports-header">
        <span>Pending Imports</span>
        <button type="button" aria-label="Clear pending imports" title="Clear pending imports" on:click={() => pendingImports = []}>✕</button>
      </div>
      <ul>
        {#each pendingImports as tiddler, index (tiddler.title ?? index)}
          <li class={/^\d{14}-\d{3,4}$/.test(tiddler.title ?? '') || Boolean(tiddler['stream-type']) ? 'tiddler-list' : ''}>{tiddler.title || 'Untitled Payload'}</li>
        {/each}
      </ul>
    </div>
  {/if}
  {#if showBookmarkModal}
    <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && closeBookmarkModal()}>
      <div class="launcher-modal" role="dialog" aria-modal="true" aria-labelledby="bookmark-title">
        <button class="modal-close" aria-label="Close bookmark dialog" on:click={closeBookmarkModal}>×</button>
        <h2 id="bookmark-title">Bookmark Remote Instance</h2>
        <p>Save the address of a self-hosted Lithic instance for quick access from this launcher.</p>
        <input bind:this={bookmarkInputElement} bind:value={bookmarkInput} aria-label="Self-hosted instance URL" placeholder="https://..." on:keydown={(event) => event.key === 'Enter' && addInstanceBookmark()} />
        {#if bookmarkError}<p class="status-line error" role="alert">{bookmarkError}</p>{/if}
        <div class="modal-actions"><button class="modal-action" on:click={addInstanceBookmark}>Save Bookmark</button><button class="modal-action secondary" on:click={closeBookmarkModal}>Cancel</button></div>      </div>
    </div>
  {/if}

  <section class="launcher-actions" aria-label="Launcher actions">
    <div class="action-card action-pair">
      <button class="action-button" on:click={blankLith} disabled={busy}>New Blank Lith</button>
      <button class="action-button mount-button" on:click={mountFromDisk} disabled={busy}>Mount a Lith</button>
      <button class="bookmark-button" aria-label="Bookmark a self-hosted instance" title="Bookmark a Remote Instance" on:click={openBookmarkModal}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16l-6-4z" /></svg></button>
    </div>
  </section>
  {#if bookmarks.length > 0 || recentFiles.length > 0 || Object.keys(cachedEntries).length > 0 || showRecent}
    <section class="recent-section" aria-label="Recent Liths">
      <div class="recent-search-wrap">
        <svg class="recent-search-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7.5"></circle><path d="m16.5 16.5 4 4"></path></svg>
        <input class="recent-search" aria-label="Search recent Liths" placeholder="Search recent liths…" bind:value={search} on:keydown={deselectRecentSearch} />
        {#if search}<button class="recent-search-clear" type="button" aria-label="Clear recent Lith search" on:click={() => search = ''}>×</button>{/if}
      </div>
      <div class="recent-list">
        {#each bookmarks.filter((url) => url.toLowerCase().includes(search.toLowerCase())) as url}
          <div class="recent-row bookmark-row">
            <button class="recent-name" on:click={() => openInstance(url)}>{url.replace(/^https?:\/\//, '')}</button>
            <button class="recent-icon-button remove-recent" type="button" aria-label={`Remove bookmark ${url}`} on:click={() => removeInstanceBookmark(url)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button>
          </div>
        {/each}
        {#if filteredRecent.length === 0 && filteredCached.length === 0 && bookmarks.filter((url) => url.toLowerCase().includes(search.toLowerCase())).length === 0}<p class="empty">No matching Liths.</p>{/if}
        {#each filteredRecent as file}
          {@const name = getEntryName(file)}
          <div class="recent-row">
            <button class="recent-name" on:click={() => openRecent(file)}>{name}{#if cachedEntries[name]}<span class="cached-size">{formatCacheSize(cachedEntries[name].sizeBytes)}</span>{/if}</button>
            <button class="recent-icon-button cache-history-button" type="button" disabled={!cachedEntries[name]} aria-label={`Download cached history for ${name}`} title={cachedEntries[name] ? 'Download cached history' : 'No cached history available'} on:click={() => downloadCachedFile(name)}>
              <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
            </button>
            {#if cacheSearchMatches[name]?.preview}
              <div use:positionCachePreview class="cache-preview" aria-label="Cached text match">{@html cacheSearchMatches[name].preview}</div>
            {/if}
            <button class="recent-icon-button remove-recent" type="button" aria-label={`Remove ${name}`} on:click={() => removeRecent(file)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17"></path></svg></button>
          </div>
        {/each}
        {#each filteredCached as entry}
          <div class="recent-row cached-only-row">
            <div class="recent-name cached-result" role="note">{entry.name}<span class="cached-size">{formatCacheSize(entry.sizeBytes)}</span><span class="cached-label">Cached locally</span></div>
            <button class="recent-icon-button cache-history-button" type="button" aria-label={`Download cached history for ${entry.name}`} title="Download cached history" on:click={() => downloadCachedFile(entry.name)}>
              <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><path class="history-icon-shape" d="m 73.595508,109.76746 c -7.198235,0 -13.103617,5.58342 -13.647229,12.64471 h -0.0072 V 138.2696 H 58.61606 l 2.32389,4.02559 2.324405,-4.02559 h -1.323433 v -15.85123 c 0.530186,-5.97937 5.534806,-10.65103 11.654586,-10.65103 6.474618,0 11.703161,5.22855 11.703161,11.70316 0,6.47462 -5.228543,11.70161 -11.703161,11.70161 -2.644513,0 -5.080809,-0.87232 -7.037814,-2.34508 v 2.39572 c 2.058162,1.23707 4.46633,1.94924 7.037814,1.94924 7.555498,0 13.703556,-6.14599 13.703556,-13.70149 0,-7.5555 -6.148058,-13.70304 -13.703556,-13.70304 z m -2.108915,7.49825 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path></svg>
            </button>
            {#if cacheSearchMatches[entry.name]?.preview}
              <div use:positionCachePreview class="cache-preview" aria-label="Cached text match">{@html cacheSearchMatches[entry.name].preview}</div>
            {/if}
          </div>
        {/each}
      </div>
      <button class="reset-cache" on:click={clearRecent}>Clear All Recent Files</button>
    </section>
  {/if}
  <footer><a class="github-link" href="https://github.com/Lithic-UK/Lithic" target="_blank" rel="noreferrer">Github</a><button class="install-button" on:click={() => alert('Install is available from the browser menu.')} hidden={mode === 'tauri'}>Install</button></footer>
</main>
