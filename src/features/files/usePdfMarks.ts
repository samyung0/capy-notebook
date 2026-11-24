import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/api/client';
import type { PDFAnnotationChanges, PDFAnnotationList } from '@/api/types';
import { isStorageRefusal } from '@/lib/errors';
import {
  applyChange,
  type Mark,
  type MarkChange,
  normalizeMark,
} from './pdfMarks';

/** Shared so the viewer can start the read as soon as it knows the file is a
 * PDF, instead of after the whole document has downloaded and parsed. */
export const pdfAnnotationsQuery = (fileId: string) =>
  queryOptions({
    meta: { errorBoundary: false },
    queryFn: () => api.get<PDFAnnotationList>(`/files/${fileId}/annotations`),
    queryKey: ['file', fileId, 'private-annotations'],
  });

type Step = { before: MarkChange; after: MarkChange };

/** How long the queue waits for more edits before it saves. */
const SAVE_DELAY_MS = 400;
/** One request's share of the queue, under the server's 4 MB and 200 marks. */
const BATCH_BYTES = 3_000_000;
const BATCH_MARKS = 200;
const BATCH_REMOVES = 2000;
const EMPTY: Mark[] = [];

function* batches(queue: MarkChange, sourceIdentity: string) {
  let body: PDFAnnotationChanges = { remove: [], save: [], sourceIdentity };
  let bytes = 0;
  for (const [id, mark] of queue) {
    const size = mark ? JSON.stringify(mark).length : 0;
    if (
      (mark &&
        (body.save.length === BATCH_MARKS || bytes + size > BATCH_BYTES)) ||
      body.remove.length === BATCH_REMOVES
    ) {
      yield body;
      body = { remove: [], save: [], sourceIdentity };
      bytes = 0;
    }
    if (mark) {
      body.save.push(mark);
      bytes += size;
    } else body.remove.push(id);
  }
  if (body.save.length || body.remove.length) yield body;
}

/** The viewer's marks, drawn and changed at once (D1): edits queue and save
 * together in the background, so drawing never waits on a request (Zotero's
 * reader). History holds each edit's marks before and after. A failed save
 * drops the queue and history, and the marks go back to the saved ones. */
export function usePdfMarks(fileId: string, sourceIdentity: string) {
  const cache = useQueryClient();
  const { queryKey } = pdfAnnotationsQuery(fileId);
  const {
    data,
    isError: readError,
    isPending: loading,
  } = useQuery(pdfAnnotationsQuery(fileId));
  // Marks saved on other bytes (the file changed under the viewer) draw nothing
  // and take no edits; the viewer remounts on the new revision.
  const otherBytes = !!data && data.sourceIdentity !== sourceIdentity;
  const saved = data && !otherBytes ? data.marks : EMPTY;
  // A read cached from older bytes is fetched again, once.
  useEffect(() => {
    if (otherBytes) void cache.invalidateQueries({ queryKey });
  }, [otherBytes]);
  // Local marks once edited; until then the saved ones.
  const [edited, setEdited] = useState<Mark[] | null>(null);
  const marks = edited ?? saved;
  const latest = useRef(marks);
  latest.current = marks;
  const queue = useRef<MarkChange>(new Map());
  const timer = useRef(0);
  const inFlight = useRef(false);
  const history = useRef<{ undo: Step[]; redo: Step[] }>({
    redo: [],
    undo: [],
  });
  const [saving, setSaving] = useState(false);
  const [wrote, setWrote] = useState(false);
  const [writeFailure, setWriteFailure] = useState<unknown>(null);
  const [, redrawHistory] = useState(0);

  async function flush() {
    window.clearTimeout(timer.current);
    if (inFlight.current || !queue.current.size) return;
    const sending = queue.current;
    queue.current = new Map();
    inFlight.current = true;
    try {
      for (const body of batches(sending, sourceIdentity))
        await api.patch(`/files/${fileId}/annotations`, body);
      setWriteFailure(null);
      setWrote(true);
      // The saved marks take what this request sent, not edits queued since.
      cache.setQueryData<PDFAnnotationList>(
        queryKey,
        (prev) => prev && { ...prev, marks: applyChange(prev.marks, sending) }
      );
    } catch (error) {
      queue.current = new Map();
      history.current = { redo: [], undo: [] };
      setWriteFailure(error);
      setEdited(null);
      void cache.invalidateQueries({ queryKey });
    } finally {
      inFlight.current = false;
      if (queue.current.size) void flush();
      else setSaving(false);
    }
  }
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // What is queued saves at once when the viewer closes or the tab hides.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') void flushRef.current();
    };
    document.addEventListener('visibilitychange', hidden);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      void flushRef.current();
    };
  }, []);

  function apply(change: MarkChange) {
    const next = applyChange(latest.current, change);
    latest.current = next;
    setEdited(next);
    for (const [id, mark] of change) queue.current.set(id, mark);
    setSaving(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(
      () => void flushRef.current(),
      SAVE_DELAY_MS
    );
  }

  const ready = !loading && !readError && !otherBytes;
  /** Records an edit in history and queues its save. */
  function commit(edit: MarkChange) {
    if (!ready || !edit.size) return;
    const change: MarkChange = new Map();
    for (const [id, mark] of edit) change.set(id, mark && normalizeMark(mark));
    const before: MarkChange = new Map();
    for (const id of change.keys())
      before.set(id, latest.current.find((mark) => mark.id === id) ?? null);
    history.current.undo.push({ after: change, before });
    history.current.redo = [];
    apply(change);
    redrawHistory((n) => n + 1);
  }
  function travel(from: 'undo' | 'redo') {
    if (!ready) return;
    const step = history.current[from].pop();
    if (!step) return;
    history.current[from === 'undo' ? 'redo' : 'undo'].push(step);
    apply(from === 'undo' ? step.before : step.after);
    redrawHistory((n) => n + 1);
  }

  return {
    canRedo: history.current.redo.length > 0,
    canUndo: history.current.undo.length > 0,
    commit,
    marks,
    ready,
    redo: () => travel('redo'),
    saving,
    undo: () => travel('undo'),
    // A frozen or storage refusal shows as the workspace status, not a strip.
    writeError: !!writeFailure && !isStorageRefusal(writeFailure),
    wrote,
  };
}
