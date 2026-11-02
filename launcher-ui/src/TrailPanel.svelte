<script lang="ts">
  /**
   * The instance's own history, as the GitHub sync dialog draws it.
   *
   * A panel rather than a section of that dialog because the connected screen is not the only one
   * that draws it: a self hosted instance offers its trail while disconnected too, and the two
   * differ only in what the list was loaded from. What joins two commits is the gap row, drawn
   * with the wiki history trail's own chevron and sentence, so the two histories read as one idea.
   *
   * The rows are composed here rather than handed in, because a row is what the list draws: the
   * stamp, the distance from the row above and the pill its own message earns it are three
   * decisions the page above has no use for.
   */
  import { createEventDispatcher } from 'svelte';
  import { copy, LOCALE_TAG } from './copy';
  import { trailGapLabel, trailRows as trailRowList, type TrailCommit, type TrailPill, type TrailRow, type TrailView } from './instance-trail';

  export let view: TrailView;
  export let commits: TrailCommit[] = [];
  export let note = '';
  /** A revert in flight, so its own button cannot be pressed twice. */
  export let busy = false;

  const dispatch = createEventDispatcher<{ revert: TrailRow }>();

  /**
   * A row's pill: what the commit was, in one of three words.
   *
   * The tones are the version trail's own badge tones, so the two lists are not learnt twice:
   * green for a save Lithic made on its own, the accent blue for a deliberate go-back, and the
   * quiet grey for a commit nothing here recognises. Each title carries the explanation and then
   * the commit's own message, which is the fact a pill cannot state and the row no longer prints.
   */
  function pillBadge(kind: TrailPill, message: string) {
    const trail = copy.dialogs.gitSync.trail;
    const raw = message.trim();
    if (kind === 'auto') return { label: trail.pillAuto, tone: 'sync', title: trail.pillAutoTitle(raw).trim() };
    if (kind === 'revert') return { label: trail.pillRevert, tone: '', title: trail.pillRevertTitle(raw).trim() };
    return { label: trail.pillOther, tone: 'delta', title: trail.pillOtherTitle(raw).trim() };
  }

  /**
   * The rows the list draws: each commit stamped, its distance from the row above, and the pill
   * its own message earns it.
   */
  $: rows = trailRowList(commits).map((row) => ({ ...row, badge: pillBadge(row.pill, row.summary) }));
</script>

{#if view !== 'no-repo'}
  <div class="trail-panel">
    <p class="trail-title">{copy.dialogs.gitSync.trail.title}</p>
    {#if view === 'loading'}
      <p class="trail-note">{copy.dialogs.gitSync.trail.loading}</p>
    {:else if view === 'failed'}
      <p class="status-line error" role="alert">{note}</p>
    {:else if rows.length === 0}
      <p class="trail-note">{copy.dialogs.gitSync.trail.none}</p>
    {:else}
      <ul class="trail-list">
        {#each rows as row, index (row.hash)}
          {#if index > 0}
            <!--
              What joins two commits, exactly as the wiki trail joins two versions: the
              chevron points up at the newer row, and the distance beside it is that row's
              own sentence. Decorative, so it stays out of the accessibility tree, and the
              chevron is pinned to the column's centre line so the arrows read as one spine.
            -->
            <li class="history-link" aria-hidden="true">
              <svg viewBox="0 0 14 8" aria-hidden="true"><path d="M1.5 6.5 7 1.5l5.5 5"></path></svg>
              {#if row.gap}<span class="history-gap">{trailGapLabel(row.gap, copy.dialogs.history.later, LOCALE_TAG)}</span>{/if}
            </li>
          {/if}
          <li class="history-entry">
            <span class="trail-hash" title={row.hash}>{row.short}</span>
            <!--
              What the commit was, rather than the sentence git stored with it: every
              message in this history was written by Lithic itself, so the row can say
              which kind of save it was at a glance. The sentence is still there on the
              pill's own tooltip, which is where a message nobody can read at a glance
              belongs. The words and their tones are the deck's (`pillBadge`).
            -->
            <span class="history-badge trail-badge {row.badge.tone}" title={row.badge.title}>{row.badge.label}</span>
            <span class="history-time trail-time">{row.stamp}</span>
            <!--
              The revert glyph, supplied as artwork rather than redrawn: the history trail's
              own mark turned a quarter turn, so it reads as the same family as the download
              icon beside the versions without being mistaken for it. It is drawn in the
              download icon's own coordinate box (`viewBox`, and the same `.history-download-icon`
              size rule) with one translate, which is what makes the two marks the same size
              whatever either of them is later restyled to.
            -->
            <button
              class="recent-icon-button history-download-button trail-revert"
              type="button"
              disabled={busy}
              aria-label={copy.dialogs.gitSync.trail.revertAria(row.short, row.stamp)}
              title={copy.dialogs.gitSync.trail.revertTitle}
              on:click={() => dispatch('revert', row)}
            >
              <svg class="history-download-icon" viewBox="56 108 33 36" aria-hidden="true"><g transform="translate(-7.01 5.03)"><path class="history-icon-shape" d="m 80.482426,115.61206 v 8.05016 h 7.125663 v -1.59836 h -5.527311 v -6.4518 z"></path><path class="history-icon-shape" d="m 96.232885,121.64218 c 0,-7.19823 -5.58342,-13.10362 -12.64471,-13.64723 v -0.007 h -15.85743 v -1.32502 l -4.02559,2.32389 4.02559,2.32441 v -1.32343 h 15.85123 c 5.97937,0.53018 10.65103,5.5348 10.65103,11.65458 0,6.47462 -5.22855,11.70316 -11.70316,11.70316 -6.47462,0 -11.70161,-5.22854 -11.70161,-11.70316 0,-2.64451 0.87232,-5.08081 2.34508,-7.03781 h -2.39572 c -1.23707,2.05816 -1.94924,4.46633 -1.94924,7.03781 0,7.5555 6.14599,13.70356 13.70149,13.70356 7.5555,0 13.70304,-6.14806 13.70304,-13.70356 z"></path></g></svg>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}
