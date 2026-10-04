function readVarUint(
  input: Uint8Array,
  offset: { value: number }
): number | null {
  let result = 0;
  let shift = 0;
  while (offset.value < input.length && shift < 35) {
    const byte = input[offset.value++];
    result += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return result;
    shift += 7;
  }
  return null;
}

// Hocuspocus accepts writable Yjs updates in both sync-step-2 and update
// messages. Return their update body so every writable frame passes the same
// contributor and document-limit validation before MessageReceiver applies it.
export function inboundYjsUpdate(message: Uint8Array): Uint8Array | null {
  return inboundYjsSync(message)?.update ?? null;
}

/** A writable Yjs frame's update and whether it is a sync step 2 (a
 * client's reply to the room's step 1) rather than an incremental update. */
export function inboundYjsSync(
  message: Uint8Array
): { step2: boolean; update: Uint8Array } | null {
  const offset = { value: 0 };
  const documentNameLength = readVarUint(message, offset);
  if (
    documentNameLength === null ||
    documentNameLength > message.length - offset.value
  ) {
    return null;
  }
  offset.value += documentNameLength;
  const messageType = readVarUint(message, offset);
  if (messageType !== 0 && messageType !== 4) return null;

  const syncMessageType = readVarUint(message, offset);
  if (syncMessageType !== 1 && syncMessageType !== 2) return null;

  const updateLength = readVarUint(message, offset);
  if (updateLength === null || updateLength > message.length - offset.value) {
    return null;
  }
  return {
    step2: syncMessageType === 1,
    update: message.slice(offset.value, offset.value + updateLength),
  };
}

// Read-only Hocuspocus connections may send sync-step-2 as an acknowledgement
// of state they already received. Mirror MessageReceiver's distinction so a
// no-op sync succeeds while a frame containing client changes is rejected.
export function yjsUpdateContainsChanges(
  document: Y.Doc,
  update: Uint8Array
): boolean {
  // Read from the update against the room, O(update), instead of a snapshot
  // of the whole room (O(structs)): a struct past what the room holds, or a
  // deletion of anything the room holds alive or does not hold, is a change.
  const held = (client: number) => Y.getState(document.store, client);
  const { ds, structs } = Y.decodeUpdate(update);
  for (const struct of structs)
    if (struct.id.clock + struct.length > held(struct.id.client)) return true;
  for (const [client, ranges] of ds.clients)
    for (const { clock, len } of ranges)
      for (let at = clock; at < clock + len; ) {
        if (at >= held(client)) return true;
        const struct = Y.getItem(document.store, Y.createID(client, at));
        if (struct instanceof Y.Item && !struct.deleted) return true;
        at = struct.id.clock + struct.length;
      }
  return false;
}

import * as Y from 'yjs';
