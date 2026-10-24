import { readFileSync } from 'node:fs';
import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import { beforeAll, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { MaterialValue } from '@/features/materials/document';
import { initSync } from './generated/late_merge.js';
import {
  hiddenDocument,
  holdsUnsent,
  LATE_MERGE_DEADLINE_MS,
  mergeLate,
} from './lateMerge';
import { mergeRequest } from './lateMerge.worker';

/** The sample the native merge is held to (collaboration-rs late-merge
 * tests/sample.rs): a tab's document, the room's collected one, and the
 * merged update. */
const sample = (name: string) =>
  new Uint8Array(
    readFileSync(
      new URL(
        `../../../../collaboration-rs/crates/late-merge/tests/fixtures/sample-${name}.bin`,
        import.meta.url
      )
    )
  );

// Node cannot fetch the packaged wasm URL; the bytes go to the glue the
// worker uses, whose init() is then a no-op.
beforeAll(() => {
  initSync({
    module: readFileSync(
      new URL('./generated/late_merge_bg.wasm', import.meta.url)
    ),
  });
});

it('merges in the worker to exactly the bytes the native merge gives', async () => {
  const current = sample('current');
  const reply = await mergeRequest({
    current: current.slice().buffer,
    old: sample('old').slice().buffer,
  });
  if (!('merged' in reply)) throw new Error(reply.error);
  const merged = new Uint8Array(reply.merged);
  expect(merged).toEqual(sample('merged'));
  // And the same hidden blocks: those the tab typed in that the other
  // session deleted.
  expect(reply.hidden).toEqual(
    JSON.parse(
      readFileSync(
        new URL(
          '../../../../collaboration-rs/crates/late-merge/tests/fixtures/sample-hidden.json',
          import.meta.url
        ),
        'utf8'
      )
    )
  );
  expect(reply.hidden.length).toBeGreaterThan(0);
  // Yjs takes the update whole: nothing waits for a unit it lacks.
  const doc = new Y.Doc();
  Y.applyUpdate(doc, current);
  Y.applyUpdate(doc, merged);
  expect(doc.store.pendingStructs).toBeNull();
  expect(doc.store.pendingDs).toBeNull();
});

it('re-authors the same edits under the assigned id, all of them under it', async () => {
  const current = sample('current');
  const author = 4242;
  const reply = await mergeRequest({
    author,
    current: current.slice().buffer,
    old: sample('old').slice().buffer,
  });
  if (!('merged' in reply)) throw new Error(reply.error);
  const reauthored = new Uint8Array(reply.merged);
  const { structs } = Y.decodeUpdate(reauthored);
  expect(structs.length).toBeGreaterThan(0);
  expect(structs.every((struct) => struct.id.client === author)).toBe(true);
  // The text the merge under the tab's own ids gives.
  const read = (update: Uint8Array) => {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, current);
    Y.applyUpdate(doc, update);
    expect(doc.store.pendingStructs).toBeNull();
    return doc.get('content', Y.XmlText).toString();
  };
  expect(read(reauthored)).toBe(read(sample('merged')));
});

it('answers what is not a Yjs document with the reason, not a throw', async () => {
  const reply = await mergeRequest({
    current: sample('current').slice().buffer,
    old: new Uint8Array([1, 2, 3]).buffer,
  });
  expect(reply).toEqual({
    error: expect.stringContaining('not a Yjs document'),
  });
});

it('needs no merge when the old document holds nothing the current one lacks', () => {
  const doc = new Y.Doc();
  doc.getText('t').insert(0, 'abc');
  const same = Y.encodeStateAsUpdate(doc);
  expect(holdsUnsent(same, doc)).toBe(false);
  const tab = (edit: (text: Y.Text) => void) => {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, same);
    edit(copy.getText('t'));
    return Y.encodeStateAsUpdate(copy);
  };
  expect(
    holdsUnsent(
      tab((text) => text.insert(3, 'd')),
      doc
    )
  ).toBe(true);
  // A deletion alone is an edit to merge too.
  expect(
    holdsUnsent(
      tab((text) => text.delete(1, 1)),
      doc
    )
  ).toBe(true);
});

/** The top-level blocks of a note, or the children of one block. */
const embeds = (text: Y.XmlText) =>
  (text.toDelta() as { insert: Y.XmlText }[]).map(({ insert }) => insert);

it("keeps the whole blocks someone deleted, embeds and all, in the tab's order", async () => {
  const room = new Y.Doc();
  const content = room.get('content', Y.XmlText);
  const value = [
    { children: [{ text: 'intro' }], id: 'b0', type: 'p' },
    {
      children: [{ children: [{ text: 'inside' }], id: 'c1p', type: 'p' }],
      id: 'c1',
      type: 'callout',
    },
  ] as MaterialValue;
  content.applyDelta(slateNodesToInsertDelta(value));
  // A Mermaid block added later sits first: its id comes after the callout's.
  const mermaid = [
    {
      children: [{ text: '' }],
      id: 'm1',
      source: 'graph TD',
      type: 'mermaid',
    },
  ] as MaterialValue;
  content.applyDelta([{ retain: 1 }, ...slateNodesToInsertDelta(mermaid)]);
  const tab = new Y.Doc();
  Y.applyUpdate(tab, Y.encodeStateAsUpdate(room));
  const [, diagram, callout] = embeds(tab.get('content', Y.XmlText));
  // The tab writes a source over the stored one (as the Mermaid dialog does
  // for a stored string) and types into it; it adds an image to the callout.
  const source = new Y.Text();
  diagram.setAttribute('source', source);
  source.insert(0, 'graph LR');
  const image = [
    {
      children: [{ text: '' }],
      id: 'img1',
      type: 'img',
      url: 'https://example.com/a.png',
    },
  ] as MaterialValue;
  callout.applyDelta([{ retain: 1 }, ...slateNodesToInsertDelta(image)]);
  // Another session deletes both blocks.
  content.delete(2, 1);
  content.delete(1, 1);
  const old = Y.encodeStateAsUpdate(tab);
  const reply = await mergeRequest({
    current: Y.encodeStateAsUpdate(room).buffer as ArrayBuffer,
    old: old.slice().buffer,
  });
  if (!('merged' in reply)) throw new Error(reply.error);
  expect(reply.hidden).toHaveLength(2);
  const kept = new Y.Doc();
  Y.applyUpdate(kept, hiddenDocument(old, [...reply.hidden, reply.hidden[0]]));
  expect(yTextToSlateElement(kept.get('content', Y.XmlText)).children).toEqual([
    {
      children: [{ text: '' }],
      id: 'm1',
      source: 'graph LR',
      type: 'mermaid',
    },
    {
      children: [
        { children: [{ text: 'inside' }], id: 'c1p', type: 'p' },
        {
          children: [{ text: '' }],
          id: 'img1',
          type: 'img',
          url: 'https://example.com/a.png',
        },
      ],
      id: 'c1',
      type: 'callout',
    },
  ]);
});

it('counts the deadline from the loaded WASM, not from the download', async () => {
  vi.useFakeTimers();
  const workers: {
    onmessage: (event: { data: unknown }) => void;
    stopped: boolean;
  }[] = [];
  vi.stubGlobal(
    'Worker',
    class {
      onmessage = (_event: { data: unknown }) => {};
      onerror = null;
      stopped = false;
      constructor() {
        workers.push(this);
      }
      postMessage() {}
      terminate() {
        this.stopped = true;
      }
    }
  );
  try {
    let outcome: string | null = null;
    void mergeLate(new Uint8Array(), new Uint8Array()).then(
      () => {
        outcome = 'merged';
      },
      () => {
        outcome = 'failed';
      }
    );
    // A slow download: past the deadline, but the WASM has not loaded.
    await vi.advanceTimersByTimeAsync(LATE_MERGE_DEADLINE_MS * 2);
    expect(outcome).toBeNull();
    workers[0].onmessage({ data: { ready: true } });
    await vi.advanceTimersByTimeAsync(LATE_MERGE_DEADLINE_MS - 1);
    expect(outcome).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBe('failed');
    expect(workers[0].stopped).toBe(true);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
