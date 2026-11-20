import { useQuery, useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { deletedItemOf, qk } from '@/api/client';
import { materialQuery, quizQuery } from '@/api/hooks';
import { SimpleDialog } from '@/components/ui/Dialog';
import {
  isRefusedRead,
  useAccessLostNotice,
} from '@/features/collaboration/accessLostNotice';
import { EmbedLoading } from '@/features/materials/embeds/EmbedView';
import type { CardMaterialKind } from './materialCardHosts';

const AppEmbedEdit = lazy(() =>
  import('@/features/materials/embeds/AppEmbed').then((mod) => ({
    default: mod.AppEmbedEdit,
  }))
);

/** The quiz or set a canvas's dialog edits, as the page already holds it. */
export type DialogMaterial = {
  id: string;
  kind: CardMaterialKind;
  title: string;
};

/** A quiz's or set's editor in a dialog, for the account's Canvas page, which has
 * no workspace page to open one in (Epo 2026-11-13, "for edit i think we can show
 * like a dialog"): the editor a note's embed has, each question opening the
 * question dialog. The page says which kind it is and its title, from its list
 * or from what New just made, so the editor's own reads start as the dialog
 * opens. Its saves go through the live rooms, so closing reads the material
 * again for the cards that show it. */
export function CanvasMaterialDialog({
  material,
  onClose,
}: {
  material: DialogMaterial | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const close = () => {
    if (material) {
      void qc.invalidateQueries({ queryKey: qk.quiz(material.id) });
      void qc.invalidateQueries({ queryKey: qk.material(material.id) });
    }
    onClose();
  };
  return (
    <SimpleDialog onClose={close} open={!!material} title={material?.title}>
      {material && <AccessLostNotice material={material} />}
      {material && (
        <Suspense fallback={<EmbedLoading />}>
          {/* As a canvas card's Edit: with no onEmpty a quiz may lose its last
              question, a set keeps its last card. */}
          <AppEmbedEdit materialId={material.id} refKind={material.kind} />
        </Suspense>
      )}
    </SimpleDialog>
  );
}

/** Kicked from the quiz or set the dialog edits (Epo 2026-11-20): its room
 * refused this person, then the editor's read did too (`AppEmbedEdit`'s gate,
 * which the room's refusal read again). The editor says it is unavailable;
 * the toast says they lost access and the lists read again. Reads nothing
 * itself. */
function AccessLostNotice({ material }: { material: DialogMaterial }) {
  const { error: quizError } = useQuery({
    ...quizQuery(material.id),
    enabled: false,
  });
  const { error: setError } = useQuery({
    ...materialQuery(material.id),
    enabled: false,
  });
  const error = material.kind === 'quiz' ? quizError : setError;
  useAccessLostNotice(
    false,
    material.id,
    isRefusedRead(error) && !deletedItemOf(error),
    null
  );
  return null;
}
