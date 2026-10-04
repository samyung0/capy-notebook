import { type Connection, OutgoingMessage } from '@hocuspocus/server';
import * as Y from 'yjs';
import type { OfficeFormat } from './officeRuntime.js';

/**
 * The answer for an update that refers to content the room does not hold,
 * which an honest client sends when the room reloaded without its latest
 * items (an instance died before persisting them) and it types before its
 * sync step 2 arrives: resync the connection (resyncOfficeConnection), never
 * refuse it.
 */
export const OFFICE_UPDATE_UNHELD = 'unheld';

const PPTX_META = 'pptx:meta';
// The one pptx:meta key a remote update may write (comment flavour).
const PPTX_WRITABLE_META_KEY = 'commentFlavor';

/** Where a struct sits: its top-level root and, in a map root, its key. */
interface Container {
  key: string | null;
  root: string;
}
// A reference the room garbage-collected: Yjs drops the struct on integration.
const GONE = 'gone';
// A reference neither the room nor the update holds.
const UNKNOWN = 'unknown';
type Found = Container | typeof GONE | typeof UNKNOWN;

/**
 * What a client update holds that the room does not: the container of each
 * new struct, and whether the room cannot integrate it yet (`unheld`).
 */
function inspectUpdate(document: Y.Doc, update: Uint8Array) {
  const held = (client: number) => Y.getState(document.store, client);
  const rootNames = new Map<unknown, string>();
  for (const [name, type] of document.share) rootNames.set(type, name);
  const { structs, ds } = Y.decodeUpdate(update);
  const incoming = new Map<number, Y.Item[]>();
  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue;
    const items = incoming.get(struct.id.client) ?? [];
    items.push(struct);
    incoming.set(struct.id.client, items);
  }
  // Decoded structs arrive in clock order per client.
  const incomingAt = (id: Y.ID) => {
    const items = incoming.get(id.client) ?? [];
    let low = 0;
    let high = items.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const item = items[middle];
      if (id.clock < item.id.clock) high = middle - 1;
      else if (id.clock >= item.id.clock + item.length) low = middle + 1;
      else return item;
    }
  };
  const heldAt = (id: Y.ID): Found => {
    const struct: Y.AbstractStruct = Y.getItem(document.store, id);
    if (!(struct instanceof Y.Item)) return GONE;
    let top = struct;
    for (
      let parent = top.parent as Y.AbstractType<unknown>;
      parent._item;
      parent = top.parent as Y.AbstractType<unknown>
    )
      top = parent._item;
    const root = rootNames.get(top.parent);
    return root === undefined ? UNKNOWN : { key: top.parentSub, root };
  };
  const resolved = new Map<Y.Item, Found>();
  // Iterative: an update typed character by character chains its origins.
  const containerOf = (start: Y.Item): Found => {
    const chain: Y.Item[] = [];
    let item = start;
    let found: Found;
    while (true) {
      const known = resolved.get(item);
      if (known) {
        found = known;
        break;
      }
      resolved.set(item, UNKNOWN); // a reference cycle stays unknown
      chain.push(item);
      const parent = item.parent as string | Y.ID | null;
      if (typeof parent === 'string') {
        found = { key: item.parentSub, root: parent };
        break;
      }
      const reference = parent ?? item.origin ?? item.rightOrigin;
      if (!reference) {
        found = UNKNOWN;
        break;
      }
      if (reference.clock < held(reference.client)) {
        found = heldAt(reference);
        break;
      }
      const next = incomingAt(reference);
      if (!next) {
        found = UNKNOWN;
        break;
      }
      item = next;
    }
    for (const item of chain) resolved.set(item, found);
    return found;
  };
  // Yjs integrates each client's structs in clock order only, and applies a
  // deletion only once it holds the deleted range: an update that starts past
  // what the room holds of a client (an earlier update of that client never
  // arrived, as when it types at a held position before a reconnect's sync
  // step 2), skips a range, or deletes what neither side holds would stay
  // pending in the room, and a room with pending content cannot be saved.
  let unheld = false;
  const reach = new Map<number, number>();
  for (const struct of structs) {
    const client = struct.id.client;
    const from = reach.get(client) ?? held(client);
    if (struct instanceof Y.Skip || struct.id.clock > from) unheld = true;
    reach.set(client, Math.max(from, struct.id.clock + struct.length));
  }
  for (const [client, ranges] of ds.clients) {
    const until = reach.get(client) ?? held(client);
    if (ranges.some(({ clock, len }) => clock + len > until)) unheld = true;
  }
  const containers: Container[] = [];
  for (const items of incoming.values()) {
    for (const item of items) {
      if (item.id.clock + item.length <= held(item.id.client)) continue;
      const found = containerOf(item);
      if (found === GONE) continue;
      if (found === UNKNOWN) unheld = true;
      else containers.push(found);
    }
  }
  return { containers, ds, unheld };
}

/** Whether a source room cannot integrate `update` yet (see
 * officeUpdateViolation); text rooms resync such updates too. */
export function sourceUpdateUnheld(document: Y.Doc, update: Uint8Array) {
  return inspectUpdate(document, update).unheld;
}

/**
 * Why a client update may not enter an Office room, or null when it may. Each
 * struct the room does not hold yet must sit under one of the engine's
 * document roots (`roots`, the bundle's OFFICE_DOCUMENT_ROOTS), and in PPTX
 * writes and deletions under pptx:meta must stay inside commentFlavor, as the
 * engines require of remote updates. A decoded struct names its root, else
 * its parent item, else a sibling (origin) whose container it shares. An
 * update with no such write that refers to content the room does not hold
 * answers OFFICE_UPDATE_UNHELD.
 */
export function officeUpdateViolation(
  document: Y.Doc,
  update: Uint8Array,
  format: OfficeFormat,
  roots: readonly string[]
): string | null {
  const { containers, ds, unheld } = inspectUpdate(document, update);
  for (const found of containers) {
    if (!roots.includes(found.root))
      return `Office update writes outside the ${format} document roots (${found.root})`;
    if (
      format === 'pptx' &&
      found.root === PPTX_META &&
      found.key !== PPTX_WRITABLE_META_KEY
    )
      return 'Office update writes pptx:meta beyond commentFlavor';
  }
  const meta = format === 'pptx' ? document.share.get(PPTX_META) : undefined;
  const settled = unheld ? OFFICE_UPDATE_UNHELD : null;
  if (!meta || ds.clients.size === 0) return settled;
  const deletes = (item: Y.Item) =>
    (ds.clients.get(item.id.client) ?? []).some(
      (range) =>
        range.clock < item.id.clock + item.length &&
        item.id.clock < range.clock + range.len
    );
  const touches = (type: Y.AbstractType<unknown>): boolean => {
    for (const item of type._map.values()) if (touched(item)) return true;
    for (let item = type._start; item; item = item.right)
      if (touched(item)) return true;
    return false;
  };
  const touched = (item: Y.Item): boolean =>
    !item.deleted &&
    (deletes(item) ||
      (item.content instanceof Y.ContentType && touches(item.content.type)));
  for (const [key, item] of meta._map)
    if (key !== PPTX_WRITABLE_META_KEY && touched(item))
      return 'Office update deletes pptx:meta beyond commentFlavor';
  return settled;
}

const resyncing = new WeakSet<Connection>();
// Consecutive sync step 2 replies of a connection the room could not place.
const unplacedSteps = new WeakMap<Connection, number>();
export const MAX_UNPLACED_STEPS = 2;

/**
 * Resyncs the connection of an unheld update (resyncOfficeConnection). A sync
 * step 2 answers the room's step 1 with everything the client holds beyond
 * it, so one that cannot be placed means the client itself holds content out
 * of order and another resync would loop: after MAX_UNPLACED_STEPS in a row
 * this throws, which closes the connection (it reconnects with backoff, its
 * edits unsent and kept).
 */
export function resyncUnheld(connection: Connection, step2: boolean) {
  const unplaced = step2 ? (unplacedSteps.get(connection) ?? 0) + 1 : 0;
  unplacedSteps.set(connection, unplaced);
  if (unplaced >= MAX_UNPLACED_STEPS)
    throw new Error('source sync step 2 cannot be placed in the room');
  resyncOfficeConnection(connection);
}

/** The connection's update went in: its unplaced count starts over. */
export function placedUpdate(connection: Connection) {
  unplacedSteps.delete(connection);
}

/**
 * Drops the message being handled and sends the connection the room's sync
 * step 1; the client's step 2 reply carries everything the room lacks, the
 * dropped update included. Hocuspocus has no hook that skips one message
 * without closing the connection, so the connection reads as read-only for
 * that message: it is acknowledged unapplied and nothing is integrated.
 * endOfficeResync (afterHandleMessage) makes it writable again.
 */
export function resyncOfficeConnection(connection: Connection) {
  // Already read-only (a handoff writer that answered ready, or one the
  // handoff is closing): Hocuspocus drops the message anyway, the handoff
  // brings the room along, and the connection must stay read-only.
  if (connection.readOnly) return;
  resyncing.add(connection);
  connection.readOnly = true;
  connection.send(
    new OutgoingMessage(connection.messageAddress)
      .createSyncMessage()
      .writeFirstSyncStepFor(connection.document)
      .toUint8Array()
  );
}

export function endOfficeResync(connection: Connection) {
  if (resyncing.delete(connection)) connection.readOnly = false;
}
