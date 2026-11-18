import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Awareness } from 'y-protocols/awareness';
import type { BoardPresenceView } from '@/features/blocksuite/drawingBoard';
import {
  FLIP_WITHIN,
  PeerOutline,
  PeerPointer,
  pointerTransform,
} from '@/features/collaboration/PresenceMarks';
import {
  type PresenceConnection,
  presenceClients,
} from '@/features/collaboration/presence';
import { useNoteEditorPrefs } from '@/features/notes/noteEditorPrefs';
import {
  type BoardMark,
  placeOutline,
  placeText,
  readBoardPeer,
} from './boardPresence';

/** A canvas's presence as its page holds it: the room's awareness, who the
 * room says is in it, and the board the marks go on. */
export type CanvasPresence = {
  awareness: Awareness;
  connections: PresenceConnection[];
  view: BoardPresenceView;
};

const NO_MARKS: BoardMark[] = [];
const NO_FLIPS: ReadonlySet<string> = new Set();
/** A pan or zoom has come to rest: text is measured again, since a note out
 * of view has no place on the page until it is back in it. */
const VIEW_RESTS_MS = 150;

/** A peer's marks, and what each was placed from. */
type Placed = {
  from: { b: string; label: string; p: boolean; text: string };
  outline?: BoardMark;
  pointer?: BoardMark;
  text: BoardMark[];
};

const sameMarks = (
  left: BoardMark | BoardMark[] | undefined,
  right: BoardMark | BoardMark[] | undefined
) => JSON.stringify(left) === JSON.stringify(right);

/**
 * Other people on a canvas (Epo 2026-11-18): their pointers and what they
 * selected, drawn as a note draws them (PresenceMarks.tsx), and their carets
 * and selected text inside a note's or a text block's text, a 2 px bar and a
 * 13% tint in their colour as a note's are. Someone typing in a shape or on a
 * connector shows as the outline around it. Nothing with the show-others
 * switch off, and nothing for a viewer, whom the room tells nothing.
 *
 * The marks sit in a layer inside the board, placed in board units: a pan or
 * zoom writes that layer's transform and zoom and nothing else, so they follow
 * the board in the same frame, and one outside the visible area is clipped.
 * A peer's pointer move writes its mark's transform (the 120 ms glide, in
 * board units, so the viewport never restarts it) and no React state; React
 * renders when a mark appears, goes, or changes its box, name or side.
 * Outlines are worked out from the board's own boxes. Only text reads the
 * page's layout, at most once a frame, when a caret, the document or the
 * resting viewport changed.
 */
export function BoardPresenceMarks({
  presence,
}: {
  presence: CanvasPresence | null;
}) {
  return presence && createPortal(<Marks {...presence} />, presence.view.host);
}

function Marks({ awareness, connections, view }: CanvasPresence) {
  const shown = useNoteEditorPrefs((state) => state.showOthers);
  const layer = useRef<HTMLDivElement>(null);
  const [marks, setMarks] = useState<BoardMark[]>(NO_MARKS);
  const [flipped, setFlipped] = useState(NO_FLIPS);
  // Each pointer's element and where it is now, by its mark's key.
  const pointers = useRef(new Map<string, HTMLElement>());
  const spots = useRef(new Map<string, [x: number, y: number]>());
  const clients = useRef(presenceClients(connections));
  const relayout = useRef(() => {});
  useEffect(() => {
    clients.current = presenceClients(connections);
    relayout.current();
  }, [connections]);

  useEffect(() => {
    const box = layer.current;
    // Nothing of another board, room or setting stays drawn.
    setMarks(NO_MARKS);
    setFlipped(NO_FLIPS);
    if (!(shown && box)) return;
    const { doc } = awareness;
    const placed = new Map<number, Placed>();
    const changed = new Set<number>();
    let every = true;
    let frame = 0;
    let rest: ReturnType<typeof setTimeout> | undefined;
    let at = view.view();
    let flips = '';
    /** Which pointers are near the board's right edge: their names go on
     * their left. Arithmetic on what is already known. */
    const flip = () => {
      const next: string[] = [];
      for (const [key, [x]] of spots.current)
        if (x * at.zoom + at.left > at.width - FLIP_WITHIN) next.push(key);
      const sides = next.join();
      if (sides === flips) return;
      flips = sides;
      setFlipped(new Set(next));
    };
    const layout = () => {
      frame = 0;
      const peers = every
        ? new Set([...placed.keys(), ...awareness.getStates().keys()])
        : changed;
      let redraw = false;
      for (const client of peers) {
        const peer = readBoardPeer(awareness, clients.current, client);
        const before = placed.get(client);
        const key = `${client}:p`;
        if (!peer) {
          spots.current.delete(key);
          redraw = placed.delete(client) || redraw;
          continue;
        }
        const { b, f, p, s } = peer.presence;
        const from = {
          b: JSON.stringify(b),
          label: `${peer.color} ${peer.name}`,
          p: !!p,
          text: `${s} ${f}`,
        };
        const renamed = before?.from.label !== from.label;
        const next: Placed = { from, text: before?.text ?? [] };
        if (p) {
          const [x, y] = p;
          spots.current.set(key, [x, y]);
          // A move goes straight to the element; its mark keeps the place it
          // was first drawn at, which React never writes again.
          if (before?.pointer && !renamed) {
            next.pointer = before.pointer;
            const drawn = pointers.current.get(key);
            if (drawn) drawn.style.transform = pointerTransform(x, y);
          } else {
            const { color, name } = peer;
            next.pointer = { color, key, kind: 'pointer', name, x, y };
          }
        } else spots.current.delete(key);
        redraw ||= next.pointer !== before?.pointer;
        if (every || renamed || before?.from.b !== from.b) {
          next.outline = placeOutline(view, client, peer);
          redraw ||= !sameMarks(next.outline, before?.outline);
        } else next.outline = before?.outline;
        if (every || renamed || before?.from.text !== from.text) {
          next.text = placeText(view, doc, client, peer);
          redraw ||= !sameMarks(next.text, before?.text ?? []);
        }
        placed.set(client, next);
      }
      every = false;
      changed.clear();
      flip();
      if (!redraw) return;
      // Tints under outlines, carets over them, pointers on top.
      const drawn = [...placed.values()];
      setMarks([
        ...drawn.flatMap(({ text }) =>
          text.filter(({ kind }) => kind === 'range')
        ),
        ...drawn.flatMap(({ outline }) => outline ?? []),
        ...drawn.flatMap(({ text }) =>
          text.filter(({ kind }) => kind === 'caret')
        ),
        ...drawn.flatMap(({ pointer }) => pointer ?? []),
      ]);
    };
    const schedule = () => {
      frame ||= requestAnimationFrame(layout);
    };
    // Every outline and caret moves with what is drawn and the room's names.
    const again = () => {
      every = true;
      schedule();
    };
    relayout.current = again;
    const place = () => {
      at = view.view();
      box.style.transform = `translate(${at.left}px, ${at.top}px) scale(${at.zoom})`;
      box.style.setProperty('--presence-zoom', String(at.zoom));
      flip();
    };
    const moved = () => {
      place();
      clearTimeout(rest);
      rest = setTimeout(again, VIEW_RESTS_MS);
    };
    // This tab's own presence changes nothing here.
    const update = ({
      added,
      removed,
      updated,
    }: Record<'added' | 'removed' | 'updated', number[]>) => {
      for (const client of [...added, ...updated, ...removed])
        if (client !== awareness.clientID) changed.add(client);
      if (changed.size > 0) schedule();
    };
    place();
    again();
    awareness.on('change', update);
    // Anyone's edit can move an element or the text around a caret.
    doc.on('update', again);
    const offView = view.onView(moved);
    const spotted = spots.current;
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(rest);
      awareness.off('change', update);
      doc.off('update', again);
      offView();
      relayout.current = () => {};
      spotted.clear();
    };
  }, [awareness, view, shown]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-1 overflow-hidden"
    >
      <div className="absolute top-0 left-0 origin-top-left" ref={layer}>
        {marks.map((mark) => {
          const { color, key, name } = mark;
          if (mark.kind === 'pointer')
            return (
              <PeerPointer
                color={color}
                flip={flipped.has(key)}
                key={key}
                left={mark.x}
                name={name}
                ref={(element) => {
                  if (!element) {
                    pointers.current.delete(key);
                    return;
                  }
                  pointers.current.set(key, element);
                  // It may have moved between its mark and its element.
                  const spot = spots.current.get(key);
                  if (spot) element.style.transform = pointerTransform(...spot);
                }}
                top={mark.y}
                zoomed
              />
            );
          if (mark.kind === 'outline')
            return (
              <PeerOutline
                color={color}
                height={mark.h}
                key={key}
                left={mark.x}
                name={name}
                top={mark.y}
                width={mark.w}
                zoomed
              />
            );
          const peer = { '--peer': `var(--peer-${color})` } as CSSProperties;
          return mark.kind === 'caret' ? (
            // Sized in screen pixels and scaled back, as an outline is: the
            // bar is 2 px at any zoom.
            <span
              className="absolute w-0.5 origin-top-left bg-(--peer)"
              data-remote-caret={name}
              key={key}
              style={{
                ...peer,
                height: `calc(${mark.h}px * var(--presence-zoom))`,
                left: mark.x,
                top: mark.y,
                transform:
                  'scale(calc(1 / var(--presence-zoom))) translateX(-1px)',
              }}
            />
          ) : (
            <span
              className="absolute bg-[color-mix(in_srgb,var(--peer)_13%,transparent)]"
              data-remote-cursor={name}
              key={key}
              style={{
                ...peer,
                height: mark.h,
                left: mark.x,
                top: mark.y,
                width: mark.w,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
