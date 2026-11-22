import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import type { SurfaceBlockModel } from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { MemoryBlobSource } from '@blocksuite/affine/sync';
import { expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { keyedElements } from '@/features/graph/keyed';
import {
  appended,
  ChartElementModel,
  cleared,
  FIRST_SPOKE,
  firstSpokes,
  liftedBars,
  typedBars,
  typedLabels,
} from './boardChart';
import { BARS_MAX, filledSlices, LABELS_MAX } from './boardData';
import { boardFirstState } from './boardFirstState';
import { unknownStore } from './boardUnknown';
import { openRoomStore } from './roomStore';

/* A canvas chart's bars, pie labels and pie lines are each keyed by id (Epo
 * 2026-11-22, as the plane's elements): two people changing different items of
 * one chart at the same moment both keep their change. */

const stores = new StoreExtensionManager([
  RootStoreExtension,
  SurfaceStoreExtension,
]);

/** One tab's store over its own copy of the canvas's room. */
function tab() {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, boardFirstState(), 'room');
  const { dispose, store } = openRoomStore({
    awareness: new Awareness(doc),
    blobs: { main: new MemoryBlobSource() },
    doc,
    id: 'cv_1',
    storeExtensions: [...stores.get('store'), ...unknownStore('workspace')],
  });
  const surface = store.getModelsByFlavour(
    'affine:surface'
  )[0] as SurfaceBlockModel;
  return { dispose, doc, surface };
}

/** Two tabs holding the chart one of them put down; `sync` hands each the
 * other's changes, as the room does. */
function twoTabs(fields: Record<string, unknown>) {
  const tabs = [tab(), tab()];
  const [a, b] = tabs;
  const id = a.surface.addElement({
    axisMax: 10,
    axisStep: 2,
    bars: {},
    labels: {},
    spokes: {},
    type: 'chart',
    xywh: '[0,0,320,240]',
    ...fields,
  });
  const sync = () => {
    const toB = Y.encodeStateAsUpdate(a.doc, Y.encodeStateVector(b.doc));
    const toA = Y.encodeStateAsUpdate(b.doc, Y.encodeStateVector(a.doc));
    Y.applyUpdate(b.doc, toB, 'room');
    Y.applyUpdate(a.doc, toA, 'room');
  };
  sync();
  const charts = tabs.map(({ surface }) => {
    const chart = surface.getElementById(id);
    if (!(chart instanceof ChartElementModel)) throw new Error('no chart');
    return chart;
  });
  return {
    charts,
    dispose: () => {
      for (const each of tabs) each.dispose();
    },
    surfaces: tabs.map(({ surface }) => surface),
    sync,
  };
}

const bars = ['Mon', 'Tue', 'Wed'].map((label, i) => ({
  fill: '#1e96eb',
  id: `b${i + 1}`,
  label,
  value: 2,
}));

it("keeps one bar's new value and another's new label made at once, and redraws for a peer's", () => {
  const { charts, dispose, surfaces, sync } = twoTabs({
    bars: keyedElements(bars),
    kind: 'bar',
  });
  const [a, b] = charts;
  const heard: string[] = [];
  surfaces[1].elementUpdated.subscribe(({ id, props }) =>
    heard.push(...(id === b.id ? Object.keys(props) : []))
  );
  a.write({
    bars: a.barList.map((bar) =>
      bar.id === 'b1' ? { ...bar, value: 7 } : bar
    ),
  });
  b.write({
    bars: b.barList.map((bar) =>
      bar.id === 'b3' ? { ...bar, label: 'Thu' } : bar
    ),
  });
  heard.length = 0;
  sync();
  for (const chart of charts)
    expect(chart.barList.map(({ label, value }) => [label, value])).toEqual([
      ['Mon', 7],
      ['Tue', 2],
      ['Thu', 2],
    ]);
  // B's card and an open editor hear A's change inside the list.
  expect(heard).toContain('bars');
  dispose();
});

it('keeps both bars two people add at once', () => {
  const { charts, dispose, sync } = twoTabs({
    bars: keyedElements(bars),
    kind: 'bar',
  });
  const [a, b] = charts;
  a.write({ bars: [...a.barList, { ...bars[0], id: 'b4', label: 'Thu' }] });
  b.write({ bars: [...b.barList, { ...bars[0], id: 'b5', label: 'Fri' }] });
  sync();
  for (const chart of charts)
    expect(chart.barList.map(({ id }) => id).sort()).toEqual([
      'b1',
      'b2',
      'b3',
      'b4',
      'b5',
    ]);
  dispose();
});

it("keeps one pie line turned and another slice's fill made at once", () => {
  const { charts, dispose, sync } = twoTabs({
    kind: 'pie',
    spokes: keyedElements([
      { angle: 0, id: 's1' },
      { angle: 120, id: 's2' },
      { angle: 240, id: 's3' },
    ]),
  });
  const [a, b] = charts;
  a.write({
    spokes: a.spokeList.map((spoke) =>
      spoke.id === 's2' ? { ...spoke, angle: 150 } : spoke
    ),
  });
  b.write({
    spokes: b.spokeList.map((spoke) =>
      spoke.id === 's3' ? { ...spoke, fill: '#f6c343' } : spoke
    ),
  });
  sync();
  for (const chart of charts) {
    expect(chart.spokeList).toEqual([
      { angle: 0, id: 's1' },
      { angle: 150, id: 's2' },
      { angle: 240, fill: '#f6c343', id: 's3' },
    ]);
    expect(filledSlices(chart.spokeList)).toEqual([
      { fill: '#f6c343', from: 240, to: 360 },
    ]);
  }
  dispose();
});

it('adds no bar or pie label once a peer has filled the last place', () => {
  const full = Array.from({ length: BARS_MAX - 1 }, (_, i) => ({
    ...bars[0],
    id: `b${i}`,
  }));
  const { charts, dispose, sync } = twoTabs({
    bars: keyedElements(full),
    kind: 'bar',
  });
  const [a, b] = charts;
  // A draws a bar in the free place; B adds the last one before A lets go.
  b.write({ bars: [...b.barList, { ...bars[0], id: 'peer' }] });
  sync();
  expect(appended(a.barList, { ...bars[0], id: 'mine' }, BARS_MAX)).toBeNull();
  const labels = Array.from({ length: LABELS_MAX }, (_, i) => ({
    angle: i,
    id: `l${i}`,
    reach: 0.5,
    text: 'A',
  }));
  const place = { angle: 90, reach: 0.5, text: '' };
  expect(typedLabels(labels, place, 'B')).toBeNull();
  expect(typedLabels(labels.slice(1), place, 'B')).toEqual([
    ...labels.slice(1),
    { angle: 90, id: expect.any(String), reach: 0.5, text: 'B' },
  ]);
  dispose();
});

it('a chart two adds merged past the cap opens on both tabs, edits, and takes no more', () => {
  const over = Array.from({ length: BARS_MAX + 1 }, (_, i) => ({
    ...bars[0],
    id: `b${i}`,
  }));
  // Both tabs open it as a chart (`twoTabs` throws on a placeholder).
  const { charts, dispose, sync } = twoTabs({
    bars: keyedElements(over),
    kind: 'bar',
  });
  const [a, b] = charts;
  a.write({
    bars: a.barList.map((bar) =>
      bar.id === `b${BARS_MAX}` ? { ...bar, value: 9 } : bar
    ),
  });
  sync();
  expect(b.barList.at(-1)?.value).toBe(9);
  expect(appended(a.barList, { ...bars[0], id: 'more' }, BARS_MAX)).toBeNull();
  const labels = Array.from({ length: LABELS_MAX + 1 }, (_, i) => ({
    angle: i,
    id: `l${i}`,
    reach: 0.5,
    text: 'A',
  }));
  expect(
    typedLabels(labels, { angle: 90, reach: 0.5, text: '' }, 'B')
  ).toBeNull();
  dispose();
});

it("closing a pie label's text field keeps a peer's move and resize, and its erase", () => {
  const { charts, dispose, sync } = twoTabs({
    kind: 'pie',
    labels: keyedElements([
      { angle: 30, id: 'l1', reach: 0.5, text: 'A' },
      { angle: 200, id: 'l2', reach: 0.5, text: 'B' },
    ]),
  });
  const [a, b] = charts;
  // A opens the fields on both labels; meanwhile B moves and resizes one, erases
  // the other.
  b.write({
    labels: [{ angle: 90, id: 'l1', reach: 0.8, size: 20, text: 'A' }],
  });
  sync();
  const typed = typedLabels(
    a.labelList,
    { angle: 30, id: 'l1', reach: 0.5, text: 'A' },
    'C'
  );
  if (typed) a.write({ labels: typed });
  sync();
  for (const chart of charts)
    expect(chart.labelList).toEqual([
      { angle: 90, id: 'l1', reach: 0.8, size: 20, text: 'C' },
    ]);
  expect(
    typedLabels(
      a.labelList,
      { angle: 200, id: 'l2', reach: 0.5, text: 'B' },
      'D'
    )
  ).toBeNull();
  dispose();
});

it("closing an untouched pie label field keeps a peer's rename made while it was open", () => {
  const { charts, dispose, sync } = twoTabs({
    kind: 'pie',
    labels: keyedElements([{ angle: 30, id: 'l1', reach: 0.5, text: 'A' }]),
  });
  const [a, b] = charts;
  // A opens the field on l1 ("A"); B renames it in its data pane; A clicks away
  // without typing.
  b.write({ labels: [{ angle: 30, id: 'l1', reach: 0.5, text: 'B' }] });
  sync();
  const draft = { angle: 30, id: 'l1', reach: 0.5, text: 'A' };
  const typed = typedLabels(a.labelList, draft, 'A');
  if (typed) a.write({ labels: typed });
  sync();
  for (const chart of charts) expect(chart.labelList[0].text).toBe('B');
  dispose();
});

it("closing an untouched bar label field keeps a peer's rename made while it was open", () => {
  const { charts, dispose, sync } = twoTabs({
    bars: keyedElements(bars),
    kind: 'bar',
  });
  const [a, b] = charts;
  // A opens the field under Wed; B renames it Thu; A clicks away without typing.
  b.write({
    bars: b.barList.map((one) =>
      one.id === 'b3' ? { ...one, label: 'Thu' } : one
    ),
  });
  sync();
  const typed = typedBars(a.barList, 'b3', 'Wed', 'Wed');
  if (typed) a.write({ bars: typed });
  sync();
  for (const chart of charts) expect(chart.barList[2].label).toBe('Thu');
  // Typed, the text goes onto the bar as it reads now.
  expect(typedBars(a.barList, 'b3', 'Wed', 'Fri')?.[2]).toEqual({
    ...bars[2],
    label: 'Fri',
  });
  dispose();
});

it('a bar drag drops only the bars it took to 0', () => {
  // Mon, Tue (typed as 0) and Wed are chosen; Mon is dragged, Wed goes along to
  // 0 and Tue stays at 0. Thu, at 0 and not chosen, stays too.
  const [mon, tue, wed] = bars;
  const thu = { ...mon, id: 'b4', label: 'Thu', value: 0 };
  const before = [
    { ...mon, value: 4 },
    { ...tue, value: 0 },
    { ...wed, value: 1 },
    thu,
  ];
  expect(
    liftedBars(before, [
      { ...mon, value: 3 },
      { ...tue, value: 0 },
      { ...wed, value: 0 },
      thu,
    ])
  ).toEqual([{ ...mon, value: 3 }, { ...tue, value: 0 }, thu]);
  // Up and back with no change at all leaves every bar.
  expect(liftedBars(before, before)).toEqual(before);
});

it("two Clear alls at once, or one crossing a peer's turn of the first line, leave one line", () => {
  const pie = {
    kind: 'pie',
    spokes: keyedElements([
      ...firstSpokes('pie'),
      { angle: 90, fill: '#f6c343', id: 's2' },
    ]),
  };
  const both = twoTabs(pie);
  for (const chart of both.charts) chart.write(cleared('pie'));
  both.sync();
  for (const chart of both.charts)
    expect(chart.spokeList).toEqual([{ angle: 0, id: FIRST_SPOKE }]);
  both.dispose();

  const crossing = twoTabs(pie);
  const [a, b] = crossing.charts;
  a.write(cleared('pie'));
  b.write({
    spokes: b.spokeList.map((spoke) =>
      spoke.id === FIRST_SPOKE ? { ...spoke, angle: 30 } : spoke
    ),
  });
  crossing.sync();
  for (const chart of crossing.charts)
    expect(chart.spokeList).toEqual([{ angle: 30, id: FIRST_SPOKE }]);
  crossing.dispose();
});
