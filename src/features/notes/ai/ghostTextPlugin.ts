import {
  CopilotPlugin,
  triggerCopilotSuggestion,
  withoutAbort,
} from '@platejs/ai/react';
import { serializeMd } from '@platejs/markdown';
import { YjsEditor } from '@slate-yjs/core';
import {
  NodeApi,
  type Operation,
  type SlateEditor,
  type TElement,
} from 'platejs';
import { isApiError } from '@/api/client';
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
  setGhostTextState,
} from './ghostText';

const isOn = (editor: SlateEditor) => ghostTextState(editor)?.enabled === true;

/** Below `sm` the suggestion is hidden and phone keyboards have no Tab, so
 * nothing triggers there (Epo 2026-10-28). */
const WIDE_ENOUGH = '(min-width: 640px)';

/** The caret's block when ghost text may run in it: a top-level text block,
 * never a cell, callout, column or code line (Epo 2026-10-28). */
function caretBlock(editor: SlateEditor) {
  const entry = editor.api.block();
  return entry && entry[1].length === 1 ? entry : undefined;
}

/** The caret's block and its text: an answer is shown only while these are
 * what the request was asked about. */
function caretKey(editor: SlateEditor): string {
  const entry = caretBlock(editor);
  return entry ? `${String(entry[0].id)}\n${NodeApi.string(entry[0])}` : '';
}

const askedFor = new WeakMap<object, string>();

const isRemote = (editor: SlateEditor) =>
  YjsEditor.isYjsEditor(editor) && !YjsEditor.isLocal(editor);

/** A collaborator's edit matters only in the caret's block (Epo 2026-10-28). */
const touchesCaretBlock = (editor: SlateEditor, operation: Operation) =>
  'path' in operation &&
  (operation.path as number[])[0] === editor.selection?.anchor.path[0];

/** Keys decided in MI:225: ⌥Space asks and ⌥→ takes one word on Apple. */
const IS_APPLE =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);

const TRAILING_SPACE = /\s*$/;
// The serializer writes a block's trailing spaces as `&#x20;`.
const TRAILING_MARKDOWN_SPACE = /(?:\s|&#x20;)+$/;

/** Markdown of each top-level block from the caret's backwards. The caret
 * sits at the end of its block (triggerQuery), so that block is whole; its
 * trailing space goes back as plain text so the server can join at the caret. */
function* blocksBackwards(editor: SlateEditor, index: number) {
  for (let i = index; i >= 0; i--) {
    const block = editor.children[i] as TElement;
    const markdown = serializeMd(editor, { value: [block] })
      .replace(TRAILING_MARKDOWN_SPACE, '')
      .trimStart();
    if (i === index) {
      yield markdown + (TRAILING_SPACE.exec(NodeApi.string(block))?.[0] ?? '');
    } else {
      yield markdown;
    }
  }
}

/** Plate posts this string as the prompt; ghostTextFetch sends it on. */
function ghostPrompt(editor: SlateEditor): string {
  const entry = caretBlock(editor);
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
          // Turned off on another device: stop asking until this tab learns it.
          if (isApiError(error) && error.code === 'note_ai_disabled') {
            setGhostTextState(editor, {
              enabled: false,
              title: ghostTextState(editor)?.title ?? '',
            });
            return;
          }
          if (!creditsRanOut(error)) return;
          const { description, title } = describeError(error);
          userToast({
            description,
            id: 'note-ghost-text-credits',
            title,
            variant: 'error',
          });
        },
        onFinish: (_prompt, completion) => {
          // An answer for text the caret has since left is dropped.
          if (
            completion &&
            isOn(editor) &&
            caretKey(editor) === askedFor.get(editor)
          ) {
            api.copilot.setBlockSuggestion({ text: completion });
          }
        },
      },
      debounceDelay: GHOST_DEBOUNCE_MS,
      getPrompt: () => {
        askedFor.set(editor, caretKey(editor));
        return ghostPrompt(editor);
      },
      renderGhostText: GhostText,
      triggerQuery: () =>
        isOn(editor) &&
        window.matchMedia(WIDE_ENOUGH).matches &&
        editor.api.isCollapsed() &&
        !!caretBlock(editor) &&
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
          // Asked for, so no pause first.
          void triggerCopilotSuggestion(editor);
        },
        keys: IS_APPLE ? 'alt+space' : 'ctrl+space',
      },
    },
  })).overrideEditor(({ api, editor, getOptions, tf: { apply } }) => ({
    transforms: {
      // Any local change to the text or the caret cancels the pending trigger
      // and a running request (Plate lets both run on); a collaborator's edit
      // elsewhere leaves the suggestion and the request alone.
      apply(operation) {
        if (!getOptions().shouldAbort) return apply(operation);
        if (isRemote(editor) && !touchesCaretBlock(editor, operation)) {
          withoutAbort(editor, () => apply(operation));
          return;
        }
        api.copilot.stop();
        apply(operation);
      },
    },
  }));
}
