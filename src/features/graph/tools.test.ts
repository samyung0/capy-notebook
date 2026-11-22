import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as limits from '@/api/limits.generated';
import { graphFull } from '@/features/questions/graph';
import type { GraphElement, Vec } from './model';
import {
  type Formula,
  freePointName,
  graphTools,
  type ToolHost,
} from './tools';

/** A canvas box at the page's top left, its events sent by hand. */
class Canvas extends EventTarget {
  style = { cursor: '' };
}

/** Text 8 px a character, as a canvas measures it. */
const ctx = {
  font: '',
  measureText: (text: string) => ({ width: text.length * 8 }),
};

let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  frames = [];
});

/** The tools over a 400 × 400 graph at 40 px a unit, (0, 10) at its top left,
 * so a unit is 40 px and the grid's points land on halves. */
function setup(start: GraphElement[] = [], options: { full?: boolean } = {}) {
  const canvas = new Canvas();
  const state = {
    elements: start,
    formula: null as null | {
      done: (latex: string) => void;
      near: Formula | null;
    },
    label: null as string | null,
    refused: 0,
    writes: 0,
  };
  const host: ToolHost = {
    accent: () => '#7c5cff',
    canvas: canvas as unknown as HTMLCanvasElement,
    changed: () => undefined,
    ctx: ctx as unknown as CanvasRenderingContext2D,
    dark: () => false,
    elements: () => state.elements,
    formula: (near, _at, done) => {
      state.formula = { done, near };
    },
    full: () => Boolean(options.full),
    labelText: () => state.label,
    local: (event) => [event.clientX, event.clientY],
    polar: () => false,
    redraw: () => undefined,
    refused: () => {
      state.refused++;
    },
    size: () => ({ h: 400, w: 400 }),
    trail: { add() {}, draw() {}, end() {}, start() {} },
    view: () => ({ left: 0, ppuX: 40, ppuY: 40, top: 10 }),
    write: (next) => {
      state.elements = next;
      state.writes++;
    },
  };
  const tools = graphTools(host);
  tools.attach();
  const send = (type: string, [x, y]: Vec, fields: object = {}) =>
    canvas.dispatchEvent(
      Object.assign(new Event(type), {
        altKey: false,
        button: 0,
        buttons: type === 'pointerup' ? 0 : 1,
        clientX: x,
        clientY: y,
        pointerId: 1,
        pointerType: 'mouse',
        shiftKey: false,
        ...fields,
      })
    );
  /** A click at a pixel. */
  const click = (at: Vec, fields?: object) => {
    send('pointerdown', at, fields);
    send('pointerup', at, fields);
  };
  /** A press dragged from one pixel to another. */
  const drag = (from: Vec, to: Vec, fields?: object) => {
    send('pointerdown', from, fields);
    send('pointermove', [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2], fields);
    send('pointermove', to, fields);
    send('pointerup', to, fields);
  };
  return { click, drag, send, state, tools };
}

/** A pixel for a point on the plane. */
const px = (x: number, y: number): Vec => [x * 40, (10 - y) * 40];

describe('drawing tools', () => {
  it('places a point on the grid', () => {
    const { click, state, tools } = setup();
    tools.pick('point');
    click([41, 362]);
    expect(state.elements).toMatchObject([
      { coords: [1, 1], name: 'A', type: 'point' },
    ]);
    // Point stays on, as AFFiNE's pen does.
    expect(tools.tool()).toBe('point');
  });

  it('names each point it places with the next free name', () => {
    const { click, state, tools } = setup([
      { coords: [0, 0], id: 'a', name: 'A', type: 'point' },
      { coords: [0, 1], id: 'c', name: 'C', type: 'point' },
    ]);
    tools.pick('point');
    click(px(2, 2));
    click(px(3, 3));
    expect(
      state.elements.map((element) => 'name' in element && element.name)
    ).toEqual(['A', 'C', 'B', 'D']);
  });

  it('names points past Z with a subscript', () => {
    const letters = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'];
    const named = (names: string[]) =>
      names.map(
        (name): GraphElement => ({
          coords: [0, 0],
          id: name,
          name,
          type: 'point',
        })
      );
    expect(freePointName(named(letters))).toBe('A_1');
    expect(
      freePointName(named([...letters, ...letters.map((l) => `${l}_1`)]))
    ).toBe('A_2');
  });

  it('draws a line and a vector from one click to the next, then goes back to Select', () => {
    const { click, state, tools } = setup();
    tools.pick('line');
    click(px(1, 1));
    click(px(3, 2));
    tools.pick('vector');
    click(px(0, 0));
    click(px(2, 0));
    expect(state.elements).toMatchObject([
      {
        coords: [
          [1, 1],
          [3, 2],
        ],
        type: 'polyline',
      },
      {
        arrow: true,
        coords: [
          [0, 0],
          [2, 0],
        ],
        type: 'polyline',
      },
    ]);
    expect(tools.tool()).toBe('select');
  });

  it('draws a curve through its clicks until the last is clicked again', () => {
    const { click, state, tools } = setup();
    tools.pick('curve');
    for (const at of [px(0, 0), px(1, 2), px(2, 0), px(2, 0)]) click(at);
    expect(state.elements).toMatchObject([
      {
        coords: [
          [0, 0],
          [1, 2],
          [2, 0],
        ],
        type: 'curve',
      },
    ]);
    expect(tools.finishLabel()).toBeNull();
  });

  it('ends a curve at the most points a graph keeps', () => {
    const { click, state, tools } = setup();
    tools.pick('curve');
    for (let i = 0; i < limits.QUESTION_GRAPH_PATH_MAX + 5; i++)
      click(px((i % 10) / 2, Math.floor(i / 10) / 2));
    const [curve] = state.elements;
    expect(curve.type === 'curve' && curve.coords.length).toBe(
      limits.QUESTION_GRAPH_PATH_MAX
    );
  });

  it('places a circle a grid step round, or as wide as it is dragged', () => {
    const { click, drag, state, tools } = setup();
    tools.pick('ellipse');
    click(px(1, 1));
    tools.pick('ellipse');
    drag(px(5, 5), px(8, 5));
    expect(state.elements).toMatchObject([
      { center: [1, 1], radii: [2, 2], type: 'ellipse' },
      { center: [5, 5], radii: [3, 3], type: 'ellipse' },
    ]);
  });

  it('types a label where it is clicked, then goes back to Select', () => {
    const { click, state, tools } = setup();
    tools.pick('label');
    click(px(2, 3));
    expect(tools.typing()).toMatchObject({ at: [2, 3], text: '' });
    state.label = ' Area ';
    tools.commitLabel();
    expect(state.elements).toMatchObject([
      { coords: [2, 3], text: 'Area', type: 'text' },
    ]);
    expect(tools.tool()).toBe('select');
  });

  it('places a formula once typed, and empties an old one away', () => {
    const { click, state, tools } = setup();
    tools.pick('formula');
    click(px(2, 3));
    state.formula?.done('x^2');
    expect(state.elements).toMatchObject([
      { coords: [2, 3], latex: 'x^2', type: 'formula' },
    ]);
    tools.pick('formula');
    click(px(2, 3));
    expect(state.formula?.near?.latex).toBe('x^2');
    state.formula?.done('');
    expect(state.elements).toEqual([]);
  });

  it('turns a new element away at the cap', () => {
    const { click, state, tools } = setup([], { full: true });
    tools.pick('point');
    click(px(1, 1));
    expect(state.elements).toEqual([]);
    expect(state.refused).toBe(1);
  });

  it('adds nothing to a canvas plane two adds merged past the cap (Epo 2026-11-22)', () => {
    const many: GraphElement[] = Array.from(
      { length: limits.QUESTION_GRAPH_ELEMENTS_MAX + 1 },
      (_, i) => ({ coords: [i, -100], id: `P${i}`, type: 'point' })
    );
    const { click, state, tools } = setup(many, {
      full: graphFull(many.length),
    });
    tools.pick('point');
    click(px(1, 1));
    expect(state.elements).toBe(many);
    expect(state.refused).toBe(1);
  });
});

const named: GraphElement[] = [
  { coords: [1, 1], id: 'A', name: 'A', type: 'point' },
  { coords: [5, 1], id: 'B', name: 'B', type: 'point' },
  { id: 'AB', points: ['A', 'B'], type: 'segment' },
  {
    coords: [
      [0, 6],
      [4, 6],
    ],
    id: 'line',
    type: 'polyline',
  },
];

describe('eraser', () => {
  it('takes what its ring passes over, and what is built on an erased point', () => {
    const { drag, state, tools } = setup(named);
    tools.pick('erase');
    drag(px(1, 6), px(1, 5.5));
    expect(state.elements.map(({ id }) => id)).toEqual(['A', 'B', 'AB']);
    drag(px(1, 1), px(1, 0.9));
    expect(state.elements.map(({ id }) => id)).toEqual(['B']);
  });
});

describe('select', () => {
  it('picks a mark by its stroke and moves it on the grid in one write', () => {
    const { click, drag, state, tools } = setup(named);
    click(px(2, 6.1));
    expect(tools.selected('line')).toBe(true);
    drag(px(2, 6), px(3.1, 7));
    expect(state.writes).toBe(1);
    expect(state.elements[3]).toMatchObject({
      coords: [
        [1, 7],
        [5, 7],
      ],
    });
  });

  it('moves a segment by the points it is built on', () => {
    const { drag, state } = setup(named);
    drag(px(3, 1), px(3, 2));
    expect(state.elements.slice(0, 2)).toMatchObject([
      { coords: [1, 2] },
      { coords: [5, 2] },
    ]);
  });

  it('boxes what it touches on empty paper, and Delete takes them with what is built on them', () => {
    const { drag, state, tools } = setup(named);
    drag(px(0.5, 0.5), px(1.5, 1.5));
    expect(tools.selected('A')).toBe(true);
    expect(tools.selected('B')).toBe(false);
    expect(tools.deleteSelected()).toBe(true);
    expect(state.elements.map(({ id }) => id)).toEqual(['B', 'line']);
  });

  it("shows a curve point's handles and bends the curve with one", () => {
    const curve: GraphElement = {
      coords: [
        [0, 0],
        [2, 2],
        [4, 0],
      ],
      id: 'c',
      type: 'curve',
    };
    const { click, drag, state } = setup([curve]);
    click(px(2, 2));
    // The point's out handle, on the smooth curve's tangent to the right.
    const [, out] = [
      [4 / 3, 2],
      [8 / 3, 2],
    ];
    drag(px(out[0], out[1]), px(out[0], 3));
    const [bent] = state.elements;
    expect(bent.type === 'curve' && bent.handles?.[1][1][1]).toBeCloseTo(3);
    // Its twin turns with it, at its own length: the point stays smooth.
    expect(bent.type === 'curve' && bent.handles?.[1][0][1]).toBeCloseTo(
      2 - 2 / 3 / Math.hypot(2 / 3, 1)
    );
  });
});
