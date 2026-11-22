import * as limits from '@/api/limits.generated';
import { m } from '@/i18n';
import { sameJson } from '@/lib/sameJson';
import type { FigureBinding } from './figureBinding';
import { graphFull } from './graph';
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
 * refuses too, named to `onRefused`. A new row's element waits the same way,
 * named with the cap, while the figure already holds the cap: a co-editor may
 * have filled the last place since the row was started (as a chart's
 * `appended`, Epo 2026-11-22). An edit to an existing element past the
 * figure's first `drawnMax` is held back the same way: a quiz or note graph's
 * readers draw only its first elements up to the cap (the repairs keep those),
 * while a canvas plane draws every one, so each of its existing rows edits.
 * While a row waits so, each co-editor's change to the figure writes again, so
 * it goes in once a delete makes room. `dispose` ends all of it as the editor
 * closes: nothing waiting is written after.
 */
export function graphWriter(
  binding: FigureBinding,
  /** The rows now: their keys in order and the elements the drawable ones give. */
  local: () => { elements: readonly GraphElement[]; keys: readonly string[] },
  onRefused: (refused: ReadonlyMap<string, string>) => void,
  drawnMax: number,
  frames: Frames = animationFrames
) {
  const typing = new Set<string>();
  const refused = new Map<string, string>();
  /** Edits held back past what readers draw, as the last flush found them. */
  const heldBack = new Set<string>();
  let frame = 0;
  let closed = false;
  /** While `flush` writes: its own writes make no room, so the watch skips them. */
  let writing = false;
  /** The refusals as `onRefused` last heard them. */
  let told: ReadonlyMap<string, string> = new Map();
  const tell = () => {
    if (
      told.size === refused.size &&
      [...refused].every(([key, issue]) => told.get(key) === issue)
    )
      return;
    told = new Map(refused);
    onRefused(told);
  };
  /** Watches the figure while a row waits for room. */
  let unwatch: (() => void) | null = null;
  const watch = () => {
    if (closed) return;
    const waiting = refused.size > 0 || heldBack.size > 0;
    if (waiting && !unwatch)
      unwatch = binding.subscribe(() => {
        if (!(closed || writing)) frame ||= frames.request(flush);
      });
    else if (!waiting && unwatch) {
      unwatch();
      unwatch = null;
    }
  };
  const flush = () => {
    frames.cancel(frame);
    frame = 0;
    const figure = binding.read();
    if (figure?.block.type !== 'graph' || !typing.size) return;
    const held = new Map(
      figure.block.elements.map((element) => [element.id, element])
    );
    const { elements, keys } = local();
    const drawn = new Map(elements.map((element) => [element.id, element]));
    // Elements readers do not draw (past a quiz or note graph's cap), counted
    // in the figure, where a refused row holds no place.
    const unread = new Set(
      figure.block.elements.slice(drawnMax).map(({ id }) => id)
    );
    // How many of the figure's elements come before the row: a row that
    // cannot draw now still holds its place by the element the figure keeps.
    let placed = 0;
    heldBack.clear();
    writing = true;
    try {
      for (const key of keys) {
        const element = drawn.get(key);
        const there = held.get(key);
        if (!element || (there && unread.has(key))) {
          if (element && there && typing.has(key)) heldBack.add(key);
          if (there) placed++;
          continue;
        }
        if (!typing.has(key) || (there && sameJson(there, element))) {
          typing.delete(key);
          refused.delete(key);
          if (there) placed++;
          continue;
        }
        const check = graphElementSchema.safeParse(element);
        if (!check.success) {
          refused.set(element.id, check.error.issues[0].message);
          if (there) placed++;
          continue;
        }
        if (!there && graphFull(held.size)) {
          refused.set(
            element.id,
            m.question_ui_graph_elements_max({
              max: limits.QUESTION_GRAPH_ELEMENTS_MAX,
            })
          );
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
    } finally {
      writing = false;
    }
    tell();
    watch();
  };
  return {
    /** Ends the watching and any frame queued (the editor closed). */
    dispose() {
      closed = true;
      frames.cancel(frame);
      frame = 0;
      unwatch?.();
      unwatch = null;
    },
    /** Writes what is waiting now (the dialog is closing). */
    flush,
    /** Removes a row's element at once. */
    remove(key: string) {
      typing.delete(key);
      refused.delete(key);
      heldBack.delete(key);
      tell();
      watch();
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
