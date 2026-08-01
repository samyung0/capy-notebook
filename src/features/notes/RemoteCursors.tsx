import {
  CursorEditor,
  type CursorEditor as CursorEditorType,
  relativeRangeToSlateRange,
  type YjsEditor,
} from '@slate-yjs/core';
import type { Path } from 'platejs';
import {
  createPlatePlugin,
  PlateLeaf,
  type PlateLeafProps,
  type useEditorRef,
} from 'platejs/react';
import { useEffect, useMemo, useState } from 'react';

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

export function useRemoteCursorDecorations(
  editor: ReturnType<typeof useEditorRef>
) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!CursorEditor.isCursorEditor(editor)) return;
    const update = () => setVersion((value) => value + 1);
    CursorEditor.on(editor, 'change', update);
    return () => CursorEditor.off(editor, 'change', update);
  }, [editor]);

  return useMemo(() => {
    if (!CursorEditor.isCursorEditor(editor)) return [];
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
  }, [editor, version]);
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
