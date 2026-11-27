import { useNavigate } from '@tanstack/react-router';
import { Panel } from '@/components/app/layout';
import { Skeleton, SkeletonList } from '@/components/ui/feedback';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { WorkspaceDashboardSkeleton } from './WorkspaceDashboard';
import {
  SectionTitle,
  WorkspaceRailSkeleton,
  type WorkspaceSection,
} from './WorkspaceRail';

/** The opened workspace's frame while its read is on the way (Q906), laid out
 * as WorkspaceOpen lays out the page the URL opens, so the page takes its
 * place without a jump: the rail from 768px, the Files or Agent side panel
 * from 1260px, the centre's header where that page has one, and the
 * Dashboard's or a workspace page's content as shapes. Nothing that depends on
 * the person's role shows until the read says. */
export function WorkspaceSkeleton({
  header,
  page,
  panel,
  rail,
}: {
  /** The centre has a header row (phones, a tablet's Files, an open item). */
  header: boolean;
  page: WorkspaceSection;
  /** The page's side panel shows (Files or Agent from 1260px). */
  panel: boolean;
  rail: boolean;
}) {
  const navigate = useNavigate();
  return (
    <div aria-busy className="flex h-full min-h-0 gap-2">
      <span className="sr-only" role="status">
        {m.workspace_loading()}
      </span>
      {rail && <WorkspaceRailSkeleton />}
      <div className="flex min-h-0 min-w-0 flex-1">
        {panel && (
          // 340px with its 4px of the gap, as the page's panel opens.
          <div className="w-[340px] shrink-0 pr-1">
            <Panel
              className="w-full"
              frost="left"
              sectionClassName="h-full gap-0"
            >
              <SectionTitle
                title={
                  page === 'files' ? m.workspace_tab_files() : m.chat_chats()
                }
              />
              <SkeletonList className="px-1.5 py-2" count={5} rowHeight={36} />
            </Panel>
          </div>
        )}
        <div className={cn('min-w-0 flex-1', panel && 'pl-1')}>
          <Panel
            className="w-full"
            frost="center"
            sectionClassName="h-full gap-0"
          >
            {header && (
              <div
                className={cn(
                  'flex h-12 shrink-0 items-center gap-2 border-divider border-b sm:h-15',
                  rail ? 'px-4' : 'px-3'
                )}
              >
                {/* Phones have no rail to leave by. */}
                {!rail && (
                  <ToolbarButton
                    label={m.workspace_back_to()}
                    onClick={() => void navigate({ to: '/' })}
                  >
                    <Icon name="navigationBack" />
                  </ToolbarButton>
                )}
                <Skeleton className="h-5 w-40 max-w-[50%]" />
              </div>
            )}
            {page === 'dashboard' ? (
              <WorkspaceDashboardSkeleton />
            ) : page === 'study' || page === 'members' || page === 'todo' ? (
              // A workspace page's title, then its list loading.
              <div className="page-px min-h-0 flex-1 overflow-hidden pt-5 pb-24 lg:pt-7 lg:pb-10">
                <div className="t-page-title flex min-h-[1lh] items-center">
                  <Skeleton className="h-[0.75em] w-40" />
                </div>
                <SkeletonList className="mt-6" count={6} rowHeight={40} />
              </div>
            ) : null}
          </Panel>
        </div>
      </div>
    </div>
  );
}
