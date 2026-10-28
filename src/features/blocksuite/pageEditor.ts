import '@toeverything/theme/style.css';
import {
  StoreExtensionManager,
  ViewExtensionManager,
} from '@blocksuite/affine/ext-loader';
import { getInternalStoreExtensions } from '@blocksuite/affine/extensions/store';
import { getInternalViewExtensions } from '@blocksuite/affine/extensions/view';
import { BlockStdScope } from '@blocksuite/affine/std';
import { Text } from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { html, render } from 'lit';

// Spike (todo-blocksuite-spike.md, piece 1): BlockSuite's page editor on a
// local doc. Each view provider registers its custom elements once per class
// (ext-loader's `effectRan`), and vendor/ is outside Vite's watch list, so an
// HMR update of this module never defines an element twice.
const viewManager = new ViewExtensionManager(getInternalViewExtensions());
const storeManager = new StoreExtensionManager(getInternalStoreExtensions());

/** A one-paragraph note in a fresh in-memory workspace. */
export function createLocalNote() {
  const workspace = new TestWorkspace();
  workspace.storeExtensions = storeManager.get('store');
  workspace.meta.initialize();
  const store = workspace.createDoc('note').getStore();
  store.load(() => {
    const pageId = store.addBlock('affine:page', { title: new Text() });
    const noteId = store.addBlock('affine:note', {}, pageId);
    store.addBlock('affine:paragraph', {}, noteId);
  });
  store.resetHistory();
  return store;
}

/** Renders the page editor into `container`; returns its unmount. The page
 * specs look up their scroll container as `.affine-page-viewport`. */
export function mountPageEditor(container: HTMLElement) {
  const std = new BlockStdScope({
    extensions: viewManager.get('page'),
    store: createLocalNote(),
  });
  render(
    html`<div class="affine-page-viewport">${std.render()}</div>`,
    container
  );
  return () => {
    render(null, container);
  };
}
