import { parseHTML } from 'linkedom';
import { expect, it } from 'vitest';
import {
  adoptMaterialHost,
  cardEditable,
  cardEditing,
  cardUndo,
  lendCardUndo,
  onCardState,
  onMaterialHosts,
  releaseMaterialHost,
  setCardEditable,
  setCardEditing,
} from './materialCardHosts';

// The registry makes its hosts with `document`; the tests run without a DOM.
const { document } = parseHTML('<!doctype html><html><body></body></html>');
Object.assign(globalThis, { document });

// The page renders a placed card's runner into the host the block lends it, so the
// set of hosts is what it subscribes to (Epo 2026-11-09).
it('lends a host per card and takes it back when the card goes', async () => {
  const seen: Map<string, { materialId: string }>[] = [];
  const stop = onMaterialHosts((cards) => seen.push(cards));
  expect(seen.at(-1)?.size).toBe(0);

  const host = adoptMaterialHost('block-1', {
    kind: 'quiz',
    materialId: 'qz_1',
  });
  expect(seen.at(-1)?.get('block-1')?.materialId).toBe('qz_1');

  releaseMaterialHost('block-1');
  await Promise.resolve();
  expect(seen.at(-1)?.has('block-1')).toBe(false);
  stop();
  expect(host.className).toBe('capy-card-body');
});

// BlockSuite re-creates a block's view; the same element must come back, so an
// answer in progress inside it is never unmounted.
it('gives a re-created block the same host for its card', async () => {
  const first = adoptMaterialHost('block-2', {
    kind: 'flashcards',
    materialId: 'set_1',
  });
  releaseMaterialHost('block-2');
  const again = adoptMaterialHost('block-2', {
    kind: 'flashcards',
    materialId: 'set_1',
  });
  expect(again).toBe(first);
  // The release of the view it left does not take the card away.
  await Promise.resolve();
  const live: Map<string, unknown>[] = [];
  const stop = onMaterialHosts((cards) => live.push(cards));
  expect(live.at(-1)?.has('block-2')).toBe(true);
  stop();
});

// The card points at another material (an undo, a paste repointed): the page's host
// follows it.
it('follows a card repointed at another material', () => {
  const seen: Map<string, { kind: string; materialId: string }>[] = [];
  const stop = onMaterialHosts((cards) => seen.push(cards));
  const host = adoptMaterialHost('block-3', {
    kind: 'quiz',
    materialId: 'qz_2',
  });
  expect(
    adoptMaterialHost('block-3', { kind: 'quiz', materialId: 'qz_3' })
  ).toBe(host);
  expect(seen.at(-1)?.get('block-3')?.materialId).toBe('qz_3');
  stop();
});

// The board's toolbar offers Edit for a card the page says may be edited, and its
// Done or another card's Edit moves the one card being edited (Epo 2026-11-13).
it('tells the board which cards may be edited and which one is', () => {
  let told = 0;
  const stop = onCardState(() => {
    told += 1;
  });
  setCardEditable('block-4', true);
  expect(cardEditable('block-4')).toBe(true);
  setCardEditing({ id: 'block-4', materialId: 'qz_4' });
  expect(cardEditing()?.materialId).toBe('qz_4');
  setCardEditing({ id: 'block-5', materialId: 'set_5' });
  expect(cardEditing()?.id).toBe('block-5');
  setCardEditing(null);
  expect(cardEditing()).toBeNull();
  expect(told).toBe(4);
  stop();
});

// The board's Undo and Redo reach the edited card's own history, and only while
// it is edited (Epo 2026-11-13).
it("lends the edited card's undo to the board while it is edited", () => {
  const history = {
    canRedo: () => false,
    canUndo: () => true,
    redo: () => undefined,
    subscribe: () => () => undefined,
    undo: () => undefined,
  };
  setCardEditing({ id: 'block-6', materialId: 'qz_6' });
  const giveBack = lendCardUndo(history);
  expect(cardUndo()).toBe(history);
  setCardEditing(null);
  expect(cardUndo()).toBeNull();
  giveBack();
});
