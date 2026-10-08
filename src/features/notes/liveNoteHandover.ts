/** The open note editors' hand-over of their live document, by material id.
 * Its own module so View's pane can call it without loading the editor. */
const handovers = new Map<string, () => void>();

/** Registers an open editor's hand-over; returns the unregister. */
export function registerLiveNote(materialId: string, handOver: () => void) {
  handovers.set(materialId, handOver);
  return () => {
    if (handovers.get(materialId) === handOver) handovers.delete(materialId);
  };
}

/** Edit to View: the open editor of this material puts its live document into
 * the cached material, before View renders, so View renders it once. */
export function handOverLiveNote(materialId: string) {
  handovers.get(materialId)?.();
}
