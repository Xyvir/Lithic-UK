/**
 * Putting text on the clipboard, which is the one thing a device flow asks of the page itself.
 *
 * Two routes, because only one of them exists in every launcher mode. `navigator.clipboard` is
 * the modern one, and it is absent outside a secure context: a hosted instance has it, the
 * shim's own `127.0.0.1` counts as trustworthy and has it, Tauri has it, and the legacy
 * launcher opened over `file://` does not. The fallback is the older trick, a textarea holding
 * the text, selected, then copied with the deprecated `execCommand`, which is still the only
 * thing that works there.
 *
 * Both routes answer with a boolean rather than throwing, so a copy that did not happen is a
 * fact the page can say out loud instead of an exception each call site has to catch. The
 * fallback is also the answer to a *refused* permission rather than only a missing API: a
 * browser that blocks the async one while allowing the older one is a real combination, and it
 * should not leave a click that does nothing.
 */

/** What `copyText` reads out of the page. Named so a test can hand it a fake one. */
export type ClipboardEnv = {
  /** `navigator.clipboard`, undefined where the page has no secure context. */
  clipboard?: { writeText: (text: string) => Promise<unknown> } | undefined;
  /** The document the fallback writes its textarea into. */
  doc?: Document | undefined;
};

function pageEnv(): ClipboardEnv {
  return {
    clipboard: typeof navigator === 'undefined' ? undefined : navigator.clipboard,
    doc: typeof document === 'undefined' ? undefined : document
  };
}

/**
 * Copy `text`, by whichever route this page has. `true` means it is on the clipboard.
 *
 * The text is never mutated: formatting is the caller's business, because the thing that gets
 * pasted is the thing that was shown.
 */
export async function copyText(text: string, env: ClipboardEnv = pageEnv()): Promise<boolean> {
  if (text === '') return false;
  if (env.clipboard && typeof env.clipboard.writeText === 'function') {
    try {
      await env.clipboard.writeText(text);
      return true;
    } catch {
      // Not the end of it: the fallback below needs no permission at all.
    }
  }
  return copyBySelection(text, env.doc);
}

/**
 * The pre-`navigator.clipboard` copy: a textarea holding the text, selected, then copied.
 *
 * The textarea is parked off screen rather than hidden, because `display: none` and
 * `visibility: hidden` both make a selection unreadable, and what is being copied is the
 * selection. It is removed in a `finally` so a refused copy cannot leave it in the document,
 * and `readonly` is set so a mobile keyboard has no reason to open over the dialog.
 */
function copyBySelection(text: string, doc: Document | undefined): boolean {
  if (!doc || !doc.body || typeof doc.execCommand !== 'function') return false;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  doc.body.appendChild(area);
  try {
    area.select();
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
