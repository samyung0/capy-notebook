import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import { expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { FIGURE_MAPS, isFigureType } from '@/features/figures/figureMap';
import './figureBinding';

/* The browser and server parity corpus for note figures (Epo 2026-11-16,
 * D15), as quizzes' parity.test.ts: what the server bootstraps
 * (collaboration-rs/crates/notes/tests/figure_parity/rust.json) the patched
 * slate-yjs reads as the same note; what the browser inserts (ts.json,
 * written here with PARITY_WRITE=1) the server reads back
 * (notes/tests/figure_parity.rs). Ids and the client are fixed so the file
 * is stable. */

let next = 0;
vi.mock('@/lib/id', () => ({ uid: (prefix = 'id') => `${prefix}_${next++}` }));

const dir = resolve(
  import.meta.dirname,
  '../../../collaboration-rs/crates/notes/tests/figure_parity'
);
const read = (name: string) =>
  readFileSync(resolve(dir, name), 'utf8').replaceAll('\r\n', '\n');

type Corpus = { state: string; value: Record<string, unknown>[] };
const server = JSON.parse(read('rust.json')) as Corpus;

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const unhex = (text: string) =>
  Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

const blocks = (doc: Y.Doc) =>
  (doc.get('content', Y.XmlText).toDelta() as { insert: Y.XmlText }[]).map(
    ({ insert }) => insert
  );

it('reads what the server bootstraps as the same note, each figure a figure map', () => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, unhex(server.state));
  const nodes = blocks(doc);
  expect(nodes.map((node) => yTextToSlateElement(node))).toEqual(server.value);
  for (const node of nodes) {
    const type = node.getAttribute('type');
    if (!isFigureType(type)) continue;
    const map = node.getAttribute('block') as unknown as Y.Map<unknown>;
    for (const key of FIGURE_MAPS[type])
      expect(map.get(key)).toBeInstanceOf(Y.Map);
  }
});

it('keeps the browser corpus the server reads current', () => {
  next = 0;
  const doc = new Y.Doc();
  doc.clientID = 1;
  doc
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(server.value as never));
  const written = `${JSON.stringify(
    { state: hex(Y.encodeStateAsUpdate(doc)), value: server.value },
    null,
    2
  )}\n`;
  if (process.env.PARITY_WRITE) writeFileSync(resolve(dir, 'ts.json'), written);
  const committed = JSON.parse(read('ts.json')) as Corpus;
  expect(committed.value).toEqual(server.value);
  const held = (state: string) => {
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, unhex(state));
    return blocks(loaded).map((node) => {
      const block = node.getAttribute('block');
      return block instanceof Y.Map ? block.toJSON() : null;
    });
  };
  expect(held(committed.state)).toEqual(held(JSON.parse(written).state));
});
