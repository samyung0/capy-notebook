import '@toeverything/theme/style.css';
import './pageEditor.css';
import { AttachmentViewExtension } from '@blocksuite/affine/blocks/attachment/view';
import { BookmarkViewExtension } from '@blocksuite/affine/blocks/bookmark/view';
import { DataViewViewExtension } from '@blocksuite/affine/blocks/data-view/view';
import { DatabaseViewExtension } from '@blocksuite/affine/blocks/database/view';
import { EdgelessTextViewExtension } from '@blocksuite/affine/blocks/edgeless-text/view';
import { EmbedViewExtension } from '@blocksuite/affine/blocks/embed/view';
import { EmbedDocViewExtension } from '@blocksuite/affine/blocks/embed-doc/view';
import { FrameViewExtension } from '@blocksuite/affine/blocks/frame/view';
import { PageClipboard } from '@blocksuite/affine/blocks/root';
import { SurfaceViewExtension } from '@blocksuite/affine/blocks/surface/view';
import { SurfaceRefViewExtension } from '@blocksuite/affine/blocks/surface-ref/view';
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
import type { BlockIslands } from '@/features/notes/blocksuite/islands';
import { blockIslandsExtension, CapyViewExtension } from './capyViews';
import {
  CapyPageClipboard,
  ChatAnswerClipboardConfig,
  TextClipboardConfig,
} from './clipboard';
import { noteStoreExtensions, openRoomStore } from './roomStore';

const OFF = new Set([
  // The views of the blocks the store refuses (roomStore.ts `REFUSED`),
  // with their slash items and toolbar entries.
  AttachmentViewExtension,
  BookmarkViewExtension,
  DataViewViewExtension,
  DatabaseViewExtension,
  EdgelessTextViewExtension,
  EmbedDocViewExtension,
  EmbedViewExtension,
  FrameViewExtension,
  SurfaceRefViewExtension,
  SurfaceViewExtension,
  // The `@` linked-doc menu needs a docs collection (D14). The remote
  // selection widget writes a random awareness `color`; cursors come from
  // room presence instead (todo-blocksuite-layout.md, Awareness).
  LinkedDocViewExtension,
  RemoteSelectionViewExtension,
]);
// Each view provider registers its custom elements once per class
// (ext-loader's `effectRan`), and vendor/ is outside Vite's watch list, so an
// HMR update of this module never defines an element twice.
const viewManager = new ViewExtensionManager([
  ...getInternalViewExtensions().filter((provider) => !OFF.has(provider)),
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
 * `openRoomStore`). Material refs publish their elements to `islands`.
 * Returns its unmount and its read-only switch, which pauses and resumes
 * edits in place (offline past the bound, a draft send, a paused swap)
 * without building the editor again. The page specs look up their scroll
 * container as `.affine-page-viewport`.
 */
export function mountNoteEditor(
  container: HTMLElement,
  room: { awareness: Awareness; doc: Y.Doc; id: string; readonly: boolean },
  islands: BlockIslands
) {
  const opened = openRoomStore(room);
  const std = new BlockStdScope({
    extensions: [...pageExtensions(), blockIslandsExtension(islands)],
    store: opened.store,
  });
  render(
    html`<div class="affine-page-viewport">${std.render()}</div>`,
    container
  );
  return {
    setReadonly: (readonly: boolean) => {
      opened.store.readonly = readonly;
    },
    unmount: () => {
      render(null, container);
      opened.dispose();
    },
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
