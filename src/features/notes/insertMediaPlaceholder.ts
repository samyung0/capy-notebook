import { KEYS } from 'platejs';
import { insertEditorNode, type NoteEditorInstance } from './insertEditorNode';
import type { plateMediaType } from './media';

type MediaType = ReturnType<typeof plateMediaType>;

/** Exposed for the toolbar and slash menu. */
export function insertMediaPlaceholder(
  editor: NoteEditorInstance,
  type: MediaType
) {
  insertEditorNode(editor, {
    children: [{ text: '' }],
    mediaType: type,
    type: KEYS.placeholder,
  });
}
