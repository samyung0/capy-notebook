import type { GfxController } from '@blocksuite/affine/std/gfx';
import { m } from '@/i18n';

/** How long the chip stays once the pointer leaves the link, and how long the
 * pointer rests on another link on its way to the chip before that link takes it. */
const HIDE_DELAY_MS = 150;

/** Past a selected note's turned box, clear of its frame (6 px off the note)
 * and the frame's handles at any turn: their 18 px targets reach about 21 px
 * past the box at 45°, the side bars' 16 px. */
const FRAME_CLEARANCE = 24;

/** The chip's gap above its link, and to the board's edges and tool row. */
const GAP = 6;
const EDGE = 4;

/** A note's drawn box: local change 56 turns its inner container, not the
 * note's own element. */
const NOTE_BOX = '[data-testid="edgeless-note-container"]';

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
 * typed in shows its address and Open (a new tab) above it, or past the frame of a
 * selected note; on a touch screen a tap on it does. A click on the text still
 * selects the note, so dragging it is unchanged. While a note is typed in, its own
 * link popup takes over. */
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
  let timer = 0;
  const hide = () => {
    window.clearTimeout(timer);
    shown = null;
    chip.hidden = true;
  };
  /** Above the link. For a selected note, clear of its frame and handles
   * (Epo 2026-11-13, F1): past the frame on the side away from its rotate knob
   * (below the note until it is turned past a quarter), else beside it at the
   * link's height, right then left; where none fits (a note taller than the
   * screen, or as wide as it), above the link again. Always inside the board
   * and clear of its bottom tool row, so a tap on Open always reaches it. */
  const place = (link: Element) => {
    const boardBox = board.getBoundingClientRect();
    const box = link.getBoundingClientRect();
    const { offsetHeight: height, offsetWidth: width } = chip;
    // A read-only board draws no tool row: its box is empty.
    const tools = board
      .querySelector('edgeless-toolbar-widget')
      ?.getBoundingClientRect();
    const ceiling = boardBox.top + EDGE;
    const floor =
      (tools?.height ? Math.min(boardBox.bottom, tools.top) : boardBox.bottom) -
      EDGE -
      height;
    const leftmost = boardBox.left + EDGE;
    const rightmost = boardBox.right - EDGE - width;
    const alongside = Math.max(leftmost, Math.min(box.left, rightmost));
    let spot: [number, number] = [alongside, box.top - height - GAP];
    const note = link.closest('affine-edgeless-note') as
      | (Element & { model: { id: string; rotate: number } })
      | null;
    if (note && gfx.selection.has(note.model.id)) {
      const around = (
        note.querySelector(NOTE_BOX) ?? note
      ).getBoundingClientRect();
      const level = box.top + (box.height - height) / 2;
      const spots: [number, number][] = [
        [
          alongside,
          Math.cos((note.model.rotate * Math.PI) / 180) < 0
            ? around.top - FRAME_CLEARANCE - height
            : around.bottom + FRAME_CLEARANCE,
        ],
        [around.right + FRAME_CLEARANCE, level],
        [around.left - FRAME_CLEARANCE - width, level],
      ];
      spot =
        spots.find(
          ([left, top]) =>
            top >= ceiling &&
            top <= floor &&
            left >= leftmost &&
            left <= rightmost
        ) ?? spot;
    }
    const [left, top] = spot;
    chip.style.left = `${left - boardBox.left}px`;
    chip.style.top = `${Math.max(ceiling, Math.min(top, floor)) - boardBox.top}px`;
  };
  const show = (link: Element, url: URL) => {
    window.clearTimeout(timer);
    if (shown === link) return;
    shown = link;
    address.textContent = `${url.host}${url.pathname === '/' ? '' : url.pathname}`;
    open.href = url.href;
    chip.hidden = false;
    place(link);
  };
  /** Whether a point lies on the way from the shown link to its chip: the box
   * around both, which holds every straight path between them. */
  const onTheWay = (x: number, y: number) => {
    if (!shown) return false;
    const from = shown.getBoundingClientRect();
    const to = chip.getBoundingClientRect();
    return (
      x >= Math.min(from.left, to.left) &&
      x <= Math.max(from.right, to.right) &&
      y >= Math.min(from.top, to.top) &&
      y <= Math.max(from.bottom, to.bottom)
    );
  };
  const look = (event: PointerEvent) => {
    if (gfx.selection.editing) return hide();
    // On the chip, it stays.
    if (chip.contains(event.target as Node)) return window.clearTimeout(timer);
    const found = linkAt(event.clientX, event.clientY);
    if (found && found.link === shown) return window.clearTimeout(timer);
    // A mouse on its way to the chip keeps it: it neither hides nor goes to
    // another link the pointer crosses, unless the pointer rests there.
    const passing =
      event.pointerType === 'mouse' && onTheWay(event.clientX, event.clientY);
    if (found && !passing) return show(found.link, found.url);
    window.clearTimeout(timer);
    if (found)
      timer = window.setTimeout(
        () => show(found.link, found.url),
        HIDE_DELAY_MS
      );
    else if (shown && !passing) timer = window.setTimeout(hide, HIDE_DELAY_MS);
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
  // A note selected under a shown chip gets its frame: the chip moves clear of it.
  const selected = gfx.selection.slots.updated.subscribe(() => {
    if (gfx.selection.editing) hide();
    else if (shown) place(shown);
  });
  return () => {
    window.clearTimeout(timer);
    board.removeEventListener('pointermove', onMove);
    board.removeEventListener('pointerup', onUp);
    panned.unsubscribe();
    selected.unsubscribe();
    chip.remove();
  };
}
