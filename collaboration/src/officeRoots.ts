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
  let unheld = false;
  for (const items of incoming.values()) {
    for (const item of items) {
      if (item.id.clock + item.length <= held(item.id.client)) continue;
      const found = containerOf(item);
      if (found === GONE) continue;
      if (found === UNKNOWN) {
        unheld = true;
        continue;
      }
      if (!roots.includes(found.root))
        return `Office update writes outside the ${format} document roots (${found.root})`;
      if (
        format === 'pptx' &&
        found.root === PPTX_META &&
        found.key !== PPTX_WRITABLE_META_KEY
      )
        return 'Office update writes pptx:meta beyond commentFlavor';
    }
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
