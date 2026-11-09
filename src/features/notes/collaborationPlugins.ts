import {
  commentDecorationPlugin,
  discussionPlugin,
  type EditorCollaborationOptions,
} from './Collaboration';

export function buildCollaborationPlugins(options: EditorCollaborationOptions) {
  return [discussionPlugin.configure({ options }), commentDecorationPlugin];
}
