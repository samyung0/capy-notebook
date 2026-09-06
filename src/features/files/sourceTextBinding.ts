import * as Y from 'yjs';

export const SOURCE_TEXT_INPUT = Symbol('source-text-input');
const NEWLINES = /\r\n|\r|\n/g;
const CARRIAGE_RETURNS = /\r\n|\r/g;

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

/** Apply one browser edit without replacing the shared string. */
export function applyTextInput(
  text: Y.Text,
  value: string,
  origin: unknown = SOURCE_TEXT_INPUT
) {
  const raw = text.toString();
  const before = displayText(raw);
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
  if (start === oldEnd && start === newEnd) return;
  const rawStart = sourceTextOffset(raw, start),
    rawEnd = sourceTextOffset(raw, oldEnd);
  // Existing line endings stay untouched; new lines follow the source's first newline.
  const newline = raw.match(NEWLINES)?.[0] ?? '\n';
  const insert = value.slice(start, newEnd).replaceAll('\n', newline);
  text.doc!.transact(() => {
    if (rawEnd > rawStart) text.delete(rawStart, rawEnd - rawStart);
    if (insert) text.insert(rawStart, insert);
  }, origin);
}

/** Keep native IME input isolated until composition ends, then merge only its Yjs operations. */
export function beginTextComposition(doc: Y.Doc) {
  const baseVector = Y.encodeStateVector(doc);
  const draft = new Y.Doc();
  Y.applyUpdate(draft, Y.encodeStateAsUpdate(doc));
  return {
    commit() {
      Y.applyUpdate(
        doc,
        Y.encodeStateAsUpdate(draft, baseVector),
        SOURCE_TEXT_INPUT
      );
    },
    destroy() {
      draft.destroy();
    },
    text: draft.getText('source'),
  };
}
