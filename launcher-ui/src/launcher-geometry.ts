/**
 * Where the recents panel and the action card put what they draw beside other things, and how
 * long the list keeps drawing its scrollbar once a gesture has stopped.
 *
 * Svelte actions rather than state: each one measures the page from a single node, and none of
 * them needs the page's state to answer anything, so state here would only schedule a render to
 * change what nobody is looking at.
 */

export function positionCachePreview(node: HTMLElement) {
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

/**
 * Draw the recent list's scrollbar only while the list is being scrolled.
 *
 * A scrollbar is a fact about the list, not about the row being read: at rest the panel's
 * rows already carry the gap and the reserved gutter a thumb needs, so what the thumb
 * adds is four dark pixels of furniture on the one panel that is nearly all list, and on
 * a phone, where the window is barely wider than the column, the gutter is the only thing
 * in the panel's right padding at all.
 *
 * `.scrolling` is the whole mechanism (see the stylesheet) because a native scrollbar
 * cannot be animated: Blink paints a scrollbar from its un-animated style, so a transition
 * or an animation on the thumb is measured to do nothing at all, and the thumb can only
 * cut between hidden and drawn. A class toggle costs the same frame either way.
 *
 * Written as a class rather than reactive state because a scroll burst fires on every
 * frame of the gesture and nothing else on the page reads this: state would schedule a
 * render per frame to change one attribute the user is not looking at, and the linger is a
 * timer, which is not something a template can hold.
 *
 * The linger is the other half of the idea. Hiding the thumb as soon as the last scroll
 * event lands would blink it off between two wheel notches (a flick of a trackpad lands
 * events tens of milliseconds apart) so the class outlives the gesture by long enough
 * that a burst reads as one continuous scroll.
 */
export function trackListScroll(node: HTMLElement) {
  let linger: ReturnType<typeof setTimeout> | null = null;
  const onScroll = () => {
    node.classList.add('scrolling');
    if (linger) clearTimeout(linger);
    linger = setTimeout(() => node.classList.remove('scrolling'), 700);
  };
  node.addEventListener('scroll', onScroll, { passive: true });
  return {
    destroy() {
      if (linger) clearTimeout(linger);
      node.removeEventListener('scroll', onScroll);
    }
  };
}

/**
 * Align the new-document label, and the reset control under the card, with the centered
 * mount label in the landscape layout.
 *
 * The measurement is published on the page's container rather than on the button it was
 * taken from, because two controls in two subtrees read it: the label inside New Blank
 * Lith, and the reset control in the panel's foot, which is a sibling of the action card
 * rather than a child of it. The number is the distance from the card's own content edge
 * to the type the two of them are matching, so each turns it into the padding its own box
 * needs (see the landscape block in the stylesheet).
 *
 * The property outlives the button it was measured against. When the inline title field
 * takes that button's row the field is the same full width, so the mount label does not
 * move and the reset control below stays where it was while a title is typed.
 */
export function alignNewLithLabel(node: HTMLButtonElement) {
  const card = node.parentElement;
  const page = node.closest<HTMLElement>('main.container');
  let frame = 0;
  const update = () => {
    frame = 0;
    if (!window.matchMedia('(orientation: landscape) and (max-height: 560px) and (max-width: 950px)').matches) {
      page?.style.removeProperty('--mount-label-offset');
      return;
    }
    const mount = card?.querySelector<HTMLButtonElement>('.mount-button');
    const label = mount?.querySelector<HTMLElement>('.mount-label');
    if (!mount || !label) return;
    const newRect = node.getBoundingClientRect();
    const mountRect = mount.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    if (!newRect.width || !mountRect.width || !labelRect.width) return;
    const style = getComputedStyle(node);
    const inset =
      (Number.parseFloat(style.borderLeftWidth) || 0) + (Number.parseFloat(style.paddingLeft) || 0);
    page?.style.setProperty('--mount-label-offset', `${Math.max(0, labelRect.left - newRect.left - inset)}px`);
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update);
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
  observer?.observe(node);
  if (card) observer?.observe(card);
  const mount = card?.querySelector('.mount-button');
  if (mount) observer?.observe(mount);
  const label = mount?.querySelector('.mount-label');
  if (label) observer?.observe(label);
  window.addEventListener('resize', schedule);
  schedule();
  return {
    destroy() {
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
    }
  };
}
