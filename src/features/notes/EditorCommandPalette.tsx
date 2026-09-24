import { useEditorRef } from 'platejs/react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog, DialogOverlay, DialogPortal } from '@/components/ui/Dialog';
import { EditorIcon } from '@/features/notes/EditorIcon';
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
  const { canEdit, allowExternalAssets } = useEditorRuntime();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen(!open);
        if (open) editor.tf.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editor, open]);

  const commands = useMemo(() => {
    const comment: EditorCommand | null =
      canEdit && collaboration
        ? {
            get description() {
              return m.editor_comment_selection();
            },
            group: 'general',
            icon: 'commentAdd',
            id: 'comment',
            get label() {
              return m.editor_comment();
            },
            run: () => collaboration.openComment(),
            shortcut: 'Ctrl/Cmd+Shift+M',
          }
        : null;
    return [...EDITOR_COMMANDS, ...(comment ? [comment] : [])].filter(
      (command) =>
        enabled[command.group] &&
        (command.id === 'comment' ||
          isEditorCommandAllowed(command, allowExternalAssets)) &&
        commandMatches(command, query)
    );
  }, [allowExternalAssets, canEdit, collaboration, enabled, query]);

  return (
    <Dialog
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) editor.tf.focus();
      }}
      open={open}
    >
      <DialogPortal>
        <DialogOverlay className="z-60" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          aria-label={m.editor_command_palette()}
          className="motion-modal motion-blur-in fixed top-[15dvh] left-1/2 z-60 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 overflow-hidden rounded-card border border-line bg-surface shadow-pop"
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <DialogPrimitive.Title className="sr-only">
            {m.editor_command_palette()}
          </DialogPrimitive.Title>
          <div className="flex items-center gap-2 border-divider border-b px-3">
            <EditorIcon className="size-4 text-fg-muted" name="search" />
            <input
              className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-placeholder"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  setOpen(false);
                  editor.tf.focus();
                }
              }}
              placeholder={m.editor_search_commands()}
              ref={inputRef}
              value={query}
            />
            <Button
              aria-label={m.editor_close_palette()}
              onClick={() => {
                setOpen(false);
                editor.tf.focus();
              }}
              size="sm"
              variant="ghost"
            >
              <EditorIcon className="size-4" name="x" />
            </Button>
          </div>
          <div className="max-h-80 overflow-auto p-1">
            {commands.length ? (
              commands.map((command) => (
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
                  <EditorIcon
                    className="size-4 text-fg-muted"
                    name={command.icon}
                  />
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
              ))
            ) : (
              <p className="px-2 py-5 text-center text-fg-muted text-sm">
                {m.editor_commands_none()}
              </p>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
