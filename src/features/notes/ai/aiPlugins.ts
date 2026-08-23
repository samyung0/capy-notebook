import { useChat as useBaseChat } from '@ai-sdk/react';
import {
  AIChatPlugin,
  AIPlugin,
  aiCommentToRange,
  CopilotPlugin,
  useChatChunk,
} from '@platejs/ai/react';
import { serializeMd, stripMarkdown } from '@platejs/markdown';
import { CursorOverlayPlugin } from '@platejs/selection/react';
import { slateRangeToRelativeRange, type YjsEditor } from '@slate-yjs/core';
import type { TElement } from 'platejs';
import { useEditorRef, usePluginOption } from 'platejs/react';
import { useEffect, useMemo, useRef } from 'react';
import * as Y from 'yjs';
import { useCreateMaterialDiscussion } from '@/api/hooks';
import {
  createPlateAiTransport,
  plateAiCopilotUrl,
  plateAiFetch,
} from '@/api/plateAiTransport';
import { userToast } from '@/components/ui/userToast';
import { m } from '@/i18n';
import { llmKeyUserMessage } from '@/lib/errors';
import { useEditorRuntime } from '../EditorRuntime';
import { openAiMenu } from './aiMenuState';
import { getAiPreview, setAiPreview } from './aiPreviewState';
import {
  AiAnchorElement,
  AiCursorOverlay,
  AiLeaf,
  AiLoadingBar,
  GhostText,
} from './PlateAi';

/* The AI SDK data parts emitted by the Go adapter. */
type PlateToolName = 'comment' | 'edit' | 'generate';
type PlateDataPart = {
  toolName: PlateToolName;
  table?: {
    status: 'finished' | 'streaming';
    cellUpdate: { id: string; content: string } | null;
  };
  comment?: {
    status: 'finished' | 'streaming';
    comment: { blockId: string; comment: string; content: string } | null;
  };
};

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function usePlateChat(workspaceId: string) {
  const editor = useEditorRef();
  const { materialId } = useEditorRuntime();
  const { mutate: createDiscussion } = useCreateMaterialDiscussion(materialId);
  const transport = useMemo(
    () => createPlateAiTransport(workspaceId),
    [workspaceId]
  );
  const chat = useBaseChat<
    import('ai').UIMessage<Record<string, never>, PlateDataPart>
  >({
    id: `plate-${materialId}`,
    onData(part) {
      if (part.type === 'data-toolName') {
        editor.setOption(AIChatPlugin, 'toolName', part.data as PlateToolName);
        return;
      }
      if (part.type === 'data-table' && part.data) {
        const data = part.data as PlateDataPart['table'];
        if (data?.status === 'streaming' && data.cellUpdate) {
          const current = getAiPreview(editor);
          const updates = [...(current?.tableUpdates ?? [])];
          const index = updates.findIndex(
            (entry) => entry.id === data.cellUpdate?.id
          );
          if (index >= 0) updates[index] = data.cellUpdate;
          else updates.push(data.cellUpdate);
          setAiPreview(editor, {
            kind: 'table',
            originalText: '',
            proposedText: updates
              .map((entry) => `${entry.id}: ${entry.content}`)
              .join('\n'),
            tableUpdates: updates,
          });
        }
        return;
      }
      if (part.type === 'data-comment' && part.data) {
        const data = part.data as PlateDataPart['comment'];
        if (!data?.comment || data.status !== 'finished') return;
        const range = aiCommentToRange(editor, data.comment);
        if (!range) return;
        const yjsEditor = editor as typeof editor & YjsEditor;
        if (!yjsEditor.sharedRoot) return;
        const relative = slateRangeToRelativeRange(
          yjsEditor.sharedRoot,
          editor,
          range
        );
        createDiscussion({
          anchorEnd: bytesToBase64(Y.encodeRelativePosition(relative.focus)),
          anchorQuote: editor.api.string(range).slice(0, 1000),
          anchorStart: bytesToBase64(Y.encodeRelativePosition(relative.anchor)),
          anchorVersion: 1,
          blockId: data.comment.blockId,
          contentRich: [
            { children: [{ text: data.comment.comment }], type: 'p' },
          ],
        });
      }
    },
    transport,
  });
  // AI SDK v4 returns a new helpers object on every render. Plate stores plugin
  // options externally, so writing that changing reference causes a render loop.
  const stableChatRef = useRef({ ...chat });
  Object.assign(stableChatRef.current, chat);

  useEffect(() => {
    if (editor.getOption(AIChatPlugin, 'chat') !== stableChatRef.current) {
      editor.setOption(AIChatPlugin, 'chat', stableChatRef.current as never);
    }
  }, [editor]);

  return stableChatRef.current;
}

function createAiChatPlugin(workspaceId: string) {
  return AIChatPlugin.extend({
    options: {
      chatOptions: {
        api: `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/command`,
        body: {},
      },
    },
    render: {
      afterContainer: AiLoadingBar,
      node: AiAnchorElement,
    },
    shortcuts: {
      show: {
        handler: ({ editor }) => {
          openAiMenu(editor);
          return true;
        },
        keys: 'mod+j',
      },
    },
    useHooks: ({ editor, getOption }) => {
      usePlateChat(workspaceId);
      const mode = usePluginOption(AIChatPlugin, 'mode');
      const toolName = usePluginOption(AIChatPlugin, 'toolName');
      useChatChunk({
        onChunk: ({ chunk, isFirst, nodes, text }) => {
          if (isFirst && mode === 'insert') {
            const block = editor.api.block({ highest: true })?.[0] as
              | TElement
              | undefined;
            setAiPreview(editor, {
              insertAfterId:
                typeof block?.id === 'string' ? block.id : undefined,
              kind: 'insert',
              nodes: [],
              originalText: '',
              proposedText: '',
            });
            editor.setOption(AIChatPlugin, 'streaming', true);
          }
          if (mode === 'insert' && nodes.length > 0) {
            const current = getAiPreview(editor);
            if (getOption('streaming')) {
              setAiPreview(editor, {
                insertAfterId: current?.insertAfterId,
                kind: 'insert',
                nodes: [
                  {
                    children: [{ text: stripMarkdown(text || chunk) }],
                    type: 'p',
                  } as TElement,
                ],
                originalText: '',
                proposedText: text || chunk,
              });
            }
          }
          if (toolName === 'edit' && mode === 'chat') {
            const current = getAiPreview(editor);
            const range =
              editor.getOption(AIChatPlugin, 'chatSelection') ??
              editor.selection;
            if (!current && range) {
              const yjsEditor = editor as typeof editor & YjsEditor;
              if (yjsEditor.sharedRoot) {
                setAiPreview(editor, {
                  kind: 'edit',
                  originalText: editor.api.string(range),
                  proposedText: text,
                  targetRange: slateRangeToRelativeRange(
                    yjsEditor.sharedRoot,
                    editor,
                    range
                  ),
                });
              }
            } else if (current?.kind === 'edit') {
              setAiPreview(editor, {
                ...current,
                proposedText: text,
              });
            }
          }
        },
        onFinish: () => editor.getApi(AIChatPlugin).aiChat.stop(),
      });
    },
  });
}

const COPILOT_INSTRUCTIONS =
  'Continue naturally to the next punctuation mark. Preserve tone, do not repeat text, and do not start a new block. Return 0 when no useful continuation exists.';

function createCopilotPlugin(workspaceId: string) {
  return CopilotPlugin.configure(({ api }) => ({
    options: {
      completeOptions: {
        api: plateAiCopilotUrl(workspaceId),
        body: { instructions: COPILOT_INSTRUCTIONS },
        fetch: plateAiFetch,
        onError: (error: unknown) => {
          userToast({
            description:
              llmKeyUserMessage(error) ?? m.editor_ai_suggestion_body(),
            id: 'plate-copilot-error',
            title: m.editor_ai_suggestion_title(),
            variant: 'error',
          });
        },
        onFinish: (_, completion) => {
          if (completion && completion !== '0') {
            api.copilot.setBlockSuggestion({ text: stripMarkdown(completion) });
          }
        },
      },
      debounceDelay: 500,
      getPrompt: ({ editor }) => {
        const context = editor.api.block({ highest: true });
        if (!context) return '';
        return serializeMd(editor, {
          value: [context[0] as TElement],
        });
      },
      renderGhostText: GhostText,
    },
    shortcuts: {
      accept: { keys: 'tab' },
      acceptNextWord: { keys: 'mod+right' },
      reject: { keys: 'escape' },
      triggerSuggestion: { keys: 'ctrl+space' },
    },
  }));
}

export function buildAiPlugins(workspaceId: string) {
  return [
    createCopilotPlugin(workspaceId),
    AIPlugin.withComponent(AiLeaf),
    createAiChatPlugin(workspaceId),
    CursorOverlayPlugin.configure({
      render: { afterEditable: AiCursorOverlay },
    }),
  ];
}
