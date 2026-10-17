import { api } from '@/api/client';
import type { SourceCollaborationToken, SourceSession } from '@/api/types';
import { clearOfficeMarks, officeMark } from '@/lib/officeMarks';
import { cacheSource, readCachedSource } from '@/lib/sourceCache';
import { warmSourceSocket } from './sourceProvider';

export type SourceOpenMode = 'view' | 'edit';

/**
 * What opening a source reads from the network, started as one unit: the
 * session (View: the lock-free read; Edit: the editing session and its room
 * token), then the base bytes as soon as the session names them.
 */
export interface SourceOpen {
  /** The base bytes; rejects with the download's failure. */
  base: Promise<Uint8Array<ArrayBuffer>>;
  /** Edit only. */
  credentials?: SourceCollaborationToken;
  session: SourceSession;
}

/** An open the route started for a view or editor that has not taken it. */
interface Pending {
  controller: AbortController;
  fileId: string;
  mode: SourceOpenMode;
  open: Promise<SourceOpen>;
  timer: ReturnType<typeof setTimeout>;
}

/** A started open nobody takes is dropped after this long (a quick switch). */
const PENDING_MS = 30_000;
let pending: Pending | null = null;
/** Files a mounted view shows, by how many views. */
const held = new Map<string, number>();

/** A view shows this file until the returned release: the route starts no
 * open for it meanwhile (its loader runs again on every search change). */
export function holdSource(fileId: string) {
  held.set(fileId, (held.get(fileId) ?? 0) + 1);
  return () => {
    const count = (held.get(fileId) ?? 1) - 1;
    if (count > 0) held.set(fileId, count);
    else held.delete(fileId);
  };
}

/** The base bytes: this device's copy when it still hashes to the session's
 * base, else the download, kept for the next open. */
async function sourceBase(
  session: SourceSession,
  signal?: AbortSignal
): Promise<Uint8Array<ArrayBuffer>> {
  const cached = await readCachedSource(session.baseSourceSHA256);
  if (cached) {
    officeMark('base', { bytes: cached.byteLength, cached: true });
    return cached;
  }
  const response = await fetch(session.sourceURL, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  officeMark('base', { bytes: bytes.byteLength, cached: false });
  void cacheSource(session.baseSourceSHA256, bytes);
  return bytes;
}

function startOpen(
  fileId: string,
  mode: SourceOpenMode,
  signal: AbortSignal
): Promise<SourceOpen> {
  clearOfficeMarks();
  officeMark('open', { mode });
  const session = api
    .get<SourceSession>(
      `/files/${fileId}/source-session${mode === 'view' ? '?view=true' : ''}`,
      { signal }
    )
    .then((value) => {
      officeMark('session', { mode });
      return value;
    });
  const credentials =
    mode === 'edit'
      ? api
          .post<SourceCollaborationToken>(
            `/files/${fileId}/collaboration-token`,
            {},
            { signal }
          )
          .then((value) => {
            officeMark('token');
            // The room joins on this socket when its editor takes the open.
            warmSourceSocket(value.url);
            return value;
          })
      : undefined;
  // The download starts with the session, not after the token.
  const base = session.then((value) => sourceBase(value, signal));
  // A caller that stops before awaiting the bytes leaves them unhandled.
  base.catch(() => {});
  return Promise.all([session, credentials]).then(([value, token]) => ({
    base,
    credentials: token,
    session: value,
  }));
}

function link(signal: AbortSignal | undefined, controller: AbortController) {
  if (signal?.aborted) controller.abort();
  else
    signal?.addEventListener('abort', () => controller.abort(), {
      once: true,
    });
}

/**
 * Starts opening a file the route knows is an Office file, for the view or
 * editor that will mount for it; one open waits at a time, so a quick switch
 * drops the earlier one (its download aborts), as does nobody taking it.
 */
export function prefetchSourceOpen(fileId: string, mode: SourceOpenMode) {
  if (held.has(fileId) || (pending?.fileId === fileId && pending.mode === mode))
    return;
  dropPending();
  const controller = new AbortController();
  const open = startOpen(fileId, mode, controller.signal);
  open.catch(() => {});
  pending = {
    controller,
    fileId,
    mode,
    open,
    timer: setTimeout(dropPending, PENDING_MS),
  };
}

function dropPending() {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending.controller.abort();
  pending = null;
}

/** The open the route started for this file and mode, or a new one; aborting
 * `signal` stops it either way. One the route started for the file in the
 * other mode (it guessed Edit, the view opens in View) is dropped, so the
 * file never downloads twice in parallel. */
export function takeSourceOpen(
  fileId: string,
  mode: SourceOpenMode,
  signal?: AbortSignal
): Promise<SourceOpen> {
  const controller = new AbortController();
  link(signal, controller);
  let open: Promise<SourceOpen>;
  if (pending?.fileId === fileId && pending.mode !== mode) dropPending();
  if (pending?.fileId === fileId && pending.mode === mode) {
    const taken = pending;
    clearTimeout(taken.timer);
    pending = null;
    link(controller.signal, taken.controller);
    open = taken.open;
  } else open = startOpen(fileId, mode, controller.signal);
  // A refused session or token stops the download it started.
  open.catch(() => controller.abort());
  return open;
}
