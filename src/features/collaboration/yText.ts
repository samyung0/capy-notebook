import {
  type ChangeEvent,
  useCallback,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from 'react';
import type * as Y from 'yjs';

/** The origin of this tab's own edits to a live item: its Undo tracks only
 * these, and bindings treat everything else as remote. */
export const LOCAL_EDIT = Symbol('live-item-local-edit');

/**
 * Turns `text` into `next` with the fewest changes (the common prefix and
 * suffix stay), so another writer typing elsewhere in the text keeps their
 * characters. Offsets are UTF-16 units, as Yjs counts them.
 */
export function applyTextChange(
  text: Y.Text,
  next: string,
  origin: unknown = LOCAL_EDIT
) {
  const current = text.toString();
  if (current === next) return;
  let start = 0;
  const max = Math.min(current.length, next.length);
  while (start < max && current[start] === next[start]) start++;
  // Never split a surrogate pair.
  if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start--;
  let end = 0;
  while (
    end < current.length - start &&
    end < next.length - start &&
    current.at(-1 - end) === next.at(-1 - end)
  )
    end++;
  if (end > 0 && isLowSurrogate(current.charCodeAt(current.length - end)))
    end--;
  const removed = current.length - start - end;
  const inserted = next.slice(start, next.length - end);
  const apply = () => {
    if (removed > 0) text.delete(start, removed);
    if (inserted) text.insert(start, inserted);
  };
  if (text.doc) text.doc.transact(apply, origin);
  else apply();
}

const isHighSurrogate = (code: number) => code >= 0xd8_00 && code <= 0xdb_ff;
const isLowSurrogate = (code: number) => code >= 0xdc_00 && code <= 0xdf_ff;

/** A caret offset carried through a remote change's delta: an insert before
 * it pushes it right, a deletion before it pulls it left. */
export function mapOffset(offset: number, delta: Y.YTextEvent['delta']) {
  let at = 0;
  let mapped = offset;
  for (const op of delta) {
    if (op.retain != null) at += op.retain;
    else if (typeof op.insert === 'string') {
      if (at <= offset) mapped += op.insert.length;
      at += op.insert.length;
    } else if (op.delete != null && at < offset)
      mapped -= Math.min(op.delete, offset - at);
  }
  return Math.max(0, mapped);
}

/** The text's string, re-rendering only its own field when it changes. */
export function useYText(text: Y.Text | null | undefined): string {
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!text) return () => undefined;
      text.observe(notify);
      return () => text.unobserve(notify);
    },
    [text]
  );
  return useSyncExternalStore(subscribe, () => text?.toString() ?? '');
}

/**
 * An `<input>` or `<textarea>` bound to a live text: typing goes in as the
 * fewest changes, others' typing comes back with this user's caret and
 * selection carried through it.
 */
export function useBoundText<E extends HTMLInputElement | HTMLTextAreaElement>(
  text: Y.Text | null | undefined
) {
  const ref = useRef<E>(null);
  const pending = useRef<[number, number] | null>(null);
  const subscribe = useCallback(
    (notify: () => void) => {
      if (!text) return () => undefined;
      const observe = (event: Y.YTextEvent, tr: Y.Transaction) => {
        const element = ref.current;
        if (
          tr.origin !== LOCAL_EDIT &&
          element &&
          document.activeElement === element
        ) {
          const start = element.selectionStart ?? 0;
          const end = element.selectionEnd ?? start;
          pending.current = [
            mapOffset(start, event.delta),
            mapOffset(end, event.delta),
          ];
        }
        notify();
      };
      text.observe(observe);
      return () => text.unobserve(observe);
    },
    [text]
  );
  const value = useSyncExternalStore(subscribe, () => text?.toString() ?? '');
  useLayoutEffect(() => {
    const selection = pending.current;
    pending.current = null;
    if (selection && ref.current) ref.current.setSelectionRange(...selection);
  });
  const onChange = useCallback(
    (event: ChangeEvent<E>) => {
      if (text) applyTextChange(text, event.target.value);
    },
    [text]
  );
  return { onChange, ref, value };
}
