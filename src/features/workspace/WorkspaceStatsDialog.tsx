import { useWorkspaceStats } from '@/api/hooks';
import { SimpleDialog } from '@/components/ui/Dialog';
import { m } from '@/i18n';

export function WorkspaceStatsDialog({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { data } = useWorkspaceStats(id, { errorBoundary: false });
  const rows = [
    [m.quiz_col_chapters(), data?.chapters],
    [m.nav_files(), data?.files],
    [m.nav_quizzes(), data?.quizzes],
    [m.stats_attempts(), data?.attempts],
    [m.stats_average_score(), data ? `${data.avgScore}%` : undefined],
  ] as const;
  return (
    <SimpleDialog
      onClose={onClose}
      open
      title={m.workspace_stats_title()}
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
