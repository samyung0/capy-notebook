import { AIChatPlugin } from '@platejs/ai/react';
import {
  flip,
  offset,
  useFloatingToolbar,
  useFloatingToolbarState,
} from '@platejs/floating';
import {
  Bold,
  Code2,
  Italic,
  Link,
  MessageSquarePlus,
  Sigma,
  Sparkles,
  Strikethrough,
  Underline,
} from 'lucide-react';
import { KEYS } from 'platejs';
import {
  useEditorId,
  useEditorRef,
  useEventEditorValue,
  usePluginOption,
} from 'platejs/react';
import { ButtonTooltip } from '@/components/ui/Tooltip';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { openAiMenu } from './ai/aiMenuState';
import { useCollaborationActions } from './Collaboration';
import { useEditorRuntime } from './EditorRuntime';
import { insertInlineEquation } from './editorCommands';
import { EDITOR_SHORTCUTS } from './toolbar/ToolbarButton';

export function FloatingToolbar() {
  const editor = useEditorRef();
  const editorId = useEditorId();
  const focusedEditorId = useEventEditorValue('focus');
  const aiOpen = usePluginOption(AIChatPlugin, 'open');
  const { canComment } = useEditorRuntime();
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
    hideToolbar: aiOpen,
  });
  const { clickOutsideRef, hidden, props, ref } = useFloatingToolbar(state);

  if (hidden) return null;

  const mark = (key: string) => {
    editor.tf.focus();
    editor.tf.toggleMark(key);
  };

  return (
    <div ref={clickOutsideRef}>
      <div
        {...props}
        aria-label={m.editor_selection_actions()}
        className="absolute z-50 flex max-w-[90vw] items-center gap-0.5 overflow-x-auto rounded-card border border-line bg-surface p-1 shadow-pop"
        ref={ref}
        role="toolbar"
      >
        <FloatingButton
          label={m.editor_ai_commands()}
          onClick={() => openAiMenu(editor)}
          shortcut={EDITOR_SHORTCUTS.ai}
        >
          <Sparkles /> <span className="pr-1 text-xs">{m.editor_ask_ai()}</span>
        </FloatingButton>
        <Separator />
        <FloatingButton
          label={m.editor_bold()}
          onClick={() => mark(KEYS.bold)}
          shortcut={EDITOR_SHORTCUTS.bold}
        >
          <Bold />
        </FloatingButton>
        <FloatingButton
          label={m.editor_italic()}
          onClick={() => mark(KEYS.italic)}
          shortcut={EDITOR_SHORTCUTS.italic}
        >
          <Italic />
        </FloatingButton>
        <FloatingButton
          label={m.editor_underline()}
          onClick={() => mark(KEYS.underline)}
          shortcut={EDITOR_SHORTCUTS.underline}
        >
          <Underline />
        </FloatingButton>
        <FloatingButton
          label={m.editor_strikethrough()}
          onClick={() => mark(KEYS.strikethrough)}
          shortcut={EDITOR_SHORTCUTS.strikethrough}
        >
          <Strikethrough />
        </FloatingButton>
        <FloatingButton
          label={m.editor_inline_code()}
          onClick={() => mark(KEYS.code)}
          shortcut={EDITOR_SHORTCUTS.code}
        >
          <Code2 />
        </FloatingButton>
        <FloatingButton
          label={m.editor_inline_equation()}
          onClick={() => insertInlineEquation(editor)}
        >
          <Sigma />
        </FloatingButton>
        <FloatingButton
          label={m.editor_link()}
          onClick={() =>
            (
              document.querySelector(
                `button[aria-label="${m.editor_link()}"]`
              ) as HTMLButtonElement | null
            )?.click()
          }
        >
          <Link />
        </FloatingButton>
        {canComment && collaboration && (
          <>
            <Separator />
            <FloatingButton
              label={m.editor_comment()}
              onClick={collaboration.openComment}
            >
              <MessageSquarePlus />
            </FloatingButton>
          </>
        )}
      </div>
    </div>
  );
}

function FloatingButton({
  label,
  shortcut,
  children,
  onClick,
  active,
}: {
  label: string;
  shortcut?: string;
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <ButtonTooltip label={label} shortcut={shortcut}>
      <button
        aria-label={label}
        aria-pressed={active}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1 rounded-button px-2 text-fg-secondary hover:bg-surface-hover-bg hover:text-fg [&_svg]:size-4',
          active && 'bg-tint-accent-1 text-tint-accent-1-fg'
        )}
        data-plate-prevent-deselect
        onClick={onClick}
        onMouseDown={(event) => event.preventDefault()}
        type="button"
      >
        {children}
      </button>
    </ButtonTooltip>
  );
}

function Separator() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-divider" />;
}
