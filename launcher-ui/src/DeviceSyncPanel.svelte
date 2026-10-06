<script lang="ts">
  /**
   * Device sync, as the launcher drives it: the pairing, and nothing else.
   *
   * This panel used to carry a copy of the folder's own listing and a picker that added a
   * Lith to it, which made it a second, smaller recents list: the same names in another
   * order, with the launcher's own way of saving a copy, and a folder nobody could see from
   * anywhere else in the app. It holds neither now. Every Lith in the folder is a row in the
   * launcher's recent list, whether this device has it or not, and the control on that row
   * is what loads one or sends one; this modal is only where two devices find each other.
   * `recent-sync.ts` is where the rules live and `App.svelte` is where the rows are drawn.
   *
   * One panel, two engines: the browser's wasm module and the desktop app's native one
   * (see `device-sync.ts`). Nothing here branches on which.
   */
  import { onDestroy } from 'svelte';
  import { copy } from './copy';
  import { copyText } from './clipboard';
  import type { DeviceSyncSession, DeviceSyncState } from './device-sync';

  export let session: DeviceSyncSession;
  export let onClose: () => void;

  let state: DeviceSyncState = session.current;
  const stopFollowing = session.follow((next) => (state = next));
  onDestroy(stopFollowing);

  let joinText = '';
  let joinBusy = false;
  let ticketBusy = false;
  let copied = false;
  let unpairBusy = false;

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
    return detail === 'empty-ticket'
      ? copy.deviceSync.joinEmpty
      : detail === 'already-paired'
        ? copy.deviceSync.alreadyPaired
        : copy.deviceSync.error(detail);
  }

  async function showTicket() {
    ticketBusy = true;
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
    try {
      if (await session.join(joinText)) {
        joinText = '';
      }
    } finally {
      joinBusy = false;
    }
  }

  async function unpair() {
    unpairBusy = true;
    try {
      await session.unpair();
    } finally {
      unpairBusy = false;
    }
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
        <span class="device-sync-peers">{state.paired ? (state.peerCount > 0 ? copy.deviceSync.liveStatus : copy.deviceSync.waitingStatus) : copy.deviceSync.idleStatus}</span>
      </p>

      {#if !state.paired || state.ticket}
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
      {/if}

      {#if state.paired}
        <div class="device-sync-unpair-row">
          <span>{copy.deviceSync.paired}</span>
          <button class="modal-action secondary" disabled={unpairBusy || state.operating} on:click={unpair}>
            {unpairBusy ? copy.deviceSync.unpairing : copy.deviceSync.unpair}
          </button>
        </div>
      {:else}
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
      {/if}

      <p class="device-sync-activity" role="status">{activityLabel(state)}</p>
      <!--
        Where the folder's Liths are now. The listing that used to sit here was the launcher's
        own second copy of the recent list, so the one thing this modal owes a person is the
        sentence that says so, in the place they would look for it.
      -->
      <p class="device-sync-hint">{copy.deviceSync.recentsHint}</p>
      {#if state.error}<p class="device-sync-note error" role="alert">{errorLabel(state.error)}</p>{/if}
    {/if}
  </div>
</div>
