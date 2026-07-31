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
import { cn } from '@/lib/cn';
import { openAiMenu } from './ai/aiMenuState';
import { useCollaborationActions } from './Collaboration';
import { useEditorRuntime } from './EditorRuntime';

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
        aria-label="Selection actions"
        className="absolute z-50 flex max-w-[90vw] items-center gap-0.5 overflow-x-auto rounded-card border border-line bg-surface p-1 shadow-pop"
        ref={ref}
        role="toolbar"
      >
        <FloatingButton label="AI commands" onClick={() => openAiMenu(editor)}>
          <Sparkles /> <span className="pr-1 text-xs">Ask AI</span>
        </FloatingButton>
        <Separator />
        <FloatingButton label="Bold" onClick={() => mark(KEYS.bold)}>
          <Bold />
        </FloatingButton>
        <FloatingButton label="Italic" onClick={() => mark(KEYS.italic)}>
          <Italic />
        </FloatingButton>
        <FloatingButton label="Underline" onClick={() => mark(KEYS.underline)}>
          <Underline />
        </FloatingButton>
        <FloatingButton
          label="Strikethrough"
          onClick={() => mark(KEYS.strikethrough)}
        >
          <Strikethrough />
        </FloatingButton>
        <FloatingButton label="Inline code" onClick={() => mark(KEYS.code)}>
          <Code2 />
        </FloatingButton>
        <FloatingButton
          label="Inline equation"
          onClick={() =>
            editor.tf.insertNodes({
              children: [{ text: '' }],
              texExpression: '',
              type: KEYS.inlineEquation,
            })
          }
        >
          <Sigma />
        </FloatingButton>
        <FloatingButton
          label="Link"
          onClick={() =>
            (
              document.querySelector(
                'button[aria-label="Link"]'
              ) as HTMLButtonElement | null
            )?.click()
          }
        >
          <Link />
        </FloatingButton>
        {canComment && collaboration && (
          <>
            <Separator />
            <FloatingButton label="Comment" onClick={collaboration.openComment}>
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
  children,
  onClick,
  active,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  active?: boolean;
}) {
  return (
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
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function Separator() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-divider" />;
}
