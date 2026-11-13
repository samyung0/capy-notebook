import { POLYGON_SHAPES } from '@blocksuite/affine/model';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { m } from '@/i18n';
import { fromBase64, toBase64 } from './base64';
import { SAVED, withCanvasBlock, withElements } from './boardFixture';
import { BoardLoadError } from './boardLoad';
import { drawBoardPreview, POLYGON_CORNERS } from './boardPreview';

const SIZE = { height: 120, width: 180 };
const SVG_HEAD = /^<svg [^>]*width="180" height="120"/;
const BLUE_POLYGON =
  /<path d="M[^"]*L[^"]*L[^"]*L[^"]*L[^"]*Z" fill="none" stroke="#1971c2"/;
const RED_STROKE = /<path d="([^"]*)" stroke="#e03131"/;
const INLINE_NOTE_TEXT = /<tspan x="0" [^>]*>Osmosis/;
const TURNED_NOTE = /transform="rotate\(30 100 20\)"/;
const CARD_NOTE_BOX =
  /<rect [^>]*rx="16" fill="#fff" fill-opacity="0.5" stroke="#e6e6e6"/;

it('draws the plane card, its marks and its axes', () => {
  const svg = drawBoardPreview(SAVED, SIZE, 'question');
  expect(svg).toMatch(SVG_HEAD);
  expect(svg).toContain('stroke="#6f6f6c"');
});

it('keeps a long stroke to what the preview can show', () => {
  const points = Array.from({ length: 2000 }, (_, i) => [i / 4, (i % 50) / 4]);
  const svg = drawBoardPreview(
    toBase64(
      withElements({
        color: '#e03131',
        lineWidth: 4,
        points,
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
        points: [
          [0, 0],
          [80, 10],
        ],
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
  const note = block('note', 'affine:note', {
    background,
    displayMode: 'both',
    edgeless: { style },
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
