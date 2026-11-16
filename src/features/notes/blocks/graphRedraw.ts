import type { TElement } from 'platejs';
import { useEditorRef } from 'platejs/react';
import { useEffect, useRef } from 'react';
import { graphSvg } from '@/features/graph/svg';
import type { QuestionFigureElement } from '@/features/materials/document';
import { GraphError, validateGraphRecipe } from '@/features/questions/graph';
import { repairFigureBlock } from '@/features/questions/repair';
import type { GraphBlock } from '@/features/questions/types';
import { writeNoEdit } from '../roomBinding';

/** A top-level figure's index and block, found by its id. */
function figureAt(
  children: readonly TElement[],
  id: string
): [number, QuestionFigureElement['block']] | null {
  const index = children.findIndex((node) => node.id === id);
  if (index < 0) return null;
  return [index, (children[index] as unknown as QuestionFigureElement).block];
}

/**
 * Redraws a graph's SVG after its recipe changes (Epo 2026-10-17): two
 * editors' graph edits merge element by element, so the SVG one of them
 * saved can miss the other's. An editor in Edit mode renders the graph as
 * readers draw it (repaired) in an idle callback and writes `image` only when
 * the SVG differs, outside Undo. The write changes `image` alone, which this
 * does not watch, so it never redraws itself; readers keep the stored SVG.
 */
export function useGraphRedraw(element: TElement, readOnly: boolean) {
  const editor = useEditorRef();
  const block = (element as unknown as QuestionFigureElement).block;
  const recipe =
    block.type === 'graph'
      ? JSON.stringify([block.elements, block.board, block.width, block.height])
      : null;
  const drawn = useRef(recipe);
  const id = element.id as string;
  useEffect(() => {
    if (readOnly || recipe === null || recipe === drawn.current) return;
    drawn.current = recipe;
    let cancelled = false;
    const redraw = () => {
      const found = figureAt(editor.children, id);
      if (cancelled || !found || found[1].type !== 'graph') return;
      const [, held] = found;
      const repaired = repairFigureBlock(held) as GraphBlock;
      try {
        validateGraphRecipe(repaired);
      } catch (error) {
        // A merge that cannot be drawn keeps its stored SVG.
        if (error instanceof GraphError) return;
        throw error;
      }
      const svg = graphSvg(repaired);
      if ('svg' in held.image && held.image.svg === svg) return;
      writeNoEdit(editor, () =>
        editor.tf.withoutSaving(() =>
          editor.tf.setNodes({ block: { ...held, image: { svg } } } as never, {
            at: [found[0]],
          })
        )
      );
    };
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(redraw);
      return () => {
        cancelled = true;
        cancelIdleCallback(handle);
      };
    }
    const handle = setTimeout(redraw, 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [editor, id, readOnly, recipe]);
}
