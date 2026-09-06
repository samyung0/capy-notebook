import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { type SourceDraft, sourceRecoveryDrafts } from './sourceDraft';

it('merges one recovery lineage while preserving further groups and current drafts', () => {
  const first = new Y.Doc();
  first.getText('source').insert(0, 'base');
  const second = new Y.Doc();
  Y.applyUpdate(second, Y.encodeStateAsUpdate(first));
  first.getText('source').insert(0, 'first ');
  second.getText('source').insert(4, ' second');
  const draft = (
    id: string,
    epoch: number,
    baseSourceSHA256: string,
    doc: Y.Doc
  ): SourceDraft => ({
    base: new Uint8Array(),
    baseSourceSHA256,
    epoch,
    fileId: 'actor:file',
    id,
    state: Y.encodeStateAsUpdate(doc),
    version: id,
  });
  const drafts = [
    draft('a', 1, 'old', first),
    draft('b', 1, 'old', second),
    draft('c', 1, 'different', first),
    draft('d', 3, 'current', first),
  ];
  const session = { baseSourceSHA256: 'current', epoch: 3, format: 'docx' };
  const group = sourceRecoveryDrafts(drafts, session);
  expect(group.map((d) => d.id)).toEqual(['a', 'b']);
  const recovered = new Y.Doc();
  for (const snapshot of group) Y.applyUpdate(recovered, snapshot.state);
  expect(recovered.getText('source').toString()).toBe('first base second');
  const remaining = drafts.filter((d) => !group.includes(d));
  expect(sourceRecoveryDrafts(remaining, session).map((d) => d.id)).toEqual([
    'c',
  ]);
  expect(
    sourceRecoveryDrafts(
      remaining.filter((d) => d.id !== 'c'),
      session
    )
  ).toEqual([]);
  expect(remaining.find((d) => d.id === 'd')).toBe(drafts[3]);
  for (const doc of [first, second, recovered]) doc.destroy();
});

it('keeps same-epoch text drafts compatible across published source hashes', () => {
  const drafts = ['old', 'new'].map(
    (hash, index): SourceDraft => ({
      base: new Uint8Array(),
      baseSourceSHA256: hash,
      epoch: 2,
      fileId: 'actor:file',
      id: String(index),
      state: new Uint8Array(),
      version: '1',
    })
  );
  expect(
    sourceRecoveryDrafts(drafts, {
      baseSourceSHA256: 'latest',
      epoch: 2,
      format: 'text',
    })
  ).toEqual([]);
  expect(
    sourceRecoveryDrafts(drafts, {
      baseSourceSHA256: 'latest',
      epoch: 3,
      format: 'text',
    })
  ).toEqual(drafts);
});
