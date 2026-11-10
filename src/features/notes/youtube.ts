import { insertEditorNode, type NoteEditorInstance } from './insertEditorNode';

export function insertYouTubeEmbed(
  editor: NoteEditorInstance,
  videoId: string
) {
  insertEditorNode(editor, {
    children: [{ text: '' }],
    provider: 'youtube',
    type: 'video',
    videoId,
  });
}
