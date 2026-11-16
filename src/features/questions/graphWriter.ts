import * as limits from '@/api/limits.generated';
import { sameJson } from '@/lib/sameJson';
import type { FigureBinding } from './figureBinding';
import type { GraphElement } from './types';
import { graphElementSchema } from './validation';

export type Frames = {
  cancel: (frame: number) => void;
  request: (run: () => void) => number;
};

const animationFrames: Frames = {
  cancel: (frame) => cancelAnimationFrame(frame),
  request: (run) => requestAnimationFrame(run),
};

/**
 * A graph editor's rows written to its figure (Epo 2026-11-16, live figures).
 * A row typed into, restyled, dragged or left unable to draw is `touch`ed:
 * until its element is in the figure it is `typing`, and a co-editor's change
 * to that element leaves the row as typed. On the next frame each touched
 * row's element is written, once however fast it was typed and only when it
 * differs from the figure's; a new one goes last, then to its row's place. A
 * row that gives no element (it does not parse, or names a point that is not
 * there) stays typing and unwritten until it does; one the graph check
 * refuses too, named to `onRefused`. Rows past the element cap are not written.
 */
export function graphWriter(
  binding: FigureBinding,
  /** The rows' elements now, in row order. */
  local: () => GraphElement[],
  onRefused: (refused: ReadonlyMap<string, string>) => void,
  frames: Frames = animationFrames
) {
  const typing = new Set<string>();
  const refused = new Map<string, string>();
  let frame = 0;
  const flush = () => {
    frames.cancel(frame);
    frame = 0;
    const figure = binding.read();
    if (figure?.block.type !== 'graph' || !typing.size) return;
    const held = new Map(
      figure.block.elements.map((element) => [element.id, element])
    );
    const before = refused.size;
    let placed = 0;
    for (const element of local().slice(
      0,
      limits.QUESTION_GRAPH_ELEMENTS_MAX
    )) {
      const there = held.get(element.id);
      if (!typing.has(element.id) || (there && sameJson(there, element))) {
        typing.delete(element.id);
        if (there) placed++;
        continue;
      }
      const check = graphElementSchema.safeParse(element);
      if (!check.success) {
        refused.set(element.id, check.error.issues[0].message);
        continue;
      }
      refused.delete(element.id);
      typing.delete(element.id);
      binding.setElement(element);
      if (!there) {
        if (placed < held.size) binding.moveElement(element.id, placed);
        held.set(element.id, element);
      }
      placed++;
    }
    if (refused.size || before) onRefused(new Map(refused));
  };
  return {
    /** Writes what is waiting now (the dialog is closing). */
    flush,
    /** Removes a row's element at once. */
    remove(key: string) {
      typing.delete(key);
      if (refused.delete(key)) onRefused(new Map(refused));
      binding.deleteElement(key);
    },
    /** Rows changed here: written on the next frame. */
    touch(keys: Iterable<string>) {
      for (const key of keys) typing.add(key);
      frame ||= frames.request(flush);
    },
    /** Whether a row holds what the figure does not have yet. */
    typing: (key: string) => typing.has(key),
  };
}

export type GraphWriter = ReturnType<typeof graphWriter>;
