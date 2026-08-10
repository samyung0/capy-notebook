import {
  CursorEditor,
  type CursorEditor as CursorEditorType,
  relativeRangeToSlateRange,
  type YjsEditor,
} from '@slate-yjs/core';
import type { Path, Point } from 'platejs';
import {
  createPlatePlugin,
  PlateLeaf,
  type PlateLeafProps,
  type useEditorRef,
} from 'platejs/react';
import { useEffect, useState } from 'react';

const REMOTE_CURSOR_KEY = 'evo_remote_cursor';

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
          : 'Collaborator';
      return (
        <PlateLeaf
          {...props}
          attributes={{
            ...props.attributes,
            'data-remote-cursor': name,
          }}
          style={{
            ...props.style,
            backgroundColor: `${color}22`,
            boxShadow: `inset 2px 0 ${color}`,
            pointerEvents: 'none',
          }}
        />
      );
    },
  },
});

type CollaborativeEditor = YjsEditor &
  ReturnType<typeof useEditorRef> &
  CursorEditorType;

type RemoteCursorDecoration = {
  anchor: Point;
  focus: Point;
  [REMOTE_CURSOR_KEY]: true;
  remoteCursorColor: string | undefined;
  remoteCursorName: string | undefined;
};

const NO_REMOTE_CURSORS: RemoteCursorDecoration[] = [];

function readRemoteCursors(
  editor: ReturnType<typeof useEditorRef>
): RemoteCursorDecoration[] {
  if (!CursorEditor.isCursorEditor(editor)) return NO_REMOTE_CURSORS;
  const collaborative = editor as CollaborativeEditor;
  return Object.values(CursorEditor.cursorStates(collaborative)).flatMap(
    (cursor) => {
      if (
        cursor.clientId === collaborative.awareness.clientID ||
        !cursor.relativeSelection
      ) {
        return [];
      }
      const range = relativeRangeToSlateRange(
        collaborative.sharedRoot,
        collaborative,
        cursor.relativeSelection
      );
      if (!range) return [];
      return [
        {
          ...range,
          [REMOTE_CURSOR_KEY]: true,
          remoteCursorColor:
            typeof cursor.data?.color === 'string'
              ? cursor.data.color
              : undefined,
          remoteCursorName:
            typeof cursor.data?.name === 'string'
              ? cursor.data.name
              : undefined,
        },
      ];
    }
  );
}

function samePoint(left: Point, right: Point) {
  return (
    left.offset === right.offset &&
    left.path.length === right.path.length &&
    left.path.every((segment, index) => segment === right.path[index])
  );
}

function sameCursors(
  left: RemoteCursorDecoration[],
  right: RemoteCursorDecoration[]
) {
  return (
    left.length === right.length &&
    left.every((cursor, index) => {
      const other = right[index];
      return (
        !!other &&
        cursor.remoteCursorColor === other.remoteCursorColor &&
        cursor.remoteCursorName === other.remoteCursorName &&
        samePoint(cursor.anchor, other.anchor) &&
        samePoint(cursor.focus, other.focus)
      );
    })
  );
}

export function useRemoteCursorDecorations(
  editor: ReturnType<typeof useEditorRef>
) {
  // Awareness fires for heartbeats and for this client's own cursor, and every
  // state change here re-renders the whole editable. That is the cost this file
  // exists to avoid — and the render also restores the DOM caret from Slate's
  // selection, which can undo native caret movement the editor has not synced
  // yet. So only an actually different decoration set may reach React.
  const [cursors, setCursors] =
    useState<RemoteCursorDecoration[]>(NO_REMOTE_CURSORS);
  useEffect(() => {
    if (!CursorEditor.isCursorEditor(editor)) return;
    const update = () => {
      const next = readRemoteCursors(editor);
      setCursors((previous) => (sameCursors(previous, next) ? previous : next));
    };
    update();
    CursorEditor.on(editor, 'change', update);
    return () => CursorEditor.off(editor, 'change', update);
  }, [editor]);

  return cursors;
}

export function remoteCursorRangesForEntry(
  entry: [unknown, Path],
  decorations: Array<Record<string, unknown>>
) {
  const [, path] = entry;
  const isPrefix = (prefix: Path, value: Path) =>
    prefix.length <= value.length &&
    prefix.every((segment, index) => segment === value[index]);
  const compare = (left: Path, right: Path) => {
    for (let index = 0; index < Math.min(left.length, right.length); index++) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return left.length - right.length;
  };

  return decorations.filter((range) => {
    const anchor = range.anchor as { path: Path } | undefined;
    const focus = range.focus as { path: Path } | undefined;
    if (!(anchor && focus)) return false;
    const start =
      compare(anchor.path, focus.path) <= 0 ? anchor.path : focus.path;
    const end = start === anchor.path ? focus.path : anchor.path;
    return (
      (compare(start, path) <= 0 && compare(path, end) <= 0) ||
      isPrefix(path, start) ||
      isPrefix(path, end)
    );
  });
}
