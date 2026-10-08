import { YjsEditor } from '@slate-yjs/core';
import { Editor, Element, Transforms } from 'slate';
import * as Y from 'yjs';
import { openHeadlessEditor } from './editCommands.js';
import { MATERIAL_REF_TYPE } from './materialDocument.js';

/**
 * A material's children (editor assets, embedded quizzes and flashcard sets)
 * are its own (human/authorization-permissions-lifecycles.md, 2026-10-06). A
 * paste, undo, cut and paste, replayed draft or AI Undo is an ordinary update
 * that can write another material's ids, or ids of this material's trashed
 * children. This pass reads the ids an update wrote, asks the API to make each
 * one the material's own (as the user who sent the update, whose access a copy
 * checks), then repoints each node to its own child or drops it.
 */

export const ASSET_KEY = 'assetId';
export const MATERIAL_KEY = 'materialId';

export interface ChildWrites {
  assetIds: string[];
  /** The quiz or flashcard blocks whose materialId the update wrote. */
  blocks: Set<Y.XmlText>;
}

/** The child ids an update wrote, looked up in the document it was applied
 * to: element props are attributes of their Y.XmlText, and only the item in
 * the document knows its key (a decoded overwrite carries none). Typing writes
 * no ContentAny item, so most updates cost a decode and nothing more. */
export function childWrites(
  document: Y.Doc,
  update: Uint8Array
): ChildWrites | null {
  const assetIds = new Set<string>();
  const blocks = new Set<Y.XmlText>();
  for (const struct of Y.decodeUpdate(update).structs) {
    if (!(struct instanceof Y.Item && struct.content instanceof Y.ContentAny))
      continue;
    let item: unknown;
    try {
      item = Y.getItem(document.store, struct.id);
    } catch {
      continue;
    }
    // Gone already (overwritten in the same update, or collected).
    if (
      !(item instanceof Y.Item) ||
      item.deleted ||
      !(item.content instanceof Y.ContentAny)
    )
      continue;
    const value = item.content.arr[0];
    if (typeof value !== 'string' || !value) continue;
    if (item.parentSub === ASSET_KEY) assetIds.add(value);
    else if (
      item.parentSub === MATERIAL_KEY &&
      item.parent instanceof Y.XmlText &&
      item.parent.getAttribute('type') === MATERIAL_REF_TYPE
    )
      blocks.add(item.parent);
  }
  if (!assetIds.size && !blocks.size) return null;
  return { assetIds: [...assetIds], blocks };
}

export interface BlockRequest {
  blockId: string;
  /** Another block keeps this quiz: this one asks for its own copy. */
  copy: boolean;
  materialId: string;
}

export interface ChildPlan {
  assetIds: string[];
  blocks: BlockRequest[];
}

/** What to ask for: every written asset id, and each written quiz block. A
 * quiz now in several blocks stays with one of them, the first that the update
 * did not write (it keeps the original) or else the first in the document;
 * every other block asks for a copy. Blocks are top-level (materialDocument). */
export function planChildren(document: Y.Doc, writes: ChildWrites): ChildPlan {
  const root = document.get('content', Y.XmlText);
  const refs: Array<{ block: Y.XmlText; blockId: string; materialId: string }> =
    [];
  for (const op of root.toDelta() as Array<{ insert: unknown }>) {
    if (!(op.insert instanceof Y.XmlText)) continue;
    const attributes = op.insert.getAttributes() as Record<string, unknown>;
    if (
      attributes.type === MATERIAL_REF_TYPE &&
      typeof attributes.id === 'string' &&
      typeof attributes.materialId === 'string' &&
      attributes.materialId
    )
      refs.push({
        block: op.insert,
        blockId: attributes.id,
        materialId: attributes.materialId,
      });
  }
  const kept = new Map<string, Y.XmlText>();
  for (const ref of refs)
    if (!writes.blocks.has(ref.block) && !kept.has(ref.materialId))
      kept.set(ref.materialId, ref.block);
  for (const ref of refs)
    if (!kept.has(ref.materialId)) kept.set(ref.materialId, ref.block);
  return {
    assetIds: writes.assetIds,
    blocks: refs
      .filter((ref) => writes.blocks.has(ref.block))
      .map((ref) => ({
        blockId: ref.blockId,
        copy: kept.get(ref.materialId) !== ref.block,
        materialId: ref.materialId,
      })),
  };
}

export interface ChildAnswer {
  /** Asset id → the material's own id, or "" to drop its nodes. */
  assets: Map<string, string>;
  /** Block id → the material's own quiz or set, or "" to drop the block. */
  blocks: Map<string, string>;
}

/** Repoints nodes to the material's own children and drops the rest, through
 * a headless editor on the shared root so the change is ordinary Slate
 * operations. Nodes are found by id at apply time: the document may have moved
 * on while the API answered. Returns whether anything changed. */
export function applyChildren(document: Y.Doc, answer: ChildAnswer) {
  const { editor } = openHeadlessEditor(document);
  let changed = false;
  try {
    const targets = [
      ...Editor.nodes(editor, {
        at: [],
        match: (node) => {
          if (!Element.isElement(node)) return false;
          const props = node as unknown as Record<string, unknown>;
          return (
            (typeof props.assetId === 'string' &&
              answer.assets.has(props.assetId) &&
              answer.assets.get(props.assetId) !== props.assetId) ||
            (props.type === MATERIAL_REF_TYPE &&
              typeof props.id === 'string' &&
              answer.blocks.has(props.id) &&
              answer.blocks.get(props.id) !== props.materialId)
          );
        },
      }),
    ];
    if (!targets.length) return false;
    Editor.withoutNormalizing(editor, () => {
      // Last first, so removing one does not shift the paths still to go.
      for (const [node, path] of targets.reverse()) {
        const props = node as unknown as Record<string, string>;
        const to =
          props.type === MATERIAL_REF_TYPE && answer.blocks.has(props.id)
            ? { key: MATERIAL_KEY, value: answer.blocks.get(props.id) }
            : { key: ASSET_KEY, value: answer.assets.get(props.assetId) };
        if (to.value)
          Transforms.setNodes(editor, { [to.key]: to.value }, { at: path });
        else Transforms.removeNodes(editor, { at: path });
        changed = true;
      }
    });
    YjsEditor.flushLocalChanges(editor);
  } finally {
    if (YjsEditor.connected(editor)) YjsEditor.disconnect(editor);
  }
  return changed;
}

/** Ids an answer kept as they are: the material's own children, some just
 * restored from the trash, which open editors load again. */
export function keptIds(plan: ChildPlan, answer: ChildAnswer) {
  return {
    assetIds: plan.assetIds.filter((id) => answer.assets.get(id) === id),
    materialIds: plan.blocks
      .filter((block) => answer.blocks.get(block.blockId) === block.materialId)
      .map((block) => block.materialId),
  };
}

const ASSETS_PER_CALL = 50;
const BLOCKS_PER_CALL = 20;

interface AdoptedChild {
  id: string;
  sourceId: string;
}

/** Asks the API for the material's own child of each planned id, in calls of
 * the route's size. storageRefused: a copy did not fit the payer's storage. */
export async function adoptChildren(
  apiUrl: string,
  secret: string,
  materialId: string,
  actorUserId: string,
  plan: ChildPlan
): Promise<ChildAnswer & { storageRefused: boolean }> {
  const answer = {
    assets: new Map<string, string>(),
    blocks: new Map<string, string>(),
    storageRefused: false,
  };
  const calls = Math.max(
    Math.ceil(plan.assetIds.length / ASSETS_PER_CALL),
    Math.ceil(plan.blocks.length / BLOCKS_PER_CALL)
  );
  for (let call = 0; call < calls; call += 1) {
    const assetIds = plan.assetIds.slice(
      call * ASSETS_PER_CALL,
      (call + 1) * ASSETS_PER_CALL
    );
    const blocks = plan.blocks.slice(
      call * BLOCKS_PER_CALL,
      (call + 1) * BLOCKS_PER_CALL
    );
    const response = await fetch(
      `${apiUrl}/internal/collaboration/materials/${encodeURIComponent(materialId)}/children`,
      {
        body: JSON.stringify({
          actorUserId,
          assetIds,
          materials: blocks.map(({ copy, materialId: id }) => ({
            copy,
            materialId: id,
          })),
        }),
        headers: {
          'content-type': 'application/json',
          'x-collaboration-secret': secret,
        },
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
      }
    );
    if (!response.ok) {
      const body = await response.text();
      throw new Error(
        `children adoption failed (${response.status}): ${body.slice(0, 500)}`
      );
    }
    const result = (await response.json()) as {
      assets: AdoptedChild[];
      materials: AdoptedChild[];
      storageRefused: boolean;
    };
    for (const asset of result.assets)
      answer.assets.set(asset.sourceId, asset.id);
    for (const [index, material] of result.materials.entries())
      answer.blocks.set(blocks[index].blockId, material.id);
    answer.storageRefused ||= result.storageRefused;
  }
  return answer;
}
