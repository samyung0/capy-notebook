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
}: {
  canNext: boolean;
  canPrevious: boolean;
  className?: string;
  onNext: () => void;
  onPrevious: () => void;
}) {
  return (
    <div className={cn('flex justify-end gap-2', className)}>
      <Button
        disabled={!canPrevious}
        iconLeft="navigationBack"
        onClick={onPrevious}
        size="sm"
        variant="outline"
      >
        {m.action_previous()}
      </Button>
      <Button
        disabled={!canNext}
        iconRight="navigationForward"
        onClick={onNext}
        size="sm"
        variant="outline"
      >
        {m.action_next()}
      </Button>
    </div>
  );
}
