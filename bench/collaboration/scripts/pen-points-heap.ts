/**
 * A pen board's Yjs state and a tab's Y.Doc heap, with each stroke's points as
 * number arrays and as one binary value (`src/features/blocksuite/strokePoints.ts`,
 * report 2026-11-24-binary-pen-points.md). Both ways build the same board:
 * 6,000 seeded 41-point strokes, each written as the editor writes one (the
 * element with its first point, then its points and box at half and at all of
 * them), a new tab every 1,000, into a room document that collects overwritten
 * values as the server's does. Its state then opens in a fresh Y.Doc, as a tab
 * opens the canvas, and the memory that doc holds is read after a forced GC: its
 * JS heap and its ArrayBuffers (binary values live outside the heap). Each
 * way runs in a process of its own, so one's garbage isn't counted in the other.
 *
 * Run: pnpm exec tsx bench/collaboration/scripts/pen-points-heap.ts [zoom]
 * The points are whole board units, the best case for number arrays (Yjs writes
 * a small whole number in 2 bytes). A zoom other than 1 divides them by it, as a
 * stroke drawn at that zoom lands: 1.1 gives coordinates no whole number or
 * Float32 holds, 9 bytes each, as a fit's or a pinch's zoom gives.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import * as Y from 'yjs';
import { encodeStrokePoints } from '../../../src/features/blocksuite/strokePoints';

const STROKES = 6000;
const POINTS = 41;
const PER_TAB = 1000;
const LINE_WIDTH = 4;
const zoom = Number(process.argv[2] ?? 1);
const way = process.argv[3];

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;
const held = () => {
  for (let i = 0; i < 4; i++) gc();
  const { arrayBuffers, heapUsed } = process.memoryUsage();
  return heapUsed + arrayBuffers;
};

/** A stroke's points as the board draws them, in board units: a random walk
 * from a seeded start, whole pointer positions divided by the zoom. */
function strokes() {
  let seed = 7;
  const random = () => {
    seed = (seed * 16_807) % 2_147_483_647;
    return seed / 2_147_483_647;
  };
  return Array.from({ length: STROKES }, () => {
    let x = Math.round(random() * 6000);
    let y = Math.round(random() * 4000);
    return Array.from({ length: POINTS }, () => {
      x += Math.round((random() - 0.5) * 24);
      y += Math.round((random() - 0.5) * 24);
      return [x / zoom, y / zoom];
    });
  });
}

/** Points relative to their box, which takes half the line's width on every
 * side, and the box, as BlockSuite's brush sets both. */
function placed(points: number[][]) {
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const [x, y] = [Math.min(...xs), Math.min(...ys)].map(
    (v) => v - LINE_WIDTH / 2
  );
  const w = Math.max(...xs) - x + LINE_WIDTH / 2;
  const h = Math.max(...ys) - y + LINE_WIDTH / 2;
  return {
    relative: points.map(([px, py]) => [px - x, py - y]),
    xywh: `[${x},${y},${w},${h}]`,
  };
}

function board(binary: boolean) {
  const room = new Y.Doc();
  Y.applyUpdate(
    room,
    readFileSync(
      new URL(
        '../../../collaboration-rs/crates/server/fixtures/board-first-state.bin',
        import.meta.url
      )
    )
  );
  const value = (points: number[][]) =>
    binary ? encodeStrokePoints(points) : points;
  let sent = 0;
  let tab = new Y.Doc();
  const join = () => {
    tab.destroy();
    tab = new Y.Doc();
    Y.applyUpdate(tab, Y.encodeStateAsUpdate(room));
    // What the tab sends: each of its own transactions' update.
    tab.on('update', (update: Uint8Array) => {
      sent += update.length;
      Y.applyUpdate(room, update);
    });
  };
  const elementsOf = (doc: Y.Doc) =>
    (
      (doc.getMap<Y.Map<unknown>>('blocks').get('surface') as Y.Map<unknown>).get(
        'prop:elements'
      ) as Y.Map<unknown>
    ).get('value') as Y.Map<Y.Map<unknown>>;
  for (const [i, points] of strokes().entries()) {
    if (i % PER_TAB === 0) join();
    const write = (change: () => void) => tab.transact(change);
    const id = `stroke-${i}`;
    write(() => {
      const element = new Y.Map<unknown>();
      const first = placed(points.slice(0, 1));
      for (const [key, field] of Object.entries({
        color: '#1f2937',
        id,
        index: `a${i}`,
        lineWidth: LINE_WIDTH,
        points: value(first.relative),
        rotate: 0,
        seed: i,
        type: 'brush',
        xywh: first.xywh,
      }))
        element.set(key, field);
      elementsOf(tab).set(id, element);
    });
    for (const upTo of [Math.ceil(POINTS / 2), POINTS]) {
      const { relative, xywh } = placed(points.slice(0, upTo));
      write(() => {
        const element = elementsOf(tab).get(id) as Y.Map<unknown>;
        element.set('points', value(relative));
        element.set('xywh', xywh);
      });
    }
  }
  tab.destroy();
  const state = Y.encodeStateAsUpdate(room);
  room.destroy();
  return { sent, state };
}

if (way) {
  const { sent, state } = board(way === 'binary');
  const before = held();
  const tab = new Y.Doc();
  Y.applyUpdate(tab, state);
  const memory = held() - before;
  console.log(
    JSON.stringify({
      points: way,
      sent_bytes: sent,
      state_bytes: state.length,
      tab_heap_bytes: memory,
      zoom,
    })
  );
} else {
  // tsx's loader is in this process's node flags, so the children take it too.
  for (const each of ['arrays', 'binary'])
    spawnSync(
      process.execPath,
      [
        ...process.execArgv,
        fileURLToPath(import.meta.url),
        String(zoom),
        each,
      ],
      { stdio: 'inherit' }
    );
}
