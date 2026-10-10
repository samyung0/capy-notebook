/**
 * Browser captures of edited Office files for the list cards
 * (openwiki/thumbnails.md, phase 2a). The runtime draws the WebP in its idle
 * time, never on the keystroke or save path; Capy uploads it to Go. Failures
 * are logged once and never retried: the card keeps its old image until the
 * next capture.
 */
import { authHeaders } from '@/api/auth';
import { API_BASE } from '@/api/client';

/** Edits idle this long: draw the capture ahead. */
export const DRAW_AFTER_MS = 5000;
/** Edits idle this long: upload it. */
export const UPLOAD_AFTER_MS = 60_000;
/** Or this long after the first change since the last capture. */
export const UPLOAD_WITHIN_MS = 10 * 60_000;

export interface ThumbnailCaptureOptions {
  /** The room has every edit and the user may edit now. */
  allowed: () => boolean;
  /** The WebP of the document as the editor holds it now; null for nothing to capture. */
  draw: () => Promise<ArrayBuffer | null>;
  upload: (bytes: ArrayBuffer, keepalive: boolean) => Promise<void>;
}

export interface ThumbnailCapture {
  dispose: () => void;
  /** A local edit reached the document. */
  edited: () => void;
  /** The page is hiding or going away: upload what was drawn already. */
  leave: () => void;
}

export function createThumbnailCapture({
  allowed,
  draw,
  upload,
}: ThumbnailCaptureOptions): ThumbnailCapture {
  // Local edits seen, and how many the last capture covered (or gave up on).
  let edits = 0;
  let captured = 0;
  let ready: { bytes: ArrayBuffer; edits: number } | null = null;
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
    const bytes = await draw();
    if (disposed) return null;
    // Nothing to capture (an XLSX on another sheet) ends the cycle quietly.
    if (!bytes) captured = at;
    ready = bytes ? { bytes, edits: at } : null;
    return ready;
  };
  const send = (
    blob: { bytes: ArrayBuffer; edits: number },
    keepalive: boolean
  ) => {
    captured = blob.edits;
    ready = null;
    clearTimeout(deadline);
    deadline = undefined;
    void upload(blob.bytes, keepalive).catch(log);
  };
  const capture = async () => {
    clearTimeout(drawTimer);
    clearTimeout(idleTimer);
    clearTimeout(deadline);
    deadline = undefined;
    if (edits === captured || !allowed()) return;
    try {
      // Fresh after a pause; the 10-minute mark during typing draws now.
      const blob = ready?.edits === edits ? ready : await drawNow();
      if (blob && !disposed && allowed()) send(blob, false);
    } catch (error) {
      fail(error);
    }
  };

  return {
    dispose: () => {
      disposed = true;
      ready = null;
      for (const timer of [drawTimer, idleTimer, deadline]) clearTimeout(timer);
    },
    edited: () => {
      if (disposed) return;
      edits++;
      clearTimeout(drawTimer);
      clearTimeout(idleTimer);
      drawTimer = setTimeout(() => void drawNow().catch(fail), DRAW_AFTER_MS);
      idleTimer = setTimeout(() => void capture(), UPLOAD_AFTER_MS);
      deadline ??= setTimeout(() => void capture(), UPLOAD_WITHIN_MS);
    },
    leave: () => {
      if (ready && edits !== captured && allowed()) send(ready, true);
    },
  };
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

/** POST /api/files/{id}/thumbnail; `keepalive` outlives the page. */
export async function uploadThumbnail(
  fileId: string,
  bytes: ArrayBuffer,
  keepalive: boolean
) {
  const response = await fetch(
    `${API_BASE}/files/${encodeURIComponent(fileId)}/thumbnail`,
    {
      body: bytes,
      headers: { ...(await authHeaders()), 'Content-Type': 'image/webp' },
      keepalive,
      method: 'POST',
    }
  );
  if (!response.ok)
    throw new Error(`Thumbnail capture refused: ${response.status}`);
}
