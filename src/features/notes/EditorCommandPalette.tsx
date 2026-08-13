import { MessageSquarePlus, Search, X } from 'lucide-react';
import { useEditorRef } from 'platejs/react';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { useOptionalNoteBlockDialogs } from './blocks/dialogContext';
import { useCollaborationActions } from './Collaboration';
import { useEditorRuntime } from './EditorRuntime';
import {
  commandMatches,
  EDITOR_COMMANDS,
  type EditorCommand,
} from './editorCommands';
import { isEditorCommandAllowed } from './editorMode';
import { useNoteEditorPrefs } from './noteEditorPrefs';

export function EditorCommandPalette() {
  const editor = useEditorRef();
  const dialogs = useOptionalNoteBlockDialogs();
  const collaboration = useCollaborationActions();
  const enabled = useNoteEditorPrefs((state) => state.enabled);
  const { canComment, mode } = useEditorRuntime();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const commands = useMemo(() => {
    const comment: EditorCommand | null =
      canComment && collaboration
        ? {
            get description() {
              return m.editor_comment_selection();
            },
            group: 'general',
            icon: MessageSquarePlus,
            id: 'comment',
            get label() {
              return m.editor_comment();
            },
            run: () => collaboration.openComment(),
            shortcut: 'Ctrl/Cmd+Shift+M',
          }
        : null;
    return [
      ...(mode === 'edit' ? EDITOR_COMMANDS : []),
      ...(comment ? [comment] : []),
    ].filter(
      (command) =>
        enabled[command.group] &&
        (command.id === 'comment' || isEditorCommandAllowed(mode, command)) &&
        commandMatches(command, query)
    );
  }, [canComment, collaboration, enabled, mode, query]);

  if (!open) return null;
  return (
    <div
      aria-label={m.editor_command_palette()}
      className="fixed inset-0 z-60 flex items-start justify-center bg-black/10 px-4 pt-[15dvh] backdrop-blur-xs"
      onMouseDown={() => setOpen(false)}
      role="dialog"
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-card border border-line bg-surface shadow-pop"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-divider border-b px-3">
          <Search className="size-4 text-fg-muted" />
          <input
            autoFocus
            className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setOpen(false);
            }}
            placeholder={m.editor_search_commands()}
            value={query}
          />
          <Button
            aria-label={m.editor_close_palette()}
            onClick={() => setOpen(false)}
            size="sm"
            variant="ghost"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="max-h-80 overflow-auto p-1">
          {commands.length ? (
            commands.map((command) => {
              const Icon = command.icon;
              return (
                <button
                  className="flex w-full items-center gap-3 rounded-button px-2 py-2 text-left hover:bg-surface-hover-bg"
                  key={command.id}
                  onClick={() => {
                    setOpen(false);
                    if (command.focusEditor !== false) editor.tf.focus();
                    command.run(editor, dialogs);
                  }}
                  type="button"
                >
                  <Icon className="size-4 text-fg-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium text-sm">
                      {command.label}
                    </span>
                    <span className="block truncate text-fg-muted text-xs">
                      {command.description}
                    </span>
                  </span>
                  {command.shortcut && (
                    <span className="text-fg-muted text-xs">
                      {command.shortcut}
                    </span>
                  )}
                </button>
              );
            })
          ) : (
            <p className="px-2 py-5 text-center text-fg-muted text-sm">
              {m.editor_commands_none()}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
