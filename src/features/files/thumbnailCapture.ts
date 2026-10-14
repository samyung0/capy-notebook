/**
 * Browser captures of edited Office files for the list cards
 * (openwiki/thumbnails.md, Browser captures). The runtime draws the WebP in its idle
 * time, never on the keystroke or save path; Capy uploads it to Go. An editor
 * opening a file whose card is older than its saved document captures it too.
 * Failures are logged once and never retried: the card keeps its old image
 * until the next capture.
 */
import { authHeaders } from '@/api/auth';
import { API_BASE } from '@/api/client';

/** Edits idle this long: draw the capture ahead. */
export const DRAW_AFTER_MS = 5000;
/** Edits idle this long: upload it. */
export const UPLOAD_AFTER_MS = 60_000;
/** Or this long after the first change since the last capture. */
export const UPLOAD_WITHIN_MS = 10 * 60_000;
/**
 * Captures this size or larger are never sent: Go refuses a 64 KiB body, and
 * a keepalive upload shares a 64 KiB budget.
 */
export const MAX_UPLOAD_BYTES = 65_535;

/** Go refused an upload (`status`: 429 when another capture came first). */
export class ThumbnailUploadRefused extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Thumbnail capture refused: ${status}`);
    this.status = status;
  }
}

/** A drawn capture, with the auth headers fetched when it was drawn. */
export interface DrawnThumbnail {
  bytes: ArrayBuffer;
  /** For an upload as the page goes away, which has no time to fetch them. */
  headers: Record<string, string>;
}

/**
 * A draw that found nothing yet (a DOCX whose edit's layout had not landed):
 * the cycle stays, so the upload's own draw tries again.
 */
export const NOT_DRAWN_YET = 'not-drawn-yet';

export interface ThumbnailCaptureOptions {
  /** The room has every edit and the user may edit now. */
  allowed: () => boolean;
  /** The WebP of the document as the editor holds it now; null for nothing to capture. */
  draw: () => Promise<DrawnThumbnail | null | typeof NOT_DRAWN_YET>;
  upload: (drawn: DrawnThumbnail, keepalive: boolean) => Promise<void>;
}

export interface ThumbnailCapture {
  dispose: () => void;
  /** A local edit reached the document. */
  edited: () => void;
  /** The page is hiding or going away: upload what was drawn already. */
  leave: () => void;
  /**
   * The editor holds the document. When the file's card is older than its
   * saved document (Go's `thumbnailStale`: an agent's edit, an Undo, edits
   * whose browser closed before capturing), capture it now, as after an
   * edit. Only the first call of an open counts.
   */
  opened: (stale: boolean) => void;
  /**
   * An update from elsewhere (another editor, the agent, an Undo) reached the
   * document: a capture drawn before it is dropped, so the next upload draws
   * again. It starts no capture.
   */
  remote: () => void;
}

/** A drawn capture, with the local edits and remote updates it covers. */
type Ready = DrawnThumbnail & { edits: number; remotes: number };

export function createThumbnailCapture({
  allowed,
  draw,
  upload,
}: ThumbnailCaptureOptions): ThumbnailCapture {
  // Local edits seen, and how many the last capture covered (or gave up on).
  let edits = 0;
  let captured = 0;
  // Remote updates seen: a capture drawn before the latest one is stale.
  let remotes = 0;
  let openedSeen = false;
  // The cycle holds only the stale open, no local edit.
  let openedOnly = false;
  let ready: Ready | null = null;
  let drawTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let logged = false;

  const log = (error: unknown) => {
    if (logged) return;
    logged = true;
    console.warn('Thumbnail capture failed:', error);
  };
  // A failed draw ends its cycle (the edits since the last capture): no retry.
  const fail = (error: unknown) => {
    captured = edits;
    ready = null;
    log(error);
  };
  const drawNow = async () => {
    const at = edits;
    const seen = remotes;
    const drawn = await draw();
    // An update from elsewhere during the draw: the drawing may predate it,
    // and the cycle stays for the next upload's draw.
    if (disposed || drawn === NOT_DRAWN_YET || seen !== remotes) return null;
    if (drawn && drawn.bytes.byteLength >= MAX_UPLOAD_BYTES)
      throw new Error(`The capture is ${drawn.bytes.byteLength} bytes`);
    // Nothing to capture (an XLSX on another sheet) ends the cycle quietly.
    if (!drawn) captured = at;
    ready = drawn ? { ...drawn, edits: at, remotes: seen } : null;
    return ready;
  };
  const send = (blob: Ready, keepalive: boolean) => {
    const before = captured;
    captured = blob.edits;
    ready = null;
    clearTimeout(deadline);
    deadline = undefined;
    void upload(blob, keepalive).catch((error: unknown) => {
      // The edits are not captured: the next upload (a pending idle one,
      // the next edit's or leaving) sends them, drawn again when an update
      // from elsewhere came after this drawing. Nothing is retried here.
      // A stale open refused as too soon: another editor just captured the
      // file, and this one has nothing of its own to add, so the cycle ends.
      const takenElsewhere =
        openedOnly &&
        error instanceof ThumbnailUploadRefused &&
        error.status === 429;
      if (captured === blob.edits && !takenElsewhere) {
        captured = before;
        if (blob.remotes === remotes) ready ??= blob;
      }
      log(error);
    });
  };
  const capture = async () => {
    // Saving or paused: the pending timers stay, for a later upload.
    if (edits === captured || !allowed()) return;
    try {
      // Fresh after a pause; the 10-minute mark during typing draws now.
      const blob = ready?.edits === edits ? ready : await drawNow();
      if (blob && !disposed && allowed()) send(blob, false);
    } catch (error) {
      fail(error);
    }
  };

  const change = () => {
    if (disposed) return;
    edits++;
    clearTimeout(drawTimer);
    clearTimeout(idleTimer);
    drawTimer = setTimeout(() => {
      if (edits !== captured) drawNow().catch(fail);
    }, DRAW_AFTER_MS);
    idleTimer = setTimeout(() => void capture(), UPLOAD_AFTER_MS);
    deadline ??= setTimeout(() => {
      deadline = undefined;
      void capture();
    }, UPLOAD_WITHIN_MS);
  };

  return {
    dispose: () => {
      disposed = true;
      ready = null;
      for (const timer of [drawTimer, idleTimer, deadline]) clearTimeout(timer);
    },
    edited: () => {
      openedOnly = false;
      change();
    },
    leave: () => {
      if (ready && edits !== captured && allowed()) send(ready, true);
    },
    opened: (stale) => {
      if (disposed || openedSeen) return;
      openedSeen = true;
      if (!stale) return;
      // One change to capture: uploaded now when the editor may, else by the
      // cycle's idle upload or leaving, as an edit's would be.
      openedOnly = edits === captured;
      change();
      void capture();
    },
    remote: () => {
      remotes++;
      ready = null;
    },
  };
}

/**
 * Tells `capture` the editor holds the document of `session`. Its stale card
 * counts once per session read: the editor can close and open again on the
 * same session (View and back) after that capture landed.
 */
export function openedOn(
  capture: ThumbnailCapture,
  session: { thumbnailStale?: boolean },
  seen: WeakSet<object>
) {
  capture.opened(!!session.thumbnailStale && !seen.has(session));
  seen.add(session);
}

let webp: Promise<boolean> | undefined;

/** Whether this browser encodes WebP from a canvas (Safari does not). */
export function canEncodeWebp(): Promise<boolean> {
  webp ??= (async () => {
    if (typeof OffscreenCanvas !== 'function') return false;
    const canvas = new OffscreenCanvas(1, 1);
    canvas.getContext('2d');
    const blob = await canvas.convertToBlob({ type: 'image/webp' });
    return blob.type === 'image/webp';
  })().catch(() => false);
  return webp;
}

/**
 * POST /api/files/{id}/thumbnail. A `keepalive` upload outlives the page and
 * sends at once with the headers fetched when the capture was drawn; any
 * other fetches fresh ones.
 */
export async function uploadThumbnail(
  fileId: string,
  drawn: DrawnThumbnail,
  keepalive: boolean
) {
  const headers = keepalive ? drawn.headers : await authHeaders();
  const response = await fetch(
    `${API_BASE}/files/${encodeURIComponent(fileId)}/thumbnail`,
    {
      body: drawn.bytes,
      headers: { ...headers, 'Content-Type': 'image/webp' },
      keepalive,
      method: 'POST',
    }
  );
  if (!response.ok) throw new ThumbnailUploadRefused(response.status);
}
