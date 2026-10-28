import { DndPlugin } from '@platejs/dnd';
import {
  BlockSelectionPlugin,
  useBlockSelected,
  useCursorOverlay,
} from '@platejs/selection/react';
import { ElementApi, KEYS } from 'platejs';
import {
  type PlateElementProps,
  useEditorRef,
  usePluginOption,
} from 'platejs/react';
import { useEffect, useMemo } from 'react';
import {
  blockIndex,
  blockRuns,
  setNotePresence,
  throttled,
} from './notePresence';
import { editorAwareness } from './uploadPresence';

/** Ported from plate-playground-template block-selection.tsx: only blocks the
 * BlockSelectionPlugin marked selectable get the overlay. */
function hasSelectableClass({
  attributes,
  className,
}: {
  attributes: { className?: string };
  className?: string;
}) {
  return [className, attributes.className]
    .filter(Boolean)
    .join(' ')
    .includes('slate-selectable');
}

const NO_OVERLAY_KEYS = new Set<string>([KEYS.table, KEYS.tr]);

export function BlockSelection(props: PlateElementProps) {
  const isBlockSelected = useBlockSelected();
  const isDragging = usePluginOption(DndPlugin, 'isDragging');

  if (!isBlockSelected || isDragging || NO_OVERLAY_KEYS.has(props.plugin.key))
    return null;

  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0"
      data-slot="block-selection"
    />
  );
}

/** `render.belowRootNodes` entry for BlockSelectionPlugin. */
export function BlockSelectionBelowRootNodes(props: PlateElementProps) {
  if (!hasSelectableClass(props as Parameters<typeof hasSelectableClass>[0]))
    return null;
  return <BlockSelection {...props} />;
}

/**
 * Keeps the text selection visibly highlighted while editor focus moves into
 * floating inputs (link dialog, menus). The AI plugin set registers its own
 * variant that also hides during streaming; this one covers non-AI editors.
 */
export function EditorCursorOverlay() {
  const { cursors } = useCursorOverlay();

  return (
    <>
      {cursors.map(({ id, selectionRects }) =>
        id === 'selection'
          ? selectionRects.map((rect, index) => (
              <div
                className="pointer-events-none absolute z-10 bg-selection"
                key={index}
                style={{
                  height: rect.height,
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                }}
              />
            ))
          : null
      )}
    </>
  );
}

/** Puts the block selection in this tab's presence as runs of adjacent
 * blocks (Epo 2026-10-28), at most every 50 ms; renders nothing. */
export function BlockSelectionPresence() {
  const editor = useEditorRef();
  const selected = usePluginOption(BlockSelectionPlugin, 'selectedIds');
  const runs = useMemo(() => {
    const awareness = editorAwareness(editor);
    if (!awareness) return null;
    // Selected ids resolve through the rendered blocks, not a walk of the
    // note (Q547).
    let root: Element | undefined;
    let blocks: ReturnType<typeof blockIndex> | undefined;
    const nodeOf = (id: string) => {
      const block = blocks?.find(id);
      const node = block && editor.api.toSlateNode(block);
      return ElementApi.isElement(node) && node.id === id ? node : undefined;
    };
    return throttled(() => {
      const at = editor.api.toDOMNode(editor);
      if (at !== root) {
        root = at;
        blocks = at && blockIndex(at);
      }
      blocks?.next();
      setNotePresence(awareness, {
        b: blockRuns(
          editor,
          editor.getOption(BlockSelectionPlugin, 'selectedIds') ?? new Set(),
          nodeOf
        ),
      });
    });
  }, [editor]);
  useEffect(() => {
    if (selected) runs?.schedule();
  }, [runs, selected]);
  useEffect(() => () => runs?.cancel(), [runs]);
  return null;
}
