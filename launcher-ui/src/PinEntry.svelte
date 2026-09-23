<script lang="ts">
  /**
   * The vault's PIN, entered as boxes.
   *
   * Box entry rather than a text field, because the PIN has a fixed length and a
   * fixed alphabet: one character per box, anything else refused as it is typed,
   * and the last box filling up is the signal to go. That last part is the whole
   * entry method — `complete` fires the moment the sixth character lands, so
   * opening an instance is six characters and nothing else.
   *
   * Case is folded here and again in Rust (`normalize_secret`), which is what makes
   * "case-insensitive" a fact about the file rather than a claim about the boxes.
   */
  import { onMount, tick } from 'svelte';

  /** The PIN, always the folded form: upper case, letters and digits only. */
  export let value = '';
  export let length = 6;
  /** Shown above the boxes, and the group's accessible name. */
  export let label = 'PIN';
  /**
   * Fired as soon as the last box is filled, with the completed PIN. The value is
   * passed rather than left to be read back out of the binding: this is the one
   * moment the caller knows for certain what was typed.
   */
  export let complete: ((pin: string) => void) | null = null;
  export let disabled = false;
  /** Reveal the characters, driven by the dialog's own show toggle. */
  export let reveal = false;
  /** Bump this to empty the boxes and take focus again — a new attempt. */
  export let reset = 0;
  /** Bump this to move the caret into the first empty box. */
  export let focusSignal = 0;

  let root: HTMLDivElement | undefined;
  let seenReset = reset;
  let seenFocus = focusSignal;

  function seed(from: string): string[] {
    const characters = from.slice(0, length).toUpperCase().split('');
    return Array.from({ length }, (_, index) => characters[index] ?? '');
  }

  let digits = seed(value);

  /** The boxes are read from the DOM: six of them, in order, and nothing to keep in step. */
  function boxes(): HTMLInputElement[] {
    return root ? [...root.querySelectorAll('input')] : [];
  }

  /** The model is the source of truth, so the DOM follows it — never the reverse. */
  function paint() {
    boxes().forEach((box, index) => {
      box.value = digits[index] ?? '';
    });
    value = digits.join('');
  }

  export function clear() {
    digits = Array.from({ length }, () => '');
    paint();
    void tick().then(() => boxes()[0]?.focus());
  }

  export function focusFirst() {
    void tick().then(() => {
      const boxesNow = boxes();
      const empty = digits.findIndex((character) => !character);
      boxesNow[empty === -1 ? length - 1 : empty]?.focus();
    });
  }

  $: if (reset !== seenReset) {
    seenReset = reset;
    clear();
  }

  $: if (focusSignal !== seenFocus) {
    seenFocus = focusSignal;
    focusFirst();
  }

  onMount(() => {
    paint();
    focusFirst();
  });

  /**
   * Fill from `index` with whatever arrived — one keystroke, or a whole PIN pasted
   * into one box — and report a full PIN. Anything outside the alphabet is dropped
   * rather than rejected, so a stray symbol never fills a box.
   */
  function fill(index: number, raw: string) {
    const cleaned = raw.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
    const next = [...digits];
    let cursor = index;
    for (const character of cleaned) {
      if (cursor >= length) break;
      next[cursor] = character;
      cursor += 1;
    }
    digits = next;
    paint();
    if (!cleaned) {
      // Something was typed that the PIN cannot hold: the box is already back to
      // what it had, and the caret stays where the user was typing.
      void tick().then(() => boxes()[index]?.focus());
      return;
    }
    const pin = digits.join('');
    if (pin.length === length) complete?.(pin);
    else focusFirst();
  }

  function keydown(index: number, event: KeyboardEvent) {
    const boxesNow = boxes();
    if (event.key === 'Backspace') {
      event.preventDefault();
      // Backspace on an empty box means the character before it, not the empty one.
      const target = digits[index] ? index : Math.max(0, index - 1);
      const next = [...digits];
      next[target] = '';
      digits = next;
      paint();
      void tick().then(() => boxesNow[target]?.focus());
      return;
    }
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      void tick().then(() => boxesNow[index - 1]?.focus());
    }
    if (event.key === 'ArrowRight' && index < length - 1) {
      event.preventDefault();
      void tick().then(() => boxesNow[index + 1]?.focus());
    }
  }

  function paste(index: number, event: ClipboardEvent) {
    const text = event.clipboardData?.getData('text') ?? '';
    if (!/[0-9A-Za-z]/.test(text)) return;
    event.preventDefault();
    fill(index, text);
  }
</script>

<div class="pin-entry" bind:this={root}>
  <span class="pin-label">{label}</span>
  <div class="pin-boxes" role="group" aria-label={label}>
    {#each Array.from({ length }, (_, index) => index) as index (index)}
      <!--
        `select()` on focus, because a box that is already full would otherwise
        refuse the next character: with one character allowed, replacing it is the
        only way to correct a box without reaching for backspace.
      -->
      <input
        class="pin-box"
        type={reveal ? 'text' : 'password'}
        inputmode="text"
        maxlength="1"
        autocomplete="off"
        autocapitalize="characters"
        autocorrect="off"
        spellcheck="false"
        {disabled}
        aria-label={`${label}, character ${index + 1} of ${length}`}
        on:input={(event) => fill(index, (event.currentTarget as HTMLInputElement).value)}
        on:keydown={(event) => keydown(index, event)}
        on:paste={(event) => paste(index, event)}
        on:focus={(event) => (event.currentTarget as HTMLInputElement).select()}
      />
    {/each}
  </div>
</div>
