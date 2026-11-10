import { useQueryClient } from '@tanstack/react-query';
import { linkOptions, useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { updateMaterialBodyTitleMax } from '@/api/gen/validators';
import {
  useCreateFlashcardSet,
  useCreateQuiz,
  useCreateStandaloneNote,
  useDeleteMaterial,
  useUpdateMaterial,
} from '@/api/hooks';
import type { MaterialListItem } from '@/api/types';
import { TrashConfirmDialog } from '@/components/app/TrashConfirmDialog';
import type { MenuItem } from '@/components/ui/Menu';
import { NameFormDialog } from '@/components/ui/NameFormDialog';
import { MaterialShareDialog } from '@/features/materials/MaterialShareDialog';
import { CloneItemDialog } from '@/features/workspace/CloneItemDialog';
import {
  ContentPropertiesDialog,
  downloadMenuItems,
} from '@/features/workspace/ContentActions';
import { toMaterialActionTarget } from '@/features/workspace/contentActionTarget';
import { useAccountFrozen } from '@/features/workspace/WorkspaceHealth';
import { m } from '@/i18n';

/** A block opens itself; an assignee's quiz opens its assignment, as in
 * Recent, since the quiz itself is refused to them while it is open. A canvas
 * has no page of its own: it is its workspace's Canvas tab. */
export function blockLink(item: MaterialListItem) {
  if (item.kind === 'canvas' && item.canvasWorkspaceId)
    return linkOptions({
      params: { workspaceId: item.canvasWorkspaceId },
      search: { panel: 'canvas' },
      to: '/workspaces/$workspaceId',
    });
  if (item.assignmentId && !item.isOwner)
    return linkOptions({
      params: { workspaceId: item.workspaceId },
      search: { assignment: item.assignmentId, study: 'assignments' },
      to: '/workspaces/$workspaceId',
    });
  return linkOptions({
    params: { materialId: item.id },
    to: '/materials/$materialId',
  });
}

/**
 * The Files page's block actions: New block's menu (a standalone note, quiz
 * or flashcard set), each block's menu, and the dialogs those open, hoisted so
 * one instance serves every card. A block another member owns (All files)
 * opens, studies, clones, downloads and shows its properties only.
 */
export function useBlockActions() {
  const navigate = useNavigate();
  const frozen = useAccountFrozen();
  const { mutate: createNote } = useCreateStandaloneNote();
  const { mutate: createQuiz } = useCreateQuiz();
  const { mutate: createFlashcardSet } = useCreateFlashcardSet();
  const newMenu: MenuItem[] = [
    {
      icon: 'newNote',
      label: m.create_kind_note(),
      onClick: () =>
        createNote(
          {},
          {
            onSuccess: (material) =>
              navigate({
                params: { materialId: material.id },
                to: '/materials/$materialId',
              }),
          }
        ),
    },
    {
      icon: 'quiz',
      label: m.editor_quiz(),
      onClick: () =>
        createQuiz(
          { name: m.quiz_untitled(), questions: [] },
          {
            onSuccess: (quiz) =>
              navigate({
                params: { materialId: quiz.id },
                to: '/materials/$materialId',
              }),
          }
        ),
    },
    {
      icon: 'flashcards',
      label: m.editor_flashcards(),
      onClick: () =>
        createFlashcardSet(
          { color: 'purple', name: m.flashcards_new_flashcards() },
          {
            onSuccess: (set) =>
              navigate({
                params: { flashcardSetId: set.id },
                to: '/flashcards/$flashcardSetId',
              }),
          }
        ),
    },
  ];

  const [renaming, setRenaming] = useState<MaterialListItem | null>(null);
  const [sharing, setSharing] = useState<MaterialListItem | null>(null);
  const [deleting, setDeleting] = useState<MaterialListItem | null>(null);
  const [cloning, setCloning] = useState<MaterialListItem | null>(null);
  const [inspecting, setInspecting] = useState<MaterialListItem | null>(null);
  const { mutateAsync: rename } = useUpdateMaterial(
    renaming?.workspaceId ?? ''
  );
  const { mutate: deleteMaterial } = useDeleteMaterial(
    deleting?.workspaceId ?? ''
  );

  const queryClient = useQueryClient();
  // Stable while `frozen` holds, so the memoised cards skip a pick's render.
  const menuFor = useCallback(
    (item: MaterialListItem): MenuItem[] => {
      const remove: MenuItem = {
        danger: true,
        icon: 'trash',
        label: m.action_delete(),
        onClick: () => setDeleting(item),
      };
      // In a workspace the viewer left it can only be deleted (it still pays).
      if (item.lostAccess) return [remove];
      const owner = !!item.isOwner;
      // An assignee's quiz only opens its assignment.
      if (item.assignmentId && !owner)
        return [
          {
            icon: 'navigationForward',
            label: m.assignment_open(),
            onClick: () => navigate(blockLink(item)),
          },
        ];
      // A canvas is personal: opened in its workspace, or deleted, and nothing
      // else (no sharing, cloning or renaming; Epo 2026-11-09).
      if (item.kind === 'canvas')
        return [
          {
            icon: 'navigationForward',
            label: m.action_open(),
            onClick: () => navigate(blockLink(item)),
          },
          ...(owner ? [remove] : []),
        ];
      const items: MenuItem[] = [];
      if (item.kind === 'quiz') {
        items.push({
          icon: 'quiz',
          label: m.action_study(),
          onClick: () =>
            navigate({
              params: { quizId: item.id },
              to: '/quizzes/$quizId/attempt',
            }),
        });
      } else if (item.kind === 'flashcards') {
        items.push({
          icon: 'flashcards',
          label: m.action_study(),
          onClick: () =>
            navigate({
              params: { flashcardSetId: item.id },
              to: '/flashcards/$flashcardSetId',
            }),
        });
      }
      if (owner) {
        items.push({
          icon: 'pencil',
          label: m.action_rename(),
          onClick: () => setRenaming(item),
        });
      }
      if (owner && !item.workspaceId) {
        items.push({
          icon: 'link',
          label: m.action_share(),
          onClick: () => setSharing(item),
        });
      }
      items.push({
        disabled: frozen,
        icon: 'clone',
        label: m.action_clone_to(),
        onClick: () => setCloning(item),
      });
      items.push(
        ...downloadMenuItems(
          { id: item.id, kind: item.kind, name: item.title, type: 'material' },
          item.workspaceId || null,
          queryClient
        )
      );
      items.push({
        icon: 'help',
        label: m.content_properties(),
        onClick: () => setInspecting(item),
      });
      if (owner) items.push(remove);
      return items;
    },
    [frozen, navigate, queryClient]
  );

  const dialogs = (
    <>
      <NameFormDialog
        defaultName={renaming?.title ?? ''}
        fieldLabel={m.material_rename()}
        maxLength={updateMaterialBodyTitleMax}
        onClose={() => setRenaming(null)}
        onSubmit={async (title) => {
          if (!renaming) return;
          await rename({ id: renaming.id, patch: { title } });
          setRenaming(null);
        }}
        open={!!renaming}
        title={m.material_rename()}
      />
      {sharing && (
        <MaterialShareDialog
          material={sharing}
          onClose={() => setSharing(null)}
        />
      )}
      {cloning && (
        <CloneItemDialog
          item={{
            id: cloning.id,
            kind: cloning.kind,
            name: cloning.title,
            type: 'material',
            workspaceId: cloning.workspaceId,
          }}
          onClose={() => setCloning(null)}
        />
      )}
      {inspecting && (
        <ContentPropertiesDialog
          content={toMaterialActionTarget(inspecting)}
          onClose={() => setInspecting(null)}
          open
        />
      )}
      <TrashConfirmDialog
        name={deleting?.title ?? ''}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) deleteMaterial(deleting.id);
          setDeleting(null);
        }}
        open={!!deleting}
      />
    </>
  );

  return { dialogs, frozen, menuFor, newMenu };
}
