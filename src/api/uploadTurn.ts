import { api } from './client';

/** A gateway upload ticket's answer: its place in line, 0 once its turn has
 * come. */
interface UploadTurn {
  position: number;
  ticketId: string;
}

/** The abort reason of an upload the user removed (removeSourceTransfer):
 * its ticket is given back as removed, so its batch counts it as removed. */
export const uploadRemoved = new DOMException(
  'The upload was removed.',
  'AbortError'
);

/** Uploads through the gateway's line (Epo 2026-10-22): the gateway runs
 * uploads while their declared sizes fit its budget and lines up the rest,
 * and an upload past the user's upload rate class waits in the line too
 * instead of a 429 (Q282), so the browser never retries one. The ticket
 * request carries the upload's metadata, which the upload must repeat, so a
 * refused upload never waits; a full line refuses it as busy
 * (`upload_queue_full`). While the ticket waits, each long poll answers once
 * its place changes, and `onQueued` hears every place, 0 when its turn comes;
 * then `send` uploads with the ticketed path. When waiting or the upload
 * fails, the ticket is given back first, so its place goes to the next one;
 * once the upload has spent it, giving it back is a harmless 410. */
export async function uploadWithTicket<T>(
  uploadPath: string,
  metadata: object,
  send: (path: string) => Promise<T>,
  {
    onQueued,
    signal,
  }: {
    onQueued?: (position: number) => void;
    signal?: AbortSignal;
  } = {}
): Promise<T> {
  if (signal?.aborted) throw signal.reason;
  // The ticket request is not aborted: a ticket the gateway issued is given
  // back once it answers (below), so the caller always knows, by `onQueued`,
  // whether the gateway holds one.
  let turn = await api.post<UploadTurn>(`${uploadPath}/tickets`, metadata);
  const ticket = `/uploads/tickets/${encodeURIComponent(turn.ticketId)}`;
  try {
    onQueued?.(turn.position);
    if (signal?.aborted) throw signal.reason;
    while (turn.position > 0) {
      turn = await api.get<UploadTurn>(`${ticket}?position=${turn.position}`, {
        signal,
      });
      onQueued?.(turn.position);
    }
    return await send(
      `${uploadPath}?ticket=${encodeURIComponent(turn.ticketId)}`
    );
  } catch (error) {
    // A ticket left behind would hold its place, or its turn, until the turn
    // passed; a failed give-back only leaves it to that. A file the user
    // removed counts as removed in its batch, any other give-up as failed.
    const reason = signal?.reason === uploadRemoved ? '?reason=removed' : '';
    await api.del(ticket + reason).catch(() => undefined);
    throw error;
  }
}
