import type { Workspace } from '@/api/types';
import { Icon, type IconName } from '@/components/ui/Icon';
import { SectionTitle } from '@/features/workspace/WorkspaceRail';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useAssignmentCount } from '../assignments/useAssignmentCount';
import { type StudyPage, studyView } from './studyView';

const PAGES: Record<StudyPage, { icon: IconName; label: () => string }> = {
  assignments: { icon: 'clipboard', label: m.study_panel_assignments },
  members: { icon: 'userGroup', label: m.study_panel_members },
  practice: { icon: 'quiz', label: m.study_panel_practice },
  summary: { icon: 'profile', label: m.study_panel_summary },
};

/** The Study panel: this person's pages (studyView). */
export function StudyPanel({
  active,
  onOpen,
  workspace,
}: {
  active: StudyPage | null;
  onOpen: (page: StudyPage) => void;
  workspace: Pick<Workspace, 'id' | 'kind' | 'role'>;
}) {
  const { pages } = studyView(workspace);
  const assignmentCount = useAssignmentCount(workspace);
  return (
    <div className="flex h-full min-h-0 flex-col" data-study-panel>
      <SectionTitle title={m.workspace_tab_study()} />
      <nav
        aria-label={m.workspace_tab_study()}
        className="flex flex-col gap-0.5 px-2.5"
      >
        {pages.map((page) => {
          const on = active === page;
          return (
            <button
              aria-current={on ? 'page' : undefined}
              className={cn(
                'flex min-h-8 cursor-pointer items-center gap-2 rounded-button px-1.5 py-1 text-left font-semibold outline-none hover:bg-page-hover focus-visible:ring-2 focus-visible:ring-action',
                on && 'bg-page-hover'
              )}
              key={page}
              onClick={() => onOpen(page)}
              type="button"
            >
              <Icon className="shrink-0" name={PAGES[page].icon} size={18} />
              <span className="min-w-0 flex-1 translate-y-px truncate">
                {PAGES[page].label()}
              </span>
              {page === 'assignments' && !!assignmentCount && (
                <span className="t-meta shrink-0 translate-y-px font-semibold text-fg-muted">
                  {assignmentCount}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
