import { AIChatPlugin } from '@platejs/ai/react';
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
  useEventEditorValue,
  usePluginOption,
} from 'platejs/react';
import { PopupMotion } from '@/components/ui/PopupMotion';
import { EditorIcon } from '@/features/notes/EditorIcon';
import { m } from '@/i18n';
import { features } from '@/lib/features';
import { openAiMenu } from './ai/aiMenuState';
import { useCollaborationActions } from './Collaboration';
import { useEditorRuntime } from './EditorRuntime';
import { insertInlineEquation } from './editorCommands';
import { EDITOR_SHORTCUTS, ToolbarButton } from './toolbar/ToolbarButton';

export function FloatingToolbar() {
  return features.editorAi ? (
    <FloatingToolbarWithAi />
  ) : (
    <FloatingToolbarChrome hideForAi={false} showAi={false} />
  );
}

function FloatingToolbarWithAi() {
  const aiOpen = usePluginOption(AIChatPlugin, 'open');
  return <FloatingToolbarChrome hideForAi={aiOpen} showAi />;
}

function FloatingToolbarChrome({
  hideForAi,
  showAi,
}: {
  hideForAi: boolean;
  showAi: boolean;
}) {
  const editor = useEditorRef();
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
    hideToolbar: hideForAi,
  });
  const { clickOutsideRef, hidden, props, ref } = useFloatingToolbar(state);

  const mark = (key: string) => {
    editor.tf.focus();
    editor.tf.toggleMark(key);
  };

  return (
    <div ref={clickOutsideRef}>
      <PopupMotion
        {...props}
        aria-label={m.editor_selection_actions()}
        className="flex max-w-[90vw] items-center gap-0.5 overflow-x-auto rounded-card border border-line bg-surface p-1 shadow-pop"
        open={!hidden}
        positionClassName="absolute z-50"
        positionRef={ref}
        role="toolbar"
      >
        {showAi && (
          <>
            <ToolbarButton
              className="w-auto px-2"
              label={m.editor_ai_commands()}
              onClick={() => openAiMenu(editor)}
              shortcut={EDITOR_SHORTCUTS.ai}
              tooltipSide="top"
            >
              <EditorIcon name="sparkles" />{' '}
              <span className="pr-1 text-xs">{m.editor_ask_ai()}</span>
            </ToolbarButton>
            <Separator />
          </>
        )}
        <ToolbarButton
          label={m.editor_bold()}
          onClick={() => mark(KEYS.bold)}
          shortcut={EDITOR_SHORTCUTS.bold}
          tooltipSide="top"
        >
          <EditorIcon name="bold" />
        </ToolbarButton>
        <ToolbarButton
          label={m.editor_italic()}
          onClick={() => mark(KEYS.italic)}
          shortcut={EDITOR_SHORTCUTS.italic}
          tooltipSide="top"
        >
          <EditorIcon name="italic" />
        </ToolbarButton>
        <ToolbarButton
          label={m.editor_underline()}
          onClick={() => mark(KEYS.underline)}
          shortcut={EDITOR_SHORTCUTS.underline}
          tooltipSide="top"
        >
          <EditorIcon name="underline" />
        </ToolbarButton>
        <ToolbarButton
          label={m.editor_strikethrough()}
          onClick={() => mark(KEYS.strikethrough)}
          shortcut={EDITOR_SHORTCUTS.strikethrough}
          tooltipSide="top"
        >
          <EditorIcon name="strikethrough" />
        </ToolbarButton>
        <ToolbarButton
          label={m.editor_inline_code()}
          onClick={() => mark(KEYS.code)}
          shortcut={EDITOR_SHORTCUTS.code}
          tooltipSide="top"
        >
          <EditorIcon name="code" />
        </ToolbarButton>
        <ToolbarButton
          label={m.editor_inline_equation()}
          onClick={() => insertInlineEquation(editor)}
          tooltipSide="top"
        >
          <EditorIcon name="sigma" />
        </ToolbarButton>
        <ToolbarButton
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
          <>
            <Separator />
            <ToolbarButton
              label={m.editor_comment()}
              onClick={collaboration.openComment}
              tooltipSide="top"
            >
              <EditorIcon name="commentAdd" />
            </ToolbarButton>
          </>
        )}
      </PopupMotion>
    </div>
  );
}

function Separator() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-divider" />;
}
