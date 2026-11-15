import { lazy, Suspense, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

const QuizPreviewDialog = lazy(() =>
  import('./AssignmentPreview').then((module) => ({
    default: module.QuizPreviewDialog,
  }))
);

/** Preview, outlined with the eye (Epo 2026-11-15); its label goes on
 * phones, kept for the screen reader. */
export function PreviewButton({
  className,
  disabled,
  onClick,
}: {
  className?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      aria-label={m.assignment_preview()}
      className={cn('shrink-0 max-sm:w-(--control-h) max-sm:px-0', className)}
      disabled={disabled}
      iconLeft="view"
      onClick={onClick}
      variant="outline"
    >
      <span className="max-sm:hidden">{m.assignment_preview()}</span>
    </Button>
  );
}

/** A practice quiz's Preview beside Study: its questions as members get them,
 * the dialog loading as it opens. */
export function QuizPreviewButton({ quizId }: { quizId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <PreviewButton onClick={() => setOpen(true)} />
      {open && (
        <Suspense fallback={null}>
          <QuizPreviewDialog onClose={() => setOpen(false)} quizId={quizId} />
        </Suspense>
      )}
    </>
  );
}
