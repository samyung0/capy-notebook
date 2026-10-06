import * as Y from 'yjs';

export const SOURCE_TEXT_INPUT = Symbol('source-text-input');
const CARRIAGE_RETURNS = /\r\n|\r/g;
// The first newline only: without `g` the search stops there.
const NEWLINE = /\r\n|\r|\n/;

/**
 * How a source's text maps to its textarea's, which folds CRLF and CR to LF:
 * whether the source holds any `\r` (only then do offsets differ), and the
 * newline new lines take (the source's first). Read whenever the textarea is
 * filled from the source; local input never adds a `\r` of its own.
 */
export interface SourceLines {
  cr: boolean;
  newline: string;
}

export function sourceLines(raw: string): SourceLines {
  return {
    cr: raw.includes('\r'),
    newline: NEWLINE.exec(raw)?.[0] ?? '\n',
  };
}

export function displayText(value: string): string {
  return value.replace(CARRIAGE_RETURNS, '\n');
}

export function sourceTextOffset(value: string, displayOffset: number): number {
  let index = 0;
  for (
    let visible = 0;
    visible < displayOffset && index < value.length;
    visible++, index++
  )
    if (value[index] === '\r' && value[index + 1] === '\n') index++;
  return index;
}

export function displayTextOffset(value: string, sourceOffset: number): number {
  return displayText(value.slice(0, sourceOffset)).length;
}

/** One textarea edit in its own (LF) offsets: `[start, end)` becomes `insert`. */
export interface TextEdit {
  end: number;
  insert: string;
  start: number;
}

/** Apply one textarea edit to the shared text, in O(edit) unless the source
 * holds a `\r`. */
export function applyTextEdit(
  text: Y.Text,
  edit: TextEdit,
  lines: SourceLines,
  origin: unknown = SOURCE_TEXT_INPUT
) {
  let { end, start } = edit;
  if (lines.cr) {
    const raw = text.toString();
    start = sourceTextOffset(raw, start);
    end = sourceTextOffset(raw, end);
  }
  // Existing line endings stay untouched; new lines follow the source's.
  const insert =
    lines.newline === '\n'
      ? edit.insert
      : edit.insert.replaceAll('\n', lines.newline);
  if (end === start && !insert) return;
  text.doc!.transact(() => {
    if (end > start) text.delete(start, end - start);
    if (insert) text.insert(start, insert);
  }, origin);
}

/** Apply the textarea's whole value as its difference from the shared text:
 * for input whose place `textareaEdit` cannot tell. */
export function applyTextInput(
  text: Y.Text,
  value: string,
  lines: SourceLines,
  origin: unknown = SOURCE_TEXT_INPUT
) {
  const raw = text.toString();
  const before = lines.cr ? displayText(raw) : raw;
  let start = 0;
  while (
    start < before.length &&
    start < value.length &&
    before[start] === value[start]
  )
    start++;
  let oldEnd = before.length,
    newEnd = value.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    before[oldEnd - 1] === value[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  applyTextEdit(
    text,
    { end: oldEnd, insert: value.slice(start, newEnd), start },
    lines,
    origin
  );
}

const INSERTS = new Set([
  'insertText',
  'insertFromPaste',
  'insertLineBreak',
  'insertParagraph',
]);
const BACKWARD = new Set([
  'deleteContentBackward',
  'deleteWordBackward',
  'deleteSoftLineBackward',
  'deleteHardLineBackward',
]);
const FORWARD = new Set([
  'deleteContentForward',
  'deleteWordForward',
  'deleteSoftLineForward',
  'deleteHardLineForward',
]);

/** The textarea at a `beforeinput`: its selection, and its length for a
 * collapsed delete forward, the one edit whose size only the length tells. */
export interface InputStart {
  end: number;
  length: number | null;
  start: number;
}

export function inputStart(
  event: InputEvent,
  textarea: Pick<
    HTMLTextAreaElement,
    'selectionEnd' | 'selectionStart' | 'textLength'
  >
): InputStart {
  const { selectionEnd: end, selectionStart: start } = textarea;
  return {
    end,
    length:
      start === end && FORWARD.has(event.inputType)
        ? textarea.textLength
        : null,
    start,
  };
}

/**
 * The edit an `input` event made, from the textarea before it (`inputStart`)
 * and its caret after: typing, paste, Enter and the deletions, in O(edit).
 * Null for anything else (undo from a menu, a drop, IME, autocorrect) or an
 * edit that did not land where expected: the caller diffs the whole text.
 */
export function textareaEdit(
  event: Pick<InputEvent, 'data' | 'inputType'>,
  before: InputStart,
  textarea: Pick<HTMLTextAreaElement, 'selectionStart' | 'textLength' | 'value'>
): TextEdit | null {
  const { inputType } = event;
  const caret = textarea.selectionStart;
  if (INSERTS.has(inputType)) {
    const insert =
      inputType === 'insertLineBreak' || inputType === 'insertParagraph'
        ? '\n'
        : displayText(event.data ?? textarea.value.slice(before.start, caret));
    return caret === before.start + insert.length
      ? { end: before.end, insert, start: before.start }
      : null;
  }
  const deletes =
    BACKWARD.has(inputType) ||
    FORWARD.has(inputType) ||
    inputType === 'deleteByCut';
  if (!deletes) return null;
  if (before.start !== before.end)
    return caret === before.start
      ? { end: before.end, insert: '', start: before.start }
      : null;
  if (BACKWARD.has(inputType))
    return caret <= before.start
      ? { end: before.start, insert: '', start: caret }
      : null;
  if (before.length === null || caret !== before.start) return null;
  const removed = before.length - textarea.textLength;
  return removed >= 0
    ? { end: before.start + removed, insert: '', start: before.start }
    : null;
}

/**
 * An IME composition over the live document: the textarea holds the composed
 * text meanwhile, and `commit` puts it in place of the range the composition
 * started on, held as relative positions so peers' edits made while composing
 * stay where they landed. Only when a peer edits mid-composition is the
 * document kept as it was (`peerEdit`), for an IME that rewrote text off the
 * caret (`rewrite`).
 */
export function beginTextComposition(
  text: Y.Text,
  start: number,
  end: number,
  lines: SourceLines
) {
  let from = start,
    to = end;
  if (lines.cr) {
    const raw = text.toString();
    from = sourceTextOffset(raw, start);
    to = sourceTextOffset(raw, end);
  }
  const startAt = Y.createRelativePositionFromTypeIndex(text, from);
  // Ends after the last replaced character: text a peer adds after it stays.
  const endAt =
    to > from ? Y.createRelativePositionFromTypeIndex(text, to, -1) : startAt;
  let before: Uint8Array | undefined;
  return {
    /** Put the composed text in place; returns the source offset after it. */
    commit(composed: string) {
      const doc = text.doc!;
      // A root text is never deleted, so its positions always resolve.
      const first = Y.createAbsolutePositionFromRelativePosition(
        startAt,
        doc
      )!.index;
      const last = Y.createAbsolutePositionFromRelativePosition(
        endAt,
        doc
      )!.index;
      const display = displayText(composed);
      const insert =
        lines.newline === '\n'
          ? display
          : display.replaceAll('\n', lines.newline);
      doc.transact(() => {
        if (last > first) text.delete(first, last - first);
        if (insert) text.insert(first, insert);
      }, SOURCE_TEXT_INPUT);
      return first + insert.length;
    },
    get missed() {
      return before !== undefined;
    },
    /** A peer's transaction is about to apply. */
    peerEdit() {
      before ??= Y.encodeStateAsUpdate(text.doc!);
    },
    /** The textarea's whole value as its difference from the document as
     * composing began, merged around peers' edits. No caret to restore. */
    rewrite(value: string): null {
      if (!before) {
        applyTextInput(text, value, lines);
        return null;
      }
      const draft = new Y.Doc();
      Y.applyUpdate(draft, before);
      const vector = Y.encodeStateVector(draft);
      applyTextInput(draft.getText('source'), value, lines);
      Y.applyUpdate(
        text.doc!,
        Y.encodeStateAsUpdate(draft, vector),
        SOURCE_TEXT_INPUT
      );
      draft.destroy();
      return null;
    },
    /** The composition's `start` in the textarea. */
    start,
  };
}
