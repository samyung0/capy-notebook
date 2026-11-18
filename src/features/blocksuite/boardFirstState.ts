import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { Text } from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import * as Y from 'yjs';

/** The Yjs client a canvas's first state is written under: the gateway never
 * mints it, so the room refuses any later change under it. */
const FIRST_STATE_CLIENT = 1;

const stores = new StoreExtensionManager([
  RootStoreExtension,
  SurfaceStoreExtension,
]);

/** A new canvas's whole state, as a Yjs v1 update: the page (`page`) and its
 * canvas (`surface`), written by the editor's own store. The collaboration
 * server seeds every canvas room with these bytes, from the fixture
 * `collaboration-rs/crates/server/fixtures/board-first-state.bin` that
 * `boardFirstState.test.ts` keeps equal to them. */
export function boardFirstState(): Uint8Array {
  const ids = ['page', 'surface'];
  const workspace = new TestWorkspace({
    idGenerator: () => {
      const id = ids.shift();
      if (!id) throw new Error('A first state holds a page and its canvas');
      return id;
    },
  });
  workspace.storeExtensions = stores.get('store');
  workspace.meta.initialize();
  const store = workspace.createDoc('board').getStore();
  store.spaceDoc.clientID = FIRST_STATE_CLIENT;
  store.load(() => {
    const page = store.addBlock('affine:page', { title: new Text() });
    store.addBlock('affine:surface', {}, page);
  });
  return Y.encodeStateAsUpdate(store.spaceDoc);
}
