import { useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { keepKeys } from './context';
import type { CellValue } from './model';

/** A text field that writes on Enter or leaving it; Escape drops the draft.
 * A draft `parse` refuses stays in the field, marked invalid, until it is
 * fixed or dropped. */
export function CommitInput({
  className,
  onCommit,
  onDone,
  parse,
  value,
  ...rest
}: Omit<
  React.ComponentProps<'input'>,
  'value' | 'onChange' | 'defaultValue'
> & {
  value: string;
  onCommit: (text: string) => void;
  /** After a commit or Escape (not after a refused draft). */
  onDone?: () => void;
  /** False when the text cannot be written (the draft stays). */
  parse?: (text: string) => boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [held, setHeld] = useState(value);
  // A peer's change shows while the field holds no edit of its own.
  if (value !== held) {
    setHeld(value);
    if (draft === held) setDraft(value);
  }
  const [invalid, setInvalid] = useState(false);
  const cancelled = useRef(false);
  const commit = () => {
    const drop = cancelled.current;
    cancelled.current = false;
    if (!drop && draft !== value && parse && !parse(draft)) {
      setInvalid(true);
      return;
    }
    if (!drop && draft !== value) onCommit(draft);
    else setDraft(value);
    setInvalid(false);
    onDone?.();
  };
  return (
    <input
      aria-invalid={invalid || undefined}
      className={cn(
        'min-w-0 bg-transparent outline-none placeholder:text-placeholder',
        className,
        'aria-invalid:text-tint-error-fg aria-invalid:outline-(--color-solid-error)'
      )}
      onBlur={commit}
      onChange={(event) => {
        setDraft(event.target.value);
        setInvalid(false);
      }}
      onKeyDown={(event) => {
        keepKeys(event);
        if (event.key === 'Enter') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          cancelled.current = true;
          event.currentTarget.blur();
        }
      }}
      value={draft}
      {...rest}
    />
  );
}

/** A cell value from a typed text: empty clears it. */
export const textCell = (text: string): CellValue | undefined =>
  text === '' ? undefined : text;
