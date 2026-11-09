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
 * a set one card. */
export const MATERIAL_CARD_SIZE: Record<CardMaterialKind, [number, number]> = {
  flashcards: [360, 260],
  quiz: [360, 420],
};
