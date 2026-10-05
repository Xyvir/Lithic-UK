<script lang="ts">
  /**
   * Device sync, as the launcher drives it.
   *
   * This is the whole user-facing half of the engine: it shows this device's ticket,
   * takes another device's, lists the paired folder, and is where bytes go out (a picked
   * Lith) and come in (a saved copy of an entry). Every button asks the session rather
   * than the engine, and every line it draws comes from the state the session published,
   * so the panel itself holds no facts about the folder.
   *
   * One panel, two engines: the browser's wasm module and the desktop app's native one
   * (see `device-sync.ts`). Nothing here branches on which, except a saved copy, which on
   * the app is a file the app writes rather than a download the page starts.
   */
  import { onDestroy } from 'svelte';
  import { saveTextVerifiably } from './file-bridge.ts';
  import { copy } from './copy';
  import { copyText } from './clipboard';
  import type { DeviceSyncSession, DeviceSyncState, SyncedEntry } from './device-sync';

  export let session: DeviceSyncSession;
  /** How the launcher spells a byte count, so a row here matches every other row. */
  export let formatSize: (bytes: number) => string;
  export let onClose: () => void;

  let state: DeviceSyncState = session.current;
  const stopFollowing = session.follow((next) => (state = next));
  onDestroy(stopFollowing);

  let joinText = '';
  let joinBusy = false;
  let ticketBusy = false;
  let copied = false;
  let publishBusy = false;
  let pullBusy: string | null = null;
  let note: string | null = null;
  let errorNote: string | null = null;
  let fileInput: HTMLInputElement | undefined;

  /**
   * The engine's own id, shortened for reading. It is a 64 character public key, and the
   * panel shows it as the device's name rather than as something to be checked: the
   * ticket is what actually pairs, and a person comparing two ids is comparing noise.
   */
  function shortId(id: string): string {
    return id.length > 12 ? `${id.slice(0, 12)}…` : id;
  }

  /** Why the engine cannot run here, in one sentence. */
  function unavailable(reason: string | null): string {
    if (reason === 'file' || reason === 'no-wasm' || reason === 'no-crypto') {
      return copy.deviceSync.unavailable[reason];
    }
    return copy.deviceSync.unavailable.engine;
  }

  /** The folder's last activity, as a sentence. */
  function activityLabel(state: DeviceSyncState): string {
    const event = state.activity;
    if (!event) return copy.deviceSync.activity.idle;
    switch (event.kind) {
      case 'remote-update':
        return copy.deviceSync.activity.update(event.name);
      case 'seeded':
        return copy.deviceSync.activity.seeded(event.name);
      case 'external-drift':
        return copy.deviceSync.activity.drift(event.name);
      case 'peer-up':
        return copy.deviceSync.activity.peerUp;
      case 'peer-down':
        return copy.deviceSync.activity.peerDown;
      case 'failed':
        return copy.deviceSync.activity.failed(event.name, event.reason);
    }
  }

  /** A failure the panel can name itself, or the engine's own detail. */
  function errorLabel(detail: string | null): string {
    if (!detail) return '';
    return detail === 'empty-ticket' ? copy.deviceSync.joinEmpty : copy.deviceSync.error(detail);
  }

  async function showTicket() {
    ticketBusy = true;
    note = null;
    try {
      await session.share();
    } finally {
      ticketBusy = false;
    }
  }

  async function copyTicket() {
    if (!state.ticket) return;
    await copyText(state.ticket);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  async function pair() {
    joinBusy = true;
    note = null;
    try {
      if (await session.join(joinText)) {
        joinText = '';
      }
    } finally {
      joinBusy = false;
    }
  }

  async function saveEntry(entry: SyncedEntry) {
    pullBusy = entry.name;
    note = null;
    errorNote = null;
    try {
      const bytes = await session.pull(entry.name);
      if (!bytes) return;
      if (session.native) {
        // The app owns the dialog and the write, so a copy is a file on disk and the
        // answer proves it, exactly like every other save in the launcher.
        const outcome = await saveTextVerifiably(entry.name, new TextDecoder().decode(bytes));
        if (outcome !== 'cancelled') note = copy.deviceSync.saved(entry.name);
      } else {
        download(entry.name, bytes);
        note = copy.deviceSync.saved(entry.name);
      }
    } catch (error) {
      errorNote = copy.deviceSync.error(error instanceof Error ? error.message : String(error));
    } finally {
      pullBusy = null;
    }
  }

  async function publishPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    publishBusy = true;
    note = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (await session.publish(file.name, bytes)) {
        note = copy.deviceSync.published(file.name);
      }
    } finally {
      publishBusy = false;
      // Emptied so picking the same file again is still a change.
      input.value = '';
    }
  }

  /** Hand the bytes to the browser as a download, the way the version history does. */
  function download(name: string, bytes: Uint8Array) {
    // The assertion is the lib's own type parameter, not a runtime claim: it wants a view
    // over a plain ArrayBuffer, and a wasm-bindgen Uint8Array is always exactly that.
    const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/x-lith' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
</script>

<div
  class="modal-overlay"
  role="presentation"
  on:click={(event) => event.currentTarget === event.target && onClose()}
>
  <div class="launcher-modal device-sync-modal" role="dialog" aria-modal="true" aria-labelledby="device-sync-title">
    <button class="modal-close" aria-label={copy.deviceSync.closeAria} on:click={onClose}>×</button>
    <h2 id="device-sync-title">{copy.deviceSync.title}</h2>

    {#if state.phase === 'unavailable' || state.phase === 'failed'}
      <p class="device-sync-note error" role="alert">{unavailable(state.error)}</p>
      {#if state.phase === 'failed' && state.error && state.error !== 'file' && state.error !== 'no-wasm' && state.error !== 'no-crypto'}
        <p class="device-sync-note error">{state.error}</p>
      {/if}
    {:else}
      {#if state.phase === 'loading'}
        <p class="device-sync-note" role="status">{copy.deviceSync.loading}</p>
      {/if}

      <p class="device-sync-status" role="status">
        <span class="device-sync-name"
          >{copy.deviceSync.nodeLabel}: {state.nodeId ? shortId(state.nodeId) : '…'}</span
        >
        <span class="device-sync-folder">{copy.deviceSync.folderCount(state.entries.length)}</span>
        {#if state.peers.length > 0}<span class="device-sync-peers">{copy.deviceSync.peers(state.peers.length)}</span>{/if}
      </p>

      <section class="device-sync-step">
        <h3>{copy.deviceSync.ticketTitle}</h3>
        {#if state.ticket}
          <textarea class="device-sync-ticket device-sync-ticket-read" readonly rows="3" aria-label={copy.deviceSync.ticketTitle}>{state.ticket}</textarea
          >
          <div class="modal-actions">
            <button class="modal-action device-sync-copy" on:click={copyTicket}>{copied ? copy.deviceSync.ticketCopied : copy.deviceSync.ticketCopy}</button>
          </div>
          <p class="device-sync-hint">{copy.deviceSync.ticketBody}</p>
        {:else}
          <div class="modal-actions">
            <button class="modal-action device-sync-ticket-show" disabled={ticketBusy || state.phase !== 'ready'} on:click={showTicket}>
              {ticketBusy ? copy.deviceSync.ticketBusy : copy.deviceSync.ticketShow}
            </button>
          </div>
          <p class="device-sync-hint">{copy.deviceSync.ticketHint}</p>
        {/if}
      </section>

      <section class="device-sync-step">
        <h3>{copy.deviceSync.joinTitle}</h3>
        <textarea
          class="device-sync-ticket device-sync-ticket-join"
          rows="2"
          bind:value={joinText}
          placeholder={copy.deviceSync.joinPlaceholder}
          aria-label={copy.deviceSync.joinTitle}
        ></textarea>
        <div class="modal-actions">
          <button
            class="modal-action device-sync-pair"
            disabled={joinBusy || !joinText.trim() || state.phase !== 'ready'}
            on:click={pair}>{joinBusy ? copy.deviceSync.joining : copy.deviceSync.join}</button
          >
        </div>
        <p class="device-sync-hint">{copy.deviceSync.joinHint}</p>
      </section>

      <section class="device-sync-step">
        <h3>{copy.deviceSync.folderTitle}</h3>
        {#if state.entries.length === 0}
          <p class="device-sync-hint">{copy.deviceSync.folderEmpty}</p>
        {:else}
          <ul class="device-sync-entries">
            {#each state.entries as entry (entry.name)}
              <li>
                <span class="device-sync-entry">
                  <span class="device-sync-entry-name">{entry.name}</span>
                  <span class="device-sync-entry-size">{formatSize(entry.size)}</span>
                </span>
                <button
                  class="modal-action secondary device-sync-save"
                  disabled={pullBusy !== null}
                  on:click={() => saveEntry(entry)}
                  aria-label={`${copy.deviceSync.download}: ${entry.name}`}
                  >{pullBusy === entry.name ? copy.deviceSync.downloading : copy.deviceSync.download}</button
                >
              </li>
            {/each}
          </ul>
        {/if}
        <div class="modal-actions">
          <button class="modal-action device-sync-add" disabled={publishBusy || state.phase !== 'ready'} on:click={() => fileInput?.click()}>
            {publishBusy ? copy.deviceSync.publishing : copy.deviceSync.add}
          </button>
        </div>
        <p class="device-sync-hint">{copy.deviceSync.addHint}</p>
        <!-- Hidden rather than absent: the picker a browser opens can only be asked for
             by an input, and the button above is what a person presses. -->
        <input
          class="device-sync-file"
          type="file"
          accept=".lith,application/x-lith"
          tabindex="-1"
          aria-hidden="true"
          bind:this={fileInput}
          on:change={publishPicked}
        />
      </section>

      <p class="device-sync-activity" role="status">{activityLabel(state)}</p>
      {#if note}<p class="device-sync-note ok" role="status">{note}</p>{/if}
      {#if errorNote}<p class="device-sync-note error" role="alert">{errorNote}</p>{/if}
      {#if state.error}<p class="device-sync-note error" role="alert">{errorLabel(state.error)}</p>{/if}
    {/if}
  </div>
</div>
