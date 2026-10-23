<script lang="ts">
  /*
   * The flash-only page: what `?flash=1` mounts.
   *
   * It is the desktop app's fallback for a window that cannot flash: WKWebView and WebKitGTK
   * implement no Web Serial, and an older WebView2 may not either. There the app writes this
   * same artifact to a temporary file and hands it to a Chromium browser, which owns the device
   * chooser the write needs. Everything else the launcher draws is left out on purpose: the run
   * needs the images, a board and the password the board will broadcast its network with, and a
   * recents list or a bookmark behind it would only be a page the person has to ignore.
   *
   * There is no dismissal, because there is nothing here to dismiss: the tab is the way out,
   * and closing it while a write is running is the browser's own warning rather than this
   * page's.
   */
  import { copy } from './copy';
  import { esp32PasswordOk, esp32Percent, esp32StageLine, flashLithicAppliance, serialFlashSupported } from './esp32-flash';

  let busy = false;
  let line = '';
  let problem = '';
  let percent = 0;
  let password = '';
  let passwordOk = false;
  $: passwordOk = esp32PasswordOk(password);
  const supported = serialFlashSupported();

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
</script>

<svelte:head><title>{copy.esp32.title}</title></svelte:head>

<div class="modal-overlay">
  <div class="launcher-modal flash-modal" role="main" aria-labelledby="flash-title">
    <h1 id="flash-title">{copy.esp32.title}</h1>
    <p>{copy.esp32.intro}</p>
    <label class="flash-field">
      <span>{copy.esp32.passwordLabel}</span>
      <input bind:value={password} type="password" autocomplete="new-password" aria-describedby="flash-password-rule" disabled={busy} />
    </label>
    <p class="flash-rule" id="flash-password-rule">{copy.esp32.passwordRule}</p>
    {#if line}<p class="status-line" role="status">{line}{#if busy && percent > 0}{' - '}{percent}%{/if}</p>{/if}
    {#if problem}<p class="status-line error" role="alert">{problem}</p>{/if}
    <div class="modal-actions">
      {#if supported}
        <button class="modal-action" disabled={busy || !passwordOk} on:click={run}>{copy.esp32.flash}</button>
      {:else}
        <!-- A page reached by hand in a browser with no serial API would otherwise draw a
             button whose only outcome is a failure. -->
        <p class="status-line error" role="alert">{copy.esp32.unsupported}</p>
      {/if}
    </div>
  </div>
</div>
