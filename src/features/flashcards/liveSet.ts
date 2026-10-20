import { useCallback, useRef, useSyncExternalStore } from 'react';
import * as Y from 'yjs';
import { EMBED_CATALOG } from '@/api/embeds.generated';
import { LOCAL_EDIT } from '@/features/collaboration/yText';
import type { FlashcardContent } from '@/features/materials/blocks';
import { uid } from '@/lib/id';
import { keyBetween } from '@/lib/orderKey';

/* A flashcard set's live document (live-items DESIGN.md 1.4): the root map
 * `cards`, card id -> {order, front: Y.Text, back: Y.Text, image?}. The
 * collaboration server checks every update against this shape
 * (collaboration-rs/crates/items/src/flashcards.rs) and projects it to the
 * set's Plate content, so reads elsewhere keep their JSON. */

export const CARDS_ROOT = 'cards';
/** The server's caps (characters; maxLength counts UTF-16 units, stricter). */
export const MAX_FRONT = EMBED_CATALOG.limits.CARD_FRONT_MAX;
export const MAX_BACK = EMBED_CATALOG.limits.CARD_BACK_MAX;

export const setScope = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>(CARDS_ROOT);

interface Entry {
  card: Y.Map<unknown>;
  id: string;
  order: string;
}

function entries(doc: Y.Doc): Entry[] {
  const out: Entry[] = [];
  setScope(doc).forEach((card, id) => {
    if (!(card instanceof Y.Map)) return;
    const order = card.get('order');
    out.push({ card, id, order: typeof order === 'string' ? order : '' });
  });
  // Two writers who inserted at the same place hold the same key; the id
  // breaks the tie the same way everywhere (the server sorts alike).
  return out.sort((a, b) =>
    a.order < b.order
      ? -1
      : a.order > b.order
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0
  );
}

const textOf = (card: Y.Map<unknown>, field: 'front' | 'back') => {
  const text = card.get(field);
  return text instanceof Y.Text ? text.toString() : '';
};

/** Every card, in order, as plain content. */
export function readCards(doc: Y.Doc): FlashcardContent[] {
  return entries(doc).map(({ card, id }) => {
    const image = card.get('image') as { assetId?: unknown } | undefined;
    return {
      back: textOf(card, 'back'),
      front: textOf(card, 'front'),
      id,
      ...(typeof image?.assetId === 'string'
        ? { image: { assetId: image.assetId } }
        : {}),
    };
  });
}

/** A card's face to bind a field to. */
export function cardFace(
  doc: Y.Doc,
  id: string,
  field: 'front' | 'back'
): Y.Text | null {
  const card = setScope(doc).get(id);
  const text = card instanceof Y.Map ? card.get(field) : null;
  return text instanceof Y.Text ? text : null;
}

function cardMap(order: string, front = '', back = '') {
  const card = new Y.Map<unknown>();
  card.set('order', order);
  card.set('front', new Y.Text(front));
  card.set('back', new Y.Text(back));
  return card;
}

/** Appends a blank card; returns its id. */
export function addCard(doc: Y.Doc): string {
  const id = uid('card');
  const last = entries(doc).at(-1)?.order ?? null;
  doc.transact(() => {
    setScope(doc).set(id, cardMap(keyBetween(last, null)));
  }, LOCAL_EDIT);
  return id;
}

export function removeCard(doc: Y.Doc, id: string) {
  doc.transact(() => setScope(doc).delete(id), LOCAL_EDIT);
}

export function setCardImage(
  doc: Y.Doc,
  id: string,
  image: { assetId: string } | undefined
) {
  const card = setScope(doc).get(id);
  if (!(card instanceof Y.Map)) return;
  doc.transact(() => {
    if (image) card.set('image', { assetId: image.assetId });
    else card.delete('image');
  }, LOCAL_EDIT);
}

export const isBlank = (card: FlashcardContent) =>
  !(card.front.trim() || card.back.trim() || card.image);

/** Seeds a set from its stored cards, as the server bootstraps a room (the
 * MSW stand-in and tests use it). */
export function seedCards(doc: Y.Doc, cards: FlashcardContent[]) {
  let order: string | null = null;
  doc.transact(() => {
    for (const card of cards) {
      order = keyBetween(order, null);
      const map = cardMap(order, card.front, card.back);
      if (card.image) map.set('image', { assetId: card.image.assetId });
      setScope(doc).set(card.id, map);
    }
  });
}

/** The set's cards, re-rendering when any card changes; the array keeps its
 * identity until then. */
export function useCards(doc: Y.Doc | null | undefined): FlashcardContent[] {
  const cache = useRef<{ doc: Y.Doc | null; cards: FlashcardContent[] }>({
    cards: [],
    doc: null,
  });
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!doc) return () => undefined;
      const root = setScope(doc);
      const changed = () => {
        cache.current = { cards: readCards(doc), doc };
        notify();
      };
      root.observeDeep(changed);
      return () => root.unobserveDeep(changed);
    },
    [doc]
  );
  const snapshot = () => {
    if (!doc) return EMPTY;
    if (cache.current.doc !== doc)
      cache.current = { cards: readCards(doc), doc };
    return cache.current.cards;
  };
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const EMPTY: FlashcardContent[] = [];
