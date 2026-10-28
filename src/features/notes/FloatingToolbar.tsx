import {
  flip,
  offset,
  useFloatingToolbar,
  useFloatingToolbarState,
} from '@platejs/floating';
import { KEYS } from 'platejs';
import {
  useEditorId,
  useEditorRef,
  useEditorSelector,
  useEventEditorValue,
} from 'platejs/react';
import { FloatingToolbar as SharedFloatingToolbar } from '@/components/ui/BlockToolbar';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { m } from '@/i18n';
import { useCollaborationActions } from './Collaboration';
import { useEditorRuntime } from './EditorRuntime';
import { insertInlineEquation } from './editorCommands';
import {
  EDITOR_SHORTCUTS,
  MarkToolbarButton,
  ToolbarButton,
} from './toolbar/ToolbarButton';

export function FloatingToolbar() {
  const editor = useEditorRef();
  const inLink = useEditorSelector(
    (ed) => ed.api.some({ match: { type: KEYS.link } }),
    []
  );
  const editorId = useEditorId();
  const focusedEditorId = useEventEditorValue('focus');
  const { canEdit } = useEditorRuntime();
  const collaboration = useCollaborationActions();
  const state = useFloatingToolbarState({
    editorId,
    floatingOptions: {
      middleware: [
        offset(10),
        flip({
          fallbackPlacements: [
            'top-start',
            'top-end',
            'bottom-start',
            'bottom-end',
          ],
          padding: 12,
        }),
      ],
      placement: 'top',
    },
    focusedEditorId,
  });
  const { clickOutsideRef, hidden, props, ref } = useFloatingToolbar(state);

  return (
    <div ref={clickOutsideRef}>
      <SharedFloatingToolbar
        {...props}
        aria-label={m.editor_selection_actions()}
        open={!hidden}
        positionClassName="absolute z-50"
        positionRef={ref}
        role="toolbar"
      >
        <MarkToolbarButton
          label={m.editor_bold()}
          markKey={KEYS.bold}
          shortcut={EDITOR_SHORTCUTS.bold}
          tooltipSide="top"
        >
          <EditorIcon name="bold" />
        </MarkToolbarButton>
        <MarkToolbarButton
          label={m.editor_italic()}
          markKey={KEYS.italic}
          shortcut={EDITOR_SHORTCUTS.italic}
          tooltipSide="top"
        >
          <EditorIcon name="italic" />
        </MarkToolbarButton>
        <MarkToolbarButton
          label={m.editor_underline()}
          markKey={KEYS.underline}
          shortcut={EDITOR_SHORTCUTS.underline}
          tooltipSide="top"
        >
          <EditorIcon name="underline" />
        </MarkToolbarButton>
        <MarkToolbarButton
          label={m.editor_strikethrough()}
          markKey={KEYS.strikethrough}
          shortcut={EDITOR_SHORTCUTS.strikethrough}
          tooltipSide="top"
        >
          <EditorIcon name="strikethrough" />
        </MarkToolbarButton>
        <MarkToolbarButton
          label={m.editor_inline_code()}
          markKey={KEYS.code}
          shortcut={EDITOR_SHORTCUTS.code}
          tooltipSide="top"
        >
          <EditorIcon name="code" />
        </MarkToolbarButton>
        <ToolbarButton
          label={m.editor_inline_equation()}
          onClick={() => insertInlineEquation(editor)}
          tooltipSide="top"
        >
          <EditorIcon name="sigma" />
        </ToolbarButton>
        <ToolbarButton
          active={inLink}
          label={m.editor_link()}
          onClick={() =>
            (
              document.querySelector(
                `button[aria-label="${m.editor_link()}"]`
              ) as HTMLButtonElement | null
            )?.click()
          }
          tooltipSide="top"
        >
          <EditorIcon name="link" />
        </ToolbarButton>
        {canEdit && collaboration && (
          <ToolbarButton
            label={m.editor_comment()}
            onClick={collaboration.openComment}
            tooltipSide="top"
          >
            <EditorIcon name="commentAdd" />
          </ToolbarButton>
        )}
      </SharedFloatingToolbar>
    </div>
  );
}
