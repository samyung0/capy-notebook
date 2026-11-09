import { Spinner } from '@/components/ui/feedback';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** "Marking…" with a spinner, while a marking run holds the answer or attempt
 * (Q729). */
export function MarkingNow({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 font-semibold text-fg-secondary',
        className
      )}
      data-marking
    >
      <Spinner className="size-3.5" label={m.quiz_grading()} />
      <span aria-hidden>{m.quiz_grading()}</span>
    </span>
  );
}
