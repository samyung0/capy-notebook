import { HttpResponse, http } from 'msw';
import type {
  ResourceEffect,
  ResourceEffectOperation,
  UndoPayload,
} from '@/api/types';
import { uid } from './db';

/** What each operation's Undo turns it into; Redo is the Undo of an Undo. */
const NEXT: Record<ResourceEffectOperation, ResourceEffectOperation> = {
  created: 'trashed',
  edit_undone: 'edited',
  edited: 'edit_undone',
  restored: 'trashed',
  trashed: 'restored',
};

/** An edit chain's step that is refused, as when its room unloaded after the
 * Redo: Undo, Redo, then the next Undo fails. */
const REFUSED_EDIT_STEP = 2;

const steps = new Map<string, { effect: ResourceEffect; depth: number }>();

/** The Undo payload the server sends with an edit's receipt (a created
 * file's step needs none). */
export function mockUndoPayload(effect: ResourceEffect): UndoPayload | null {
  const edit =
    effect.operation === 'edited' || effect.operation === 'edit_undone';
  if (!edit || !effect.undo) return null;
  return {
    documentId: effect.resource.id,
    epoch: 1,
    mac: 'mock',
    operationId: effect.undo.operationId,
    updates: { content: 'bW9jaw==' },
  };
}

/** Keep an undoable effect the mock stream sent, so its Undo can answer. */
export function rememberUndo(effect: ResourceEffect) {
  if (effect.undo) steps.set(effect.undo.operationId, { depth: 0, effect });
}

/** POST /api/chat/edit-operations/:id/undo, like the server's: the receipt's
 * effect replaces the one undone and carries the next step's undo ref. */
export const mockUndo = http.post(
  '/api/chat/edit-operations/:id/undo',
  ({ params }) => {
    const step = steps.get(String(params.id));
    if (!step)
      return HttpResponse.json(
        { errors: [{ message: 'undo_unavailable' }], status: 409 },
        { status: 409 }
      );
    const { effect, depth } = step;
    const edit =
      effect.operation === 'edited' || effect.operation === 'edit_undone';
    if (edit && depth === REFUSED_EDIT_STEP) {
      steps.delete(String(params.id));
      return HttpResponse.json(
        { errors: [{ message: 'undo_unavailable' }], status: 409 },
        { status: 409 }
      );
    }
    const operationId = uid('op');
    const next: ResourceEffect = {
      ...effect,
      operation: NEXT[effect.operation],
      operationId,
      undo: { operationId, status: 'available' },
    };
    steps.delete(String(params.id));
    steps.set(operationId, { depth: depth + 1, effect: next });
    return HttpResponse.json({
      effect: next,
      kind: 'undo',
      operationId,
      outcome: 'succeeded',
      toolVersion: 1,
      undoPayload: mockUndoPayload(next) ?? undefined,
    });
  }
);
