import { BaseSuggestionPlugin } from '@platejs/suggestion';
import { TrailingBlockPlugin } from 'platejs';
import {
  commentPlugin,
  discussionPlugin,
  type EditorCollaborationOptions,
  suggestionPlugin,
} from './Collaboration';

/**
 * The trailing paragraph is editor housekeeping, not a user edit: without
 * withoutSuggestions, suggestion mode would permanently show a phantom
 * "appended line" suggestion at the end of every document.
 */
export const suggestionSafeTrailingBlockPlugin = TrailingBlockPlugin.configure({
  options: {
    insert: (editor, { insert }) => {
      editor.getApi(BaseSuggestionPlugin).suggestion.withoutSuggestions(insert);
    },
  },
});

export function buildCollaborationPlugins(options: EditorCollaborationOptions) {
  const currentUserId = options.currentUserId?.trim() || 'current-user';

  return [
    discussionPlugin.configure({ options: { ...options, currentUserId } }),
    commentPlugin,
    suggestionPlugin.configure({
      options: {
        // Suggestion normalization drops marks without an author. Interactive
        // modes are authenticated, but keep a stable fallback while /me data
        // is unavailable so the first keystroke is not discarded.
        currentUserId,
        isSuggesting: options.mode === 'suggestion',
      },
    }),
  ];
}
