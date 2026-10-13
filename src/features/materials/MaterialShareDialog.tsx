import { useState } from 'react';
import {
  useUpdateFlashcardSetSharing,
  useUpdateMaterialSharing,
  useUpdateQuizSharing,
} from '@/api/hooks';
import type { MaterialKind, Privacy } from '@/api/types';
import { ShareDialog } from '@/features/workspace/ShareDialog';
import { m } from '@/i18n';

/** Share for a standalone note, quiz or flashcard set, from the Blocks tab's
 * cards and the open material's header. Each kind saves through its own
 * sharing endpoint. */
export function MaterialShareDialog({
  material,
  onClose,
}: {
  material: {
    id: string;
    kind: MaterialKind;
    title: string;
    privacy: Privacy;
    sharePath?: string;
  };
  onClose: () => void;
}) {
  const [privacy, setPrivacy] = useState(material.privacy);
  const { isPending: quizPending, mutateAsync: shareQuiz } =
    useUpdateQuizSharing();
  const { isPending: flashcardsPending, mutateAsync: shareFlashcards } =
    useUpdateFlashcardSetSharing();
  const { isPending: notePending, mutateAsync: shareNote } =
    useUpdateMaterialSharing();
  return (
    <ShareDialog
      link={material.sharePath ?? `/materials/${material.id}`}
      onClose={onClose}
      onPrivacyChange={async (next) => {
        const id = material.id;
        if (material.kind === 'quiz') await shareQuiz({ id, privacy: next });
        else if (material.kind === 'flashcards')
          await shareFlashcards({ id, privacy: next });
        else await shareNote({ id, privacy: next });
        setPrivacy(next);
      }}
      open
      privacy={privacy}
      saving={quizPending || flashcardsPending || notePending}
      title={m.flashcards_share_title({ name: material.title })}
    />
  );
}
