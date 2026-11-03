import { Link } from '@tanstack/react-router';
import { useUnreadNotificationCount } from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { Panel } from '@/components/app/layout';
import { ProfileMenu } from '@/components/app/ProfileMenu';
import { Icon, type IconName } from '@/components/ui/Icon';
import type { MenuItem } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';

/** The workspace's sections (Epo 2026-11-02, S2 and N1): Dashboard has no
 * panel; Files, Agent and Study each show theirs beside the rail. */
export type WorkspaceSection = 'dashboard' | 'files' | 'agent' | 'study';

const SECTIONS: {
  value: WorkspaceSection;
  icon: IconName;
  label: () => string;
}[] = [
  {
    icon: 'dashboard',
    label: m.workspace_section_dashboard,
    value: 'dashboard',
  },
  { icon: 'folder', label: m.workspace_tab_files, value: 'files' },
  { icon: 'ai', label: m.workspace_section_agent, value: 'agent' },
  { icon: 'book', label: m.workspace_tab_study, value: 'study' },
];

/* A rail item: the icon over its label, 58px wide (board N1). */
const ITEM =
  'flex w-14.5 cursor-pointer flex-col items-center gap-0.75 rounded-button-lg pt-1.75 pb-1.5 font-semibold text-[11px] text-fg-secondary leading-[1.1] outline-none transition-colors hover:bg-page-hover hover:text-fg focus-visible:ring-2 focus-visible:ring-action';

function RailItem({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: IconName;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={cn(ITEM, active && 'bg-page-hover text-fg')}
      onClick={onClick}
      type="button"
    >
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </button>
  );
}

/** The labelled icon rail on every workspace page from lg: Home back to the
 * app, the workspace's badge (it only says where you are), the sections,
 * and your avatar opening the workspace and account menu. */
export function WorkspaceRail({
  accountItems,
  active,
  onSelect,
  workspace,
}: {
  /** The workspace part of the avatar's menu (Invite, settings, Clone). */
  accountItems: MenuItem[];
  active: WorkspaceSection;
  onSelect: (section: WorkspaceSection) => void;
  workspace: Pick<Workspace, 'iconId' | 'name'>;
}) {
  const { data: unread } = useUnreadNotificationCount({ errorBoundary: false });
  return (
    <Panel
      className="w-17 shrink-0"
      frost="left"
      sectionClassName="h-full py-3"
    >
      <nav
        aria-label={m.workspace_rail_label()}
        className="flex h-full flex-col items-center gap-1"
      >
        <Link className={cn(ITEM, 'mb-2')} preload="intent" to="/">
          <Icon name="navigationBack" size={20} />
          <span>{m.nav_home()}</span>
        </Link>
        <img
          alt={workspace.name}
          className="mb-2.5 size-8.5 shrink-0 rounded-[9px]"
          src={iconUrl(workspace.iconId)}
          title={workspace.name}
        />
        {SECTIONS.map((section) => (
          <RailItem
            active={active === section.value}
            icon={section.icon}
            key={section.value}
            label={section.label()}
            onClick={() => onSelect(section.value)}
          />
        ))}
        <div className="mt-auto">
          <ProfileMenu
            dot={(unread?.count ?? 0) > 0}
            notifications
            trigger="own"
            workspace={{ items: accountItems, name: workspace.name }}
          />
        </div>
      </nav>
    </Panel>
  );
}

/** A section panel's title row (boards T3, P1): the section's name and its
 * actions on the right. */
export function SectionTitle({
  actions,
  title,
}: {
  actions?: React.ReactNode;
  title: string;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-1 pr-2.5 pl-4">
      <h2 className="min-w-0 flex-1 truncate font-bold text-base">{title}</h2>
      {actions && <div className="flex shrink-0 items-center">{actions}</div>}
    </div>
  );
}
