import type { UndoTarget } from '@/features/collaboration/undo';
/** The hosts the workspace canvas lends the page for its placed quizzes and sets
 * (Epo 2026-11-09): a placed card is the runner itself, rendered by the page into
 * the element its block adopts. Kept apart from the board's own code so the page
 * subscribes to it without loading BlockSuite. */

export type CardMaterialKind = 'quiz' | 'flashcards';

/** One placed card and the element the page renders its runner into. */
export type MaterialCardHost = {
  host: HTMLDivElement;
  kind: CardMaterialKind;
  materialId: string;
};

const cardHosts = new Map<string, MaterialCardHost>();
/** Just released: the element is kept for the rest of the tick, so a block BlockSuite
 * re-creates (a re-render of the view, a move between layers) adopts the same one and
 * the answer in progress inside it is never unmounted. */
const parkedHosts = new Map<string, MaterialCardHost>();
const watchers = new Set<(cards: Map<string, MaterialCardHost>) => void>();

const tellWatchers = () => {
  const cards = new Map(cardHosts);
  for (const watch of watchers) watch(cards);
};

/** The cards on the canvas now, and every change to that set: what the page
 * subscribes to for its portals. */
export const onMaterialHosts = (
  watch: (cards: Map<string, MaterialCardHost>) => void
) => {
  watchers.add(watch);
  watch(new Map(cardHosts));
  return () => {
    watchers.delete(watch);
  };
};

/** The host for this block: the element it had before, or a new one. */
export const adoptMaterialHost = (
  blockId: string,
  card: Omit<MaterialCardHost, 'host'>
) => {
  const kept = parkedHosts.get(blockId) ?? cardHosts.get(blockId);
  parkedHosts.delete(blockId);
  const host = kept?.host ?? document.createElement('div');
  host.className = 'capy-card-body';
  cardHosts.set(blockId, { ...card, host });
  tellWatchers();
  return host;
};

/** What a block holds for its card now, so a changed prop re-adopts. */
export const materialHostOf = (blockId: string) => cardHosts.get(blockId);

export const releaseMaterialHost = (blockId: string) => {
  const kept = cardHosts.get(blockId);
  if (!kept) return;
  cardHosts.delete(blockId);
  parkedHosts.set(blockId, kept);
  queueMicrotask(() => {
    if (parkedHosts.delete(blockId)) tellWatchers();
  });
};

/** A placed card's size in screen pixels: a quiz shows a question with its options,
 * a set one card with its count and steps, unscrolled (Epo 2026-11-13). */
export const MATERIAL_CARD_SIZE: Record<CardMaterialKind, [number, number]> = {
  flashcards: [400, 340],
  quiz: [440, 500],
};

/** The cards whose material the person may edit, as the page reads it, and the one
 * card being edited (Epo 2026-11-13): the board's toolbar offers Edit or Done from
 * them, and the page draws that card's editor. */
const editableCards = new Set<string>();
export type EditingCard = { id: string; materialId: string };
let editingCard: EditingCard | null = null;
const stateWatchers = new Set<() => void>();
const tellState = () => {
  for (const watch of stateWatchers) watch();
};

export const onCardState = (watch: () => void) => {
  stateWatchers.add(watch);
  return () => {
    stateWatchers.delete(watch);
  };
};

export const cardEditable = (blockId: string) => editableCards.has(blockId);

export const setCardEditable = (blockId: string, editable: boolean) => {
  if (editableCards.has(blockId) === editable) return;
  if (editable) editableCards.add(blockId);
  else editableCards.delete(blockId);
  tellState();
};

export const cardEditing = () => editingCard;

export const setCardEditing = (next: EditingCard | null) => {
  if (editingCard?.id === next?.id) return;
  editingCard = next;
  tellState();
};

/** The edited card's own Undo and Redo (its quiz's or set's history, Epo
 * 2026-11-13): while a card is being edited the board's Undo and Redo act on it,
 * as the plane's editor takes them while open. */
let editingUndo: UndoTarget | null = null;

export const cardUndo = () => (editingCard ? editingUndo : null);

/** Lent by the edited card's editor (`UndoSink`); taking it back leaves a newer
 * card's alone. */
export const lendCardUndo = (target: UndoTarget) => {
  editingUndo = target;
  return () => {
    if (editingUndo === target) editingUndo = null;
  };
};
