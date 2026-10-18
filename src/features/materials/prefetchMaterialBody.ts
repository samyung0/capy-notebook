import type { QueryClient } from '@tanstack/react-query';
import { materialQuery, materialsQuery } from '@/api/hooks';
import { heavyMaterial } from './heavyDocument';

/**
 * Starts a workspace's open material from its route: the body once the
 * material list arrives (the stored list when the page painted from it) and
 * says the document is not heavy, so it no longer waits for the page to
 * render. A heavy one waits for the reader's choice, as MaterialBody's gate
 * promises: nothing of the document downloads before it.
 */
export function prefetchMaterialBody(
  qc: QueryClient,
  workspaceId: string,
  materialId: string
) {
  qc.ensureQueryData(materialsQuery(workspaceId))
    .then((materials) => {
      if (!heavyMaterial(materials.find((entry) => entry.id === materialId)))
        void qc.prefetchQuery(materialQuery(materialId));
    })
    .catch(() => {
      // The page reads the list itself and shows what fails.
    });
}
