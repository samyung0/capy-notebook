import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '@/api/client';
import type { PDFAnnotation, PDFAnnotationBody } from '@/api/types';

export type AnnotationChanges = {
  create?: (PDFAnnotationBody & { id?: string })[];
  update?: PDFAnnotation[];
  remove?: string[];
};
export function annotationBody(mark: PDFAnnotationBody): PDFAnnotationBody {
  return {
    color: mark.color,
    kind: mark.kind,
    page: mark.page,
    points: mark.points,
    rects: mark.rects,
    sourceIdentity: mark.sourceIdentity,
    text: mark.text,
  };
}

/** Shared so the viewer can start the read as soon as it knows the file is a
 * PDF, instead of after the whole document has downloaded and parsed. */
export const pdfAnnotationsQuery = (fileId: string) =>
  queryOptions({
    meta: { errorBoundary: false },
    queryFn: () => api.get<PDFAnnotation[]>(`/files/${fileId}/annotations`),
    queryKey: ['file', fileId, 'private-annotations'],
  });

/** History records inverse operations, never snapshots of another tab's marks. */
export function usePdfAnnotations(fileId: string, sourceIdentity: string) {
  const cache = useQueryClient();
  const { queryKey } = pdfAnnotationsQuery(fileId);
  const {
    data = [],
    isError: readError,
    isPending: loading,
  } = useQuery(pdfAnnotationsQuery(fileId));
  const history = useRef<{
    undo: AnnotationChanges[];
    redo: AnnotationChanges[];
  }>({ redo: [], undo: [] });
  const busy = useRef(false);
  const [, redrawHistory] = useState(0);
  const {
    mutateAsync,
    isPending,
    isError: writeError,
  } = useMutation({
    mutationFn: async (changes: AnnotationChanges) => {
      let current = cache.getQueryData<PDFAnnotation[]>(queryKey) ?? [];
      const inverse: Required<AnnotationChanges> = {
        create: [],
        remove: [],
        update: [],
      };
      const publish = () => cache.setQueryData(queryKey, [...current]);
      for (const id of changes.remove ?? []) {
        const before = current.find((mark) => mark.id === id);
        if (!before) throw new Error('Annotation changed; reopen the PDF.');
        await api.del(`/files/${fileId}/annotations/${id}`);
        inverse.create.push({ ...annotationBody(before), id: before.id });
        current = current.filter((mark) => mark.id !== id);
        publish();
      }
      for (const mark of changes.update ?? []) {
        const before = current.find((row) => row.id === mark.id);
        if (!before) throw new Error('Annotation changed; reopen the PDF.');
        const updated = await api.patch<PDFAnnotation>(
          `/files/${fileId}/annotations/${mark.id}`,
          annotationBody(mark)
        );
        inverse.update.push(before);
        current = current.map((row) => (row.id === mark.id ? updated : row));
        publish();
      }
      for (const body of changes.create ?? []) {
        const created = await api.post<PDFAnnotation>(
          `/files/${fileId}/annotations`,
          annotationBody(body)
        );
        // Restoring a deleted mark gets a new server ID. Earlier edits still
        // refer to that mark, so keep both history stacks pointing at it.
        if (body.id)
          for (const action of [
            ...history.current.undo,
            ...history.current.redo,
          ]) {
            action.remove = action.remove?.map((id) =>
              id === body.id ? created.id : id
            );
            action.update = action.update?.map((mark) =>
              mark.id === body.id ? { ...mark, id: created.id } : mark
            );
            action.create = action.create?.map((mark) =>
              mark.id === body.id ? { ...mark, id: created.id } : mark
            );
          }
        inverse.remove.push(created.id);
        current = [...current, created];
        publish();
      }
      return inverse;
    },
    onSettled: () => cache.invalidateQueries({ queryKey }),
    scope: { id: `pdf-annotations:${fileId}` },
  });
  async function run(
    changes: AnnotationChanges,
    action: 'change' | 'undo' | 'redo' = 'change'
  ) {
    if (busy.current || loading || readError) return;
    if (!Object.values(changes).some((items) => items.length)) return;
    busy.current = true;
    try {
      const inverse = await mutateAsync(changes);
      if (action === 'change') {
        history.current.undo.push(inverse);
        history.current.redo = [];
      } else {
        history.current[action].pop();
        history.current[action === 'undo' ? 'redo' : 'undo'].push(inverse);
      }
    } catch {
      // A partially completed multi-mark edit has no reliable inverse.
      history.current = { redo: [], undo: [] };
    } finally {
      busy.current = false;
      redrawHistory((value) => value + 1);
    }
  }
  return {
    annotations: data.filter((mark) => mark.sourceIdentity === sourceIdentity),
    canRedo: history.current.redo.length > 0,
    canUndo: history.current.undo.length > 0,
    change: run,
    isPending: isPending || loading,
    isSaving: isPending,
    redo: () => {
      const action = history.current.redo.at(-1);
      if (action) void run(action, 'redo');
    },
    unavailable: readError,
    undo: () => {
      const action = history.current.undo.at(-1);
      if (action) void run(action, 'undo');
    },
    writeError,
  };
}
