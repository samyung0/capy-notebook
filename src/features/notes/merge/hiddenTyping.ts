import * as Y from 'yjs';
import type { MaterialElement } from '@/features/materials/document';
import { blockId, blockVersions, rootOf, topBlock, visible } from './pieces';
import type { MergePiece } from './types';

/**
 * Hidden typing at a join (Q237, Q258): typing the room never saw that lands
 * inside a block someone deleted meanwhile, so it never shows. After a JOIN
 * the server sends its step 1 (its state vector) before its step 2, so
 * whatever the tab holds past that vector is exactly what the room has never
 * seen. `armed` takes that vector; with nothing unsent it stays idle at no
 * cost. Otherwise, until `synced`:
 * - before each room transaction, typed content past the vector (text,
 *   embeds, inserted elements; not attributes or formats, Q259) shown inside
 *   a top-level block the room already holds is a candidate, and its block
 *   is drawn once, before the room changes it;
 * - after each room transaction (Yjs emits it before collecting deleted
 *   content), a candidate the transaction deleted hides its block; text of
 *   rows that were pending until this sync (restored without a state row)
 *   deleted as it integrated survives only as text (`plain` pieces).
 * `synced` returns the pieces (`hidden`) and detaches. Text the room had
 * already seen and then deleted is never reported.
 */
export function watchHiddenTyping(
  doc: Y.Doc,
  isRoom: (origin: unknown) => boolean
) {
  const root = rootOf(doc);
  let server = new Map<number, number>();
  let attached = false;
  // Typed items past the vector and their top-level block's id.
  let candidates = new Map<Y.Item, string>();
  let drawn = new Map<
    string,
    { after: string | null; node: MaterialElement | null }
  >();
  let hidden = new Set<string>();
  let plain: MergePiece[] = [];

  const known = (client: number) => server.get(client) ?? 0;

  const before = (transaction: Y.Transaction) => {
    if (!isRoom(transaction.origin)) return;
    const draw = new Set<string>();
    doc.store.clients.forEach((structs, client) => {
      const from = known(client);
      if (Y.getState(doc.store, client) <= from) return;
      for (let i = Y.findIndexSS(structs, from); i < structs.length; i++) {
        const item = structs[i];
        if (!(item instanceof Y.Item && typed(item)) || candidates.has(item))
          continue;
        if (!visible(item)) continue;
        const block = topBlock(item, root);
        const top = block?._item;
        // A new block cannot be hidden: the room never held it.
        if (!top || top === item || top.id.clock >= known(top.id.client))
          continue;
        const id = blockId(block);
        if (!id) continue;
        candidates.set(item, id);
        if (!drawn.has(id)) draw.add(id);
      }
    });
    if (draw.size)
      for (const [id, version] of blockVersions(doc, draw))
        drawn.set(id, version);
  };

  const after = (transaction: Y.Transaction) => {
    if (!isRoom(transaction.origin)) return;
    for (const [item, id] of candidates)
      if (Y.isDeleted(transaction.deleteSet, item.id)) hidden.add(id);
    // Pending structs integrated in this transaction, already deleted.
    const texts = new Map<Y.AbstractType<unknown>, Set<Y.Item>>();
    transaction.deleteSet.clients.forEach((ranges, client) => {
      const since = Math.max(
        known(client),
        transaction.beforeState.get(client) ?? 0
      );
      const structs = doc.store.clients.get(client);
      if (!structs) return;
      for (const { clock, len } of ranges) {
        const end = clock + len;
        if (end <= since) continue;
        for (
          let i = Y.findIndexSS(structs, Math.max(clock, since));
          i < structs.length && structs[i].id.clock < end;
          i++
        ) {
          const item = structs[i];
          if (
            !(item instanceof Y.Item) ||
            item.parentSub !== null ||
            !(item.content instanceof Y.ContentString) ||
            !(item.parent instanceof Y.AbstractType)
          )
            continue;
          const hits = texts.get(item.parent) ?? new Set<Y.Item>();
          hits.add(item);
          texts.set(item.parent, hits);
        }
      }
    });
    for (const [parent, hits] of texts) {
      const piece = plainPiece(root, parent, hits);
      if (piece) plain.push(piece);
    }
  };

  const detach = () => {
    if (!attached) return;
    attached = false;
    doc.off('beforeTransaction', before);
    doc.off('afterTransaction', after);
  };

  return {
    /** The server's step 1: its state vector, before its step 2. */
    armed(vector: Uint8Array) {
      server = Y.decodeStateVector(vector);
      candidates = new Map();
      drawn = new Map();
      hidden = new Set();
      plain = [];
      let unsent = doc.store.pendingStructs !== null;
      doc.store.clients.forEach((_, client) => {
        if (Y.getState(doc.store, client) > known(client)) unsent = true;
      });
      if (!unsent) {
        detach();
        return;
      }
      if (attached) return;
      attached = true;
      doc.on('beforeTransaction', before);
      doc.on('afterTransaction', after);
    },
    dispose: detach,
    /** The room synced: the hidden pieces, and the watch ends. */
    synced(at = Date.now()): MergePiece[] {
      detach();
      const pieces: MergePiece[] = [...plain];
      for (const id of hidden) {
        const version = drawn.get(id);
        if (version?.node)
          pieces.push({
            after: version.after,
            at,
            block: id,
            mine: version.node,
            source: 'hidden',
          });
      }
      for (const piece of pieces) piece.at = at;
      candidates = new Map();
      drawn = new Map();
      hidden = new Set();
      plain = [];
      return pieces;
    },
  };
}

export type HiddenTyping = ReturnType<typeof watchHiddenTyping>;

/** Typed content (Q259): text, an embed or an inserted element, never an
 * attribute or a format. */
const typed = (item: Y.Item) =>
  item.parentSub === null &&
  (item.content instanceof Y.ContentString ||
    item.content instanceof Y.ContentEmbed ||
    item.content instanceof Y.ContentType);

/** A deleted map value as it was (its content stays until the transaction
 * ends; `getAttribute` skips deleted entries). */
function attribute(type: Y.AbstractType<unknown>, key: string) {
  const entry = type._map.get(key);
  const value = entry?.content.getContent().at(-1);
  return typeof value === 'string' ? value : null;
}

/** The hidden text of one parent as a paragraph keyed by its top-level
 * block, in document order, after the block before it. */
function plainPiece(
  root: Y.XmlText,
  parent: Y.AbstractType<unknown>,
  hits: Set<Y.Item>
): MergePiece | null {
  let top = parent._item;
  while (top && top.parent !== root) {
    const holder: Y.Item['parent'] = top.parent;
    top = holder instanceof Y.AbstractType ? holder._item : null;
  }
  if (!(top && top.content instanceof Y.ContentType)) return null;
  const block = attribute(top.content.type, 'id');
  if (!block) return null;
  let text = '';
  for (let item = parent._start; item; item = item.right)
    if (hits.has(item) && item.content instanceof Y.ContentString)
      text += item.content.str;
  if (!text) return null;
  let after: string | null = null;
  for (let left = top.left; left; left = left.left) {
    if (left.deleted || !(left.content instanceof Y.ContentType)) continue;
    after = attribute(left.content.type, 'id');
    if (after) break;
  }
  return {
    after,
    at: 0,
    block,
    mine: { children: [{ text }], id: block, type: 'p' } as MaterialElement,
    plain: true,
    source: 'hidden',
  };
}
