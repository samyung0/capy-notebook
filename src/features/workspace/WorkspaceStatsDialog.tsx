import { useWorkspaceStats } from '@/api/hooks';
import { SimpleDialog } from '@/components/ui/Dialog';

export function WorkspaceStatsDialog({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { data } = useWorkspaceStats(id);
  const rows = [
    ['Chapters', data?.chapters],
    ['Files', data?.files],
    ['Quizzes', data?.quizzes],
    ['Attempts', data?.attempts],
    ['Average score', data ? `${data.avgScore}%` : undefined],
  ] as const;
  return (
    <SimpleDialog
      onClose={onClose}
      open
      title="Workspace statistics"
      width={420}
    >
      <div className="grid grid-cols-2 gap-3">
        {rows.map(([label, val]) => (
          <div
            className="rounded-card border border-line bg-surface-hover-bg px-4 py-3"
            key={label}
          >
            <p className="t-label text-fg-muted">{label}</p>
            <p className="t-large-card-title mt-1">{val ?? '—'}</p>
          </div>
        ))}
      </div>
    </SimpleDialog>
  );
}
