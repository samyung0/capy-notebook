import { api } from '@/api/client';
import type { SourceCollaborationToken, SourceSession } from '@/api/types';
import { clearOfficeMarks, officeMark } from '@/lib/officeMarks';
import { cacheSource, readCachedSource } from '@/lib/sourceCache';
import { retireUndoPayloads, sawRoom } from '@/lib/undoPayloads';
import { warmSourceSocket } from './sourceProvider';

export type SourceOpenMode = 'view' | 'edit';

/**
 * What opening a source reads from the network for one mode: the session
 * (View: the lock-free read; Edit: the editing session and its room token),
 * then the base bytes as soon as the session names them.
 */
export interface SourceOpen {
  /** The base bytes; rejects with the download's failure. */
  base: Promise<Uint8Array<ArrayBuffer>>;
  /** Edit only. */
  credentials?: SourceCollaborationToken;
  session: SourceSession;
}

/** One mode's part of an open; aborting `controller` stops its requests. */
interface Part {
  controller: AbortController;
  open: Promise<SourceOpen>;
}

/** An open the route started that a view or editor has not taken: View for
 * everyone, Edit beside it for an editor, each part taken on its own. */
interface Pending {
  fileId: string;
  parts: Partial<Record<SourceOpenMode, Part>>;
  timer: ReturnType<typeof setTimeout>;
}

/** A started open nobody takes is dropped after this long (a quick switch). */
const PENDING_MS = 30_000;
let pending: Pending | null = null;
/** Files a mounted view shows, by how many views. */
const held = new Map<string, number>();

/** A view shows this file until the returned release: the route starts no
 * open for it meanwhile (its loader runs again on every search change).
 * Leaving the file before Edit took its part drops that part, and with it
 * the download it shared with the view (Q818 A). */
export function holdSource(fileId: string) {
  held.set(fileId, (held.get(fileId) ?? 0) + 1);
  return () => {
    const count = (held.get(fileId) ?? 1) - 1;
    if (count > 0) held.set(fileId, count);
    else {
      held.delete(fileId);
      if (pending?.fileId === fileId) dropPending();
    }
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

/**
 * Starts the parts of one open together (Q608 A). A base one part's session
 * names is downloaded once for every part naming it, and that download stops
 * only once every part has stopped.
 */
function startOpen(fileId: string, modes: readonly SourceOpenMode[]) {
  clearOfficeMarks();
  officeMark('open', { modes: modes.join(',') });
  const download = new AbortController();
  const bases = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();
  let running = modes.length;
  const parts: Partial<Record<SourceOpenMode, Part>> = {};
  for (const mode of modes) {
    const controller = new AbortController();
    const { signal } = controller;
    signal.addEventListener(
      'abort',
      () => {
        running -= 1;
        if (!running) download.abort();
      },
      { once: true }
    );
    const session = api
      .get<SourceSession>(
        `/files/${fileId}/source-session${mode === 'view' ? '?view=true' : ''}`,
        { signal }
      )
      .then((value) => {
        officeMark('session', { mode });
        // A newer epoch retires the file's agent Undo payloads (Q122).
        retireUndoPayloads(value.fileId, value.epoch);
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
              sawRoom(value.room);
              // The room joins on this socket when its editor takes the open.
              warmSourceSocket(value.url);
              return value;
            })
        : undefined;
    // The download starts with the session, not after the token. A session
    // naming no base hash shares nothing.
    const base = session.then((value) => {
      const key = value.baseSourceSHA256;
      const started = key ? bases.get(key) : undefined;
      if (started) return started;
      const bytes = sourceBase(value, download.signal);
      if (key) bases.set(key, bytes);
      return bytes;
    });
    // A caller that stops before awaiting the bytes leaves them unhandled.
    base.catch(() => {});
    const open = Promise.all([session, credentials]).then(([value, token]) => ({
      base,
      credentials: token,
      session: value,
    }));
    // So does a part nobody takes.
    open.catch(() => {});
    parts[mode] = { controller, open };
  }
  return parts;
}

function link(signal: AbortSignal | undefined, controller: AbortController) {
  if (signal?.aborted) controller.abort();
  else
    signal?.addEventListener('abort', () => controller.abort(), {
      once: true,
    });
}

/**
 * Starts opening a file the route knows is an Office file: the View read for
 * everyone and, for an editor, the edit session and room token beside it, for
 * the view or editor that mounts to take. One open waits at a time, so a
 * quick switch drops the earlier one (its download aborts), as does nobody
 * taking it.
 */
export function prefetchSourceOpen(fileId: string, canEdit: boolean) {
  if (held.has(fileId) || pending?.fileId === fileId) return;
  dropPending();
  pending = {
    fileId,
    parts: startOpen(fileId, canEdit ? ['view', 'edit'] : ['view']),
    timer: setTimeout(dropPending, PENDING_MS),
  };
}

function dropPending() {
  if (!pending) return;
  clearTimeout(pending.timer);
  for (const part of Object.values(pending.parts)) part.controller.abort();
  pending = null;
}

/** Another account signed in (or none): the open started for the previous
 * one, its room token included, goes untaken. */
export function dropSourceOpens() {
  dropPending();
}

/** The part the route started for this file and mode, or a new open;
 * aborting `signal` stops it either way. A View take leaves the edit part
 * for Edit pressed within the 30 s; an Edit take drops the View read made at
 * open, so a later View (the room turning read-only, a reopen) reads the
 * saved state afresh (Q818 A). */
export function takeSourceOpen(
  fileId: string,
  mode: SourceOpenMode,
  signal?: AbortSignal
): Promise<SourceOpen> {
  const controller = new AbortController();
  link(signal, controller);
  let part: Part | undefined;
  if (pending?.fileId === fileId) {
    part = pending.parts[mode];
    delete pending.parts[mode];
    if (mode === 'edit' || !pending.parts.edit) dropPending();
  }
  part ??= startOpen(fileId, [mode])[mode]!;
  link(controller.signal, part.controller);
  // A refused session or token stops the download it started.
  part.open.catch(() => controller.abort());
  return part.open;
}

/** A View read of its own, never a part the route started: Download saves
 * the latest saved state (Epo 2026-10-27, Q818 A). */
export function readSourceView(fileId: string): Promise<SourceOpen> {
  return startOpen(fileId, ['view']).view!.open;
}
