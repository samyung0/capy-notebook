import { ConfirmDialog } from '@/components/ui/Dialog';
import { m } from '@/i18n';

/** Confirms moving one file or material to the trash, where it stays
 * recoverable for 30 days. Permanent deletions use ConfirmDialog directly. */
export function TrashConfirmDialog({
  name,
  open,
  onClose,
  onConfirm,
}: {
  name: string;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <ConfirmDialog
      body={m.confirm_trash_body()}
      onClose={onClose}
      onConfirm={onConfirm}
      open={open}
      title={m.confirm_delete_title({ name })}
    />
  );
}
