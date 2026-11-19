import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/Input';
import { formatPoints } from '@/features/quizzes/grade';
import { cn } from '@/lib/cn';
import { typedMark } from './assignmentText';

/** A mark typed out of `marks`, from 0 with at most one decimal place, as the
 * server takes it (Epo 2026-11-18, typed marks replaced the half-mark menu).
 * Keys that would make anything else are refused (Epo: limit the input, show
 * no message), so the field only ever holds a mark or the start of one ("1.").
 * `onChange` gets null while it is empty, so a Save that needs every mark
 * waits. */
export function MarkField({
  className,
  label,
  marks,
  onChange,
  value,
}: {
  className?: string;
  label: string;
  marks: number;
  onChange: (value: number | null) => void;
  value: number | null;
}) {
  const shown = value === null ? '' : String(value);
  const [text, setText] = useState(shown);
  // A mark set from outside (a saved mark arriving) replaces the text unless
  // it already reads as that mark ("1." while typing 1.5).
  useEffect(
    () =>
      setText((current) =>
        current !== '' && Number(current) === value ? current : shown
      ),
    [shown, value]
  );
  return (
    <Input
      aria-label={label}
      autoComplete="off"
      endText={`/ ${formatPoints(marks)}`}
      inputMode="decimal"
      onChange={(event) => {
        const next = typedMark(event.target.value, marks);
        if (next === undefined) return;
        setText(next);
        onChange(next === '' ? null : Number(next));
      }}
      placeholder="–"
      type="text"
      value={text}
      wrapperClassName={cn('h-8 w-24 px-2.5', className)}
    />
  );
}
