/* A chart or graph inserted from the slash menu or toolbar goes into the note
 * at once and its dialog opens on it (Epo 2026-11-16, D15: there is no draft
 * to hold until a Save): the insert names the new element here, and the
 * element opens its dialog as it mounts. */
const opening = new Set<string>();

/** The figure about to be inserted opens its dialog once it mounts. */
export function openOnMount(id: string) {
  opening.add(id);
}

/** Whether the figure was just inserted to be edited. */
export const opensOnMount = (id: string) => opening.has(id);

/** The figure's dialog opened. */
export function openedOnMount(id: string) {
  opening.delete(id);
}
