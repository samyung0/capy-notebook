import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  type MaterialElement,
  type MaterialNode,
  type MaterialValue,
  normalizeMaterialValue,
} from '@/features/materials/document';
import { seedNotes } from '@/mocks/noteContent';
import { buildBiologyLoadTestValue } from '@/mocks/noteContent/loadTest';
import {
  applyValue,
  BLOCKS_ROOT,
  type BlocksJson,
  blocksToValue,
  blocksValue,
  canonical,
  type Delta,
  normalizeDelta,
  orderKey,
  readBlocks,
  stateFromValue,
  valueToBlocks,
  writeBlocks,
} from './layout';

const TESTDATA = fileURLToPath(
  new URL('../../../../server/internal/materialdoc/testdata/', import.meta.url)
);

/** A testdata value; its unsaved refs' `pending` bodies, which no stored note
 * holds and the converter refuses, are left out. */
function fixture(name: string): MaterialValue {
  const value: MaterialValue = JSON.parse(
    readFileSync(`${TESTDATA}${name}`, 'utf8')
  ).value;
  return value.map(({ pending: _, ...block }) => block as MaterialElement);
}

/** Through an encoded update into a fresh doc, as a room seeds its peers. */
function roundTrip(value: MaterialValue) {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, stateFromValue(value));
  return blocksValue(doc);
}

const sources: [string, MaterialValue][] = [
  ...seedNotes.map((note): [string, MaterialValue] => [note.id, note.value]),
  ['load test', buildBiologyLoadTestValue()],
  ['every-block-note.json', fixture('every-block-note.json')],
];
const corpus = sources.map(([name, value]): [string, MaterialValue] => [
  name,
  normalizeMaterialValue(value),
]);

describe('round trip', () => {
  // As authored: missing ids are derived, the same on every seed.
  it.each(sources)('%s', (_, value) => {
    const expected = canonical(value);
    expect(roundTrip(value)).toEqual(expected);
    expect(canonical(expected)).toEqual(expected);
  });

  // Stored content has an id on every element (normalizeMaterialValue).
  it.each(corpus)('%s as stored', (_, value) => {
    const expected = canonical(value);
    expect(roundTrip(value)).toEqual(expected);
    // Top-level ids are kept as they are.
    expect(expected.map((block) => block.id)).toEqual(
      value.map((block) => block.id)
    );
  });
});

it('refuses a ref holding a pending import', () => {
  expect(() =>
    valueToBlocks([
      {
        children: [{ text: '' }],
        id: 'ref',
        materialId: '',
        pending: '{}',
        refKind: 'quiz',
        type: 'material_ref',
      },
    ])
  ).toThrow('pending');
});

it('keeps nested block ids and derives the rest', () => {
  const value = normalizeMaterialValue(fixture('every-block-note.json'));
  const blocks = canonical(value);
  const element = (node: MaterialNode) => node as MaterialElement;
  const byId = (id: string) => blocks.find((block) => block.id === id)!;
  const source = (id: string) => value.find((block) => block.id === id)!;
  expect(
    byId('fx_columns').children.map((column) => element(column).id)
  ).toEqual(source('fx_columns').children.map((column) => element(column).id));
  expect(byId('fx_code').children.map((line) => element(line).id)).toEqual([
    'fx_code.l0',
    'fx_code.l1',
  ]);
  expect(byId('fx_quote').children[0]).toMatchObject({ id: 'fx_quote.p' });
  expect(byId('fx_inlines').children).toMatchObject([
    { text: 'Inlines: ' },
    { id: 'fx_inlines.i0', type: 'a', url: 'https://example.com/every-block' },
    { text: ', ' },
    { id: 'fx_inlines.i1', key: 'user_every_block', type: 'mention' },
    { text: ' and ' },
    { id: 'fx_inlines.i2', texExpression: 'e^{i\\pi}+1=0' },
    { text: '.' },
  ]);
  const rowId = element(source('fx_table').children[1]).id;
  expect(element(byId('fx_table').children[1]).children[0]).toMatchObject({
    children: [{ id: `${rowId}:fx_table-c0.p`, type: 'p' }],
    id: `${rowId}:fx_table-c0`,
    type: 'td',
  });
});

it('nests lists by indent and gives the indent back', () => {
  const p = (id: string, extra: Record<string, unknown> = {}) => ({
    children: [{ text: id }],
    id,
    type: 'p',
    ...extra,
  });
  const disc = { listStyleType: 'disc' };
  const blocks = valueToBlocks([
    p('a', { ...disc, indent: 1 }),
    p('b', { ...disc, indent: 2 }),
    p('c', { indent: 1 }),
    p('d', { indent: 3 }),
    p('e'),
  ]);
  expect(blocks.note.children).toEqual(['a', 'e']);
  expect(blocks.a.children).toEqual(['b', 'c']);
  expect(blocks.c.children).toEqual(['d']);
  expect(
    blocksToValue(blocks).map(({ id, indent, listStyleType }) => ({
      id,
      indent,
      listStyleType,
    }))
  ).toEqual([
    { id: 'a', indent: 1, listStyleType: 'disc' },
    { id: 'b', indent: 2, listStyleType: 'disc' },
    { id: 'c', indent: 1, listStyleType: undefined },
    // N1: the skipped level is clamped.
    { id: 'd', indent: 2, listStyleType: undefined },
    { id: 'e', indent: undefined, listStyleType: undefined },
  ]);
});

it('writes the spec props of text blocks', () => {
  const blocks = valueToBlocks([
    {
      align: 'end',
      checked: true,
      children: [{ text: 'done' }],
      id: 'todo',
      indent: 1,
      listStart: 3,
      listStyleType: 'todo',
      type: 'p',
    },
    {
      children: [{ text: 'i' }],
      id: 'roman',
      indent: 1,
      listStyleType: 'upper-roman',
      type: 'p',
    },
    {
      children: [{ children: [{ text: 'x = 1' }], type: 'code_line' }],
      id: 'code',
      type: 'code_block',
    },
    {
      children: [
        { children: [{ text: 'one' }], type: 'p' },
        { children: [{ bold: true, text: 'two' }], type: 'p' },
      ],
      id: 'quote',
      type: 'blockquote',
    },
  ]);
  expect(blocks.todo).toEqual({
    children: [],
    flavour: 'affine:list',
    props: {
      checked: true,
      collapsed: false,
      listStyleType: 'todo',
      order: 3,
      text: [{ insert: 'done' }],
      textAlign: 'right',
      type: 'todo',
    },
    version: 1,
  });
  expect(blocks.roman.props).toMatchObject({
    listStyleType: 'upper-roman',
    order: null,
    type: 'numbered',
  });
  expect(blocks.code.props).toEqual({
    caption: '',
    language: null,
    text: [{ insert: 'x = 1' }],
    wrap: false,
  });
  // N3: one quote paragraph.
  expect(blocks.quote.props).toEqual({
    collapsed: false,
    text: [{ insert: 'one\n' }, { attributes: { bold: true }, insert: 'two' }],
    type: 'quote',
  });
});

it('writes inline formats as text attributes', () => {
  const blocks = valueToBlocks(
    normalizeMaterialValue(fixture('every-block-note.json'))
  );
  expect(blocks.fx_inlines.props.text).toEqual([
    { insert: 'Inlines: ' },
    {
      attributes: { link: 'https://example.com/every-block' },
      insert: 'a link',
    },
    { insert: ', ' },
    {
      attributes: {
        mention: { member: 'user_every_block', name: 'Every Block Reader' },
      },
      insert: ' ',
    },
    { insert: ' and ' },
    { attributes: { latex: 'e^{i\\pi}+1=0' }, insert: ' ' },
    { insert: '.' },
  ]);
  expect(blocks.fx_marks.props.text).toContainEqual({
    attributes: { strike: true },
    insert: 'strike',
  });
  expect(blocks.fx_marks.props.text).toContainEqual({
    attributes: { background: '#fdebd0' },
    insert: 'shaded',
  });
});

it('writes a table as flat data', () => {
  const blocks = valueToBlocks([
    {
      children: [
        {
          children: [
            {
              children: [{ children: [{ text: 'H' }], type: 'p' }],
              type: 'th',
            },
            {
              children: [{ children: [{ text: 'I' }], type: 'p' }],
              type: 'th',
            },
          ],
          id: 'r0',
          type: 'tr',
        },
        {
          children: [
            {
              children: [{ children: [{ text: 'wide' }], type: 'p' }],
              colSpan: 2,
              type: 'td',
            },
          ],
          id: 'r1',
          type: 'tr',
        },
      ],
      colSizes: [120, 80],
      id: 't',
      type: 'table',
    },
  ]);
  expect(blocks.t).toEqual({
    children: [],
    flavour: 'affine:table',
    props: {
      'cells.r0:t-c0.text': [{ insert: 'H' }],
      'cells.r0:t-c1.text': [{ insert: 'I' }],
      'cells.r1:t-c0.text': [{ insert: 'wide' }],
      // N4: the merged cell is split.
      'cells.r1:t-c1.text': [],
      'columns.t-c0.columnId': 't-c0',
      'columns.t-c0.order': 'a0',
      'columns.t-c0.width': 120,
      'columns.t-c1.columnId': 't-c1',
      'columns.t-c1.order': 'a1',
      'columns.t-c1.width': 80,
      'rows.r0.header': true,
      'rows.r0.order': 'a0',
      'rows.r0.rowId': 'r0',
      'rows.r1.order': 'a1',
      'rows.r1.rowId': 'r1',
    },
    version: 1,
  });
  expect(blocksToValue(blocks)[0]).toMatchObject({
    children: [
      { children: [{ type: 'th' }, { type: 'th' }], id: 'r0' },
      { children: [{ type: 'td' }, { type: 'td' }], id: 'r1' },
    ],
    colSizes: [120, 80],
  });
});

it('stores figures as deep Y types and media with schema defaults', () => {
  const doc = applyValue(
    new Y.Doc(),
    normalizeMaterialValue(fixture('every-block-note.json'))
  );
  const blocks = doc.getMap<Y.Map<unknown>>(BLOCKS_ROOT);
  const chart = blocks.get('fx_chart')?.get('prop:block') as Y.Map<unknown>;
  expect(chart.get('labels')).toBeInstanceOf(Y.Array);
  const series = chart.get('series') as Y.Array<Y.Map<unknown>>;
  expect(series.get(0).get('values')).toBeInstanceOf(Y.Array);
  const graph = blocks.get('fx_graph')?.get('prop:block') as Y.Map<unknown>;
  expect(graph.get('elements')).toBeInstanceOf(Y.Array);
  const json = readBlocks(doc);
  expect(json.fx_image.props).toEqual({
    caption: 'A marsh',
    contentType: 'image/png',
    height: 0,
    index: 'a0',
    lockedBySelf: false,
    name: 'marsh.png',
    rotate: 0,
    size: 1024,
    sourceId: 'asset_every_block_image',
    width: 461,
    xywh: '[0,0,0,0]',
  });
  expect(json.fx_html.flavour).toBe('capy:html-embed');
});

it('seeds an empty value with root, note and one paragraph', () => {
  const blocks = readBlocks(applyValue(new Y.Doc(), []));
  const [paragraph] = blocks.note.children;
  expect(blocks.root).toEqual({
    children: ['note'],
    flavour: 'affine:page',
    props: { title: [] },
    version: 2,
  });
  // Every schema default is written; displayMode is DocOnly.
  expect(blocks.note.props).toEqual({
    background: { dark: '#252525', light: '#ffffff' },
    displayMode: 'doc',
    edgeless: {
      style: {
        borderRadius: 8,
        borderSize: 4,
        borderStyle: 'none',
        shadowType: '--affine-note-shadow-box',
      },
    },
    hidden: false,
    index: 'a0',
    lockedBySelf: false,
    xywh: '[0,0,498,92]',
  });
  expect(blocks[paragraph]).toEqual({
    children: [],
    flavour: 'affine:paragraph',
    props: { collapsed: false, text: [], type: 'text' },
    version: 1,
  });
});

it('keeps image widths in pixels against a 768 px column (D21)', () => {
  const img = (width: string): MaterialValue => [
    { children: [{ text: '' }], id: 'im', type: 'img', width },
  ];
  expect(valueToBlocks(img('33.3%')).im.props).toMatchObject({
    height: 0,
    width: 256,
  });
  expect(
    ['33.3%', '10%', '150%'].map((width) => canonical(img(width))[0])
  ).toMatchObject([{ width: '33%' }, { width: '20%' }, { width: '100%' }]);
});

it('orders like fractional-indexing', () => {
  expect([0, 1, 10, 61, 62, 63].map(orderKey)).toEqual([
    'a0',
    'a1',
    'aA',
    'az',
    'b00',
    'b01',
  ]);
});

// The shared goldens package A (Rust) writes.
const GOLDENS = `${TESTDATA}blocks/`;
const goldens = readdirSync(GOLDENS).filter((file) => file.endsWith('.json'));

/** Deltas merged the way Y.Text reads them, so yrs and Yjs chunks compare. */
function normalizeBlocks(blocks: BlocksJson): BlocksJson {
  const isDelta = (value: unknown): value is Delta =>
    Array.isArray(value) &&
    value.every(
      (op) => op && typeof op === 'object' && typeof op.insert === 'string'
    );
  return Object.fromEntries(
    Object.entries(blocks).map(([id, block]) => [
      id,
      {
        ...block,
        props: Object.fromEntries(
          Object.entries(block.props).map(([key, value]) => [
            key,
            isDelta(value) ? normalizeDelta(value) : value,
          ])
        ),
      },
    ])
  );
}

describe('Rust goldens', () => {
  it.each(goldens)('%s', (file) => {
    const golden = JSON.parse(readFileSync(`${GOLDENS}${file}`, 'utf8')) as {
      blocks: BlocksJson;
      canonical: MaterialValue;
      value: MaterialValue;
    };
    const blocks = normalizeBlocks(golden.blocks);
    expect(readBlocks(applyValue(new Y.Doc(), golden.value))).toEqual(blocks);
    expect(canonical(golden.value)).toEqual(golden.canonical);
    expect(blocksToValue(blocks)).toEqual(golden.canonical);
    const doc = new Y.Doc();
    writeBlocks(doc, blocks);
    expect(blocksValue(doc)).toEqual(golden.canonical);
  });
});
