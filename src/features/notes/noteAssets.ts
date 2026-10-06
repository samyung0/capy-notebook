import { YHistoryEditor, YjsEditor } from '@slate-yjs/core';
import { createSlatePlugin, type SlateEditor } from 'platejs';
import { api, qk } from '@/api/client';
import {
  adoptEditorAssets,
  resolveEditorAsset,
  uploadEditorAsset,
} from '@/api/editorAssets';
import { queryClient, showErrorToast } from '@/api/queryClient';
import type {
  AdoptEmbeddedMaterialsReq,
  AdoptEmbeddedMaterialsResp,
} from '@/api/types';
import {
  isMaterialRefElement,
  type MaterialRefElement,
} from '@/features/materials/document';
import { shownAssetUrl } from '@/features/materials/MediaAssetView';
import { deferStorageRefusal } from '@/lib/errors';
import { dropKeptAssets, keepAsset, keptAsset } from '@/lib/localDb';

/**
 * A note's editor assets belong to that note: the server deletes one as soon
 * as a save stops using it, and an asset of another note pasted here must
 * become this note's own copy. So, for this tab's own edits (and their undo
 * and redo), never a collaborator's:
 * - an asset a change removes has its bytes kept in IndexedDB for the
 *   session, so undo, redo or paste can upload it again once it is deleted;
 * - an asset a change inserts is adopted, and its node swapped to the id the
 *   server answers (a copy, or a re-upload of kept bytes). The swap stays out
 *   of the undo history.
 * Quiz and flashcard reference blocks follow the same rule: one a change
 * inserts is adopted too, and points at the note's own copy, or is removed
 * when its original cannot be read. Every block has its own quiz, so when a
 * change leaves one quiz in several blocks, all but one ask for a copy.
 */

/** The parts of a Slate operation that can carry media nodes. */
export interface AssetOperation {
  newProperties?: object | null;
  node?: unknown;
  properties?: object | null;
  type: string;
}

const assetIdOf = (value: unknown) => {
  const id = (value as { assetId?: unknown } | null | undefined)?.assetId;
  return typeof id === 'string' && id ? id : undefined;
};

/** What a removed media node says about its asset, for uploading it again. */
export interface RemovedMedia {
  contentType?: string;
  name?: string;
  type?: string;
}

/** Asset ids a run of operations adds to and removes from the document, net:
 * one removed and inserted again (a move, cut and paste) is in neither.
 * `nodes` holds the media node last seen for each id. `refs` are the material
 * ids of reference blocks it adds, netted the same way; a pending reference
 * has no id yet. */
export function assetChanges(operations: readonly AssetOperation[]) {
  const counts = new Map<string, number>();
  const refCounts = new Map<string, number>();
  const nodes = new Map<string, RemovedMedia>();
  const count = (id: string | undefined, by: number) => {
    if (id) counts.set(id, (counts.get(id) ?? 0) + by);
  };
  const visit = (node: unknown, by: number) => {
    const id = assetIdOf(node);
    if (id) nodes.set(id, node as RemovedMedia);
    count(id, by);
    if (isMaterialRefElement(node) && node.materialId)
      refCounts.set(
        node.materialId,
        (refCounts.get(node.materialId) ?? 0) + by
      );
    const children = (node as { children?: unknown } | null)?.children;
    if (Array.isArray(children)) for (const child of children) visit(child, by);
  };
  for (const operation of operations) {
    if (operation.type === 'insert_node') visit(operation.node, 1);
    else if (operation.type === 'remove_node') visit(operation.node, -1);
    else if (operation.type === 'set_node') {
      count(assetIdOf(operation.properties), -1);
      count(assetIdOf(operation.newProperties), 1);
    }
  }
  const added: string[] = [];
  const removed: string[] = [];
  for (const [id, net] of counts) {
    if (net > 0) added.push(id);
    else if (net < 0) removed.push(id);
  }
  const refs = [...refCounts].filter(([, net]) => net > 0).map(([id]) => id);
  return { added, nodes, refs, removed };
}

/** The upload purpose a media node's asset was stored under. */
export function mediaPurpose({ contentType, type }: RemovedMedia) {
  if (type === 'img') return 'image' as const;
  if (type === 'audio') return 'audio' as const;
  return contentType === 'application/pdf'
    ? ('pdf' as const)
    : ('file' as const);
}

const listeners = new WeakMap<object, (operation: AssetOperation) => void>();

/** Hear the operations of this tab's own edits, undo and redo that may carry
 * assets or quiz and flashcard references. Remote ones (applied through
 * slate-yjs under the provider's origin) and those made without saving to
 * history (a swap) are left out. */
export function listenAssetOperations(
  editor: SlateEditor,
  listener: (operation: AssetOperation) => void
) {
  listeners.set(editor, listener);
  return () => {
    if (listeners.get(editor) === listener) listeners.delete(editor);
  };
}

function ownChange(editor: SlateEditor) {
  if (!(YjsEditor.isYjsEditor(editor) && YjsEditor.connected(editor)))
    return false;
  const origin = YjsEditor.origin(editor);
  // Undo and redo reach Slate as Yjs events whose origin is the UndoManager.
  return (
    origin === editor.localOrigin ||
    (YHistoryEditor.isYHistoryEditor(editor) && origin === editor.undoManager)
  );
}

export const noteAssetsPlugin = createSlatePlugin({
  key: 'capy-note-assets',
}).overrideEditor(({ editor, tf: { apply } }) => ({
  transforms: {
    apply(operation) {
      const listener = listeners.get(editor);
      if (
        listener &&
        (operation.type === 'insert_node' ||
          operation.type === 'remove_node' ||
          (operation.type === 'set_node' &&
            ('assetId' in operation.properties ||
              'assetId' in operation.newProperties))) &&
        ownChange(editor)
      )
        listener(operation);
      apply(operation);
    },
  },
}));

/** Point every node using `from` at `to`, outside the undo history. */
export function swapAssetId(editor: SlateEditor, from: string, to: string) {
  const paths = [
    ...editor.api.nodes({
      at: [],
      match: (node) => assetIdOf(node) === from,
    }),
  ].map(([, path]) => path);
  if (!paths.length) return;
  const swap = () =>
    editor.tf.withoutNormalizing(() => {
      for (const path of paths)
        editor.tf.setNodes({ assetId: to }, { at: path });
    });
  if (YHistoryEditor.isYHistoryEditor(editor))
    YHistoryEditor.withoutSaving(editor, swap);
  else swap();
}

/** A quiz or flashcard reference block, by its block id. */
export interface RefBlock {
  blockId: string;
  materialId: string;
}

/** One adopt request per block whose quiz a change inserted, in document
 * order. A quiz now in several blocks stays with one of them, the first that
 * existed before the change (it keeps its attempts and history) or else the
 * first in the document; every other block asks for a copy. */
export function refAdoptions(
  blocks: readonly RefBlock[],
  existed: ReadonlySet<string>
) {
  const kept = new Map<string, string>();
  for (const { blockId, materialId } of blocks)
    if (existed.has(blockId) && !kept.has(materialId))
      kept.set(materialId, blockId);
  for (const { blockId, materialId } of blocks)
    if (!kept.has(materialId)) kept.set(materialId, blockId);
  return blocks.map((block) => ({
    ...block,
    copy: kept.get(block.materialId) !== block.blockId,
  }));
}

/** Point each reference block at its new material, or remove it when there
 * is none, outside the undo history. Blocks are found by block id: several
 * may share a material id. */
export function repointMaterialRefs(
  editor: SlateEditor,
  targets: ReadonlyMap<string, string | undefined>
) {
  const paths = [
    ...editor.api.nodes<MaterialRefElement>({
      at: [],
      match: (node) => isMaterialRefElement(node) && targets.has(node.id),
    }),
  ].map(([node, path]) => [targets.get(node.id), path] as const);
  if (!paths.length) return;
  const swap = () =>
    editor.tf.withoutNormalizing(() => {
      // Last first, so removing one does not shift the paths still to go.
      for (const [to, path] of paths.reverse()) {
        if (to) editor.tf.setNodes({ materialId: to }, { at: path });
        else editor.tf.removeNodes({ at: path });
      }
    });
  if (YHistoryEditor.isYHistoryEditor(editor))
    YHistoryEditor.withoutSaving(editor, swap);
  else swap();
}

/** Block ids of the reference blocks in the document. */
const refBlockIds = (editor: SlateEditor) =>
  new Set(
    [
      ...editor.api.nodes<MaterialRefElement>({
        at: [],
        match: isMaterialRefElement,
      }),
    ].map(([node]) => node.id)
  );

const LOCK_PREFIX = 'capy-kept-assets:';
let swept = false;

/** A session's kept rows live while it holds its Web Lock; the first session
 * of a page load deletes the rows of sessions no tab holds any more. */
function openSession() {
  const id = crypto.randomUUID();
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  let release = () => {};
  let ready = Promise.resolve();
  if (locks) {
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    ready = new Promise((granted) => {
      void locks.request(`${LOCK_PREFIX}${id}`, () => {
        granted();
        return held;
      });
    });
    if (!swept) {
      swept = true;
      void ready
        .then(async () => {
          const { held = [], pending = [] } = await locks.query();
          const alive = new Set(
            [...held, ...pending].map((lock) =>
              lock.name?.startsWith(LOCK_PREFIX)
                ? lock.name.slice(LOCK_PREFIX.length)
                : ''
            )
          );
          await dropKeptAssets((session) => alive.has(session));
        })
        .catch((error) => console.warn('Kept asset sweep failed:', error));
    }
  }
  return {
    end() {
      release();
      void dropKeptAssets((session) => session !== id).catch((error) =>
        console.warn('Dropping kept assets failed:', error)
      );
    },
    id,
    ready,
  };
}

const FLUSH_MS = 150;
const ADOPT_BATCH = 50;
const ADOPT_REFS_BATCH = 20;

/** Run for an editable note editor's lifetime; returns its cleanup. */
export function watchNoteAssets(editor: SlateEditor, materialId: string) {
  const session = openSession();
  const keeping = new Map<string, Promise<void>>();
  let operations: AssetOperation[] = [];
  // Reference blocks before the batch's first inserted one.
  let refsBefore: Set<string> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  // Right away: the save that follows the edit deletes the asset. An image
  // this tab has shown is read back from the browser's cache under the URL it
  // was shown with (no new link, no download); anything else, such as a PDF
  // or audio that was never fully loaded, is fetched by a fresh link.
  const keep = (assetId: string, node: RemovedMedia | undefined) => {
    const work = (async () => {
      const shown = shownAssetUrl(assetId);
      const asset =
        shown && node?.name ? undefined : await resolveEditorAsset(assetId);
      const response = await fetch(shown ?? asset?.url ?? '', {
        cache: 'force-cache',
      });
      if (!response.ok)
        throw new Error(`Asset download failed: ${response.status}`);
      const contentType = node?.contentType ?? asset?.contentType;
      const blob = (await response.blob()).slice(0, undefined, contentType);
      await session.ready;
      if (disposed) return;
      await keepAsset({
        assetId,
        blob,
        name: node?.name ?? asset?.name ?? assetId,
        purpose: asset?.purpose ?? mediaPurpose(node ?? {}),
        savedAt: Date.now(),
        session: session.id,
      });
    })().catch((error) =>
      console.warn('Keeping a removed asset failed:', error)
    );
    keeping.set(assetId, work);
  };

  const adopt = async (ids: string[]) => {
    for (let start = 0; start < ids.length; start += ADOPT_BATCH) {
      const { assets } = await adoptEditorAssets(
        materialId,
        ids.slice(start, start + ADOPT_BATCH)
      );
      for (const { assetId, sourceId } of assets) {
        if (disposed) return;
        if (assetId === sourceId) continue;
        if (assetId) {
          swapAssetId(editor, sourceId, assetId);
          continue;
        }
        // Gone: upload it again from bytes this session kept, if any.
        await keeping.get(sourceId);
        const kept = await keptAsset(session.id, sourceId).catch(
          () => undefined
        );
        if (!kept) continue;
        const uploaded = await uploadEditorAsset(
          materialId,
          new File([kept.blob], kept.name, { type: kept.blob.type }),
          kept.purpose
        );
        if (!disposed) swapAssetId(editor, sourceId, uploaded.assetId);
      }
    }
  };

  // The note's own quiz keeps its id (a cut and paste in this note) unless
  // the block asks for a copy; another note's becomes this note's copy,
  // images included, and one this user cannot read is removed from the paste.
  const adoptRefs = async (blocks: ReturnType<typeof refAdoptions>) => {
    const body: AdoptEmbeddedMaterialsReq = {
      materials: blocks.map(({ copy, materialId }) => ({ copy, materialId })),
    };
    const { materials } = await api.post<AdoptEmbeddedMaterialsResp>(
      `/materials/${encodeURIComponent(materialId)}/embedded/adopt`,
      body
    );
    if (disposed) return;
    const targets = new Map<string, string | undefined>();
    materials.forEach(({ materialId: adopted }, i) => {
      if (adopted !== blocks[i].materialId)
        targets.set(blocks[i].blockId, adopted);
    });
    repointMaterialRefs(editor, targets);
    if ([...targets.values()].some(Boolean))
      void queryClient.invalidateQueries({ queryKey: qk.ownedMaterialsRoot });
  };

  // Offline, the banner already says so. No retry: the node stays and pasting
  // again tries again.
  const report = (error: unknown) => {
    if (disposed || !navigator.onLine || deferStorageRefusal(error)) return;
    showErrorToast(error);
  };

  const flush = () => {
    timer = undefined;
    const { added, nodes, refs, removed } = assetChanges(operations);
    const existed = refsBefore ?? new Set<string>();
    operations = [];
    refsBefore = undefined;
    for (const id of removed) keep(id, nodes.get(id));
    if (added.length) adopt(added).catch(report);
    if (!refs.length) return;
    const inserted = new Set(refs);
    const blocks = refAdoptions(
      [
        ...editor.api.nodes<MaterialRefElement>({
          at: [],
          match: (node) =>
            isMaterialRefElement(node) && inserted.has(node.materialId),
        }),
      ].map(([node]) => ({ blockId: node.id, materialId: node.materialId })),
      existed
    );
    for (let start = 0; start < blocks.length; start += ADOPT_REFS_BATCH)
      adoptRefs(blocks.slice(start, start + ADOPT_REFS_BATCH)).catch(report);
  };

  const stop = listenAssetOperations(editor, (operation) => {
    // Heard before it applies: the blocks a pasted quiz may share its id with.
    if (
      !refsBefore &&
      operation.type === 'insert_node' &&
      assetChanges([operation]).refs.length
    )
      refsBefore = refBlockIds(editor);
    operations.push(operation);
    timer ??= setTimeout(flush, FLUSH_MS);
  });
  return () => {
    disposed = true;
    clearTimeout(timer);
    stop();
    session.end();
  };
}
