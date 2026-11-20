import {
  createContext,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { UndoSink, type UndoTarget } from '@/features/collaboration/undo';

/** Lends an embed's Undo target with the box it is drawn in; returns how to
 * take it back. */
type LendEmbedUndo = (
  target: UndoTarget,
  box: RefObject<Element | null>
) => () => void;

const LendContext = createContext<LendEmbedUndo | null>(null);
const ActiveContext = createContext<UndoTarget | null>(null);

/** The embed whose history the note's Undo and Redo act on, if any. */
export const useActiveEmbedUndo = () => useContext(ActiveContext);

/** The fields of an embed keep their own undo (as a canvas card's do). */
const FIELD = 'input, textarea, math-field, [contenteditable="true"]';

type Lender = { box: RefObject<Element | null>; target: UndoTarget };

/** The note block an embed's box sits in (its void element, outside the
 * embed's own field editors). */
const blockOf = (box: Element | null | undefined) =>
  box?.parentElement?.closest('[data-slate-node="element"]') ?? null;

/**
 * A note's embedded quizzes and sets keep their history in their own rooms
 * (Epo 2026-11-17, in place of each embed's own Undo, Redo and Saved row):
 * the embed last pressed lends the note its history, so the note's Undo and
 * Redo and ⌘Z / ⇧⌘Z act on it, as a canvas card's do while edited. Pressing
 * anywhere else (the note's title, its text, another block, or outside the
 * note), or the caret moving into the note's text, gives them back.
 */
export function EmbedUndoHost({ children }: { children: ReactNode }) {
  const lenders = useRef(new Set<Lender>());
  // What was pressed inside an embed, kept until something else is: an embed
  // still loading lends once it can.
  const pressed = useRef<Element | null>(null);
  const [active, setActive] = useState<UndoTarget | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // A press React saw here, portaled menus and dialogs included.
  const seen = useRef<Event | null>(null);
  const holder = (node: Node | null) =>
    node
      ? [...lenders.current].find(({ box }) => box.current?.contains(node))
      : undefined;
  const giveBack = useCallback(() => {
    pressed.current = null;
    setActive(null);
  }, []);
  const lend = useCallback<LendEmbedUndo>((target, box) => {
    const entry = { box, target };
    lenders.current.add(entry);
    if (pressed.current && box.current?.contains(pressed.current))
      setActive(target);
    return () => {
      lenders.current.delete(entry);
      setActive((current) => (current === target ? null : current));
    };
  }, []);
  useEffect(() => {
    // A press outside the note (the sidebar, the file's header).
    const press = (event: PointerEvent) => {
      if (event !== seen.current && pressed.current) giveBack();
    };
    // The caret moved into the note's text, by keys or Tab.
    const caret = () => {
      if (!pressed.current) return;
      const anchor = document.getSelection()?.anchorNode;
      const at = anchor instanceof Element ? anchor : anchor?.parentElement;
      const note = at?.closest('.note-editor');
      if (!(note && root.current?.contains(note))) return;
      const block = blockOf(holder(pressed.current)?.box.current);
      if (!(at && block?.contains(at))) giveBack();
    };
    document.addEventListener('pointerdown', press);
    document.addEventListener('selectionchange', caret);
    return () => {
      document.removeEventListener('pointerdown', press);
      document.removeEventListener('selectionchange', caret);
    };
  }, [giveBack]);
  // On the document, ahead of Slate's own ⌘Z: a press inside an embed but on
  // no control leaves the focus on the page's body.
  useEffect(() => {
    if (!active) return;
    const keys = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const redo = key === 'y' || (key === 'z' && event.shiftKey);
      if (!redo && key !== 'z') return;
      // Not from a portal (a dialog keeps its own), nor from a field.
      const target = event.target as Element;
      if (target !== document.body && !root.current?.contains(target)) return;
      const field = target.closest(FIELD);
      if (field && !field.classList.contains('note-editor')) return;
      event.preventDefault();
      event.stopPropagation();
      if (redo) active.redo();
      else active.undo();
    };
    document.addEventListener('keydown', keys, true);
    return () => document.removeEventListener('keydown', keys, true);
  }, [active]);
  return (
    <LendContext.Provider value={lend}>
      <ActiveContext.Provider value={active}>
        <div
          className="contents"
          onPointerDownCapture={(event) => {
            seen.current = event.nativeEvent;
            // Only presses in the note itself: the toolbar's Undo keeps the
            // embed, and so does a portaled menu (it bubbles here through
            // React).
            const target = event.target as Element;
            if (!target.closest('[data-note-scroll]')) return;
            const entry = holder(target);
            if (!entry && !target.closest('[data-embed-undo]')) {
              giveBack();
              return;
            }
            pressed.current = target;
            setActive(entry?.target ?? null);
          }}
          ref={root}
        >
          {children}
        </div>
      </ActiveContext.Provider>
    </LendContext.Provider>
  );
}

/** Around a note's embed in Edit: what its editor lends (`useLendUndo`) goes
 * to the note with this box. Outside a note editor its own row stays. */
export function EmbedUndoLender({ children }: { children: ReactNode }) {
  const host = useContext(LendContext);
  const box = useRef<HTMLDivElement>(null);
  const lend = useCallback(
    (target: UndoTarget) => (host ? host(target, box) : () => {}),
    [host]
  );
  return (
    <div data-embed-undo="" ref={box}>
      <UndoSink.Provider value={host ? lend : null}>
        {children}
      </UndoSink.Provider>
    </div>
  );
}
