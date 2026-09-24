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
  useEditorSelector,
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
import {
  EDITOR_SHORTCUTS,
  MarkToolbarButton,
  ToolbarButton,
} from './toolbar/ToolbarButton';

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
    hideToolbar: hideForAi,
  });
  const { clickOutsideRef, hidden, props, ref } = useFloatingToolbar(state);

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
