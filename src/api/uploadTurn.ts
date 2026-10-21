import { api } from './client';

/** A gateway upload ticket's answer: its place in line, 0 once its turn has
 * come. */
interface UploadTurn {
  position: number;
  ticketId: string;
}

/** Takes the ticket a gateway upload carries and waits for its turn (Epo
 * 2026-10-22): the gateway runs 32 uploads at once and lines up the rest.
 * The ticket request carries the upload's metadata, so a refused upload
 * never waits; a full line refuses it as busy (`upload_queue_full`). While
 * the ticket waits, each long poll answers once its place changes, and
 * `onQueued` hears every place, 0 when its turn comes. Returns the upload
 * path with its ticket. */
export async function takeUploadTurn(
  uploadPath: string,
  metadata: object,
  signal?: AbortSignal,
  onQueued?: (position: number) => void
): Promise<string> {
  let turn = await api.post<UploadTurn>(`${uploadPath}/tickets`, metadata, {
    signal,
  });
  onQueued?.(turn.position);
  while (turn.position > 0) {
    turn = await api.get<UploadTurn>(
      `/uploads/tickets/${encodeURIComponent(turn.ticketId)}?position=${turn.position}`,
      { signal }
    );
    onQueued?.(turn.position);
  }
  return `${uploadPath}?ticket=${encodeURIComponent(turn.ticketId)}`;
}
