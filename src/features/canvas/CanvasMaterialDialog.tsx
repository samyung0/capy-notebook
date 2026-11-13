import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { qk } from '@/api/client';
import { useMaterial } from '@/api/hooks';
import { SimpleDialog } from '@/components/ui/Dialog';
import { EmbedLoading } from '@/features/materials/embeds/EmbedView';

const AppEmbedEdit = lazy(() =>
  import('@/features/materials/embeds/AppEmbed').then((mod) => ({
    default: mod.AppEmbedEdit,
  }))
);

/** A quiz's or set's editor in a dialog, for the account's Canvas page, which has
 * no workspace page to open one in (Epo 2026-11-13, "for edit i think we can show
 * like a dialog"): the editor a note's embed has, each question opening the
 * question dialog. Its saves go through the live rooms, so closing reads the
 * material again for the cards that show it. */
export function CanvasMaterialDialog({
  materialId,
  onClose,
}: {
  materialId: string | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: material } = useMaterial(materialId, { errorBoundary: false });
  const kind =
    material?.kind === 'quiz' || material?.kind === 'flashcards'
      ? material.kind
      : null;
  const close = () => {
    if (materialId) {
      void qc.invalidateQueries({ queryKey: qk.quiz(materialId) });
      void qc.invalidateQueries({ queryKey: qk.material(materialId) });
    }
    onClose();
  };
  return (
    <SimpleDialog onClose={close} open={!!materialId} title={material?.title}>
      {materialId && kind ? (
        <Suspense fallback={<EmbedLoading />}>
          {/* As a canvas card's Edit: with no onEmpty a quiz may lose its last
              question, a set keeps its last card. */}
          <AppEmbedEdit materialId={materialId} refKind={kind} />
        </Suspense>
      ) : (
        <EmbedLoading />
      )}
    </SimpleDialog>
  );
}
