import * as Y from 'yjs';

/* A canvas's early edits renamed in place at the join (Epo 2026-11-19, Q38,
 * "Yes, rename in place"; "make sure this step is invisible, nothing ever
 * reloads, never"): every struct the tab's live Y.Doc holds under a temporary
 * client id (its own, and earlier tabs' late rows') becomes the same struct
 * under the id the room assigned, and every reference to it follows, so the
 * document is unchanged but for those ids. No second document, no remount.
 *
 * Sound only when no conflict in the document was ever settled by comparing
 * a temporary id with another client (Yjs orders concurrent inserts at one
 * place, and picks a map key's value, by client id): every struct under the
 * temporary ids comes after every other struct the document holds, and the
 * temporary ids' sessions form one chain, each painting the whole of the one
 * before (`earlyChain` at the open, `renameRefusal` at the join). Then the
 * rename changes no outcome on any peer, and the new id's clocks run in
 * causal order.
 *
 * Pinned to the internals of Yjs 13.6.31 (renameClient.test.ts fails on an
 * upgrade that moves them):
 * - `doc.store.clients`: Map<client, (Item | GC)[]>, each array contiguous by
 *   clock from 0 (Skip structs never enter a store). The temporary ids'
 *   arrays join under the new id in turn, each continuing at the previous
 *   one's end (its offset).
 * - Each struct's `id`, and each Item's `origin`, `rightOrigin` and `redone`
 *   (`ID`s). Yjs shares ID objects between structs (an Item's `rightOrigin`
 *   may be its right neighbour's `id`), so ids are replaced, never mutated.
 *   An integrated Item's `parent` is its type (an ID only before
 *   integration, in the pending structs, which must be empty); ContentType
 *   holds the type, whose `_item` is the struct, and ContentDoc a guid: no
 *   ids there.
 * - `doc.clientID`, which every new transaction reads.
 * - Y.UndoManager stack items' `insertions` and `deletions` (DeleteSet:
 *   Map<client, {clock, len}[]>), for managers registered with `onRenamed`
 *   (BlockSuite's history on a canvas room, a label editor's own). Their
 *   `meta` holds no ids, and `trackedOrigins` takes the new id (roomStore
 *   `followClientId`, `followTextEditors`).
 * - A RelativePosition's `type` and `item` (`renamePosition`, a text
 *   editor's kept caret).
 * - `store.pendingDs`, the deletions a document holds for structs it lacks
 *   (`withoutClients`).
 */

/** Each renamed client and the clock its structs start at under the new id. */
export type Renamed = ReadonlyMap<number, number>;

type DeleteSet = ReturnType<typeof Y.createDeleteSet>;

const listeners = new WeakMap<
  Y.Doc,
  Set<(renamed: Renamed, to: number) => void>
>();

/** Calls `listener` after each rename of `doc`'s clients, and after each
 * change of its id with nothing renamed (`adoptClientId`, `renamed` empty):
 * what cached a client id or an ID of the document follows it. Returns the
 * undo. */
export function onRenamed(
  doc: Y.Doc,
  listener: (renamed: Renamed, to: number) => void
) {
  let set = listeners.get(doc);
  if (!set) {
    set = new Set();
    listeners.set(doc, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** Gives `doc` the id `to`, renaming nothing: it wrote nothing under the id
 * it had (an early board whose token answered first, `ItemRoom.adopt`; the
 * id a JOIN's token offers, `RoomProvider`). What follows a rename follows
 * this too: an open label editor's own Undo tracks `to`. */
export function adoptClientId(doc: Y.Doc, to: number) {
  if (doc.clientID === to) return;
  doc.clientID = to;
  for (const listener of listeners.get(doc) ?? []) listener(new Map(), to);
}

/** `id` after `renameClients` renamed `renamed` to `to`. */
export function renamedId(id: Y.ID | null, renamed: Renamed, to: number) {
  const offset = id ? renamed.get(id.client) : undefined;
  return id && offset !== undefined ? Y.createID(to, id.clock + offset) : id;
}

/** A temporary session's late rows (Q38): its id, and what it painted
 * before its first edit. */
export interface EarlySession {
  client: number;
  /** The temporary ids it painted, oldest first. */
  earlier: readonly number[];
  /** The document's state vector as it painted (empty when its rows say
   * none: nothing shows it came after anything). */
  state: ReadonlyMap<number, number>;
}

/**
 * The temporary ids of `sessions` the rename may take, in causal order
 * (`chain`, oldest first), and those it may not (`offending`). A session is
 * in the chain when it painted exactly the chain before it, each of those
 * whole, and the whole of everything else `painted` holds (the copy, the rows
 * of sessions under assigned ids). Two tabs that edited before either joined
 * (one of them), one that painted an older copy than the rest, any session
 * that painted an offending one, and a temporary id no session's rows are
 * under, are offending. The order never comes from how the rows are stored
 * (review M1). `painted`: the state vector of everything the document will
 * hold painted.
 */
export function earlyChain(
  painted: ReadonlyMap<number, number>,
  sessions: readonly EarlySession[]
) {
  const temporary = new Set(
    sessions.flatMap(({ client, earlier }) => [client, ...earlier])
  );
  const chain: number[] = [];
  // A later session painted more temporary ids than an earlier one.
  const byLength = [...sessions].sort(
    (a, b) => a.earlier.length - b.earlier.length
  );
  for (const { client, earlier, state } of byLength) {
    const follows =
      earlier.length === chain.length &&
      earlier.every((id, at) => id === chain[at]);
    // What it must have seen whole: all but the temporary ids after it.
    const saw = [...painted].every(
      ([other, clock]) =>
        (temporary.has(other) && !chain.includes(other)) ||
        (state.get(other) ?? 0) >= clock
    );
    if (follows && saw) chain.push(client);
  }
  const offending = [...temporary].filter((client) => !chain.includes(client));
  return { chain, offending };
}

/** `doc`'s state without the structs `clients` wrote, as a document of its
 * own; null when anything else depends on them. Their deletions, which wait
 * there for structs it never takes (`store.pendingDs`), are dropped. */
export function withoutClients(doc: Y.Doc, clients: readonly number[]) {
  const skipped = new Map(
    clients.map((client) => [client, Y.getState(doc.store, client)])
  );
  const rest = new Y.Doc();
  Y.applyUpdate(rest, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(skipped)));
  const { pendingDs, pendingStructs } = rest.store;
  const waiting = pendingDs ? Y.decodeUpdateV2(pendingDs).ds.clients : null;
  if (
    pendingStructs ||
    [...(waiting?.keys() ?? [])].some((client) => !skipped.has(client))
  ) {
    rest.destroy();
    return null;
  }
  rest.store.pendingDs = null;
  return rest;
}

/** The late merge's two documents for writing `offending`'s edits in `all`
 * anew on top of the rest (review M2): `rest`, `all` without them
 * (`withoutClients`), and `old`, `all` with each key's value they hold
 * following the key's value in `rest` (`followHeads`), encoded. `all` is
 * left as it was. Null when the rest depends on them. */
export function mergeInputs(all: Y.Doc, offending: readonly number[]) {
  const rest = withoutClients(all, offending);
  if (!rest) return null;
  const old = new Y.Doc();
  Y.applyUpdate(old, Y.encodeStateAsUpdate(all));
  followHeads(old, offending, rest);
  const update = Y.encodeStateAsUpdate(old);
  old.destroy();
  return { old: update, rest };
}

/** Moves each key whose value in `doc` (a scratch document about to be
 * re-authored by the late merge onto `rest`, `withoutClients`) is one
 * `clients` wrote after the key's value in `rest`, as a write made after
 * everything there would have: the merge keeps a map value's origin, and one
 * beside a value it never saw would stay concurrent with it, settled by
 * client id (review M2). Each of their writes of the key that follows none of
 * theirs takes the head in `rest` as its origin, so the ones after it stay
 * after it and the value Yjs picked stays the key's. A key whose value is
 * another's keeps all as they were: moved, a value that lost would come after
 * the one that beat it and wipe the key (review re-check R1). At the head,
 * their writes are settled by client id, so one that lost to the value in
 * `doc` may come last there and leave the key with no value: the moved
 * document is read back once, and for each key whose value it shows another,
 * the value's first write follows that one (re-check 2, R3). A list's units
 * need nothing: the merge puts each right after the unit it was typed after,
 * so at a spot the rest typed at too, their text comes first (the merge's
 * rule, not Yjs's id order). Reads Items' `parent`, `parentSub` and the parent
 * type's `_map` (Yjs 13.6.31). */
export function followHeads(
  doc: Y.Doc,
  clients: readonly number[],
  rest: Y.Doc
) {
  const roots = new Map<unknown, string>(
    [...doc.share].map(([name, type]) => [type, name])
  );
  /** `type` in `other`, or null when `other` lacks it. */
  const typeIn = (other: Y.Doc, type: Y.AbstractType<unknown>) => {
    const item = type._item;
    if (!item) {
      const name = roots.get(type);
      return name === undefined ? null : (other.share.get(name) ?? null);
    }
    if (!other.store.clients.has(item.id.client)) return null;
    const held = Y.getItem(other.store, item.id);
    return held instanceof Y.Item && held.content instanceof Y.ContentType
      ? held.content.type
      : null;
  };
  const moved = new Set<Y.Item>();
  for (const client of clients)
    for (const struct of doc.store.clients.get(client) ?? []) {
      if (!(struct instanceof Y.Item) || struct.parentSub === null) continue;
      if (struct.origin && clients.includes(struct.origin.client)) continue;
      const parent = struct.parent as Y.AbstractType<unknown>;
      const value = parent._map.get(struct.parentSub);
      if (!value || value.deleted || !clients.includes(value.id.client))
        continue;
      const head = typeIn(rest, parent)?._map.get(struct.parentSub);
      if (!head) continue;
      struct.origin = head.lastId;
      moved.add(value);
    }
  if (!moved.size) return;
  const read = new Y.Doc();
  Y.applyUpdate(read, Y.encodeStateAsUpdate(doc));
  for (const value of moved) {
    const parent = value.parent as Y.AbstractType<unknown>;
    const shown = typeIn(read, parent)?._map.get(value.parentSub as string);
    if (!shown || Y.compareIDs(shown.id, value.id)) continue;
    let first = value;
    while (first.origin && clients.includes(first.origin.client))
      first = Y.getItem(doc.store, first.origin) as Y.Item;
    first.origin = shown.lastId;
  }
  read.destroy();
}

/** What a rename is checked against (`renameRefusal`). */
export interface RenameBase {
  /** The clients the room's confirmed state holds (the device copy the
   * document was painted from): nothing under a temporary id may have left
   * the tab. */
  history: ReadonlySet<number>;
  /** The document's state vector as the tab painted it, before its own
   * first edit: it holds no struct past it but its own (the last temporary
   * id), so no conflict was settled against one the early sessions never
   * saw. */
  painted: ReadonlyMap<number, number>;
}

/** Why renaming `temporary` (oldest first, the tab's own last) to `to` in
 * `doc` would not be sound, or null. */
export function renameRefusal(
  doc: Y.Doc,
  temporary: readonly number[],
  to: number,
  { history, painted }: RenameBase
): string | null {
  const { store } = doc;
  if (store.clients.has(to) || temporary.includes(to))
    return 'the new client id is in the document';
  if (temporary.some((client) => history.has(client)))
    return "a temporary client id is in the room's history";
  if (store.pendingStructs || store.pendingDs)
    return 'the document holds pending updates';
  if (doc._transaction) return 'a transaction is open';
  const own = temporary.at(-1);
  for (const client of store.clients.keys())
    if (
      client !== own &&
      Y.getState(store, client) > (painted.get(client) ?? 0)
    )
      return 'the document holds edits its early sessions never saw';
  return null;
}

/** Renames `temporary`'s structs in `doc` to `to`, in that order (causal:
 * oldest first, the tab's own last), and makes `to` the document's id.
 * Throws when `renameRefusal` names a reason. */
export function renameClients(
  doc: Y.Doc,
  temporary: readonly number[],
  to: number,
  base: RenameBase
): Renamed {
  const refusal = renameRefusal(doc, temporary, to, base);
  if (refusal) throw new Error(`The early edits cannot be renamed: ${refusal}`);
  const { clients } = doc.store;
  const renamed = new Map<number, number>();
  const moved: (Y.Item | Y.GC)[] = [];
  for (const client of temporary) {
    const structs = clients.get(client);
    if (!structs?.length) continue;
    const last = moved.at(-1);
    const offset = last ? last.id.clock + last.length : 0;
    renamed.set(client, offset);
    for (const struct of structs) {
      struct.id = Y.createID(to, struct.id.clock + offset);
      moved.push(struct);
    }
    clients.delete(client);
  }
  if (moved.length) clients.set(to, moved);
  // Every client's: references to a temporary id come from its own structs
  // (nothing under it left the tab), but a walk of all costs 2 ms at 4 MiB.
  for (const structs of clients.values())
    for (const struct of structs) {
      if (!(struct instanceof Y.Item)) continue;
      struct.origin = renamedId(struct.origin, renamed, to);
      struct.rightOrigin = renamedId(struct.rightOrigin, renamed, to);
      struct.redone = renamedId(struct.redone, renamed, to);
    }
  doc.clientID = to;
  for (const listener of listeners.get(doc) ?? []) listener(renamed, to);
  return renamed;
}

/** `manager`'s Undo and Redo after `renameClients`: its stack items' ranges
 * under a renamed client move to `to` at its offset. */
export function renameUndo(
  manager: Y.UndoManager,
  renamed: Renamed,
  to: number
) {
  const follow = (set: DeleteSet) => {
    if (![...set.clients.keys()].some((client) => renamed.has(client)))
      return set;
    const next = Y.createDeleteSet();
    const under = (client: number) => {
      const items = next.clients.get(client) ?? [];
      next.clients.set(client, items);
      return items;
    };
    for (const [client, items] of set.clients) {
      const offset = renamed.get(client);
      if (offset === undefined) under(client).push(...items);
      else
        under(to).push(
          ...items.map(({ clock, len }) => ({ clock: clock + offset, len }))
        );
    }
    // Sorted and merged, as Yjs reads a delete set.
    return Y.mergeDeleteSets([next]);
  };
  for (const item of [...manager.undoStack, ...manager.redoStack]) {
    item.insertions = follow(item.insertions);
    item.deletions = follow(item.deletions);
  }
}

/** A relative position (a text editor's caret, kept by the items around it)
 * after `renameClients`: its ids follow, so it resolves in the document. */
export function renamePosition(
  position: Y.RelativePosition,
  renamed: Renamed,
  to: number
) {
  position.type = renamedId(position.type, renamed, to);
  position.item = renamedId(position.item, renamed, to);
}
