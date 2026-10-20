import {
  CursorEditor,
  type CursorEditor as CursorEditorType,
  type RelativeRange,
  relativePositionToSlatePoint,
  YjsEditor,
} from '@slate-yjs/core';
import {
  type Path,
  PathApi,
  type Point,
  type SlateEditor,
  type TElement,
} from 'platejs';
import {
  createPlatePlugin,
  PlateLeaf,
  type PlateLeafProps,
} from 'platejs/react';
import { type CSSProperties, useEffect, useState } from 'react';
import * as Y from 'yjs';
import { m } from '@/i18n';

const REMOTE_CURSOR_KEY = 'capy_remote_cursor';

export const remoteCursorDecorationPlugin = createPlatePlugin({
  key: REMOTE_CURSOR_KEY,
  node: { isLeaf: true },
  render: {
    node: (props: PlateLeafProps) => {
      const color =
        typeof props.leaf.remoteCursorColor === 'string'
          ? props.leaf.remoteCursorColor
          : '#7c3aed';
      const name =
        typeof props.leaf.remoteCursorName === 'string'
          ? props.leaf.remoteCursorName
          : m.editor_collaborator();
      // A caret is a collapsed decoration, an empty leaf with no width: the
      // stylesheet draws its bar (::before), so it adds no DOM to the text.
      // The stylesheet also tints a selection, mixing the colour in CSS since
      // peers send it in any CSS form (hsl()).
      const caret = props.leaf.remoteCursorCaret === true;
      return (
        <PlateLeaf
          {...props}
          attributes={{
            ...props.attributes,
            [caret ? 'data-remote-caret' : 'data-remote-cursor']: name,
          }}
          style={
            {
              ...props.style,
              '--remote-cursor': color,
              pointerEvents: 'none',
            } as CSSProperties
          }
        />
      );
    },
  },
});

type CollaborativeEditor = YjsEditor & SlateEditor & CursorEditorType;

/** A peer's selection as its awareness state holds it: Yjs relative
 * positions, which follow the text and are resolved only when drawn. */
type RemotePeer = {
  color: string | undefined;
  name: string | undefined;
  selection: RelativeRange;
};

type RemoteCursorDecoration = {
  anchor: Point;
  focus: Point;
  [REMOTE_CURSOR_KEY]: true;
  remoteCursorCaret?: true;
  remoteCursorColor: string | undefined;
  remoteCursorName: string | undefined;
};

const NO_PEERS: RemotePeer[] = [];
const NO_REMOTE_CURSORS: RemoteCursorDecoration[] = [];

export function readRemotePeers(editor: SlateEditor): RemotePeer[] {
  if (!CursorEditor.isCursorEditor(editor)) return NO_PEERS;
  return Object.values(
    CursorEditor.cursorStates(editor as CollaborativeEditor)
  ).flatMap(({ data, relativeSelection }) =>
    relativeSelection
      ? [
          {
            color: typeof data?.color === 'string' ? data.color : undefined,
            name: typeof data?.name === 'string' ? data.name : undefined,
            selection: relativeSelection,
          },
        ]
      : []
  );
}

function samePeers(left: RemotePeer[], right: RemotePeer[]) {
  return (
    left.length === right.length &&
    left.every((peer, index) => {
      const other = right[index];
      return (
        !!other &&
        peer.color === other.color &&
        peer.name === other.name &&
        Y.compareRelativePositions(
          peer.selection.anchor,
          other.selection.anchor
        ) &&
        Y.compareRelativePositions(peer.selection.focus, other.selection.focus)
      );
    })
  );
}

export function useRemotePeers(editor: SlateEditor) {
  // Every state change here re-renders the whole editable, and the render
  // also restores the DOM caret from Slate's selection, which can undo native
  // caret movement the editor has not synced yet. So only a peer whose
  // selection or label actually changed may reach React; where its caret sits
  // in the current document is worked out in `decorate`.
  const [peers, setPeers] = useState<RemotePeer[]>(NO_PEERS);
  useEffect(() => {
    if (!CursorEditor.isCursorEditor(editor)) return;
    const update = () => {
      const next = readRemotePeers(editor);
      setPeers((previous) => (samePeers(previous, next) ? previous : next));
    };
    update();
    CursorEditor.on(editor, 'change', update);
    return () => CursorEditor.off(editor, 'change', update);
  }, [editor]);

  return peers;
}

/** slate-react renders no decorations inside a void, so a caret in an inline
 * void (an inline equation) is drawn in the text right after it. */
function outOfInlineVoid(editor: SlateEditor, point: Point): Point {
  const entry = editor.api.parent<TElement>(point.path);
  if (!entry) return point;
  const [parent, parentPath] = entry;
  return editor.api.isInline(parent) && editor.api.isVoid(parent)
    ? { offset: 0, path: PathApi.next(parentPath) }
    : point;
}

function resolvePeer(
  editor: CollaborativeEditor,
  peer: RemotePeer
): RemoteCursorDecoration[] {
  const label = {
    [REMOTE_CURSOR_KEY]: true as const,
    remoteCursorColor: peer.color,
    remoteCursorName: peer.name,
  };
  const { anchor: relativeAnchor, focus: relativeFocus } = peer.selection;
  const focus = relativePositionToSlatePoint(
    editor.sharedRoot,
    editor,
    relativeFocus
  );
  if (!focus) return [];
  const caretAt = outOfInlineVoid(editor, focus);
  const caret = {
    ...label,
    anchor: caretAt,
    focus: caretAt,
    remoteCursorCaret: true as const,
  };
  if (Y.compareRelativePositions(relativeAnchor, relativeFocus)) {
    return [caret];
  }
  const anchor = relativePositionToSlatePoint(
    editor.sharedRoot,
    editor,
    relativeAnchor
  );
  return anchor ? [{ ...label, anchor, focus }, caret] : [caret];
}

const resolved = new WeakMap<
  object,
  { peers: RemotePeer[]; ranges: RemoteCursorDecoration[]; version: unknown }
>();

/**
 * The peers' decorations for a `decorate` entry: each peer's selection as a
 * tinted range (when not collapsed) and its caret at the focus. They are
 * returned for the root entry only, since slate-react hands the root's
 * decorations down to every node they cover; returning them for a block or
 * text as well drew each caret once per level. Peer positions are relative,
 * so they are resolved once per document version (local and remote edits
 * move them) or peer change, like comment anchors.
 */
export function remoteCursorRangesForEntry(
  editor: SlateEditor,
  [, path]: [unknown, Path],
  peers: RemotePeer[]
): RemoteCursorDecoration[] {
  if (path.length > 0 || peers.length === 0) return NO_REMOTE_CURSORS;
  const cached = resolved.get(editor);
  if (cached?.version === editor.children && cached.peers === peers) {
    return cached.ranges;
  }
  const collaborative = editor as CollaborativeEditor;
  const ranges = collaborative.sharedRoot
    ? peers.flatMap((peer) => {
        try {
          return resolvePeer(collaborative, peer);
        } catch {
          // A position the document no longer holds draws no caret.
          return [];
        }
      })
    : NO_REMOTE_CURSORS;
  // A local edit is in Slate before it is flushed to Yjs (on change), and
  // positions resolved in between map Yjs offsets onto the edited text: such
  // a result is drawn but not kept for this version.
  if (YjsEditor.localChanges(collaborative).length === 0) {
    resolved.set(editor, { peers, ranges, version: editor.children });
  }
  return ranges;
}
