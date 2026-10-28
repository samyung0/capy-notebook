import { CopilotPlugin } from '@platejs/ai/react';
import { serializeMd } from '@platejs/markdown';
import { NodeApi, type SlateEditor, type TElement } from 'platejs';
import { userToast } from '@/components/ui/userToast';
import { describeError } from '@/lib/errors';
import { GhostText } from './GhostTextView';
import {
  contextBefore,
  creditsRanOut,
  endsAtTrigger,
  GHOST_DEBOUNCE_MS,
  ghostTextPaused,
  ghostTextState,
  requestGhostText,
} from './ghostText';

const isOn = (editor: SlateEditor) => ghostTextState(editor)?.enabled === true;

/** Keys decided in MI:225: ⌥Space asks and ⌥→ takes one word on Apple. */
const IS_APPLE =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

const TRAILING_SPACE = /\s*$/;

/** Markdown of each top-level block from the caret's backwards. The caret
 * sits at the end of its block (triggerQuery), so that block is whole; its
 * trailing space survives serialization so the server can join at the caret. */
function* blocksBackwards(editor: SlateEditor, index: number) {
  for (let i = index; i >= 0; i--) {
    const block = editor.children[i] as TElement;
    const markdown = serializeMd(editor, { value: [block] });
    if (i === index) {
      const space = TRAILING_SPACE.exec(NodeApi.string(block))?.[0] ?? '';
      yield markdown.trimEnd() + space;
    } else {
      yield markdown.trim();
    }
  }
}

/** Plate posts this string as the prompt; ghostTextFetch sends it on. */
function ghostPrompt(editor: SlateEditor): string {
  const entry = editor.api.block({ highest: true });
  if (!entry) return '';
  const before = contextBefore(blocksBackwards(editor, entry[1][0] ?? 0));
  if (!before.trim()) return '';
  return JSON.stringify({
    after: '',
    before,
    title: ghostTextState(editor)?.title ?? '',
  });
}

/** Plate's completion call reads `{ text }` from a fetch Response; this runs
 * the request through the API client so a refusal arrives as an ApiError. */
function ghostTextFetch(workspaceId: string): typeof fetch {
  return async (_input, init) => {
    const { prompt } = JSON.parse(String(init?.body)) as { prompt: string };
    const text = await requestGhostText(
      workspaceId,
      JSON.parse(prompt),
      init?.signal ?? undefined
    );
    return Response.json({ text });
  };
}

export function ghostTextPlugin(workspaceId: string) {
  return CopilotPlugin.configure(({ api, editor }) => ({
    options: {
      autoTriggerQuery: () => {
        if (!isOn(editor) || ghostTextPaused()) return false;
        if (editor.getOption(CopilotPlugin, 'suggestionText')) return false;
        if (editor.api.isComposing()) return false;
        const block = editor.api.block();
        return !!block && endsAtTrigger(NodeApi.string(block[0]));
      },
      completeOptions: {
        fetch: ghostTextFetch(workspaceId),
        onError: (error) => {
          if (!creditsRanOut(error)) return;
          const { description, title } = describeError(error);
          userToast({
            description,
            id: 'note-ghost-text-credits',
            title,
            variant: 'error',
          });
        },
        onFinish: (prompt, completion) => {
          // An answer for text the caret has since left is dropped.
          if (completion && prompt === ghostPrompt(editor)) {
            api.copilot.setBlockSuggestion({ text: completion });
          }
        },
      },
      debounceDelay: GHOST_DEBOUNCE_MS,
      getPrompt: () => ghostPrompt(editor),
      renderGhostText: GhostText,
      triggerQuery: () =>
        isOn(editor) &&
        editor.api.isCollapsed() &&
        editor.api.isAt({ end: true }),
    },
    // Unhandled keys return false, so Plate leaves them to the editor.
    shortcuts: {
      accept: {
        handler: () => editor.getTransforms(CopilotPlugin).copilot.accept(),
        keys: 'tab',
      },
      acceptNextWord: {
        handler: () =>
          editor.getTransforms(CopilotPlugin).copilot.acceptNextWord(),
        keys: IS_APPLE ? 'alt+right' : 'ctrl+right',
      },
      reject: {
        handler: () => api.copilot.reject(),
        keys: 'escape',
      },
      triggerSuggestion: {
        handler: () => {
          if (!isOn(editor)) return false;
          void api.copilot.triggerSuggestion();
        },
        keys: IS_APPLE ? 'alt+space' : 'ctrl+space',
      },
    },
  })).overrideEditor(({ api, getOptions, tf: { apply } }) => ({
    transforms: {
      // Plate keeps a request running through edits; any change to the text
      // or the caret cancels it instead.
      apply(operation) {
        const { isLoading, shouldAbort } = getOptions();
        if (isLoading && shouldAbort) api.copilot.stop();
        apply(operation);
      },
    },
  }));
}
