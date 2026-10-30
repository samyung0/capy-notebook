import { scrollToCenter } from '@/features/files/scrollToCenter';
import type { NoteCitationTarget } from './openItem';

/** A cited block's flash, as long as a PDF box's (PdfView). */
const FLASH_MS = 1600;
/** A note paints after its query: how long to wait for it. */
const WAIT_MS = 5000;
const POLL_MS = 100;
/** A shorter line matches too many blocks to place a citation. */
const MIN_LINE = 8;

const LINK_TARGET = /\]\([^)]*\)/g;
const NOT_TEXT = /[^\p{L}\p{N}]+/gu;

/** Letters and digits only: a chunk's Markdown marks, table pipes and spacing
 * differ from its rendered block. */
const plain = (text: string) =>
  text.replace(LINK_TARGET, '').replace(NOT_TEXT, '').toLowerCase();

/** Each rendered note root's top-level blocks: its children, in this order. */
const rendered = new WeakMap<Element, readonly unknown[]>();

export function registerNoteBlocks(note: Element, ids: readonly unknown[]) {
  rendered.set(note, ids);
}

/** The blocks from the first cited id to the last that still exist (Q594):
 * an edited block stays cited, whatever it says now. */
export function blocksWithIds(note: Element, ids: string[]): HTMLElement[] {
  const order = rendered.get(note) ?? [];
  const found = ids
    .map((id) => order.indexOf(id))
    .filter((index) => index !== -1);
  if (!found.length) return [];
  return [...note.children].slice(
    Math.min(...found),
    Math.max(...found) + 1
  ) as HTMLElement[];
}

/**
 * The note's top-level blocks behind a citation's snippet, for a citation with
 * no block ids (Q593): the longest snippet line found in exactly one block
 * places it, and the other lines near it extend the range. An edited note or a
 * line found twice finds nothing, so the note just opens, as an Office citation
 * does.
 */
export function citedBlocks(note: Element, quote: string): HTMLElement[] {
  const blocks = [...note.children] as HTMLElement[];
  const texts = blocks.map((block) => plain(block.textContent ?? ''));
  const lines = [
    ...new Set(
      quote
        .split('\n')
        .map(plain)
        .filter((line) => line.length >= MIN_LINE)
    ),
  ].sort((a, b) => b.length - a.length);
  const blocksWith = (line: string) =>
    texts.flatMap((text, index) => (text.includes(line) ? [index] : []));
  const anchor = lines.map(blocksWith).find((at) => at.length === 1)?.[0];
  if (anchor === undefined) return [];
  let first = anchor;
  let last = anchor;
  for (const line of lines) {
    const [near] = blocksWith(line)
      .filter((index) => Math.abs(index - anchor) <= lines.length)
      .sort((a, b) => Math.abs(a - anchor) - Math.abs(b - anchor));
    if (near === undefined) continue;
    first = Math.min(first, near);
    last = Math.max(last, near);
  }
  return blocks.slice(first, last + 1);
}

/** Waits for the note in `scroller`, scrolls its cited blocks to the middle and
 * flashes them, as a PDF citation does. Returns the stop. */
export function showNoteCitation(
  scroller: HTMLElement,
  { blockIds = [], quote }: NoteCitationTarget
) {
  let timer = 0;
  let flashed: HTMLElement[] = [];
  let stopScroll = () => {};
  const deadline = performance.now() + WAIT_MS;
  const look = () => {
    const note = scroller.querySelector('[data-slate-editor]');
    if (!note) {
      if (performance.now() < deadline)
        timer = window.setTimeout(look, POLL_MS);
      return;
    }
    const byId = blocksWithIds(note, blockIds);
    const blocks = byId.length ? byId : citedBlocks(note, quote);
    if (!blocks.length) return;
    stopScroll = scrollToCenter(scroller, blocks[0], () => {
      flashed = blocks;
      for (const block of blocks) block.setAttribute('data-citation-flash', '');
      timer = window.setTimeout(() => {
        for (const block of blocks)
          block.removeAttribute('data-citation-flash');
      }, FLASH_MS);
    });
  };
  look();
  return () => {
    stopScroll();
    window.clearTimeout(timer);
    for (const block of flashed) block.removeAttribute('data-citation-flash');
  };
}
