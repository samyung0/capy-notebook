import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** Previous and Next under an item shown one at a time (review sessions,
 * flashcard study, Quick review). Next moves on without recording anything. */
export function StepNav({
  canNext,
  canPrevious,
  className,
  onNext,
  onPrevious,
  start,
}: {
  canNext: boolean;
  canPrevious: boolean;
  className?: string;
  onNext: () => void;
  onPrevious: () => void;
  /** At the row's far left, e.g. an embedded set's Reset. */
  start?: ReactNode;
}) {
  return (
    <div className={cn('flex items-center justify-end', className)}>
      {start && <div className="mr-auto">{start}</div>}
      <Button
        disabled={!canPrevious}
        onClick={onPrevious}
        size="sm"
        variant="ghost-hover"
      >
        {m.action_previous()}
      </Button>
      <Button
        disabled={!canNext}
        onClick={onNext}
        size="sm"
        variant="ghost-hover"
      >
        {m.action_next()}
      </Button>
    </div>
  );
}
