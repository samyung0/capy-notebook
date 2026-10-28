import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { getInternalStoreExtensions } from '@blocksuite/affine/extensions/store';
import { NoopLogger } from '@blocksuite/affine/global/utils';
import {
  AwarenessStore,
  type Doc,
  type ExtensionType,
  type GetStoreOptions,
  StoreContainer,
  type Workspace,
} from '@blocksuite/affine/store';
import { TestMeta } from '@blocksuite/affine/store/test';
import { BlobEngine, type BlobSource } from '@blocksuite/affine/sync';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { limitUndo } from '@/features/collaboration/undo';
import { BLOCKS_ROOT } from '@/features/notes/blocksuite/layout';
import { CapyStoreExtension } from './capyBlocks';

/* Our Workspace/Doc over one room's Y.Doc (todo-blocksuite-layout.md, "Room
 * doc"). BlockSuite's own (TestWorkspace) keeps a `meta` map and a `spaces`
 * subdoc per page in its root doc; a room holds neither. Here the room doc is
 * both the root and the space doc and its `blocks` map is the store's, so
 * nothing but block edits reaches the room. */

const storeManager = new StoreExtensionManager([
  ...getInternalStoreExtensions(),
  CapyStoreExtension,
]);

/** What a note's store loads: BlockSuite's schemas and adapters, and ours. */
export function noteStoreExtensions() {
  return storeManager.get('store');
}

/** The workspace meta (one page) on a Y.Doc of its own, never the room's. */
function roomMeta(id: string) {
  const meta = new TestMeta(new Y.Doc());
  meta.initialize();
  meta.addDocMeta({ createDate: 0, id, tags: [], title: '' });
  return meta;
}

class RoomDoc implements Doc {
  readonly awarenessStore: AwarenessStore;
  readonly id: string;
  readonly rootDoc: Y.Doc;
  readonly yBlocks: Doc['yBlocks'];
  private readonly container: StoreContainer;
  private readonly owner: RoomWorkspace;
  private isReady = false;

  constructor(owner: RoomWorkspace, awareness: Awareness) {
    this.owner = owner;
    this.id = owner.id;
    this.rootDoc = owner.doc;
    this.yBlocks = owner.doc.getMap(BLOCKS_ROOT);
    // Writes `selectionV2` into the room's awareness; the room's other
    // fields (uploads, presence) stay as they are.
    this.awarenessStore = new AwarenessStore(awareness);
    this.container = new StoreContainer(this);
  }

  get meta() {
    return this.owner.meta.getDocMeta(this.id);
  }

  get workspace() {
    return this.owner;
  }

  get spaceDoc() {
    return this.rootDoc;
  }

  get loaded() {
    return true;
  }

  get ready() {
    return this.isReady;
  }

  /** Never runs an init: the room's seed wrote every block. */
  load() {
    this.isReady = true;
  }

  getStore(options: GetStoreOptions = {}) {
    return this.container.getStore({
      ...options,
      extensions: this.owner.storeExtensions.concat(options.extensions ?? []),
      id: options.id ?? this.id,
    });
  }

  get removeStore() {
    return this.container.removeStore;
  }

  clear() {
    throw new Error('A note room is never cleared from the editor');
  }

  remove() {}

  dispose() {}
}

/** Images' bytes by `sourceId`, our asset id: resolved through the gateway
 * as every other editor asset (`resolveEditorAsset`). Read-only for now:
 * uploads wait on D13. */
function assetSource(): BlobSource {
  return {
    delete: async () => {},
    get: async (assetId: string) => {
      if (!assetId) return null;
      const { resolveEditorAsset } = await import('@/api/editorAssets');
      try {
        const { url } = await resolveEditorAsset(assetId);
        const response = await fetch(url);
        return response.ok ? await response.blob() : null;
      } catch {
        return null;
      }
    },
    list: async () => [],
    name: 'capy-assets',
    readonly: true,
    set: async () => {
      throw new Error('Note image uploads are not wired yet (D13)');
    },
  };
}

export class RoomWorkspace implements Workspace {
  readonly blobSync = new BlobEngine(assetSource(), [], new NoopLogger());
  readonly doc: Y.Doc;
  readonly docs = new Map<string, Doc>();
  readonly id: string;
  // New block ids, as stableElementIds.ts mints them today.
  readonly idGenerator = () => crypto.randomUUID();
  readonly meta: TestMeta;
  readonly slots: Workspace['slots'];
  readonly storeExtensions: ExtensionType[];
  readonly page: RoomDoc;

  constructor({
    awareness,
    doc,
    id,
    storeExtensions,
  }: {
    awareness: Awareness;
    doc: Y.Doc;
    id: string;
    storeExtensions: ExtensionType[];
  }) {
    this.doc = doc;
    this.id = id;
    this.meta = roomMeta(id);
    this.slots = { docListUpdated: this.meta.docMetaUpdated };
    this.storeExtensions = storeExtensions;
    this.page = new RoomDoc(this, awareness);
    this.docs.set(id, this.page);
  }

  createDoc(): Doc {
    throw new Error('A note room holds one document');
  }

  getDoc(id: string) {
    return this.docs.get(id) ?? null;
  }

  removeDoc() {}

  dispose() {}
}

/**
 * The room's store: built once the room synced under its adopted client id,
 * and making no edit while it loads (the seed wrote every default). Undo is
 * BlockSuite's own manager (D6), reaching back 24 h, and following the
 * doc's client id: `HistoryExtension` tracks the id it saw at construction
 * only, while a refused id is replaced at once (Q475). Returns the store and
 * its teardown.
 */
export function openRoomStore({
  awareness,
  doc,
  id,
  readonly,
}: {
  awareness: Awareness;
  doc: Y.Doc;
  id: string;
  readonly?: boolean;
}) {
  const workspace = new RoomWorkspace({
    awareness,
    doc,
    id,
    storeExtensions: noteStoreExtensions(),
  });
  // Loads its extensions (the history's signals) and runs no init.
  const store = workspace.page.getStore({ readonly }).load();
  const stopFollowing = followClientId(store.history.undoManager, doc);
  return {
    dispose: () => {
      stopFollowing();
      store.dispose();
    },
    store,
    workspace,
  };
}

/** Keeps `manager` tracking `doc`'s current client id, which every
 * BlockSuite write uses as its origin (`store.transact`, the inline
 * editor), and applies `limitUndo`. */
export function followClientId(manager: Y.UndoManager, doc: Y.Doc) {
  limitUndo(manager);
  let tracked = doc.clientID;
  manager.trackedOrigins.add(tracked);
  // Before every transaction: its origin is read from the doc as it starts,
  // and the manager checks it once the transaction ends.
  const follow = () => {
    if (doc.clientID === tracked) return;
    manager.trackedOrigins.delete(tracked);
    tracked = doc.clientID;
    manager.trackedOrigins.add(tracked);
  };
  doc.on('beforeTransaction', follow);
  return () => doc.off('beforeTransaction', follow);
}
