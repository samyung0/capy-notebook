import {
  type ChangeEvent,
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from 'react';

/**
 * A typed field of a live figure (Epo 2026-11-16): it shows its own text while
 * typed in and hands it to `commit` once left, on Enter, or when the dialog
 * closes, so a co-editor's change elsewhere never moves its caret and the
 * room keeps one write per edit. Untyped, it shows `value`. Spread `input`
 * on the field; `text` is what it shows (for its character count).
 */
export function useCommitted(value: string, commit: (text: string) => void) {
  const [typed, setTyped] = useState<string | null>(null);
  const latest = useRef({ commit, typed });
  latest.current = { commit, typed };
  // A field still typed in when the dialog closes keeps its text.
  useEffect(
    () => () => {
      const { commit: last, typed: text } = latest.current;
      if (text !== null) last(text);
    },
    []
  );
  const done = () => {
    if (typed === null) return;
    latest.current.typed = null;
    setTyped(null);
    commit(typed);
  };
  return {
    input: {
      onBlur: done,
      onChange: (event: ChangeEvent<HTMLInputElement>) =>
        setTyped(event.target.value),
      onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') done();
      },
      value: typed ?? value,
    },
    text: typed ?? value,
  };
}
