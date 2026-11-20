import { useWorkspaceRecent } from '@/api/hooks';
import { mergeRecentItems } from '@/features/home/recentItems';
import { m } from '@/i18n';
import { RecentCard } from './WorkspaceDashboard';
import { WorkspaceEmpty } from './WorkspaceEmpty';

/** The Files page with nothing open, from lg (Epo 2026-11-14, the blank state
 * before 2026-11-05): the four newest files as a 2×2 grid in the middle, or
 * the empty workspace's ink and Add file. Blank while loading. */
export function FilesHome({
  onUpload,
  workspaceId,
}: {
  onUpload?: () => void;
  workspaceId: string;
}) {
  const { data, isPending } = useWorkspaceRecent(workspaceId);
  if (isPending) return null;
  const items = mergeRecentItems(data?.files ?? [], data?.materials ?? [], 4);
  if (!items.length) return <WorkspaceEmpty onUpload={onUpload} />;
  return (
    <div className="grid flex-1 place-items-center p-6">
      {/* Lifted by half the heading's row, so the grid sits in the middle. */}
      <section className="flex w-full max-w-[400px] -translate-y-4 flex-col gap-2.5">
        <h2 className="t-subtitle px-1">{m.dashboard_recent_files()}</h2>
        <div className="grid grid-cols-2 gap-1">
          {items.map((item) => (
            <RecentCard
              item={item}
              key={`${item.kind}-${item.id}`}
              workspaceId={workspaceId}
            />
          ))}
        </div>
      </section>
    </div>
  );
}
