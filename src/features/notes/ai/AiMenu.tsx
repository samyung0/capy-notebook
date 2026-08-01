import { AIChatPlugin } from '@platejs/ai/react';
import {
  FloatingPortal,
  flip,
  getRangeBoundingClientRect,
  offset,
  shift,
  useVirtualFloating,
} from '@platejs/floating';
import {
  BlockMenuPlugin,
  BlockSelectionPlugin,
} from '@platejs/selection/react';
import {
  Check,
  Feather,
  ListMinus,
  ListPlus,
  LoaderCircle,
  PenLine,
  RotateCcw,
  Sparkles,
  WandSparkles,
  X,
} from 'lucide-react';
import {
  useEditorRef,
  useEditorSelector,
  usePluginOption,
} from 'platejs/react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { applyAiPreview, setAiPreview, useAiPreview } from './aiPreviewState';

interface AiAction {
  icon: typeof Sparkles;
  id: string;
  label: string;
  mode?: 'chat' | 'insert';
  prompt: string;
  toolName: 'comment' | 'edit' | 'generate';
}

const ACTIONS: AiAction[] = [
  {
    icon: PenLine,
    id: 'continue',
    label: 'Continue writing',
    mode: 'insert',
    prompt:
      'Continue writing after the current block with one concise sentence.',
    toolName: 'generate',
  },
  {
    icon: WandSparkles,
    id: 'improve',
    label: 'Improve writing',
    prompt:
      'Improve clarity and flow without changing the meaning or adding new information.',
    toolName: 'edit',
  },
  {
    icon: Check,
    id: 'grammar',
    label: 'Fix spelling and grammar',
    prompt:
      'Fix spelling, grammar, and punctuation without changing the meaning or tone.',
    toolName: 'edit',
  },
  {
    icon: ListMinus,
    id: 'shorter',
    label: 'Make shorter',
    prompt: 'Reduce verbosity while preserving all essential information.',
    toolName: 'edit',
  },
  {
    icon: ListPlus,
    id: 'longer',
    label: 'Make longer',
    prompt:
      'Elaborate on existing ideas without introducing unsupported information.',
    toolName: 'edit',
  },
  {
    icon: Feather,
    id: 'simplify',
    label: 'Simplify language',
    prompt: 'Use clearer, more direct language while preserving the meaning.',
    toolName: 'edit',
  },
];

export function AiMenu() {
  const editor = useEditorRef();
  const open = usePluginOption(AIChatPlugin, 'open');
  const chat = usePluginOption(AIChatPlugin, 'chat');
  const chatSelection = usePluginOption(AIChatPlugin, 'chatSelection');
  const streaming = usePluginOption(AIChatPlugin, 'streaming');
  const preview = useAiPreview(editor);
  const [input, setInput] = useState('');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const loading =
    chat.status === 'streaming' || chat.status === 'submitted' || streaming;

  useEffect(() => {
    if (!open) return;

    editor.getApi(BlockMenuPlugin).blockMenu.hide();
    const close = () =>
      editor.getApi(AIChatPlugin).aiChat.hide({ focus: false });
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [editor, open]);

  const floating = useVirtualFloating({
    getBoundingClientRect: () => {
      const blocks = editor
        .getApi(BlockSelectionPlugin)
        .blockSelection.getNodes();
      const range =
        blocks.length > 0
          ? (editor.api.nodesRange(blocks) ?? null)
          : (chatSelection ?? editor.selection ?? null);
      return getRangeBoundingClientRect(editor, range);
    },
    middleware: [
      offset(4),
      flip({
        fallbackPlacements: ['top-start'],
        padding: 12,
      }),
      shift({ padding: 12 }),
    ],
    open,
    placement: 'bottom-start',
    strategy: 'fixed',
  });

  useEditorSelector(() => {
    floating.update?.();
  }, [floating.update]);

  useEffect(() => {
    floating.update?.();
  }, [floating.update, open]);

  if (!open) return null;

  const submit = (
    prompt: string,
    options: { toolName?: AiAction['toolName']; mode?: AiAction['mode'] } = {}
  ) => {
    if (!prompt.trim() || loading) return;
    const savedSelection = editor.getOption(AIChatPlugin, 'chatSelection');
    const selectedBlocks = editor
      .getApi(BlockSelectionPlugin)
      .blockSelection.getNodes();
    const contextSelection =
      selectedBlocks.length > 0
        ? (editor.api.nodesRange(selectedBlocks) ?? null)
        : (savedSelection ?? null);
    const toolName = options.toolName ?? 'generate';

    if (savedSelection && selectedBlocks.length === 0) {
      editor.tf.select(structuredClone(savedSelection));
    }
    void editor.getApi(AIChatPlugin).aiChat.submit('', {
      mode: options.mode,
      // Plate normally reads editor.selection here. The native input owns focus,
      // so pass the opening snapshot explicitly instead of relying on focus state.
      options: {
        body: {
          ctx: {
            children: editor.children,
            selection: contextSelection,
            toolName,
          },
        },
      },
      prompt,
      toolName,
    });
    setInput('');
  };

  return (
    <FloatingPortal>
      <div
        aria-label="AI commands"
        className="z-50 w-[min(360px,calc(100vw-32px))] overflow-hidden rounded-button border border-line bg-surface shadow-pop"
        onPointerDown={(event) => event.stopPropagation()}
        ref={floating.refs.setFloating}
        role="dialog"
        style={floating.style}
      >
        <div className="flex items-center border-divider border-b px-2">
          <Sparkles className="size-4 text-action-accent" />
          <input
            autoFocus
            className="h-10 min-w-0 flex-1 bg-transparent px-2 text-fg text-sm outline-none placeholder:text-placeholder"
            data-plate-focus="true"
            disabled={loading}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit(input);
              }
              if (event.key === 'Escape')
                editor.getApi(AIChatPlugin).aiChat.hide();
            }}
            placeholder="Ask AI anything"
            value={input}
          />
          <button
            aria-label="Close AI commands"
            className="rounded-button p-1 text-fg-muted hover:bg-surface-hover-bg"
            onClick={() => editor.getApi(AIChatPlugin).aiChat.hide()}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>

        {loading ? (
          <div className="flex items-center justify-between gap-2 p-3 text-fg-muted text-sm">
            <span className="flex items-center gap-2">
              <LoaderCircle className="size-4 animate-spin" />
              {chat.status === 'submitted' ? 'Thinking…' : 'Writing…'}
            </span>
            <Button
              onClick={() => editor.getApi(AIChatPlugin).aiChat.stop()}
              size="sm"
              variant="ghost"
            >
              Stop
            </Button>
          </div>
        ) : preview ? (
          <div className="flex flex-col gap-2 p-2">
            <p className="px-1 font-medium text-sm">Review the AI preview</p>
            <div className="max-h-56 overflow-auto rounded-card border border-divider bg-surface-secondary p-2 font-mono text-xs">
              {preview.originalText && (
                <p className="whitespace-pre-wrap bg-tint-error text-solid-error line-through">
                  {preview.originalText}
                </p>
              )}
              <p className="whitespace-pre-wrap bg-tint-success text-solid-success">
                {preview.proposedText || 'Generated block changes'}
              </p>
            </div>
            {previewError && (
              <p className="px-1 text-sm text-solid-error">{previewError}</p>
            )}
            <div className="flex justify-end gap-1">
              <Button
                onClick={() => {
                  setAiPreview(editor, null);
                  setPreviewError(null);
                  editor.getApi(AIChatPlugin).aiChat.hide();
                }}
                size="sm"
                variant="ghost"
              >
                Reject
              </Button>
              <Button
                onClick={() => {
                  try {
                    applyAiPreview(editor);
                    setPreviewError(null);
                    editor.getApi(AIChatPlugin).aiChat.hide();
                  } catch (cause) {
                    setPreviewError(
                      cause instanceof Error
                        ? cause.message
                        : 'The target changed; retry the AI command'
                    );
                  }
                }}
                size="sm"
                variant="accent"
              >
                Accept
              </Button>
            </div>
          </div>
        ) : (
          <div className="max-h-72 overflow-auto p-1">
            {ACTIONS.map((action) => {
              const Icon = action.icon;
              return (
                <button
                  className={cn(
                    'flex w-full items-center gap-2 rounded-button px-2 py-2 text-left text-fg text-sm',
                    'hover:bg-surface-hover-bg'
                  )}
                  key={action.id}
                  onClick={() =>
                    submit(action.prompt, {
                      mode: action.mode,
                      toolName: action.toolName,
                    })
                  }
                  type="button"
                >
                  <Icon className="size-4 text-fg-muted" />
                  {action.label}
                </button>
              );
            })}
            {chat.messages.length > 0 && (
              <button
                className="flex w-full items-center gap-2 rounded-button px-2 py-2 text-left text-fg text-sm hover:bg-surface-hover-bg"
                onClick={() => void editor.getApi(AIChatPlugin).aiChat.reload()}
                type="button"
              >
                <RotateCcw className="size-4 text-fg-muted" />
                Try again
              </button>
            )}
          </div>
        )}
      </div>
    </FloatingPortal>
  );
}
