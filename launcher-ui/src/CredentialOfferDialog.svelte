<script lang="ts">
  /**
   * The one dialog that writes a login, and the only place a password can be typed for an
   * instance nothing is saved for: either the offer a challenging instance makes while it is
   * being opened, or a bookmark row's key.
   *
   * Both of its answers hand credentials over in a grant rather than through the page, so the
   * webview never has to ask. Saving writes the vault and opening borrows the login for one
   * load, which is what replaced the page's own prompt for someone not using the manager.
   */
  import { createEventDispatcher } from 'svelte';
  import { copy } from './copy';
  import PinEntry from './PinEntry.svelte';
  import { instanceLabel } from './bookmarks';
  import { tauriInvoke } from './file-bridge';
  import { askInstanceAboutLogin, typedLoginCheck, type LoginVerdict } from './login-check';
  import { withLauncherHandoff } from './mode';

  /**
   * The address this login is for, and how the dialog was reached.
   *
   * The address is handed in rather than typed: both entries know it already, which is the whole
   * reason there is no form anywhere that would accept any address at all.
   */
  export let offer: { origin: string; address: string; kind: 'prompt' | 'row'; query: string };
  /** Whether this save is what creates the vault, which is the only shape with a repeat field. */
  export let vaultCreateMode: boolean;
  /**
   * The PIN boxes' reveal toggle, bound rather than owned because the vault's PIN fields share
   * one: revealing it in the manager leaves it revealed in every dialog that asks for a PIN.
   */
  export let pinReveal = false;

  const dispatch = createEventDispatcher<{ close: void; saved: void }>();

  /**
   * A candidate PIN's verdict: the word it reads as, the band that colours it, and the sentence
   * Rust wrote behind the word.
   *
   * The band is a class name as well as a word, so the colour cannot disagree with the arithmetic
   * behind it. `refused` is the one case Rust does not band, because the only refusal possible
   * here is the shape the boxes already enforce. The word is that band capitalized: Rust bands
   * the shape and composes the sentence, so the only thing left to spell here is the word the
   * sentence already opens with.
   */
  type SecretVerdict = { label: string; text: string; band: string };

  let pin = '';
  let pinConfirm = '';
  let user = '';
  let password = '';
  let error = '';
  /** The candidate PIN's band and sentence, or null while nothing complete is typed. */
  let warning: SecretVerdict | null = null;
  let busy = false;
  /** Bumped when a PIN is refused, so the boxes empty and take the caret again. */
  let pinReset = 0;
  /** Bumped when the PIN is complete, to move the caret on to its confirmation. */
  let pinConfirmFocus = 0;
  /** The password field's own reveal, which no other dialog draws. */
  let passwordReveal = false;
  /**
   * What these fields last answered when they were put to the instance. Null while they are still
   * being typed into, or hold something other than a complete login. See `typedLoginCheck` for
   * when it is asked and when it is cleared. Both buttons read it, which is why it is asked for a
   * typed login rather than for a save.
   */
  let checkVerdict: LoginVerdict | null = null;
  const loginCheck = typedLoginCheck((verdict) => (checkVerdict = verdict));
  $: loginCheck(offer.origin, user, password);

  /** A PIN's band and sentence, measured by Rust so the rule has one home. */
  async function secretVerdict(secret: string): Promise<SecretVerdict | null> {
    if (!secret) return null;
    try {
      const verdict = await tauriInvoke<{
        ok: boolean;
        problem?: string | null;
        warning?: string | null;
        band?: string | null;
      }>('check_credentials_secret', { secret });
      if (!verdict.ok) {
        // A refusal is not a band: it is said in the same colour every time, because
        // the only thing it can be is the shape the boxes already enforce.
        return verdict.problem
          ? { label: verdict.problem, text: verdict.problem, band: 'refused' }
          : null;
      }
      if (!verdict.warning) return null;
      const band = verdict.band ?? 'average';
      return { label: band.charAt(0).toUpperCase() + band.slice(1), text: verdict.warning, band };
    } catch (error) {
      return {
        label: error instanceof Error ? error.message : String(error),
        text: error instanceof Error ? error.message : String(error),
        band: 'refused'
      };
    }
  }

  /**
   * The PIN is complete: say whether it is weak, and move on to its confirmation.
   *
   * Only while creating. With a vault already on disk there is nothing to choose:
   * the PIN is either this vault's or it is not, and `Save` is where that is decided,
   * so checking it here would only be a second derivation of the same key.
   */
  async function pinComplete(typed: string): Promise<void> {
    if (!vaultCreateMode) return;
    pinConfirmFocus += 1;
    warning = await secretVerdict(typed);
  }

  /**
   * Save this instance's login and open it, in one unlock.
   *
   * One command rather than unlock-then-save-then-lend: the PIN is derived once, and the vault
   * that the derivation opens is dropped on the way out with nothing left open behind it. The
   * answer is the same one-origin, expiring grant any other instance open leaves.
   */
  async function save(): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      // A verdict is always about the text in the boxes right now (any change to them
      // clears it) so one that has already arrived costs nothing to use. If none has,
      // the answer is still on its way, and this is the moment it would decide
      // something: the gap between typing and clicking is exactly where a password the
      // instance will refuse would otherwise get through.
      const verdict = checkVerdict && checkVerdict.state !== 'busy'
        ? checkVerdict
        : await askInstanceAboutLogin(offer.origin, user, password);
      checkVerdict = verdict;
      if (verdict.state === 'refused') {
        error = copy.dialogs.credential.notSaved;
        return;
      }
      await tauriInvoke('save_login_for_instance', {
        origin: offer.origin,
        secret: pin,
        user,
        password
      });
      pin = '';
      pinConfirm = '';
      password = '';
      // The row's key is drawn from the vault file's index, which the save just rewrote, so
      // the page is told to read it again before this window leaves for the instance.
      dispatch('saved');
      window.location.href = withLauncherHandoff(offer.address, window.location.href, offer.query);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
      pinReset += 1;
    } finally {
      busy = false;
    }
  }

  /**
   * Open it with the login that was just typed, and save nothing.
   *
   * This is the workflow for not using the credential manager, and it is what replaced both
   * reasons the page's own prompt used to appear: the answer is borrowed for one load rather
   * than written down. Nothing is opened and no PIN is needed (the values came from the boxes)
   * so it works in the first-run shape too, where the PIN boxes are empty and only the other
   * button wants them.
   *
   * What is left behind is the same one-origin, expiring grant an unlock leaves, which is what
   * lets the page answer its own 401s (`webview_auth.rs`, including the instance's `/sync/`
   * traffic) without a login ever being stored for it.
   */
  async function openWithoutSaving(): Promise<void> {
    if (busy) return;
    busy = true;
    error = '';
    try {
      // The same question saving asks, for the same reason: the one moment a password can be
      // tried before it is handed over.
      const verdict = checkVerdict && checkVerdict.state !== 'busy'
        ? checkVerdict
        : await askInstanceAboutLogin(offer.origin, user, password);
      checkVerdict = verdict;
      if (verdict.state === 'refused') {
        error = copy.dialogs.credential.notOpened;
        return;
      }
      await tauriInvoke('lend_instance_credentials', {
        origin: offer.origin,
        user,
        password
      });
      password = '';
      // Nothing was written, so no row colour changes and no coverage needs asking
      // again: the vault holds exactly what it held a moment ago.
      dispatch('close');
      window.location.href = withLauncherHandoff(offer.address, window.location.href, offer.query);
    } catch (failure) {
      error = failure instanceof Error ? failure.message : String(failure);
    } finally {
      busy = false;
    }
  }
</script>

<!--
  Closed, it borrows the login for this one load and stores nothing, which is what
  replaced the page's own prompt. The answer is in the grant either way, so the
  webview never has to ask.
-->
<div class="modal-overlay" role="presentation" on:click={(event) => event.currentTarget === event.target && dispatch('close')}>
  <div class="launcher-modal vault-modal" role="dialog" aria-modal="true" aria-labelledby="credential-offer-title">
    <button class="modal-close" aria-label={copy.dialogs.credential.closeAria} on:click={() => dispatch('close')}>×</button>
    <h2 id="credential-offer-title">{copy.dialogs.credential.title}</h2>
    <!--
      One line, whichever way this dialog was reached. It used to have two: the
      offer's said why the dialog had opened ("www.foobar.com asks for a password")
      and the row's what the credential was tied to ("answered per exact address").
      The first was the heading again with an address in it, and an address the user
      just clicked is not news. The second read as a scope the user might weigh, when
      it is only how the vault decides what to offer. What is left is the one fact
      this dialog cannot do without: which instance the credential is for.
    -->
    <p class="vault-sub">{copy.dialogs.credential.forInstance(instanceLabel(offer.origin))}</p>
    <div class="vault-pin credential-offer-pin">
      <PinEntry
        bind:value={pin}
        bind:reveal={pinReveal}
        revealToggle={!vaultCreateMode}
        label={vaultCreateMode ? copy.common.choosePin : copy.common.pin}
        disabled={busy}
        reset={pinReset}
        complete={(typed) => void pinComplete(typed)}
      />
      <!--
        The band word, at the end of the boxes' own label line: it is about the PIN
        those boxes hold, and it is the whole of what this dialog says about it. That
        end of that line is where the password field below puts its own Show toggle,
        and the two are never drawn together, because this word exists only while a
        PIN is being chosen, which is the mode that draws no toggle. The
        arithmetic behind the word rides in the word's title, so the estimate is
        still there to be read without a paragraph standing in the dialog. It
        describes a complete candidate, so it goes when the boxes no longer hold one:
        a band about a PIN that has been cleared is about nothing.
      -->
      {#if warning && pin.length === 6}
        <p class="vault-band {warning.band}" role="status" title={warning.text}>{warning.label}</p>
      {/if}
    </div>
    {#if vaultCreateMode}
      <div class="vault-pin credential-offer-pin-confirm">
        <PinEntry
          bind:value={pinConfirm}
          bind:reveal={pinReveal}
          label={copy.common.repeatPin}
          disabled={busy}
          reset={pinReset}
          focusSignal={pinConfirmFocus}
        />
      </div>
    {/if}
    <label class="vault-field"><span>{copy.dialogs.credential.username}</span><input class="credential-offer-user" bind:value={user} autocomplete="off" /></label>
    <!-- One password box, not two: the instance is asked about what is typed here,
         and it is the only thing that can tell a mistyped password from a correct
         one. Two identical typos satisfy a repeat box. Its toggle sits in its label
         row, at the right edge of it, which is the input's own width. The same place
         the PIN's toggle lands on its boxes, because this is the field nothing
         repeats back. It is a label of its own rather than one wrapped around the
         field: a label cannot hold another label, and the row above the input is
         where the toggle's place is. -->
    <div class="vault-field">
      <div class="pin-head">
        <label class="pin-label" for="credential-offer-password">{copy.dialogs.credential.password}</label>
        <label class="vault-reveal"><input type="checkbox" bind:checked={passwordReveal} /> {copy.common.show}</label>
      </div>
      <input id="credential-offer-password" class="credential-offer-password" type={passwordReveal ? 'text' : 'password'} bind:value={password} autocomplete="off" />
    </div>
    {#if checkVerdict}
      <!-- Said in the dialog rather than discovered after the handoff: this is
           the last screen that can tell the user a password is wrong, because
           the page it signs in to is one this app cannot speak on. -->
      <p class="vault-check-line {checkVerdict.state}" role="status" title={checkVerdict.detail}>{checkVerdict.detail}</p>
    {/if}
    {#if error}<p class="status-line error" role="alert">{error}</p>{/if}
    <div class="modal-actions">
      <button
        class="modal-action credential-offer-save"
        disabled={busy || pin.length !== 6 || (vaultCreateMode && pin !== pinConfirm) || !user || !password || checkVerdict?.state === 'refused'}
        on:click={save}
      >{busy ? copy.dialogs.credential.saving : copy.dialogs.credential.save}</button>
      <!-- No PIN, because nothing is written: this is the whole of "not using the
           credential manager", and it is why the page's own prompt no longer needs
           to exist in the desktop app. -->
      <button
        class="modal-action secondary credential-offer-without-saving"
        disabled={busy || !user || !password || checkVerdict?.state === 'refused'}
        on:click={openWithoutSaving}
      >{busy ? '…' : copy.dialogs.credential.openWithoutSaving}</button>
    </div>
  </div>
</div>
