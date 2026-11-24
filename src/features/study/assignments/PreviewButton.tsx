import { lazy, Suspense, useState } from 'react';
import { Button, PageButton } from '@/components/ui/Button';
import { usePhoneMenuItem } from '@/features/files/fileModeContext';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

const QuizPreviewDialog = lazy(() =>
  import('./AssignmentPreview').then((module) => ({
    default: module.QuizPreviewDialog,
  }))
);

/** Preview, outlined (Epo 2026-11-15), its word alone at every width: the
 * eye read as the Hidden chip's beside it (Epo 2026-11-16). A graded quiz's
 * is borderless on its Questions tab (Epo 2026-11-23), `size` matching the
 * tabs' row. */
export function PreviewButton({
  className,
  disabled,
  onClick,
  size,
  variant = 'outline',
}: {
  className?: string;
  disabled?: boolean;
  onClick: () => void;
  size?: 'sm';
  variant?: 'ghost-hover' | 'outline';
}) {
  const Shell = size ? Button : PageButton;
  return (
    <Shell
      className={cn('shrink-0', className)}
      disabled={disabled}
      onClick={onClick}
      size={size}
      variant={variant}
    >
      {m.assignment_preview()}
    </Shell>
  );
}

/** A practice quiz's Preview in its header: its questions as members get
 * them, the dialog loading as it opens. Phones have it in ⋮ (Epo 2026-11-16). */
export function QuizPreviewButton({ quizId }: { quizId: string }) {
  const [open, setOpen] = useState(false);
  usePhoneMenuItem('preview', {
    icon: 'view',
    label: m.assignment_preview(),
    onClick: () => setOpen(true),
  });
  return (
    <>
      <PreviewButton
        className="max-sm:hidden sm:mr-1"
        onClick={() => setOpen(true)}
      />
      {open && (
        <Suspense fallback={null}>
          <QuizPreviewDialog onClose={() => setOpen(false)} quizId={quizId} />
        </Suspense>
      )}
    </>
  );
}
