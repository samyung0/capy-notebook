/** How often this editor may publish its cursor to the room. */
export const CURSOR_SEND_MS = 50;

export interface CursorSender {
  sendCursorPosition?: (range: unknown) => void;
}

/**
 * Publishes the editor's cursor at most once per `ms`, always ending on its
 * latest position. Each caret move is an awareness message that the server
 * relays to every peer, so typing or dragging a selection would otherwise
 * send one per change. Returns the undo.
 */
export function throttleCursorPosition(
  editor: CursorSender,
  ms = CURSOR_SEND_MS,
  now: () => number = Date.now
) {
  const send = editor.sendCursorPosition;
  if (!send) return () => {};
  let last = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: unknown;
  const flush = () => {
    timer = undefined;
    last = now();
    send(latest);
  };
  editor.sendCursorPosition = (range) => {
    latest = range;
    const wait = last + ms - now();
    if (wait <= 0) {
      clearTimeout(timer);
      flush();
    } else timer ??= setTimeout(flush, wait);
  };
  return () => {
    clearTimeout(timer);
    editor.sendCursorPosition = send;
  };
}
