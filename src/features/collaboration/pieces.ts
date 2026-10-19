import * as Y from 'yjs';

/**
 * The most bytes one outgoing update may carry (Epo 2026-10-18): every
 * format's live updates, the resync after a reconnect and draft sends go to
 * the collaboration server as pieces of at most this, in order; the server
 * refuses any update over 8 MiB (`MAX_UPDATE_BYTES`,
 * collaboration-rs/crates/ydoc/src/lib.rs). A struct that cannot be cut (a
 * photo's binary, a format mark, a type) goes whole.
 */
export const PIECE_BYTES = 2 * 1024 * 1024;

type Struct = Y.Item | Y.GC | Y.Skip;
interface Encoded {
  bytes: Uint8Array;
  struct: Struct;
}

/** A struct header's varuints at most (count, client, clock), a delete
 * range's (clock, length), and an update's section counts. */
const RUN_HEADER = 20;
const RANGE_BYTES = 16;
const SECTION_HEADER = 10;

/**
 * Cuts a Yjs update (v1) into pieces of at most `limit` bytes that, applied
 * in order over whatever the whole update applies to, leave nothing pending
 * and end in the same document:
 * - structs go in dependency order: each piece holds a clock range per
 *   client, and a struct goes only after the structs of the update its
 *   origin, right origin and parent name (several clients' structs, as a
 *   resync's diff holds, interleave);
 * - a struct over the limit whose content can be cut (text, JSON values,
 *   deleted runs) becomes runs of the same item, each after the one before
 *   (`sliceItem`, as Yjs splits items itself);
 * - a new type (a note's block, a map) and the attribute entries written
 *   right after it go in one piece, so no room sees a block without its
 *   properties (`attributesOf`);
 * - the delete set comes last, after every struct it may name.
 * An update within the limit is returned as it is.
 */
export function splitUpdate(
  update: Uint8Array,
  limit = PIECE_BYTES
): Uint8Array[] {
  if (update.byteLength <= limit) return [update];
  const { ds, structs } = Y.decodeUpdate(update);
  const queues = new Map<number, Encoded[]>();
  for (const struct of structs as Struct[]) {
    const queue = queues.get(struct.id.client) ?? [];
    queue.push(...cut(struct, limit));
    queues.set(struct.id.client, queue);
  }
  // The clocks the update holds per client, and how far the pieces got.
  const ranges = new Map<number, { end: number; start: number }>();
  const done = new Map<number, number>();
  for (const [client, queue] of queues) {
    const first = queue[0].struct;
    const last = queue.at(-1)!.struct;
    ranges.set(client, {
      end: last.id.clock + last.length,
      start: first.id.clock,
    });
    done.set(client, first.id.clock);
  }
  // A dependency outside the update is the receiver's (or makes the whole
  // update pending anyway); one inside waits for its piece.
  const placed = (id: Y.ID | null) => {
    if (!id) return true;
    const range = ranges.get(id.client);
    if (!range || id.clock < range.start || id.clock >= range.end) return true;
    return id.clock < done.get(id.client)!;
  };
  const ready = (struct: Struct) =>
    !(struct instanceof Y.Item) ||
    (placed(struct.origin) &&
      placed(struct.rightOrigin) &&
      placed(struct.parent instanceof Y.ID ? struct.parent : null));

  const pieces: Uint8Array[] = [];
  let piece = new Piece();
  const add = (cost: number) => {
    if (!piece.empty() && piece.bytes + cost > limit) {
      pieces.push(piece.encode());
      piece = new Piece();
    }
  };
  const clients = [...queues.keys()].sort((a, b) => b - a);
  const next = new Map(clients.map((client) => [client, 0]));
  let left = [...queues.values()].reduce((sum, queue) => sum + queue.length, 0);
  while (left > 0) {
    let progressed = false;
    for (const client of clients) {
      const queue = queues.get(client)!;
      let index = next.get(client)!;
      while (index < queue.length && ready(queue[index].struct)) {
        const end = index + 1 + attributesOf(queue, index);
        add(
          queue
            .slice(index, end)
            .reduce((sum, { bytes }) => sum + bytes.byteLength, 0) +
            (piece.hasRun(client) ? 0 : RUN_HEADER)
        );
        do {
          const { bytes, struct } = queue[index];
          piece.addStruct(struct, bytes);
          done.set(client, struct.id.clock + struct.length);
          index += 1;
          left -= 1;
        } while (index < end && ready(queue[index].struct));
        progressed = true;
      }
      next.set(client, index);
    }
    // Structs waiting on each other (no update Yjs writes holds such a
    // cycle): the rest goes as the update had it, whole.
    if (!progressed) {
      for (const client of clients) {
        const queue = queues.get(client)!;
        for (const { bytes, struct } of queue.slice(next.get(client))) {
          add(bytes.byteLength + (piece.hasRun(client) ? 0 : RUN_HEADER));
          piece.addStruct(struct, bytes);
        }
      }
      break;
    }
  }
  const deletes = [...ds.clients.entries()].sort(([a], [b]) => b - a);
  for (const [client, items] of deletes)
    for (const { clock, len } of items) {
      add(RANGE_BYTES + (piece.hasDeletes(client) ? 0 : RUN_HEADER));
      piece.addDelete(client, clock, len);
    }
  if (!piece.empty()) pieces.push(piece.encode());
  return pieces;
}

/** How many structs after `queue[index]`, a new type, are its attribute
 * entries (map entries whose parent it is), as Yjs writes them right after
 * it in the same transaction. */
function attributesOf(queue: Encoded[], index: number): number {
  const type = queue[index].struct;
  if (!(type instanceof Y.Item && type.content instanceof Y.ContentType))
    return 0;
  let count = 0;
  for (const { struct } of queue.slice(index + 1)) {
    if (
      !(struct instanceof Y.Item) ||
      struct.parentSub === null ||
      !(struct.parent instanceof Y.ID) ||
      !Y.compareIDs(struct.parent, type.id)
    )
      break;
    count += 1;
  }
  return count;
}

/** One piece being filled: a run of structs per client, then deletes. */
class Piece {
  bytes = 2 * SECTION_HEADER;
  private readonly runs = new Map<
    number,
    { bytes: Uint8Array[]; structs: Struct[] }
  >();
  private readonly deletes = new Map<number, [number, number][]>();

  empty() {
    return this.runs.size === 0 && this.deletes.size === 0;
  }

  hasRun(client: number) {
    return this.runs.has(client);
  }

  hasDeletes(client: number) {
    return this.deletes.has(client);
  }

  addStruct(struct: Struct, bytes: Uint8Array) {
    const client = struct.id.client;
    const run = this.runs.get(client);
    if (run) {
      run.structs.push(struct);
      run.bytes.push(bytes);
    } else {
      this.runs.set(client, { bytes: [bytes], structs: [struct] });
      this.bytes += RUN_HEADER;
    }
    this.bytes += bytes.byteLength;
  }

  addDelete(client: number, clock: number, len: number) {
    const ranges = this.deletes.get(client);
    if (ranges) ranges.push([clock, len]);
    else {
      this.deletes.set(client, [[clock, len]]);
      this.bytes += RUN_HEADER;
    }
    this.bytes += RANGE_BYTES;
  }

  /** The update (v1): structs by client, newest client first as Yjs writes
   * them, then the delete set. A run's leading and trailing gaps (`Skip`)
   * are left out; its first struct's clock starts it. */
  encode(): Uint8Array {
    const parts: (number[] | Uint8Array)[] = [];
    const runs = [...this.runs.entries()]
      .map(([client, run]) => {
        let from = 0;
        let to = run.structs.length;
        while (from < to && run.structs[from] instanceof Y.Skip) from += 1;
        while (to > from && run.structs[to - 1] instanceof Y.Skip) to -= 1;
        return { client, from, run, to };
      })
      .filter(({ from, to }) => to > from)
      .sort((a, b) => b.client - a.client);
    parts.push(varUint(runs.length));
    for (const { client, from, run, to } of runs) {
      parts.push(
        varUint(to - from),
        varUint(client),
        varUint(run.structs[from].id.clock),
        ...run.bytes.slice(from, to)
      );
    }
    const deletes = [...this.deletes.entries()].sort(([a], [b]) => b - a);
    parts.push(varUint(deletes.length));
    for (const [client, ranges] of deletes) {
      parts.push(varUint(client), varUint(ranges.length));
      for (const [clock, len] of ranges)
        parts.push(varUint(clock), varUint(len));
    }
    const out = new Uint8Array(
      parts.reduce((sum, part) => sum + part.length, 0)
    );
    let at = 0;
    for (const part of parts) {
      out.set(part, at);
      at += part.length;
    }
    return out;
  }
}

/** A lib0 varuint (numbers up to 2^53, as clocks may be). */
function varUint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push(0x80 | (rest % 0x80));
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
  return out;
}

function encode(struct: Struct): Uint8Array {
  const encoder = new Y.UpdateEncoderV1();
  struct.write(encoder, 0);
  return encoder.toUint8Array();
}

/** Contents Yjs can split at any unit (as it splits items itself). */
const CUTTABLE = [
  Y.ContentString,
  Y.ContentAny,
  Y.ContentJSON,
  Y.ContentDeleted,
];

/** `struct` encoded, or, when it is over `limit` and its content can be
 * cut, encoded runs of it, halved until each fits. */
function cut(struct: Struct, limit: number): Encoded[] {
  const bytes = encode(struct);
  if (
    bytes.byteLength <= limit ||
    !(struct instanceof Y.Item) ||
    struct.length < 2 ||
    !CUTTABLE.some((type) => struct.content instanceof type)
  )
    return [{ bytes, struct }];
  const middle = boundary(struct, Math.floor(struct.length / 2));
  if (middle <= 0 || middle >= struct.length) return [{ bytes, struct }];
  return [
    ...cut(sliceItem(struct, 0, middle), limit),
    ...cut(sliceItem(struct, middle, struct.length), limit),
  ];
}

/** A cut at `at` moved off the middle of a UTF-16 surrogate pair (Yjs would
 * write a replacement character there). */
function boundary(item: Y.Item, at: number): number {
  if (!(item.content instanceof Y.ContentString)) return at;
  const code = item.content.str.charCodeAt(at - 1);
  return code >= 0xd8_00 && code <= 0xdb_ff ? at - 1 : at;
}

/**
 * Units [from, to) of `item` as an item of their own: the first keeps the
 * item's origins (and parent), a later one's origin is the unit before it,
 * its right origin the item's, as Yjs splits an item.
 */
function sliceItem(item: Y.Item, from: number, to: number): Y.Item {
  const { client, clock } = item.id;
  let content = item.content.copy();
  if (from > 0) content = content.splice(from);
  if (to - from < content.getLength()) content.splice(to - from);
  return new Y.Item(
    Y.createID(client, clock + from),
    null,
    from > 0 ? Y.createID(client, clock + from - 1) : item.origin,
    null,
    item.rightOrigin,
    item.parent,
    item.parentSub,
    content
  );
}
