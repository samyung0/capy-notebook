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
  size,
  useFloating,
} from '@platejs/floating';
import type { PointRef, TComboboxInputElement } from 'platejs';
import {
  PlateElement,
  type PlateElementProps,
  useEditorRef,
} from 'platejs/react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { PopupMotion } from '@/components/ui/PopupMotion';
import {
  ToolbarPopoverGroup,
  ToolbarPopoverItem,
} from '@/components/ui/ToolbarPopover';
import { m } from '@/i18n';
import { useOptionalNoteBlockDialogs } from './blocks/dialogContext';
import { useCollaborationActions } from './Collaboration';
import { EditorIcon } from './EditorIcon';
import { useEditorRuntime } from './EditorRuntime';
import {
  commandMatches,
  EDITOR_COMMANDS,
  type EditorCommand,
} from './editorCommands';
import { isEditorCommandAllowed } from './editorMode';
import { useNoteEditorPrefs, WIDGET_GROUPS } from './noteEditorPrefs';

export function SlashInputElement(
  props: PlateElementProps<TComboboxInputElement>
) {
  const editor = useEditorRef();
  // Optional: matches editorCommands (dialogs?.open*) and survives Plate element
  // trees that do not see NoteBlockDialogsProvider React context.
  const dialogs = useOptionalNoteBlockDialogs();
  const enabled = useNoteEditorPrefs((state) => state.enabled);
  const { canEdit, allowExternalAssets } = useEditorRuntime();
  const collaboration = useCollaborationActions();
  const inputRef = useRef<HTMLInputElement>(null);
  const cursorState = useHTMLInputCursorState(inputRef);
  const insertPointRef = useRef<PointRef | null>(null);
  const isSelectingCommandRef = useRef(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const listboxId = useId();
  const activeOptionRef = useRef<HTMLButtonElement>(null);

  const { refs, floatingStyles } = useFloating({
    middleware: [
      offset(4),
      flip({
        fallbackPlacements: ['top-start'],
        padding: 12,
      }),
      shift({ padding: 12 }),
      size({
        apply({ availableHeight, elements }) {
          elements.floating.style.setProperty(
            '--slash-available-height',
            `${Math.max(0, availableHeight)}px`
          );
        },
        padding: 12,
      }),
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
    const availableCommands = collaborationCommand
      ? [...EDITOR_COMMANDS, collaborationCommand]
      : EDITOR_COMMANDS;

    const matching = availableCommands.filter(
      (command) =>
        enabled[command.group] &&
        isEditorCommandAllowed(command, allowExternalAssets) &&
        commandMatches(command, query)
    );
    return WIDGET_GROUPS.flatMap((group) =>
      matching.filter((command) => command.group === group.id)
    );
  }, [allowExternalAssets, canEdit, collaboration, enabled, query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => {
    activeOptionRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, commands]);

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
            aria-activedescendant={
              commands[activeIndex] ? `${listboxId}-${activeIndex}` : undefined
            }
            aria-controls={listboxId}
            aria-expanded={commands.length > 0}
            aria-label={m.editor_search_commands_aria()}
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
          <PopupMotion
            className="block max-h-[min(80vh,38rem,var(--slash-available-height,38rem))] w-72 overflow-auto rounded-lg border border-overlay-line bg-overlay px-1 pt-2 pb-1.5 font-medium text-fg text-sm leading-(--body-line-height) shadow-pop"
            id={listboxId}
            open
            positionClassName="z-50"
            positionRef={refs.setFloating}
            role="listbox"
            style={floatingStyles}
          >
            {commands.length ? (
              WIDGET_GROUPS.map((group) => {
                const items = commands.filter(
                  (command) => command.group === group.id
                );
                if (!items.length) return null;
                return (
                  <ToolbarPopoverGroup
                    key={group.id}
                    label={group.label}
                    role="group"
                  >
                    {items.map((command) => {
                      const index = commands.indexOf(command);
                      return (
                        <ToolbarPopoverItem
                          aria-selected={index === activeIndex}
                          className="aria-selected:bg-overlay-hover"
                          icon={<EditorIcon name={command.icon} />}
                          id={`${listboxId}-${index}`}
                          key={command.id}
                          label={command.label}
                          onClick={() => select(index)}
                          onMouseDown={(event) => event.preventDefault()}
                          // A menu opening or scrolling under a resting pointer fires
                          // enter events with no movement; only real motion selects.
                          onMouseMove={(event) => {
                            if (event.movementX || event.movementY)
                              setActiveIndex(index);
                          }}
                          ref={
                            index === activeIndex ? activeOptionRef : undefined
                          }
                          role="option"
                          shortcut={command.shortcut}
                          tabIndex={-1}
                        />
                      );
                    })}
                  </ToolbarPopoverGroup>
                );
              })
            ) : (
              <span className="block px-2 py-3 text-fg-muted text-sm">
                {m.editor_commands_none()}
              </span>
            )}
          </PopupMotion>
        </FloatingPortal>
      </span>
      {props.children}
    </PlateElement>
  );
}
