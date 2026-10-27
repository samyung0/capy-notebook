/** How often this editor may publish its cursor to the room. */
export const CURSOR_SEND_MS = 50;

export interface CursorSender {
  /** The editor's selection: what withCursors sends, read again when a
   * send waited. */
  selection?: unknown;
  sendCursorPosition?: (range: unknown) => void;
}

/**
 * Publishes the editor's cursor at most once per `ms`, always ending on its
 * latest position. Each caret move is an awareness message that the server
 * relays to every peer, so typing or dragging a selection would otherwise
 * send one per change. A send that waited sends the selection as it is then,
 * and only while the editor is still bound (`connected`): the range it was
 * given may name paths a remote change moved since, which withCursors cannot
 * map onto the room ("Path doesn't match yText"). Returns the undo.
 */
export function throttleCursorPosition(
  editor: CursorSender,
  ms = CURSOR_SEND_MS,
  now: () => number = Date.now,
  connected: () => boolean = () => true
) {
  const send = editor.sendCursorPosition;
  if (!send) return () => {};
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (range: unknown) => {
    last = now();
    send(range);
  };
  editor.sendCursorPosition = (range) => {
    const wait = last + ms - now();
    if (wait <= 0) {
      clearTimeout(timer);
      timer = undefined;
      flush(range);
    } else
      timer ??= setTimeout(() => {
        timer = undefined;
        if (connected()) flush(editor.selection);
      }, wait);
  };
  return () => {
    clearTimeout(timer);
    editor.sendCursorPosition = send;
  };
}
