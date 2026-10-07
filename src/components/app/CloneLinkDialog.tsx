import { useNavigate, useSearch } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { isStorageQuotaError } from '@/api/client';
import {
  useCloneFlashcardSet,
  useCloneMaterial,
  useCloneQuiz,
  useCloneWorkspace,
} from '@/api/hooks';
import { WarningBanner } from '@/components/banners/WarningBanner';
import { ConfirmDialog } from '@/components/ui/Dialog';
import { m } from '@/i18n';
import { cloneLabel, parseCloneTarget } from '@/lib/cloneLink';
import { errorCopy } from '@/lib/errors';

/** The dashboard's `?clone=<kind>:<id>`, which public pages' Clone opens:
 * asks first, shows a refusal (a link viewer cloning a workspace, a full
 * plan) in the dialog, and opens the copy. */
export function CloneLinkDialog() {
  const search = useSearch({ strict: false }) as { clone?: unknown };
  const target = parseCloneTarget(search.clone);
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  // The dialog closes itself when the path changes; opening the copy must not
  // send the user back to the dashboard.
  const leaving = useRef(false);
  const options = { errorToast: false } as const;
  const { isPending: workspacePending, mutateAsync: cloneWorkspace } =
    useCloneWorkspace(options);
  const { isPending: quizPending, mutateAsync: cloneQuiz } =
    useCloneQuiz(options);
  const { isPending: flashcardsPending, mutateAsync: cloneFlashcards } =
    useCloneFlashcardSet(options);
  const { isPending: notePending, mutateAsync: cloneNote } =
    useCloneMaterial(options);
  if (!target) return null;

  const close = () => {
    if (leaving.current) return;
    setError(null);
    void navigate({ replace: true, search: {}, to: '/' });
  };

  async function clone() {
    if (!target) return;
    setError(null);
    leaving.current = true;
    try {
      switch (target.kind) {
        case 'workspace': {
          const { workspace } = await cloneWorkspace(target.id);
          await navigate({
            params: { workspaceId: workspace.id },
            to: '/workspaces/$workspaceId',
          });
          return;
        }
        case 'quiz': {
          const quiz = await cloneQuiz(target.id);
          await navigate({
            params: { quizId: quiz.id },
            to: '/quizzes/$quizId/attempt',
          });
          return;
        }
        case 'flashcards': {
          const set = await cloneFlashcards(target.id);
          await navigate({
            params: { flashcardSetId: set.id },
            to: '/flashcards/$flashcardSetId',
          });
          return;
        }
        case 'note': {
          const note = await cloneNote(target.id);
          await navigate({
            params: { materialId: note.id },
            to: '/materials/$materialId',
          });
          return;
        }
      }
    } catch (err) {
      leaving.current = false;
      setError(
        isStorageQuotaError(err)
          ? m.clone_quota_body()
          : errorCopy(err, m.source_try_again())
      );
    }
  }

  return (
    <ConfirmDialog
      body={m.clone_confirm_body()}
      closeOnConfirm={false}
      confirmLabel={m.action_clone()}
      danger={false}
      isSubmitting={
        workspacePending || quizPending || flashcardsPending || notePending
      }
      onClose={close}
      onConfirm={() => void clone()}
      open
      title={cloneLabel(target.kind)}
    >
      {error && <WarningBanner message={error} />}
    </ConfirmDialog>
  );
}
