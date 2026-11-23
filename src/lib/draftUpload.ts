import { USE_MSW } from '@/api/auth';

/** How long a draft piece's upload may move no byte before it is cut (round
 * 4, finding 9): a slow upload that keeps moving is never cut. */
export const DRAFT_STALL_MS = 30_000;

/** The slowest uplink a draft piece must still land on, in bytes a second:
 * 8 KB/s (64 kbit/s), half the 128 kbit/s carriers throttle to past a data
 * cap (round 5; Epo 2026-11-23). The collaboration service's
 * `SLOWEST_UPLINK` is the same. */
export const SLOWEST_UPLINK = 8000;

/** How long one `/drafts` request of `bytes` waits for its answer once its
 * upload ended: 30 s plus its bytes at the slowest uplink (round 5, finding
 * 2; Epo 2026-10-25, Q360). The upload's end is the browser's: it counts the
 * bytes handed to the network stack, which may still drain them at that
 * pace, so they have that long to reach the service. */
export function draftSendTimeout(bytes: number) {
  return 30_000 + Math.ceil((bytes * 1000) / SLOWEST_UPLINK);
}

// Statuses whose Response takes no body.
const NO_BODY = new Set([101, 204, 205, 304]);

/**
 * POSTs one draft piece to `/drafts`, resolving its answer, or rejecting
 * when the send failed or was cut (a captive portal, a half-open
 * connection, Q360): its upload moved no byte for DRAFT_STALL_MS, or no
 * answer came `draftSendTimeout` after it ended. fetch tells nothing of an
 * upload's progress, so a slow uplink would be cut mid-piece and its piece
 * sent again for ever (round 4, finding 9); XHR does. Under MSW it goes by
 * fetch within `draftSendTimeout` of its start, as `client.ts` uploads do:
 * the e2e specs stand in for `/drafts` by patching fetch.
 */
export function postDraft(
  url: URL,
  body: Uint8Array<ArrayBuffer>,
  headers: Record<string, string>
): Promise<Response> {
  if (USE_MSW)
    return fetch(url, {
      body,
      headers,
      method: 'POST',
      signal: AbortSignal.timeout(draftSendTimeout(body.byteLength)),
    });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cutAfter = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => xhr.abort(), ms);
    };
    const failed = () => {
      clearTimeout(timer);
      reject(new Error('The draft send failed'));
    };
    xhr.open('POST', url);
    for (const [name, value] of Object.entries(headers))
      xhr.setRequestHeader(name, value);
    // Each byte that goes gives the upload the stall window again; its end
    // starts the answer's wait.
    xhr.upload.onprogress = () => cutAfter(DRAFT_STALL_MS);
    xhr.upload.onload = () => cutAfter(draftSendTimeout(body.byteLength));
    xhr.onload = () => {
      clearTimeout(timer);
      resolve(
        new Response(NO_BODY.has(xhr.status) ? null : xhr.responseText, {
          status: xhr.status,
        })
      );
    };
    xhr.onerror = failed;
    xhr.onabort = failed;
    cutAfter(DRAFT_STALL_MS);
    xhr.send(body);
  });
}
