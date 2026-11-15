import type { GfxController } from '@blocksuite/affine/std/gfx';
import { m } from '@/i18n';

const HIDE_DELAY_MS = 150;

const SVG = 'http://www.w3.org/2000/svg';

/** An http(s) address, never a `javascript:` or app link. */
function webAddress(href: string) {
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/** The open-in-a-new-tab mark. */
function openMark() {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [name, value] of Object.entries({
    'aria-hidden': 'true',
    fill: 'none',
    height: '14',
    stroke: 'currentColor',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'stroke-width': '1.8',
    viewBox: '0 0 24 24',
    width: '14',
  }))
    svg.setAttribute(name, value);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute(
    'd',
    'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'
  );
  svg.append(path);
  return svg;
}

/** A web link in a note's text, under a point: a note shows its text under a mask
 * while it isn't being typed in, so the link itself never takes the pointer. */
function linkAt(x: number, y: number) {
  for (const element of document.elementsFromPoint(x, y)) {
    const link = element.closest('affine-edgeless-note affine-link');
    const href = link?.querySelector('a')?.href;
    if (!(link && href)) continue;
    const url = webAddress(href);
    if (url) return { link, url };
  }
  return null;
}

/** Links in a note's text (Epo 2026-11-13, L1): hovering one while no note is being
 * typed in shows its address and Open (a new tab) above it; on a touch screen a tap
 * on it does. A click on the text still selects the note, so dragging it is
 * unchanged. While a note is typed in, its own link popup takes over. */
export function watchNoteLinks(gfx: GfxController, board: HTMLElement) {
  const chip = document.createElement('div');
  chip.className = 'capy-link-chip';
  chip.hidden = true;
  const address = document.createElement('span');
  address.className = 'address';
  const open = document.createElement('a');
  open.target = '_blank';
  open.rel = 'noopener noreferrer';
  open.className = 'open';
  open.append(m.drawing_board_open_link(), openMark());
  chip.append(address, open);
  board.append(chip);

  let shown: Element | null = null;
  let hideTimer = 0;
  const hide = () => {
    window.clearTimeout(hideTimer);
    shown = null;
    chip.hidden = true;
  };
  const show = (link: Element, url: URL) => {
    window.clearTimeout(hideTimer);
    if (shown === link) return;
    shown = link;
    address.textContent = `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
    open.href = url.href;
    chip.hidden = false;
    const box = link.getBoundingClientRect();
    const frame = board.getBoundingClientRect();
    const left = Math.max(
      4,
      Math.min(box.left - frame.left, frame.width - chip.offsetWidth - 4)
    );
    chip.style.left = `${left}px`;
    chip.style.top = `${Math.max(4, box.top - frame.top - chip.offsetHeight - 6)}px`;
  };
  const look = (event: PointerEvent) => {
    if (gfx.selection.editing) return hide();
    const found = linkAt(event.clientX, event.clientY);
    if (found) return show(found.link, found.url);
    if (shown && !chip.contains(event.target as Node)) {
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(hide, HIDE_DELAY_MS);
    }
  };
  const onMove = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.buttons === 0) look(event);
  };
  const onUp = (event: PointerEvent) => {
    if (event.pointerType !== 'mouse') look(event);
  };
  board.addEventListener('pointermove', onMove);
  board.addEventListener('pointerup', onUp);
  open.addEventListener('click', hide);
  const panned = gfx.viewport.viewportUpdated.subscribe(hide);
  const selected = gfx.selection.slots.updated.subscribe(() => {
    if (gfx.selection.editing) hide();
  });
  return () => {
    window.clearTimeout(hideTimer);
    board.removeEventListener('pointermove', onMove);
    board.removeEventListener('pointerup', onUp);
    panned.unsubscribe();
    selected.unsubscribe();
    chip.remove();
  };
}
