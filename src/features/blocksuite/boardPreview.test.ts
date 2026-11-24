import { POLYGON_SHAPES } from '@blocksuite/affine/model';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { type Keyed, keyedElements } from '@/features/graph/keyed';
import { m } from '@/i18n';
import { fromBase64, toBase64 } from './base64';
import {
  keyedMap,
  SAVED,
  withCanvasBlock,
  withElements,
  withPageProps,
} from './boardFixture';
import { BoardLoadError } from './boardLoad';
import { drawBoardPreview, POLYGON_CORNERS } from './boardPreview';
import { encodeStrokePoints } from './strokePoints';

const SIZE = { height: 120, width: 180 };
const SVG_HEAD = /^<svg [^>]*width="180" height="120"/;
const BLUE_POLYGON =
  /<path d="M[^"]*L[^"]*L[^"]*L[^"]*L[^"]*Z" fill="none" stroke="#1971c2"/;
const RED_STROKE = /<path d="([^"]*)" stroke="#e03131"/;
const INLINE_NOTE_TEXT = /<tspan x="0" [^>]*>Osmosis/;
const TURNED_NOTE = /transform="rotate\(30 100 20\)"/;
const PLANE_CARD = /<svg x="0" y="600" width="300" height="200" viewBox="/;
const INK_STROKE = /<path d="M[^"]*" fill="none" stroke="#000"/;
const AREA_CLIP =
  /<clipPath id="area"><rect x="1000" y="500" width="1920" height="1200"\/><\/clipPath>/;
const FAR_LABEL = />Far</;
const AREA_HEAD = /^<svg [^>]*width="180" height="113"/;
const CARD_NOTE_BOX =
  /<rect [^>]*rx="16" fill="#fff" fill-opacity="0.5" stroke="#e6e6e6"/;
const RED_SLICE = /<path d="M[^"]*A[^"]*Z" fill="#e03131"\/>/;

/** A keyed list stored in the reverse of its order keys, so only the keys put it
 * right. */
function backwards<E extends Keyed>(list: E[]) {
  const map = new Y.Map<unknown>();
  for (const [id, entry] of Object.entries(keyedElements(list)).reverse())
    map.set(id, entry);
  return map;
}

it('draws the plane card, its marks and its axes', () => {
  const svg = drawBoardPreview(SAVED, SIZE, 'question');
  expect(svg).toMatch(SVG_HEAD);
  expect(svg).toContain('stroke="#6f6f6c"');
});

it("draws a plane's elements as the graph engine does, in the card's place", () => {
  const svg = drawBoardPreview(
    toBase64(
      withElements({
        elements: keyedMap([
          {
            coords: [
              [0, 0],
              [2, 2],
            ],
            id: 'l',
            type: 'polyline',
          },
          { coords: [1, 0], id: 'p', type: 'point' },
        ]),
        ppu: 30,
        type: 'plane',
        x0: -5,
        xywh: '[0,600,300,200]',
        y0: 5,
      })
    ),
    SIZE,
    'question'
  );
  expect(svg).toMatch(PLANE_CARD);
  expect(svg).toMatch(INK_STROKE);
});

it("draws a chart's bars and a pie's filled slice from their keyed lists", () => {
  const chart = (fields: Record<string, unknown>) =>
    drawBoardPreview(
      toBase64(
        withElements({
          axisMax: 10,
          axisStep: 2,
          bars: keyedMap([]),
          labels: keyedMap([]),
          spokes: keyedMap([]),
          type: 'chart',
          xywh: '[0,600,300,200]',
          ...fields,
        })
      ),
      SIZE,
      'question'
    );
  const bars = chart({
    bars: backwards([
      { fill: '#e03131', id: 'a', label: 'Mon', value: 4 },
      { fill: '#1971c2', id: 'b', label: 'Tue', value: 8 },
    ]),
    kind: 'bar',
  });
  expect(bars.indexOf('fill="#e03131"')).toBeLessThan(
    bars.indexOf('fill="#1971c2"')
  );
  const pie = chart({
    kind: 'pie',
    spokes: keyedMap([
      { angle: 0, id: 's' },
      { angle: 90, fill: '#e03131', id: 't' },
    ]),
  });
  expect(pie).toMatch(RED_SLICE);
});

it('keeps a long stroke to what the preview can show', () => {
  const points = Array.from({ length: 2000 }, (_, i) => [i / 4, (i % 50) / 4]);
  const svg = drawBoardPreview(
    toBase64(
      withElements({
        color: '#e03131',
        lineWidth: 4,
        points: encodeStrokePoints(points),
        type: 'brush',
        xywh: '[0,600,500,20]',
      })
    ),
    SIZE,
    'question'
  );
  const stroke = svg.match(RED_STROKE)?.[1] ?? '';
  expect(stroke.split('L').length).toBeLessThan(400);
});

it('opens and draws a highlighter stroke', () => {
  const svg = drawBoardPreview(
    toBase64(
      withElements({
        color: '#84cfff4d',
        lineWidth: 22,
        points: encodeStrokePoints([
          [0, 0],
          [80, 10],
        ]),
        type: 'highlighter',
        xywh: '[0,600,80,10]',
      })
    ),
    SIZE,
    'question'
  );
  expect(svg).toContain('stroke="#84cfff4d"');
});

it('draws a connector saved before the board placed it, between its ends', () => {
  const svg = drawBoardPreview(
    toBase64(
      withElements(
        {
          id: 'box',
          shapeType: 'rect',
          strokeColor: '#000000',
          type: 'shape',
          xywh: '[900,0,100,50]',
        },
        {
          mode: 2,
          source: { id: 'box', position: [0.5, 1] },
          stroke: '#1971c2',
          target: { position: [950, 300] },
          type: 'connector',
        }
      )
    ),
    SIZE,
    'question'
  );
  expect(svg).toContain('stroke="#1971c2"');
});

// A placed quiz or set draws as text, as a note card does: the runner itself is
// only on the canvas (Epo 2026-11-09).
it('draws a placed quiz card with its title and kind', () => {
  const svg = drawBoardPreview(
    toBase64(
      withCanvasBlock('affine:embed-capy-material', {
        kind: 'quiz',
        materialId: 'qz_1',
        title: 'Cell cycle',
        xywh: '[0,0,360,420]',
      })
    ),
    SIZE,
    'workspace'
  );
  expect(svg).toContain('Cell cycle');
  expect(svg).toContain(m.drawing_board_quiz());
});

it('refuses a board that does not check out', () => {
  expect(() => drawBoardPreview('AAAA', SIZE, 'question')).toThrow(
    BoardLoadError
  );
});

it('draws a polygon shape from the corners the board draws it with', () => {
  expect(POLYGON_CORNERS).toEqual(POLYGON_SHAPES);
  const svg = drawBoardPreview(
    toBase64(
      withElements({
        shapeType: 'pentagon',
        strokeColor: '#1971c2',
        type: 'shape',
        xywh: '[0,600,100,100]',
      })
    ),
    SIZE,
    'question'
  );
  expect(svg).toMatch(BLUE_POLYGON);
});

/** The saved board with a note on the page: `background`, its style and any other
 * props (`rotate`). */
function withNote(
  background: string,
  style: Record<string, unknown>,
  props: Record<string, unknown> = {}
) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, fromBase64(SAVED));
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const page = [...blocks.values()].find(
    (block) => block.get('sys:flavour') === 'affine:page'
  );
  if (!page) throw new Error('the saved board has no page');
  const block = (id: string, flavour: string, props: object) => {
    const map = new Y.Map<unknown>();
    map.set('sys:id', id);
    map.set('sys:flavour', flavour);
    map.set('sys:children', new Y.Array());
    for (const [key, value] of Object.entries(props))
      map.set(`prop:${key}`, value);
    blocks.set(id, map);
    return map;
  };
  // BlockSuite keeps a block's objects as maps.
  const edgeless = new Y.Map<unknown>();
  const styles = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(style)) styles.set(key, value);
  edgeless.set('style', styles);
  const note = block('note', 'affine:note', {
    background,
    displayMode: 'both',
    edgeless,
    index: 'a1',
    xywh: '[0,0,200,40]',
    ...props,
  });
  block('para', 'affine:paragraph', {
    text: new Y.Text('Osmosis'),
    type: 'text',
  });
  (note.get('sys:children') as Y.Array<string>).push(['para']);
  (page.get('sys:children') as Y.Array<string>).push(['note']);
  return toBase64(Y.encodeStateAsUpdate(doc));
}

// P1/I1 (Epo 2026-11-13): an inline note is its text alone, a card its padded box
// with its corner and edge.
it('draws an inline note as text and a card with its corner and edge', () => {
  const inline = drawBoardPreview(
    withNote('transparent', { borderStyle: 'none', shadowType: '' }),
    SIZE,
    'workspace'
  );
  // At the note's own left: no card padding.
  expect(inline).toMatch(INLINE_NOTE_TEXT);
  const card = drawBoardPreview(
    withNote('#fff', {
      borderRadius: 16,
      borderStyle: 'none',
      shadowType: '--affine-note-shadow-box',
    }),
    SIZE,
    'workspace'
  );
  expect(card).toMatch(CARD_NOTE_BOX);
});

// A note turns about its middle (Epo 2026-11-13, F1; vendor local change 56).
it('draws a turned note turned about its middle', () => {
  const svg = drawBoardPreview(
    withNote(
      'transparent',
      { borderStyle: 'none', shadowType: '' },
      {
        rotate: 30,
      }
    ),
    SIZE,
    'workspace'
  );
  expect(svg).toMatch(TURNED_NOTE);
});

// Epo 2026-11-23: a question board's pictures are its answer area exactly,
// where the board keeps it; a workspace canvas shows everything.
it('frames a question board to its answer area, and a canvas to everything', () => {
  const board = withElements(
    {
      color: '#e03131',
      lineWidth: 4,
      points: encodeStrokePoints([
        [0, 0],
        [50, 25],
      ]),
      type: 'brush',
      xywh: '[1100,600,50,25]',
    },
    {
      fontSize: 24,
      id: 'far',
      index: 'z9',
      text: new Y.Text('Far'),
      type: 'text',
      xywh: '[3000,0,80,30]',
    }
  );
  const saved = toBase64(withPageProps(board, { area: [1000, 500] }));
  const question = drawBoardPreview(saved, SIZE, 'question', true);
  // The area fills the picture: 180 wide at the area's 1,920 × 1,200.
  expect(question).toMatch(AREA_HEAD);
  expect(question).toMatch(AREA_CLIP);
  expect(question).toMatch(RED_STROKE);
  expect(question).not.toMatch(FAR_LABEL);
  expect(drawBoardPreview(toBase64(board), SIZE, 'workspace')).toMatch(
    FAR_LABEL
  );
});
