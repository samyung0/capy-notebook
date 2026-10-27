import { Button } from '@/components/ui/Button';
import { m } from '@/i18n';

/** Starts a quiz or flashcard try over, at the far right of the page title.
 * The try so far stays an attempt. */
export function ResetButton({
  disabled,
  onClick,
}: {
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      disabled={disabled}
      onClick={onClick}
      rounded="normal"
      size="md"
      variant="outline"
    >
      {m.action_reset()}
    </Button>
  );
}
