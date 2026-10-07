import { type ComponentType, createContext, lazy } from 'react';
import { Skeleton } from '@/components/ui/feedback';
import type { MaterialRefKind } from '@/features/materials/document';
import { m } from '@/i18n';

export interface EmbedProps {
  materialId: string;
  refKind: MaterialRefKind;
}

/** How a page renders a note's embedded quizzes and flashcard sets in View.
 * The app's own (reading through the account) loads on demand, so a page
 * that brings its own, like the public share page, never downloads it. */
export const EmbedViewContext = createContext<ComponentType<EmbedProps>>(
  lazy(() =>
    import('./AppEmbed').then((mod) => ({ default: mod.AppEmbedView }))
  )
);

export function EmbedLoading() {
  return <Skeleton className="h-40 w-full rounded-card" />;
}

/** The item behind the block is gone (deleted, or not readable here). */
export function EmbedUnavailable() {
  return <p className="t-meta text-fg-muted">{m.material_ref_unavailable()}</p>;
}
