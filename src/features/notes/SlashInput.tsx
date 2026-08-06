import {
  useComboboxInput,
  useHTMLInputCursorState,
} from '@platejs/combobox/react';
import {
  autoUpdate,
  FloatingPortal,
  flip,
  offset,
  shift,
  useFloating,
} from '@platejs/floating';
import { MessageSquarePlus } from 'lucide-react';
import type { PointRef, TComboboxInputElement } from 'platejs';
import {
  PlateElement,
  type PlateElementProps,
  useEditorRef,
} from 'platejs/react';
import { useEffect, useMemo, useRef, useState } from 'react';
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

export function SlashInputElement(
  props: PlateElementProps<TComboboxInputElement>
) {
  const editor = useEditorRef();
  // Optional: matches editorCommands (dialogs?.open*) and survives Plate element
  // trees that do not see NoteBlockDialogsProvider React context.
  const dialogs = useOptionalNoteBlockDialogs();
  const enabled = useNoteEditorPrefs((state) => state.enabled);
  const { canComment, mode } = useEditorRuntime();
  const collaboration = useCollaborationActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const cursorState = useHTMLInputCursorState(inputRef);
  const insertPointRef = useRef<PointRef | null>(null);
  const isSelectingCommandRef = useRef(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);

  const { refs, floatingStyles } = useFloating({
    middleware: [
      offset(4),
      flip({
        fallbackPlacements: ['top-start'],
        padding: 12,
      }),
      shift({ padding: 12 }),
    ],
    open: true,
    placement: 'bottom-start',
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
  });

  useEffect(() => {
    insertPointRef.current?.unref();
    insertPointRef.current = null;
    const path = editor.api.findPath(props.element);
    if (!path) return;
    const point = editor.api.before(path);
    if (!point) return;
    const pointRef = editor.api.pointRef(point);
    insertPointRef.current = pointRef;
    return () => {
      if (insertPointRef.current === pointRef) insertPointRef.current = null;
      pointRef.unref();
    };
  }, [editor, props.element]);

  const { props: inputProps, removeInput } = useComboboxInput({
    autoFocus: true,
    cancelInputOnBlur: true,
    // Same as MentionInput: nested <input> focus can clear Slate selection.
    cancelInputOnDeselect: false,
    cursorState,
    onCancelInput: (cause) => {
      // Focusing the editor to run a selected command blurs this native input.
      // At that point the slash node has already been deliberately removed, so
      // do not restore the slash query as if the user had cancelled the menu.
      if (isSelectingCommandRef.current) return;
      if (cause !== 'backspace') {
        editor.tf.insertText(`/${query}`, {
          at: insertPointRef.current?.current ?? undefined,
        });
      }
    },
    ref: inputRef,
  });

  const commands = useMemo(() => {
    const collaborationCommand: EditorCommand | null =
      canComment && collaboration
        ? {
            description: 'Add a comment to the current selection',
            group: 'general',
            icon: MessageSquarePlus,
            id: 'comment',
            label: 'Comment',
            run: () => collaboration.openComment(),
            shortcut: 'Ctrl/Cmd+Shift+M',
          }
        : null;
    const availableCommands = collaborationCommand
      ? [...EDITOR_COMMANDS, collaborationCommand]
      : EDITOR_COMMANDS;

    return availableCommands.filter(
      (command) =>
        enabled[command.group] &&
        isEditorCommandAllowed(mode, command) &&
        commandMatches(command, query)
    );
  }, [canComment, collaboration, enabled, mode, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function select(index: number) {
    const command = commands[index];
    if (!command) return;
    const insertionPoint = insertPointRef.current?.current;

    isSelectingCommandRef.current = true;
    removeInput(false);

    // The nested native input can clear Slate's selection. Restore the point
    // tracked immediately before the slash node before running the command.
    if (insertionPoint) editor.tf.select(insertionPoint);
    if (command.focusEditor !== false) editor.tf.focus();
    command.run(editor, dialogs);
  }

  return (
    <PlateElement {...props} as="span">
      <span
        className="relative inline-flex"
        contentEditable={false}
        ref={refs.setReference}
      >
        <span>/</span>
        <span className="relative min-w-2">
          <span aria-hidden className="invisible whitespace-pre">
            {query || '\u200b'}
          </span>
          <input
            {...inputProps}
            aria-expanded={commands.length > 0}
            aria-label="Search editor commands"
            className="absolute inset-0 size-full bg-transparent outline-none"
            onBlur={(event) => {
              // The selected command can replace this slash node with another
              // inline combobox at the same Slate path. Letting the stale slash
              // blur handler run would remove that newly inserted node.
              if (isSelectingCommandRef.current) return;
              inputProps.onBlur?.(event);
            }}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              inputProps.onKeyDown?.(event);
              if (event.defaultPrevented) return;
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex(
                  (index) => (index + 1) % Math.max(1, commands.length)
                );
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex(
                  (index) =>
                    (index - 1 + Math.max(1, commands.length)) %
                    Math.max(1, commands.length)
                );
              } else if (event.key === 'Enter' && commands.length) {
                event.preventDefault();
                select(activeIndex);
              }
            }}
            ref={inputRef}
            role="combobox"
            value={query}
          />
        </span>
        <FloatingPortal>
          <span
            className="z-50 block max-h-72 w-72 overflow-auto rounded-card border border-line bg-surface p-1 shadow-pop"
            ref={refs.setFloating}
            role="listbox"
            style={floatingStyles}
          >
            {commands.length ? (
              commands.map((command, index) => (
                <button
                  aria-selected={index === activeIndex}
                  className="flex w-full flex-col rounded-button px-2 py-1.5 text-left hover:bg-surface-hover-bg aria-selected:bg-surface-hover-bg"
                  key={command.id}
                  onClick={() => select(index)}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveIndex(index)}
                  role="option"
                  type="button"
                >
                  <span className="font-medium text-fg text-sm">
                    {command.label}
                  </span>
                  <span className="text-fg-muted text-xs">
                    {command.description}
                  </span>
                </button>
              ))
            ) : (
              <span className="block px-2 py-3 text-fg-muted text-sm">
                No commands found
              </span>
            )}
          </span>
        </FloatingPortal>
      </span>
      {props.children}
    </PlateElement>
  );
}
