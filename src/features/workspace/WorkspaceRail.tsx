import { Link } from '@tanstack/react-router';
import { useUnreadNotificationCount } from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { ProfileMenu } from '@/components/app/ProfileMenu';
import { Skeleton } from '@/components/ui/feedback';
import { Icon, type IconName } from '@/components/ui/Icon';
import type { MenuItem } from '@/components/ui/Menu';
import { PendingDot } from '@/components/ui/PendingDot';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { useAssignmentCount } from '@/features/study/assignments/useAssignmentCount';
import { useMembersNeedAction } from '@/features/study/members/membersAttention';
import { type StudyPage, studyView } from '@/features/study/practice/studyView';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** The workspace's sections (Epo 2026-11-02, S2 and N1): Files and Agent each
 * show a panel beside the rail; the rest are pages. To do, Practice, Members
 * and Study were Study's pages until Epo 2026-11-11 gave each its own place. */
export type WorkspaceSection =
  | 'dashboard'
  | 'files'
  | 'agent'
  | 'todo'
  | 'members'
  | 'study'
  | 'canvas';

/** The sections that are one of Study's former pages, and back. */
export const SECTION_PAGE = {
  members: 'members',
  study: 'summary',
  todo: 'assignments',
} as const satisfies Partial<Record<WorkspaceSection, StudyPage>>;
/** The rail row a page belongs to: Practice is a tab of Study (Epo
 * 2026-11-13). */
export const PAGE_SECTION = {
  assignments: 'todo',
  bank: 'study',
  history: 'study',
  members: 'members',
  practice: 'study',
  summary: 'study',
} as const satisfies Record<StudyPage, WorkspaceSection>;

/** The rail's rows for this person, in order: what a member is given to do is
 * To do, and Assignments to the class staff who give it out; class staff have
 * no Study, and a link or public visitor no canvas (Epo 2026-11-09). */
export function workspaceSections(
  workspace: Pick<Workspace, 'kind' | 'role'>
): { value: WorkspaceSection; icon: IconName; label: string }[] {
  const { pages } = studyView(workspace);
  // Dashboard, Canvas, Files (Epo 2026-11-26), Assignments (members' too, Epo
  // 2026-11-25), Study, Agent, Members (Epo 2026-11-24).
  return [
    {
      icon: 'dashboard' as const,
      label: m.workspace_section_dashboard(),
      value: 'dashboard' as const,
    },
    // Each member's own canvas, stored as their canvas material.
    {
      icon: 'shape' as const,
      label: m.workspace_section_canvas(),
      value: 'canvas' as const,
    },
    {
      icon: 'folder' as const,
      label: m.workspace_tab_files(),
      value: 'files' as const,
    },
    {
      icon: 'clipboard' as const,
      label: m.study_panel_assignments(),
      value: 'todo' as const,
    },
    {
      icon: 'book' as const,
      label: m.workspace_tab_study(),
      value: 'study' as const,
    },
    {
      icon: 'ai' as const,
      label: m.workspace_section_agent(),
      value: 'agent' as const,
    },
    {
      icon: 'userGroup' as const,
      label: m.study_panel_members(),
      value: 'members' as const,
    },
  ].filter((section) =>
    section.value === 'canvas'
      ? !!workspace.role
      : !(section.value in SECTION_PAGE) ||
        pages.includes(SECTION_PAGE[section.value as keyof typeof SECTION_PAGE])
  );
}

/* A rail item: the icon over its label, as the app sidebar's rows look. */
const ITEM =
  'flex w-[62px] cursor-pointer flex-col items-center gap-0.5 rounded-button-lg px-0.5 pt-2 pb-1.5 font-medium text-[11px] text-fg leading-[1.1] outline-none transition-colors hover:bg-fg/6 focus-visible:ring-2 focus-visible:ring-action';

/** An item's label; the long ones (Assignments, Workspaces) a size smaller so
 * they fit the 62px rail (Epo 2026-11-24). */
function RailLabel({ label }: { label: string }) {
  return (
    <span
      className={cn('whitespace-nowrap', label.length > 9 && 'text-[10px]')}
    >
      {label}
    </span>
  );
}

function RailItem({
  active,
  count,
  dot,
  icon,
  label,
  onClick,
  onPreload,
}: {
  active: boolean;
  /** What waits there, by the icon. */
  count?: number;
  /** Something waits there with no count to show. */
  dot?: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
  /** Under the pointer or focus: start what the press opens. */
  onPreload?: () => void;
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={cn(
        ITEM,
        active && 'bg-action font-bold text-action-fg hover:bg-action'
      )}
      onClick={onClick}
      onFocus={onPreload}
      onPointerEnter={onPreload}
      type="button"
    >
      <span className="relative">
        <Icon name={icon} size={20} />
        {!!count && (
          <span className="absolute -top-1.5 left-3.5 min-w-4 rounded-full bg-solid-error px-1 text-center font-bold text-[10px] text-white leading-4">
            {count}
          </span>
        )}
        {dot && <PendingDot className="-top-1 -right-1.5" />}
      </span>
      <RailLabel label={label} />
    </button>
  );
}

// No panel of its own: on the shell like the app sidebar's background, so a
// page frame shows straight through.
const RAIL =
  'flex h-full w-[62px] shrink-0 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden py-3';

/** Workspaces, back to the list. */
function RailBack() {
  return (
    <Link className={cn(ITEM, 'mb-1')} preload="intent" to="/">
      <Icon name="navigationBack" size={20} />
      <RailLabel label={m.nav_workspaces()} />
    </Link>
  );
}

/** The labelled icon rail on every workspace page from md, so iPads keep it:
 * Workspaces back to the list, the sections, Settings opening the workspace's
 * settings dialog, and your avatar opening the workspace and account menu.
 * From lg Files and Agent open panels; below, the Files dropdown and the pages.
 * To do carries the count the Study panel showed beside Assignments. A section
 * under the pointer or focus preloads its page (Q907). */
export function WorkspaceRail({
  accountItems,
  active,
  onPreload,
  onSelect,
  onSettings,
  workspace,
}: {
  /** The workspace part of the avatar's menu (Invite, settings, Clone). */
  accountItems: MenuItem[];
  active: WorkspaceSection;
  onPreload: (section: WorkspaceSection) => void;
  onSelect: (section: WorkspaceSection) => void;
  /** Opens Workspace settings, for whoever has them (Epo 2026-11-13). */
  onSettings?: () => void;
  workspace: Pick<Workspace, 'id' | 'kind' | 'name' | 'role'>;
}) {
  const { data: unread } = useUnreadNotificationCount({ errorBoundary: false });
  const assignmentCount = useAssignmentCount(workspace);
  const membersNeedAction = useMembersNeedAction(workspace);
  return (
    <nav aria-label={m.workspace_rail_label()} className={RAIL}>
      <RailBack />
      {workspaceSections(workspace).map((section) => (
        <RailItem
          active={active === section.value}
          count={section.value === 'todo' ? assignmentCount : undefined}
          dot={section.value === 'members' && membersNeedAction}
          icon={section.icon}
          key={section.value}
          label={section.label}
          onClick={() => onSelect(section.value)}
          onPreload={() => onPreload(section.value)}
        />
      ))}
      <div className="mt-auto flex flex-col items-center gap-2">
        {onSettings && (
          <RailItem
            active={false}
            icon="settings"
            label={m.workspace_rail_settings()}
            onClick={onSettings}
          />
        )}
        <ProfileMenu
          dot={(unread?.count ?? 0) > 0}
          notifications
          trigger="own"
          workspace={{ items: accountItems, name: workspace.name }}
        />
      </div>
    </nav>
  );
}

/** The rail while its workspace loads (Q906): Workspaces, then the shapes of
 * the sections and your avatar, in the shell's hover tone (the cards' skeleton
 * tone is the shell's own). Which sections and menus show depends on the
 * person's role, so none is drawn before the workspace's read says. */
export function WorkspaceRailSkeleton() {
  return (
    <nav aria-label={m.workspace_rail_label()} className={RAIL}>
      <RailBack />
      {Array.from({ length: 6 }, (_, i) => (
        // An item's box: its icon over its label.
        <div
          className="flex w-[62px] flex-col items-center gap-0.5 px-0.5 pt-2 pb-1.5"
          key={i}
        >
          <Skeleton className="size-5 rounded-[6px] bg-page-hover" />
          <Skeleton className="my-px h-2.5 w-9 bg-page-hover" />
        </div>
      ))}
      <Skeleton className="mt-auto size-11 shrink-0 rounded-full bg-page-hover" />
    </nav>
  );
}

/** A section panel's title row (boards T3, P1): the section's name, or Agent's
 * chat with a back arrow to the chat history, and its actions on the right. */
export function SectionTitle({
  actions,
  onBack,
  title,
}: {
  actions?: React.ReactNode;
  onBack?: () => void;
  title: string;
}) {
  return (
    <div
      className={cn(
        'flex h-14 shrink-0 items-center gap-1 pr-2.5',
        onBack ? 'pl-2.5' : 'pl-4'
      )}
    >
      {onBack && (
        <ToolbarButton label={m.chat_history()} onClick={onBack}>
          <Icon name="navigationBack" />
        </ToolbarButton>
      )}
      <h2 className="min-w-0 flex-1 truncate font-bold text-base">{title}</h2>
      {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    </div>
  );
}
