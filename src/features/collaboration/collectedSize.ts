import * as Y from 'yjs';

/**
 * The bytes a collected copy of `doc` holds: the room's state, which the
 * server collects. An undo history keeps what its tracked transactions
 * deleted (a `Y.UndoManager` keeps each item, BlockSuite's history is one,
 * and its `clear` collects nothing), so the document's own encode still
 * holds a cleared board: 200 deleted 2 KB entries encode at 404 KB, 3.3 KB
 * once collected. This is the encode less what collecting each deleted item
 * that still holds its content would save. Inside a deleted type the item
 * becomes a GC struct (an info byte and its length); elsewhere it keeps its
 * header and its content shrinks to its length. It is an upper bound, since
 * collected neighbours merge and save more: 1.6% over at half of a 2.9 MB
 * board erased, 45% over (of a small size) at all of it. The walk costs
 * 25-35 ms beside the encode at 2.9 MB on an M1, so an encode below `from`
 * (where nothing acts on the size) is taken as it is: also an upper bound.
 *
 * The Yjs internals it reads, here only: the struct store
 * (`doc.store.clients`), a parent type's own item (`parent._item`), and the
 * v1 encoding of an item and of its content (`Item.write`,
 * `AbstractContent.write`).
 */
export function collectedSize(doc: Y.Doc, from = 0) {
  let size = Y.encodeStateAsUpdate(doc).byteLength;
  if (size < from) return size;
  for (const structs of doc.store.clients.values()) {
    for (const struct of structs) {
      if (
        !(struct instanceof Y.Item && struct.deleted) ||
        struct.content instanceof Y.ContentDeleted
      )
        continue;
      const { parent } = struct;
      size -=
        parent instanceof Y.AbstractType && parent._item?.deleted
          ? written((encoder) => struct.write(encoder, 0)) -
            1 -
            varUintLength(struct.length)
          : written((encoder) => struct.content.write(encoder, 0)) -
            varUintLength(struct.length);
    }
  }
  return size;
}

/** The bytes `write` puts in an update's v1 encoding. */
function written(write: (encoder: Y.UpdateEncoderV1) => void) {
  const encoder = new Y.UpdateEncoderV1();
  write(encoder);
  return encoder.toUint8Array().byteLength;
}

/** The bytes of `value` as an unsigned varint. */
function varUintLength(value: number) {
  let length = 1;
  for (let rest = value; rest >= 128; rest = Math.floor(rest / 128)) length++;
  return length;
}
