import { Icon, type IconName } from '@/components/ui/Icon';
import { SectionTitle } from '@/features/workspace/WorkspaceRail';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import type { StudyPage } from './studyView';

const PAGES: Record<StudyPage, { icon: IconName; label: () => string }> = {
  assignments: { icon: 'clipboard', label: m.study_panel_assignments },
  members: { icon: 'userGroup', label: m.study_panel_members },
  practice: { icon: 'quiz', label: m.study_panel_practice },
  summary: { icon: 'profile', label: m.study_panel_summary },
};

const BUILT: StudyPage[] = ['practice', 'summary'];

/** The Study panel: this person's pages (studyView). A page not built yet
 * shows as a disabled row. */
export function StudyPanel({
  active,
  onOpen,
  pages,
}: {
  active: StudyPage | null;
  onOpen: (page: StudyPage) => void;
  pages: StudyPage[];
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-study-panel>
      <SectionTitle title={m.workspace_tab_study()} />
      <nav
        aria-label={m.workspace_tab_study()}
        className="flex flex-col gap-0.5 px-2.5"
      >
        {pages.map((page) => {
          const built = BUILT.includes(page);
          const on = active === page;
          return (
            <button
              aria-current={on ? 'page' : undefined}
              // Not disabled, so the Coming soon title still shows on hover.
              aria-disabled={!built || undefined}
              className={cn(
                'flex min-h-8 items-center gap-2 rounded-button px-1.5 py-1 text-left font-semibold outline-none focus-visible:ring-2 focus-visible:ring-action',
                on && 'bg-page-hover',
                built
                  ? 'cursor-pointer hover:bg-page-hover'
                  : 'cursor-default text-fg-muted'
              )}
              key={page}
              onClick={() => built && onOpen(page)}
              title={built ? undefined : m.study_panel_soon()}
              type="button"
            >
              <Icon className="shrink-0" name={PAGES[page].icon} size={18} />
              <span className="min-w-0 translate-y-px truncate">
                {PAGES[page].label()}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
