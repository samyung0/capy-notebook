import { PageClipboard } from '@blocksuite/affine/blocks/root';
import {
  MixTextAdapter,
  pasteMiddleware,
  surfaceRefToEmbed,
  uploadMiddleware,
} from '@blocksuite/affine/shared/adapters';
import { ClipboardAdapterConfigExtension } from '@blocksuite/affine/std';
import {
  BaseAdapter,
  type BlockSnapshot,
  type FromBlockSnapshotPayload,
  type FromDocSnapshotPayload,
  type FromSliceSnapshotPayload,
  type SliceSnapshot,
  type Store,
  type ToBlockSnapshotPayload,
  type ToDocSnapshotPayload,
  type ToSliceSnapshotPayload,
  type TransformerMiddleware,
} from '@blocksuite/affine/store';
import type { BlockSnapshotJson } from '@/features/notes/blocksuite/pasteBlocks';
import { ANSWER_CLIPBOARD_TYPE } from '@/features/workspace/chat/answerClipboard';

/* Paste into the BlockSuite note: our ids rule (D20), our markdown converter
 * for plain text (D17), and a chat answer's own clipboard type. */

/**
 * A pasted block keeps its id while no live block holds it (D20), as
 * `stableElementIds` does on Plate: a block cut and pasted is the same block
 * to comments and to the server. A taken id, or one already used in this
 * paste, gets a fresh one. In place of BlockSuite's `replaceIdMiddleware`,
 * which gives every pasted block a new id.
 */
export const keepIdMiddleware =
  (store: Store): TransformerMiddleware =>
  ({ assetsManager, slots }) => {
    const used = new Set<string>();
    const subscription = slots.beforeImport.subscribe((payload) => {
      if (payload.type !== 'block') return;
      const { snapshot } = payload;
      const original = snapshot.id;
      if (!(store.hasBlock(original) || used.has(original))) {
        used.add(original);
        return;
      }
      snapshot.id = store.workspace.idGenerator();
      used.add(snapshot.id);
      // An image still uploading is looked up by its block's id.
      const uploading = assetsManager.uploadingAssetsMap.get(original);
      if (uploading) {
        assetsManager.uploadingAssetsMap.set(snapshot.id, uploading);
        assetsManager.uploadingAssetsMap.delete(original);
      }
    });
    return () => subscription.unsubscribe();
  };

/** BlockSuite's page clipboard with `keepIdMiddleware` in place of its id
 * replacement; the other middlewares as upstream registers them. */
export class CapyPageClipboard extends PageClipboard {
  protected override _init = () => {
    this._initAdapters();
    const { std } = this;
    const middlewares = [
      pasteMiddleware(std),
      surfaceRefToEmbed(std),
      keepIdMiddleware(std.store),
      uploadMiddleware(std),
    ];
    for (const middleware of middlewares) std.clipboard.use(middleware);
    this._disposables.add({
      dispose: () => {
        for (const middleware of middlewares) std.clipboard.unuse(middleware);
      },
    });
  };
}

/** What the clipboard hands an adapter on paste (`Clipboard.paste`). */
type PastePayload = ToSliceSnapshotPayload<string> & {
  pageId: string;
  workspaceId: string;
};

const pasteBlocks = () => import('@/features/notes/blocksuite/pasteBlocks');

/** A slice of converted blocks, or null when one cannot sit where it would
 * go (a callout holding a code block): the paste then takes the next
 * adapter. */
function slice(
  adapter: BaseAdapter,
  content: BlockSnapshotJson[],
  { pageId, workspaceId }: { pageId: string; workspaceId: string }
): SliceSnapshot | null {
  const { schema } = adapter.job;
  const fits = (block: BlockSnapshotJson, parent: string): boolean =>
    schema.safeValidate(block.flavour, parent) &&
    block.children.every((child) => fits(child, block.flavour));
  if (!content.every((block) => fits(block, 'affine:note'))) return null;
  return {
    content: content as BlockSnapshot[],
    pageId,
    type: 'slice',
    workspaceId,
  };
}

/** Plain text pastes as Markdown through our converter, MDX on as on Plate
 * (D17). Text it cannot convert pastes as BlockSuite's own would. */
export class CapyTextAdapter extends MixTextAdapter {
  override async toSliceSnapshot(
    payload: PastePayload
  ): Promise<SliceSnapshot | null> {
    const markdown = payload.file.replaceAll('\r', '');
    if (!markdown.trim()) return null;
    try {
      const { markdownSnapshots } = await pasteBlocks();
      const converted = slice(this, markdownSnapshots(markdown), payload);
      if (converted) return converted;
    } catch {}
    return super.toSliceSnapshot(payload);
  }
}

/**
 * A chat answer's copy (`application/x-capy-answer`, answerClipboard.ts):
 * its blocks read without MDX, callouts as `affine:callout` with their
 * variant. A copy that does not read leaves the paste to the HTML adapter
 * below it. Inside a code block the code block's own paste runs first.
 */
export class ChatAnswerAdapter extends BaseAdapter<string> {
  async toSliceSnapshot(payload: PastePayload): Promise<SliceSnapshot | null> {
    try {
      const { answerSnapshots } = await pasteBlocks();
      return slice(this, answerSnapshots(payload.file), payload);
    } catch {
      return null;
    }
  }

  // A copy asks every adapter for its type; an empty one is skipped on
  // paste.
  fromBlockSnapshot(_: FromBlockSnapshotPayload) {
    return { assetsIds: [], file: '' };
  }

  fromDocSnapshot(_: FromDocSnapshotPayload) {
    return { assetsIds: [], file: '' };
  }

  fromSliceSnapshot(_: FromSliceSnapshotPayload) {
    return { assetsIds: [], file: '' };
  }

  toBlockSnapshot(_: ToBlockSnapshotPayload<string>): never {
    throw new Error('A chat answer pastes as a slice');
  }

  toDocSnapshot(_: ToDocSnapshotPayload<string>): never {
    throw new Error('A chat answer pastes as a slice');
  }
}

/** Above BlockSuite's own adapters (its snapshot is 100, HTML 90): a chat
 * answer's copy carries HTML and plain text too. */
export const ChatAnswerClipboardConfig = ClipboardAdapterConfigExtension({
  adapter: ChatAnswerAdapter,
  mimeType: ANSWER_CLIPBOARD_TYPE,
  priority: 110,
});

/** In place of BlockSuite's `PlainTextClipboardConfig`, same priority. */
export const TextClipboardConfig = ClipboardAdapterConfigExtension({
  adapter: CapyTextAdapter,
  mimeType: 'text/plain',
  priority: 70,
});
