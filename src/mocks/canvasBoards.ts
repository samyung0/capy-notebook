import * as Y from 'yjs';
import { fromBase64, toBase64 } from '@/features/blocksuite/base64';
import { SAVED } from '@/features/blocksuite/boardFixture';
import { drawBoardPreview } from '@/features/blocksuite/boardPreview';
import { encodeStrokePoints } from '@/features/blocksuite/strokePoints';
import { mockBoardAssets, mockSvgAsset } from './editorAssets';

/* Drawn canvases for the seeded quizzes (Epo 2026-11-23): each a question
 * board, its answer area at the board's origin, served as its `board` asset,
 * and its picture drawn as previews draw it. */

/** A question board holding `elements` alone, each keyed by its id. */
function questionBoard(elements: Record<string, unknown>[]) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromBase64(SAVED));
  const surface = [...doc.getMap<Y.Map<unknown>>('blocks').values()].find(
    (block) => block.get('sys:flavour') === 'affine:surface'
  );
  if (!surface) throw new Error('The board fixture has no surface');
  const held = (surface.get('prop:elements') as Y.Map<unknown>).get(
    'value'
  ) as Y.Map<unknown>;
  // The fixture's plane card goes.
  for (const id of [...held.keys()]) held.delete(id);
  elements.forEach((fields, i) => {
    const element = new Y.Map<unknown>();
    const id = `el${i}`;
    for (const [key, value] of Object.entries({
      // Stacked in order: a0, a1 … a9, aA …
      index: `a${'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'[i]}`,
      ...fields,
      id,
    }))
      element.set(key, key === 'text' ? new Y.Text(String(value)) : value);
    held.set(id, element);
  });
  return toBase64(Y.encodeStateAsUpdate(doc));
}

const INK = '#1d1d1f';
const text = (x: number, y: number, words: string, fontSize = 44) => ({
  color: INK,
  fontSize,
  text: words,
  textAlign: 'left',
  type: 'text',
  xywh: `[${x},${y},${Math.round(words.length * fontSize * 0.75)},${Math.round(fontSize * 1.3)}]`,
});
const box = (x: number, y: number, w: number, h: number) => ({
  filled: false,
  radius: 0,
  rotate: 0,
  shapeStyle: 'General',
  shapeType: 'rect',
  strokeColor: INK,
  strokeStyle: 'solid',
  strokeWidth: 4,
  type: 'shape',
  xywh: `[${x},${y},${w},${h}]`,
});
/** A pen stroke through `corners`, in board units: dense, as a pen draws it
 * (the board smooths a sparse stroke into a curve), its points relative to
 * its box, which takes the line's width on every side as BlockSuite's does. */
const line = (color: string, corners: [number, number][], lineWidth = 6) => {
  const points = corners.flatMap(([x0, y0], i) => {
    const next = corners[i + 1];
    if (!next) return [[x0, y0]];
    const steps = Math.ceil(Math.hypot(next[0] - x0, next[1] - y0) / 8);
    return Array.from({ length: steps }, (_, s) => [
      x0 + ((next[0] - x0) * s) / steps,
      y0 + ((next[1] - y0) * s) / steps,
    ]);
  });
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const [x, y] = [Math.min(...xs) - lineWidth, Math.min(...ys) - lineWidth];
  return {
    color,
    lineWidth,
    points: encodeStrokePoints(
      points.map(([px, py]) => [px, py, 0.5]),
      [x, y]
    ),
    type: 'brush',
    xywh: `[${x},${y},${Math.max(...xs) + lineWidth - x},${Math.max(...ys) + lineWidth - y}]`,
  };
};

/** Seeds a drawn canvas: its board and picture assets. */
function seed(id: string, elements: Record<string, unknown>[]) {
  const board = questionBoard(elements);
  mockBoardAssets.set(`${id}_board`, board);
  mockSvgAsset(
    `${id}_picture`,
    `${id}.svg`,
    drawBoardPreview(board, { height: 980, width: 1568 }, 'question', true)
  );
  return {
    board: `${id}_board`,
    image: `${id}_picture`,
    type: 'canvas' as const,
  };
}

/** A Punnett square to fill in: the parents' alleles on two sides. */
export const PUNNETT_CANVAS = seed('asset_mock_canvas_punnett', [
  text(120, 90, 'Fill in the offspring genotypes.'),
  box(660, 300, 300, 300),
  box(960, 300, 300, 300),
  box(660, 600, 300, 300),
  box(960, 600, 300, 300),
  text(790, 210, 'A', 56),
  text(1090, 210, 'a', 56),
  text(560, 420, 'A', 56),
  text(560, 720, 'a', 56),
  text(120, 1000, 'Ratio:  ____ : ____ : ____', 40),
]);

/** Three plants' heights over four weeks, for a choice to look at. */
export const GROWTH_CANVAS = seed('asset_mock_canvas_growth', [
  line(
    INK,
    [
      [240, 120],
      [240, 1040],
      [1760, 1040],
    ],
    5
  ),
  text(1500, 1070, 'Weeks', 40),
  text(60, 60, 'Height (cm)', 40),
  line('#d1495b', [
    [240, 1040],
    [1500, 220],
  ]),
  line('#2f6fde', [
    [240, 1040],
    [1500, 560],
  ]),
  line('#e8a33d', [
    [240, 1040],
    [1500, 860],
  ]),
  text(1530, 190, 'P', 48),
  text(1530, 530, 'Q', 48),
  text(1530, 830, 'R', 48),
]);

/* Mocks S1 and S2 (Epo 2026-11-23): plant P's growth over four weeks, its
 * axes alone, and a drawn sample marking its fastest week. */

/** Plant P's curve, rising faster in weeks 2 and 3. */
const P_CURVE: [number, number][] = [
  [240, 1000],
  [520, 960],
  [800, 840],
  [1060, 620],
  [1300, 400],
  [1560, 300],
];

/** The weeks' axes: height up, weeks along, 1 to 4 under them. */
const WEEK_AXES = [
  line(
    INK,
    [
      [240, 140],
      [240, 1040],
      [1760, 1040],
    ],
    5
  ),
  text(60, 60, 'Height (cm)', 40),
  text(1540, 1130, 'Week', 40),
  text(600, 1070, '1', 40),
  text(960, 1070, '2', 40),
  text(1320, 1070, '3', 40),
  text(1680, 1070, '4', 40),
];

/** S2's stem: how plant P grew. */
export const P_GROWTH_CANVAS = seed('asset_mock_canvas_p_growth', [
  ...WEEK_AXES,
  line('#d1495b', P_CURVE),
  text(1590, 250, 'P', 48),
]);

/** S2 (a): the axes alone, to sketch plant Q on. */
export const WEEK_AXES_CANVAS = seed('asset_mock_canvas_week_axes', WEEK_AXES);

/** S2 (b): plant P's curve again, to mark its fastest week on. */
export const P_WEEKS_CANVAS = seed('asset_mock_canvas_p_weeks', [
  ...WEEK_AXES,
  line('#d1495b', P_CURVE),
]);

/** S2 (b)'s drawn sample answer: a cross on week 2's steepest stretch. */
const P_WEEKS_SAMPLE_SEED = seed('asset_mock_canvas_p_weeks_sample', [
  ...WEEK_AXES,
  line('#d1495b', P_CURVE),
  line(
    '#2f6fde',
    [
      [1000, 560],
      [1120, 700],
    ],
    10
  ),
  line(
    '#2f6fde',
    [
      [1120, 560],
      [1000, 700],
    ],
    10
  ),
]);
export const P_WEEKS_SAMPLE = {
  board: P_WEEKS_SAMPLE_SEED.board,
  image: P_WEEKS_SAMPLE_SEED.image,
};
