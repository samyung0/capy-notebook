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
 * started on. Without a peer's edit meanwhile that is a direct replace. A
 * peer's transaction first keeps the document as composing began
 * (`peerEdit`): the commit, or the whole value of an IME that rewrote text
 * off the caret (`rewrite`), is then made against that copy and merged, so it
 * replaces only the characters that existed when the composition started and
 * keeps what the peer typed inside the range (2026-10-07). Both return the
 * source offset of the caret after it, or null when the textarea already
 * shows the document.
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
  const doc = text.doc!;
  const startAt = Y.createRelativePositionFromTypeIndex(text, from);
  // Ends after the last replaced character: text a peer adds after it stays.
  const endAt =
    to > from ? Y.createRelativePositionFromTypeIndex(text, to, -1) : startAt;
  let before: Uint8Array | undefined;
  const sourceInsert = (composed: string) => {
    const display = displayText(composed);
    return lines.newline === '\n'
      ? display
      : display.replaceAll('\n', lines.newline);
  };
  // `edit` on a copy of the document as composing began, merged back; the
  // caret is held in the copy at `caret` (a source offset there) and read
  // back in the document.
  const merged = (
    edit: (draft: Y.Text) => void,
    caret: (draft: Y.Text) => number
  ) => {
    const draft = new Y.Doc();
    Y.applyUpdate(draft, before!);
    const vector = Y.encodeStateVector(draft);
    const drafted = draft.getText('source');
    edit(drafted);
    const at = caret(drafted);
    const position = Y.createRelativePositionFromTypeIndex(
      drafted,
      at,
      at > 0 ? -1 : 0
    );
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(draft, vector), SOURCE_TEXT_INPUT);
    draft.destroy();
    // A root text is never deleted, so its positions always resolve.
    return Y.createAbsolutePositionFromRelativePosition(position, doc)!.index;
  };
  return {
    commit(composed: string): number {
      const insert = sourceInsert(composed);
      if (before)
        return merged(
          // Inserted ahead of the replaced characters, so it lands before
          // anything a peer typed among them.
          (draft) => {
            if (insert) draft.insert(from, insert);
            if (to > from) draft.delete(from + insert.length, to - from);
          },
          () => from + insert.length
        );
      // A root text is never deleted, so its positions always resolve.
      const first = Y.createAbsolutePositionFromRelativePosition(
        startAt,
        doc
      )!.index;
      const last = Y.createAbsolutePositionFromRelativePosition(
        endAt,
        doc
      )!.index;
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
      before ??= Y.encodeStateAsUpdate(doc);
    },
    /** The textarea's whole value as its difference from the document as
     * composing began; `caret` is the textarea's after it. */
    rewrite(value: string, caret: number): number | null {
      if (!before) {
        applyTextInput(text, value, lines);
        return null;
      }
      return merged(
        (draft) => applyTextInput(draft, value, lines),
        (draft) =>
          lines.cr ? sourceTextOffset(draft.toString(), caret) : caret
      );
    },
    /** The composition's `start` in the textarea. */
    start,
  };
}

/** What the binding uses of a textarea (tests drive a stand-in). */
export interface SourceTextarea extends EventTarget {
  selectionDirection: 'forward' | 'backward' | 'none';
  selectionEnd: number;
  selectionStart: number;
  setSelectionRange(
    start: number,
    end: number,
    direction?: 'forward' | 'backward' | 'none'
  ): void;
  readonly textLength: number;
  value: string;
}

/**
 * Binds a textarea to a source's shared text: local input goes in as edits
 * (in O(edit) where `textareaEdit` can place it), peers' edits refill the
 * textarea keeping its selection, IME compositions commit at their end, and
 * ⌘Z/⌘Y undo only this textarea's edits. Returns the unbinding.
 */
export function bindSourceTextarea(
  input: SourceTextarea,
  doc: Y.Doc,
  {
    onPendingChange,
    onSave,
    registerFlush,
  }: {
    onPendingChange?: (pending: boolean) => void;
    onSave: () => Promise<void>;
    registerFlush: { current: (() => Promise<void>) | null };
  }
) {
  const text = doc.getText('source');
  const undo = new Y.UndoManager(text, {
    trackedOrigins: new Set([SOURCE_TEXT_INPUT]),
  });
  let composition: ReturnType<typeof beginTextComposition> | null = null;
  // The textarea when the input being handled began (beforeinput).
  let started: InputStart | null = null;
  const waiting: (() => void)[] = [];
  let selection: {
    start: Y.RelativePosition;
    end: Y.RelativePosition;
    direction: 'forward' | 'backward' | 'none';
  } | null = null;
  const raw = text.toString();
  let lines = sourceLines(raw);
  input.value = raw;
  const toSource = (offset: number) =>
    lines.cr ? sourceTextOffset(text.toString(), offset) : offset;
  const before = (transaction: Y.Transaction) => {
    if (transaction.origin === SOURCE_TEXT_INPUT) return;
    if (composition) {
      composition.peerEdit();
      return;
    }
    selection = {
      direction: input.selectionDirection,
      end: Y.createRelativePositionFromTypeIndex(
        text,
        toSource(input.selectionEnd)
      ),
      start: Y.createRelativePositionFromTypeIndex(
        text,
        toSource(input.selectionStart)
      ),
    };
  };
  const render = () => {
    if (composition) return;
    const value = text.toString();
    lines = sourceLines(value);
    input.value = value;
    if (!selection) return;
    const start = Y.createAbsolutePositionFromRelativePosition(
        selection.start,
        doc
      ),
      end = Y.createAbsolutePositionFromRelativePosition(selection.end, doc);
    const toDisplay = (offset: number) =>
      lines.cr ? displayTextOffset(value, offset) : offset;
    if (start && end)
      input.setSelectionRange(
        toDisplay(start.index),
        toDisplay(end.index),
        selection.direction
      );
  };
  const observe = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.origin !== SOURCE_TEXT_INPUT) render();
  };
  const beforeInput = (event: Event) => {
    started = composition ? null : inputStart(event as InputEvent, input);
  };
  // Typing, paste, Enter and deletions apply in O(edit); anything else the
  // whole value's difference does.
  const change = (event: Event) => {
    const begun = started;
    started = null;
    if (composition) return;
    const edit =
      begun &&
      'inputType' in event &&
      textareaEdit(event as InputEvent, begun, input);
    if (edit) applyTextEdit(text, edit, lines);
    else applyTextInput(text, input.value, lines);
  };
  const compositionStart = () => {
    undo.stopCapturing();
    composition = beginTextComposition(
      text,
      input.selectionStart,
      input.selectionEnd,
      lines
    );
    onPendingChange?.(true);
  };
  const compositionEnd = (event?: Event) => {
    const active = composition;
    if (!active) return;
    composition = null;
    const composed =
      (event as CompositionEvent | undefined)?.data ??
      input.value.slice(active.start, input.selectionEnd);
    // The IME committed at the caret: only the composed text goes in. An
    // IME that rewrote other text gives the whole value instead.
    const caret =
      input.selectionStart === active.start + displayText(composed).length
        ? active.commit(composed)
        : active.rewrite(input.value, input.selectionStart);
    onPendingChange?.(false);
    if (active.missed) {
      // The textarea lacks the peers' edits: refill it, the caret after the
      // composed text.
      if (caret !== null) {
        const at = Y.createRelativePositionFromTypeIndex(text, caret);
        selection = { direction: 'none', end: at, start: at };
      }
      render();
    }
    undo.stopCapturing();
    for (const resolve of waiting.splice(0)) resolve();
  };
  registerFlush.current = () =>
    composition
      ? new Promise<void>((resolve) => waiting.push(resolve))
      : Promise.resolve();
  const key = (event: Event) => {
    const { ctrlKey, metaKey, shiftKey } = event as KeyboardEvent;
    if (!(metaKey || ctrlKey)) return;
    const key = (event as KeyboardEvent).key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      void registerFlush
        .current?.()
        .then(onSave)
        .catch(() => {});
    }
    if (!composition && (key === 'z' || key === 'y')) {
      event.preventDefault();
      if (shiftKey || key === 'y') undo.redo();
      else undo.undo();
    }
  };
  input.addEventListener('beforeinput', beforeInput);
  input.addEventListener('input', change);
  input.addEventListener('compositionstart', compositionStart);
  input.addEventListener('compositionend', compositionEnd);
  input.addEventListener('keydown', key);
  doc.on('beforeTransaction', before);
  text.observe(observe);
  return () => {
    // Commit authored IME operations before detaching the binding.
    compositionEnd();
    registerFlush.current = null;
    input.removeEventListener('beforeinput', beforeInput);
    input.removeEventListener('input', change);
    input.removeEventListener('compositionstart', compositionStart);
    input.removeEventListener('compositionend', compositionEnd);
    input.removeEventListener('keydown', key);
    doc.off('beforeTransaction', before);
    text.unobserve(observe);
    undo.destroy();
  };
}
