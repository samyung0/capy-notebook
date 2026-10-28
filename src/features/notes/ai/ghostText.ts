/**
 * Note ghost text, editor-independent so the coming BlockSuite note shares it
 * with the Plate note (todo-ghost-text.md). The server owns the prompt: an
 * editor sends only the note title and the text around the caret.
 */
import { api, isCreditsExhaustedError } from '@/api/client';

/** The text before the caret stays within this many UTF-8 bytes (Epo 2026-10-28). */
export const GHOST_CONTEXT_BYTES = 1500;
const GHOST_TITLE_BYTES = 1024;
/** A suggestion is asked for after the user pauses this long. */
export const GHOST_DEBOUNCE_MS = 500;

export interface GhostTextContext {
  after: string;
  before: string;
  title: string;
}

const encoder = new TextEncoder();
const utf8Length = (text: string) => encoder.encode(text).length;

/** The longest end of `text` within `limit` bytes, cut between code points. */
function utf8Tail(text: string, limit: number): string {
  const chars = Array.from(text);
  let bytes = 0;
  let start = chars.length;
  while (start > 0) {
    const size = utf8Length(chars[start - 1] ?? '');
    if (bytes + size > limit) break;
    bytes += size;
    start--;
  }
  return chars.slice(start).join('');
}

function utf8Head(text: string, limit: number): string {
  const chars = Array.from(text);
  let bytes = 0;
  let end = 0;
  while (end < chars.length) {
    const size = utf8Length(chars[end] ?? '');
    if (bytes + size > limit) break;
    bytes += size;
    end++;
  }
  return chars.slice(0, end).join('');
}

/**
 * The text before the caret from Markdown blocks given newest first (the
 * caret's block, up to the caret, then the blocks above it). Whole blocks are
 * kept while they fit the byte window, so the text starts at a block start; a
 * caret block longer than the window keeps only its end.
 */
export function contextBefore(blocksBackwards: Iterable<string>): string {
  let out: string | null = null;
  let bytes = 0;
  for (const block of blocksBackwards) {
    if (out === null) {
      out =
        utf8Length(block) > GHOST_CONTEXT_BYTES
          ? utf8Tail(block, GHOST_CONTEXT_BYTES)
          : block;
      bytes = utf8Length(out);
      continue;
    }
    const next = bytes + utf8Length(block) + 2;
    if (next > GHOST_CONTEXT_BYTES) break;
    out = `${block}\n\n${out}`;
    bytes = next;
  }
  return out ?? '';
}

const CJK_END =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]$/u;

/** Typing triggers a suggestion after a space, or after a CJK character or
 * punctuation mark, since Chinese has no spaces (Epo 2026-10-28). */
export function endsAtTrigger(text: string): boolean {
  return text.endsWith(' ') || CJK_END.test(text);
}

export async function requestGhostText(
  workspaceId: string,
  context: GhostTextContext,
  signal?: AbortSignal
): Promise<string> {
  const { text } = await api.post<{ text: string }>(
    `/workspaces/${encodeURIComponent(workspaceId)}/ai/copilot`,
    { ...context, title: utf8Head(context.title, GHOST_TITLE_BYTES) },
    { signal }
  );
  return text;
}

interface GhostTextState {
  enabled: boolean;
  title: string;
}

// Set from the user's note AI switch and the note title while an editor is
// open, so flipping the switch never rebuilds the editor.
const states = new WeakMap<object, GhostTextState>();

export const ghostTextState = (editor: object) => states.get(editor);

export function setGhostTextState(editor: object, state: GhostTextState) {
  states.set(editor, state);
}

let creditsOut = false;

/** Auto-trigger stops once credits run out, until the page reloads. */
export const ghostTextPaused = () => creditsOut;

/**
 * Failed and busy suggestions stay silent. Returns true the first time a
 * refusal says credits ran out, so the caller shows its one toast
 * (Epo 2026-10-28).
 */
export function creditsRanOut(error: unknown): boolean {
  if (!isCreditsExhaustedError(error) || creditsOut) return false;
  creditsOut = true;
  return true;
}
