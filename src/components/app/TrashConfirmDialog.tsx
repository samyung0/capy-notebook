import { ConfirmDialog } from '@/components/ui/Dialog';
import { FormAlert } from '@/components/ui/FormAlert';
import { m } from '@/i18n';

/** Confirms moving one file or material to the trash, where it stays
 * recoverable for 30 days. Permanent deletions use ConfirmDialog directly.
 * The caller closes it once the move succeeds; a refusal shows inline. */
export function TrashConfirmDialog({
  error,
  isSubmitting,
  name,
  open,
  onClose,
  onConfirm,
}: {
  error?: string | null;
  isSubmitting?: boolean;
  name: string;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      body={m.confirm_trash_body()}
      closeOnConfirm={false}
      confirmLabel={m.action_delete()}
      isSubmitting={isSubmitting}
      onClose={onClose}
      onConfirm={onConfirm}
      open={open}
      title={m.confirm_delete_title({ name })}
    >
      <FormAlert message={error ?? null} />
    </ConfirmDialog>
  );
}
