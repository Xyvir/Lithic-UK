<script lang="ts">
  /**
   * The question asked before a mount replaces edits that were captured but never saved.
   *
   * It is the one dialog with no close control and no Cancel, because its three answers are
   * policies about the edits rather than three ways out of it: merging folds them into the mount,
   * deciding later leaves the question open, and discarding clears the only copy of them that
   * exists. That is why the irreversible one wears the red rather than a confirmation behind it.
   */
  import { createEventDispatcher } from 'svelte';
  import { copy, LOCALE_TAG } from './copy';
  import type { DirtyRecovery } from './storage';

  export let info: DirtyRecovery;

  const dispatch = createEventDispatcher<{ resolve: 'merge' | 'discard' | 'later' }>();

  /** The title whose body is drawn, or null while every row is folded. */
  let openTitle: string | null = null;

  /** One body at a time, and the row that is already open folds when its own head is pressed. */
  function toggle(title: string): void {
    openTitle = openTitle === title ? null : title;
  }
</script>

<div class="modal-overlay" role="presentation">
  <div class="launcher-modal dirty-modal" role="dialog" aria-modal="true" aria-labelledby="dirty-title">
    <h2 id="dirty-title">{copy.dialogs.dirty.title}</h2>
    <p>
      {copy.dialogs.dirty.body(info.name, info.tiddlers.length, new Date(info.ts).toLocaleString(LOCALE_TAG))}
    </p>
    <!--
      Every captured edit, one title apiece, and the row is its own disclosure: a title
      says an edit happened, not whether it is worth keeping, so the body it captured
      opens under it. One open at a time, because a second body would push the three
      answers below out of the dialog, and each body is capped so a note of forty lines
      scrolls inside itself rather than growing the dialog around it. A capture that
      carries no text has nothing to show, so its row stays a title with no chevron.
    -->
    <ul class="dirty-tiddler-list">
      {#each info.tiddlers as tiddler, index (tiddler.title)}
        {@const body = typeof tiddler.text === 'string' ? tiddler.text : ''}
        {@const open = openTitle === tiddler.title}
        <li class="dirty-tiddler-row" class:open={open}>
          {#if body.trim() === ''}
            <span class="dirty-tiddler-plain">{tiddler.title}</span>
          {:else}
            <button
              type="button"
              class="dirty-tiddler-head"
              aria-expanded={open}
              aria-controls="dirty-tiddler-body-{index}"
              on:click={() => toggle(tiddler.title)}
            >
              <span class="dirty-tiddler-title">{tiddler.title}</span>
              <svg class="dirty-tiddler-chevron" viewBox="0 0 14 8" aria-hidden="true"><path d="M1.5 1.5 7 6.5l5.5-5"></path></svg>
            </button>
          {/if}
          {#if open}
            <div class="dirty-tiddler-body" id="dirty-tiddler-body-{index}">
              <pre>{body}</pre>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
    <div class="modal-actions">
      <button class="modal-action" on:click={() => dispatch('resolve', 'merge')}>{copy.dialogs.dirty.recover}</button>
      <button class="modal-action secondary" on:click={() => dispatch('resolve', 'later')}>{copy.dialogs.dirty.later}</button>
      <button class="modal-action danger" on:click={() => dispatch('resolve', 'discard')}>{copy.dialogs.dirty.discard}</button>
    </div>
  </div>
</div>
