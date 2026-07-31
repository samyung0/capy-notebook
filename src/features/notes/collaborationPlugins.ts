import { TrailingBlockPlugin } from 'platejs';
import {
  commentDecorationPlugin,
  discussionPlugin,
  type EditorCollaborationOptions,
} from './Collaboration';

export const collaborationTrailingBlockPlugin = TrailingBlockPlugin;

export function buildCollaborationPlugins(options: EditorCollaborationOptions) {
  return [discussionPlugin.configure({ options }), commentDecorationPlugin];
}
