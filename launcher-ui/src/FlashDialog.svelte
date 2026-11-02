<script lang="ts">
  /**
   * The flash dialog: the one thing a blank board needs, and the write itself.
   *
   * The offer row stays in the page, because the row sits in the manager and is what decides
   * whether the dialog can be reached at all. Everything the write needs is here instead: the
   * busy flag, the stage line, the percent and the password field, none of which anything
   * outside reads.
   *
   * This is the same run `Flash.svelte` makes when `?flash=1` is the whole page, and the two are
   * deliberately separate: that one is a page with no launcher behind it, and this one is a
   * dialog over the manager.
   */
  import { createEventDispatcher } from 'svelte';
  import { copy } from './copy';
  import { esp32PasswordOk, esp32Percent, esp32StageLine, flashLithicAppliance } from './esp32-flash';

  export let show = false;

  /**
   * The failure band, bound to the page's own because one band has two writers: the row under the
   * manager reports a browser that would not start, and this reports a write that failed. Opening
   * clears it from either side, which is what the page did before the dialog was its own
   * component, and keeping one variable is what leaves that seam visible rather than leaving two
   * that drift apart.
   */
  export let problem = '';

  const dispatch = createEventDispatcher<{ close: void }>();

  let busy = false;
  let line = '';
  let percent = 0;
  let password = '';
  let passwordOk = false;
  $: passwordOk = esp32PasswordOk(password);

  /**
   * Opening clears the band, the stage line and the percent, which is what the page did when it
   * set `flashShow` itself. Guarded on the transition rather than run whenever `show` is truthy,
   * so a failure that lands while the dialog is open is not erased by the block that drew it.
   */
  let wasShown = false;
  $: if (show !== wasShown) {
    wasShown = show;
    if (show) {
      line = '';
      percent = 0;
      problem = '';
    }
  }

  /**
   * The one action. The stages collapse into a single line because only one of them can be
   * happening, and a failure keeps the loader's own reason after its clause.
   */
  async function run(): Promise<void> {
    busy = true;
    problem = '';
    percent = 0;
    line = copy.esp32.downloading;
    try {
      await flashLithicAppliance({
        password,
        onStage: (stage) => {
          line = esp32StageLine(stage);
        },
        onProgress: (progress) => {
          percent = esp32Percent(progress);
        }
      });
      // The password is on the board now, so the field stops holding a secret.
      password = '';
    } catch (error) {
      problem = copy.esp32.failed(error instanceof Error ? error.message : String(error));
      line = '';
    } finally {
      busy = false;
    }
  }

  /**
   * Closing is refused mid run, so a backdrop click cannot abandon a write half way, and the close
   * control is disabled for the same reason.
   */
  function close(): void {
    if (busy) return;
    dispatch('close');
  }
</script>

{#if show}
  <!--
    The one-time flash offer. A blank board is the subject, so the dialog asks for one thing:
    the password the board will broadcast its network with, which is written into the flash
    beside the published images. The button waits for a usable password and then stays
    disabled for the run rather than offering a second start over the top of the first. It
    opens only from the manager row, which is drawn only where Web Serial exists, so there
    is no unsupported shape to draw here.
  -->
  <div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && close()}>
    <div class="launcher-modal flash-modal" role="dialog" aria-modal="true" aria-labelledby="flash-title">
      <button class="modal-close" aria-label={copy.esp32.closeAria} disabled={busy} on:click={close}>×</button>
      <h2 id="flash-title">{copy.esp32.title}</h2>
      <p>{copy.esp32.intro}</p>
      <label class="flash-field">
        <span>{copy.esp32.passwordLabel}</span>
        <input bind:value={password} type="password" autocomplete="new-password" aria-describedby="flash-password-rule" disabled={busy} />
      </label>
      <p class="flash-rule" id="flash-password-rule">{copy.esp32.passwordRule}</p>
      {#if line}
        <p class="status-line" role="status">{line}{#if busy && percent > 0}{' - '}{percent}%{/if}</p>
      {/if}
      {#if problem}<p class="status-line error" role="alert">{problem}</p>{/if}
      <div class="modal-actions">
        <button class="modal-action" disabled={busy || !passwordOk} on:click={run}>{copy.esp32.flash}</button>
      </div>
    </div>
  </div>
{/if}
