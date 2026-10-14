import type { Descendant } from 'platejs';
import { createPlatePlugin } from 'platejs/react';
import { userToast } from '@/components/ui/userToast';
import { parseEmbeddedFence } from '@/features/materials/blocks';
import {
  isMaterialRefElement,
  type MaterialRefKind,
  materialRefNode,
} from '@/features/materials/document';
import { validateQuestions } from '@/features/questions/validation';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import { type NoteEmbedDraft, noteBlockDialogs } from './blocks/dialogContext';
import { holdInsertPlace, type NoteEditorInstance } from './insertEditorNode';

/* Imported markdown's quiz and flashcards fences become references only once
 * their rows exist, before anything enters the note's document (live-items
 * REVIEW5): a fence body holds the answer keys, and the document reaches
 * every reader, live or through the stored note. The collaboration server
 * refuses a reference that still carries one. */

type CreateEmbedded = (
  kind: MaterialRefKind,
  body: string
) => Promise<{ id: string }>;

function holdsPending(nodes: Descendant[]): boolean {
  return nodes.some(
    (node) =>
      (isMaterialRefElement(node) && typeof node.pending === 'string') ||
      ('children' in node && holdsPending(node.children as Descendant[]))
  );
}

/** `nodes` with each pending reference pointed at a row created for its
 * fence; one whose row cannot be created is left out. */
export async function resolvePendingRefs(
  nodes: Descendant[],
  create: CreateEmbedded
): Promise<Descendant[]> {
  const resolve = async (node: Descendant): Promise<Descendant | null> => {
    if (isMaterialRefElement(node) && typeof node.pending === 'string') {
      try {
        const material = await create(node.refKind, node.pending);
        return materialRefNode(material.id, node.refKind) as Descendant;
      } catch {
        return null;
      }
    }
    if (!('children' in node) || !holdsPending(node.children as Descendant[]))
      return node;
    const children = await resolveAll(node.children as Descendant[]);
    return { ...node, children } as Descendant;
  };
  const resolveAll = async (list: Descendant[]) =>
    (await Promise.all(list.map(resolve))).filter(
      (node): node is Descendant => node !== null
    );
  return resolveAll(nodes);
}

/** The note editor's paste and markdown import: a fragment holding fences
 * goes in where the paste happened once their rows exist (the place held as
 * the toolbar's import holds it); any other fragment goes in at once. */
export const pendingRefsPlugin = createPlatePlugin({
  key: 'capy-pending-refs',
}).overrideEditor(({ editor, tf: { insertFragment } }) => ({
  transforms: {
    insertFragment(fragment, options) {
      if (!holdsPending(fragment)) {
        insertFragment(fragment, options);
        return;
      }
      void insertResolved(editor as NoteEditorInstance, fragment);
    },
  },
}));

/** A fence body as the draft its row is created from. One that does not
 * read is dropped with a toast saying so; a refused create toasts as any
 * failed mutation does. */
function fenceDraft(kind: MaterialRefKind, body: string): NoteEmbedDraft {
  try {
    const draft = parseEmbeddedFence(kind, body);
    return draft.kind === 'quiz'
      ? { kind: draft.kind, questions: validateQuestions(draft.questions) }
      : draft;
  } catch (cause) {
    userToast({
      description: errorCopy(
        cause,
        kind === 'quiz'
          ? m.editor_quiz_fence_invalid()
          : m.editor_flashcards_fence_invalid()
      ),
      title:
        kind === 'quiz'
          ? m.editor_quiz_not_added()
          : m.editor_flashcards_not_added(),
      variant: 'warning',
    });
    throw cause;
  }
}

/** Imported nodes with their fences as rows under the open note. */
export function resolveImported(nodes: Descendant[]) {
  const dialogs = noteBlockDialogs();
  return resolvePendingRefs(nodes, (kind, body) =>
    dialogs
      ? dialogs.createEmbedded(fenceDraft(kind, body))
      : Promise.reject(new Error('No note editor is open'))
  );
}

/** Inserts `nodes` where the caret is now, once their fences are rows. */
async function insertResolved(editor: NoteEditorInstance, nodes: Descendant[]) {
  if (editor.api.isExpanded()) editor.tf.delete();
  const place = holdInsertPlace(editor, { atCaret: true });
  try {
    const resolved = await resolveImported(nodes);
    if (resolved.length) place.insert(resolved);
  } finally {
    place.release();
  }
}
