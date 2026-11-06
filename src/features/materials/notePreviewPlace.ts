import { TOP_BLOCKS } from '@/features/notes/roomSwap';

const FRAMES = 300;
const SCROLLS = /auto|scroll/;
const STATIC_NOTE = '[data-slate-editor]:not([contenteditable="true"])';
const LIVE_NOTE = '[data-slate-editor][contenteditable="true"]';

const staticBlocks = (box: HTMLElement) => [
  ...(box.querySelector(STATIC_NOTE)?.children ?? []),
];
const liveBlocks = (box: HTMLElement) =>
  box.querySelector(LIVE_NOTE) ? [...box.querySelectorAll(TOP_BLOCKS)] : [];

const scrollerOf = (element: Element, box: HTMLElement) => {
  for (let at = element.parentElement; at && at !== box; at = at.parentElement)
    if (SCROLLS.test(getComputedStyle(at).overflowY)) return at;
  return null;
};

/** Keeps the reader's place as a note switches between its editor and its Preview:
 * the nth top block at the same height, since the static note's blocks carry no ids.
 * What replaces it renders a moment later, so this waits for that block. Call it
 * before the switch; `to` is what the note is switching to. */
export function keepNotePlace(box: HTMLElement, to: 'editor' | 'preview') {
  const top = box.getBoundingClientRect().top;
  const blocks = to === 'editor' ? staticBlocks(box) : liveBlocks(box);
  const index = blocks.findIndex(
    (block) => block.getBoundingClientRect().bottom > top
  );
  if (index < 0) return;
  const offset = blocks[index].getBoundingClientRect().top - top;
  const target = to === 'editor' ? liveBlocks : staticBlocks;
  let frames = 0;
  const place = () => {
    // The paint stays over an opening editor, and hands it its own place when it
    // leaves, so the editor's turn comes after that.
    const painted = to === 'editor' && box.querySelector(STATIC_NOTE);
    const block = painted ? undefined : target(box)[index];
    const scroller = block && scrollerOf(block, box);
    if (block && scroller) {
      scroller.scrollTop +=
        block.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        offset;
      return;
    }
    frames += 1;
    if (frames < FRAMES) requestAnimationFrame(place);
  };
  requestAnimationFrame(place);
}
