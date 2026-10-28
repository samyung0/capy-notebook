import '@toeverything/theme/style.css';
import { PageClipboard } from '@blocksuite/affine/blocks/root';
import { ViewExtensionManager } from '@blocksuite/affine/ext-loader';
import { getInternalViewExtensions } from '@blocksuite/affine/extensions/view';
import { PlainTextClipboardConfig } from '@blocksuite/affine/foundation/clipboard';
import { BlockStdScope } from '@blocksuite/affine/std';
import { Text } from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { LinkedDocViewExtension } from '@blocksuite/affine/widgets/linked-doc/view';
import { RemoteSelectionViewExtension } from '@blocksuite/affine/widgets/remote-selection/view';
import { html, render } from 'lit';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';
import { CapyViewExtension } from './capyViews';
import {
  CapyPageClipboard,
  ChatAnswerClipboardConfig,
  TextClipboardConfig,
} from './clipboard';
import { noteStoreExtensions, openRoomStore } from './roomStore';

// Each view provider registers its custom elements once per class
// (ext-loader's `effectRan`), and vendor/ is outside Vite's watch list, so an
// HMR update of this module never defines an element twice.
const viewManager = new ViewExtensionManager([
  ...getInternalViewExtensions().filter(
    (provider) =>
      // The `@` linked-doc menu needs a docs collection (D14). The remote
      // selection widget writes a random awareness `color`; cursors come
      // from room presence instead (todo-blocksuite-layout.md, Awareness).
      provider !== LinkedDocViewExtension &&
      provider !== RemoteSelectionViewExtension
  ),
  CapyViewExtension,
]);

/** The note's page extensions: our paste in place of BlockSuite's plain-text
 * adapter and id replacement, and a chat answer's clipboard type. */
let noteExtensions: ReturnType<ViewExtensionManager['get']> | undefined;
function pageExtensions() {
  noteExtensions ??= [
    ...viewManager
      .get('page')
      .filter(
        (extension) =>
          extension !== PageClipboard && extension !== PlainTextClipboardConfig
      ),
    CapyPageClipboard,
    TextClipboardConfig,
    ChatAnswerClipboardConfig,
  ];
  return noteExtensions;
}

/**
 * Renders a note room's editor into `container`: BlockSuite's page editor
 * over the room's synced document, with its client id adopted (see
 * `openRoomStore`). Returns its unmount. The page specs look up their scroll
 * container as `.affine-page-viewport`.
 */
export function mountNoteEditor(
  container: HTMLElement,
  room: { awareness: Awareness; doc: Y.Doc; id: string; readonly: boolean }
) {
  const opened = openRoomStore(room);
  const std = new BlockStdScope({
    extensions: pageExtensions(),
    store: opened.store,
  });
  render(
    html`<div class="affine-page-viewport">${std.render()}</div>`,
    container
  );
  return () => {
    render(null, container);
    opened.dispose();
  };
}

/** A one-paragraph note in a fresh in-memory workspace (the spike page). */
export function createLocalNote() {
  const workspace = new TestWorkspace();
  workspace.storeExtensions = noteStoreExtensions();
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

/** Renders the page editor on a local note into `container`; returns its
 * unmount. */
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
