import type { TElement } from 'platejs';
import { useEditorRef } from 'platejs/react';
import { useEffect, useRef } from 'react';
import type { QuestionFigureElement } from '@/features/materials/document';
import { GraphError, renderGraphSvg } from '@/features/questions/graph';
import { repairFigureBlock } from '@/features/questions/repair';
import type { GraphBlock } from '@/features/questions/types';

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
    const redraw = async () => {
      const found = figureAt(editor.children, id);
      if (cancelled || !found || found[1].type !== 'graph') return;
      const [, held] = found;
      const host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      host.className = 'pointer-events-none fixed top-0 -left-[20000px]';
      document.body.append(host);
      let svg: string;
      try {
        svg = await renderGraphSvg(host, repairFigureBlock(held) as GraphBlock);
      } catch (error) {
        // A merge the board cannot draw keeps its stored SVG.
        if (error instanceof GraphError) return;
        throw error;
      } finally {
        host.remove();
      }
      const now = figureAt(editor.children, id);
      // A newer change redraws on its own.
      if (cancelled || !now || now[1] !== held) return;
      if ('svg' in held.image && held.image.svg === svg) return;
      editor.tf.withoutSaving(() =>
        editor.tf.setNodes({ block: { ...held, image: { svg } } } as never, {
          at: [now[0]],
        })
      );
    };
    const run = () => void redraw();
    if (typeof requestIdleCallback === 'function') {
      const handle = requestIdleCallback(run);
      return () => {
        cancelled = true;
        cancelIdleCallback(handle);
      };
    }
    const handle = setTimeout(run, 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [editor, id, readOnly, recipe]);
}
