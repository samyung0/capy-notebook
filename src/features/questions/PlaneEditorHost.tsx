import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { PlaneEditing, PlaneOpener } from '@/features/graph/planeEditing';
import { GraphEditor, type PlaneMode } from './GraphEditor';

/**
 * The page's side of a board's plane cards (Epo 2026-11-17: one graph
 * editor): `openPlane` goes to `mountDrawingBoard`, and `planeEditor` is the
 * graph editor it opens, rendered over the board. Done, an Escape nothing else
 * took, or the board itself closes it; what the editor holds (a row typed,
 * an open mark, the camera) is written first, while its steps are its own.
 */
export function usePlaneEditor() {
  const [editing, setEditing] = useState<PlaneEditing | null>(null);
  const camera = useRef<PlaneEditing['camera'] | null>(null);
  const leaving = useRef<(() => void) | null>(null);
  const close = useRef(() => undefined as void);
  const openPlane = useCallback<PlaneOpener>((next) => {
    camera.current = next.camera;
    let open = true;
    close.current = () => {
      if (!open) return;
      open = false;
      // What the editor holds is written while its steps are still its own.
      leaving.current?.();
      next.close(camera.current ?? next.camera);
      setEditing(null);
    };
    setEditing(next);
    return () => close.current();
  }, []);
  // Escape with nothing focused (the page's body) leaves too.
  useEffect(() => {
    if (!editing) return;
    const key = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        event.target === document.body
      )
        close.current();
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [editing]);
  const plane = useMemo(
    (): PlaneMode | null =>
      editing && {
        camera: editing.camera,
        history: editing.history,
        leaving,
        list: editing.list,
        onCamera: (next) => {
          camera.current = next;
        },
      },
    [editing]
  );
  const planeEditor =
    editing &&
    plane &&
    createPortal(
      // Escape no one took leaves, as the board's editors always have.
      <div
        className="size-full"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented)
            close.current();
        }}
      >
        <GraphEditor
          binding={editing.binding}
          onDone={() => close.current()}
          plane={plane}
        />
      </div>,
      editing.root
    );
  return { openPlane, planeEditor };
}
