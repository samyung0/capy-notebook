import { Link } from '@tanstack/react-router';
import { useUnreadNotificationCount } from '@/api/hooks';
import type { Workspace } from '@/api/types';
import { ProfileMenu } from '@/components/app/ProfileMenu';
import { Icon, type IconName } from '@/components/ui/Icon';
import type { MenuItem } from '@/components/ui/Menu';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { iconUrl } from '@/lib/icon-catalog';

/** The workspace's sections (Epo 2026-11-02, S2 and N1): Dashboard has no
 * panel; Files, Agent and Study each show theirs beside the rail. */
export type WorkspaceSection =
  | 'dashboard'
  | 'files'
  | 'agent'
  | 'study'
  | 'canvas';

/** The canvas to play with: dev builds only, like the board's dev route, so a
 * production build drops BlockSuite's chunk until a page that ships opens it. */
export const CANVAS_SECTION = import.meta.env.DEV;

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
  ...(CANVAS_SECTION
    ? [
        {
          icon: 'shape' as const,
          label: m.workspace_section_canvas,
          value: 'canvas' as const,
        },
      ]
    : []),
];

/* A rail item: the icon over its label, as the app sidebar's rows look. The
   page-coloured glow keeps it readable over a dark page frame, and can't be
   seen without one. */
const ITEM =
  'flex w-[68px] cursor-pointer flex-col items-center gap-0.5 rounded-button-lg px-1 pt-2 pb-1.5 font-medium text-[11px] text-fg leading-[1.1] outline-none transition-colors drop-shadow-[0_0_3px_var(--color-page)] hover:bg-fg/6 focus-visible:ring-2 focus-visible:ring-action';

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
      className={cn(
        ITEM,
        active &&
          'bg-action font-bold text-action-fg drop-shadow-none hover:bg-action'
      )}
      onClick={onClick}
      type="button"
    >
      <Icon name={icon} size={20} />
      <span>{label}</span>
    </button>
  );
}

/** The labelled icon rail on every workspace page from md: Workspaces back to
 * the list, the workspace's badge (it only says where you are), the sections,
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
    // No panel of its own: on the shell like the app sidebar's background, so a
    // page frame shows straight through.
    <nav
      aria-label={m.workspace_rail_label()}
      className="flex h-full w-19 shrink-0 flex-col items-center gap-2 overflow-y-auto overflow-x-hidden py-3"
    >
      <Link className={cn(ITEM, 'mb-1')} preload="intent" to="/">
        <Icon name="navigationBack" size={20} />
        <span>{m.nav_workspaces()}</span>
      </Link>
      <img
        alt={workspace.name}
        className="mb-1.5 size-8.5 shrink-0 rounded-[9px]"
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
