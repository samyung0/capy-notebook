import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useMediaQuery } from 'usehooks-ts';
import { Icon, type IconName } from '@/components/ui/Icon';
import { NotificationsBell } from '@/features/notification/NotificationBell';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { features } from '@/lib/features';
import { useNotionLight } from '@/theme/theme';
import { BASE_BUTTON_STYLE } from '../ui/Button';
import { Card } from '../ui/Card';
import { Drawer, DrawerContent, DrawerTrigger } from '../ui/Drawer';
import { IconButton } from '../ui/IconButton';
import { LogoMark } from '../ui/Logo';
import { ProfilePill, SearchButton } from './AccountControls';

interface NavItem {
  exact?: boolean;
  icon: IconName;
  label: string;
  to: string;
}

function items(): { general: NavItem[]; tools: NavItem[]; bottom: NavItem[] } {
  return {
    bottom: [
      { icon: 'settings', label: m.profile_menu_settings(), to: '/settings' },
      { icon: 'book', label: m.nav_help_legal(), to: '/help-and-legal' },
    ],
    general: [
      { exact: true, icon: 'dashboard', label: m.nav_dashboard(), to: '/' },
      { icon: 'workspaces', label: m.nav_workspaces(), to: '/workspaces' },
      ...(features.schedule
        ? [
            {
              icon: 'schedule' as IconName,
              label: m.nav_schedule(),
              to: '/schedule',
            },
          ]
        : []),
      ...(features.explore
        ? [
            {
              icon: 'globe' as IconName,
              label: m.nav_explore(),
              to: '/explore',
            },
          ]
        : []),
    ],
    tools: [
      { icon: 'sparkles', label: m.nav_create(), to: '/create' },
      { icon: 'circleCheck', label: m.nav_learning(), to: '/learning' },
      { icon: 'files', label: m.nav_files(), to: '/files' },
      ...(features.tasks
        ? [{ icon: 'todo' as IconName, label: m.nav_tasks(), to: '/tasks' }]
        : []),
      ...(features.thinking
        ? [
            {
              icon: 'notes' as IconName,
              label: m.nav_thinking(),
              to: '/thinking',
            },
          ]
        : []),
    ],
  };
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(item.to + '/');
}

function Row({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <Link
      className={cn(
        BASE_BUTTON_STYLE,
        'flex h-fit justify-start px-0 py-0 leading-(--body-line-height) transition-transform active:-rotate-1',
        collapsed ? 'h-10 w-10 justify-center' : 'w-full gap-3 px-3 py-2',
        active
          ? 'bg-action font-bold text-action-fg'
          : 'font-medium text-fg hover:bg-page-hover'
      )}
      data-active={active || undefined}
      data-slot="app-nav-row"
      onClick={onNavigate}
      preload="intent"
      title={collapsed ? item.label : undefined}
      to={item.to}
    >
      <Icon name={item.icon} size={19} />
      {!collapsed && (
        <span className={cn('translate-y-px font-semibold')}>{item.label}</span>
      )}
    </Link>
  );
}

export function Sidebar({
  collapsed = false,
  className,
  onNavigate,
}: {
  collapsed?: boolean;
  className?: string;
  onNavigate?: () => void;
}) {
  // TODO: maybe switch to shadcn sidebar approach?
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const nav = items();
  const notionLight = useNotionLight();

  // TODO: untested
  if (collapsed) {
    return (
      <Card
        asChild
        className="m-2.5 mr-0 flex w-15 shrink-0 items-stretch gap-0 overflow-y-auto px-2.5 py-4"
        radius="row"
        theme="surface-dark"
      >
        <nav>
          <LogoMark size={36} />
          <div className="h-2" />
          {nav.general.map((i) => (
            <Row active={isActive(pathname, i)} collapsed item={i} key={i.to} />
          ))}
          <div className="h-2" />
          {nav.tools.map((i) => (
            <Row active={isActive(pathname, i)} collapsed item={i} key={i.to} />
          ))}
          <div className="mt-auto" />
          {nav.bottom.map((i) => (
            <Row
              active={isActive(pathname, i)}
              collapsed
              item={i}
              key={i.to}
              onNavigate={onNavigate}
            />
          ))}
        </nav>
      </Card>
    );
  }

  return (
    <Card
      asChild
      className={cn(
        'm-2.5 mr-0 ml-1 flex w-52 shrink-0 items-stretch gap-0 overflow-y-auto px-2.5 py-4',
        className
      )}
      data-slot="app-sidebar"
      radius="card-xl"
      theme="page"
    >
      <nav>
        <div
          className="flex items-center justify-between px-3 pt-1 pb-6"
          data-slot="sidebar-brand"
        >
          <div className="flex items-center gap-3">
            {/* <LogoMark size={36} /> */}
            <h1 className={cn('t-card-title font-extrabold tracking-tight')}>
              {m.app_name()}
            </h1>
          </div>
          <IconButton
            className={onNavigate ? undefined : 'lg:hidden'}
            icon="x"
            label={m.action_close()}
            onClick={onNavigate}
            size="sm"
            variant="ghost"
          />
        </div>

        {notionLight && (
          <div data-slot="sidebar-utilities">
            <SearchButton />
            <NotificationsBell />
          </div>
        )}
        <div
          className="t-label px-3 pt-0 pb-1.5 text-fg-muted"
          data-slot="sidebar-section-label"
        >
          {m.nav_section_general()}
        </div>
        <div className="flex flex-col gap-1" data-slot="sidebar-links">
          {nav.general.map((i) => (
            <Row
              active={isActive(pathname, i)}
              collapsed={false}
              item={i}
              key={i.to}
              onNavigate={onNavigate}
            />
          ))}
        </div>
        <div
          className="t-label mt-4 px-3 pt-0 pb-1.5 text-fg-muted"
          data-section="tools"
          data-slot="sidebar-section-label"
        >
          {m.nav_section_tools()}
        </div>
        <div className="flex flex-col gap-1" data-slot="sidebar-links">
          {nav.tools.map((i) => (
            <Row
              active={isActive(pathname, i)}
              collapsed={false}
              item={i}
              key={i.to}
              onNavigate={onNavigate}
            />
          ))}
        </div>

        <div className="mt-auto" />
        <div
          className="mt-3 flex flex-col gap-1 border-divider border-t pt-2"
          data-slot="sidebar-links"
        >
          {nav.bottom.map((i) => (
            <Row
              active={isActive(pathname, i)}
              collapsed={false}
              item={i}
              key={i.to}
              onNavigate={onNavigate}
            />
          ))}
        </div>
        {notionLight && (
          <div data-slot="sidebar-account">
            <ProfilePill />
          </div>
        )}
      </nav>
    </Card>
  );
}

/**
 * Mobile-only hamburger that slides the full nav in from the left.
 * The trigger is meant to live in the top inset bar; the drawer closes
 * itself whenever the route changes.
 */
export function MobileNavDrawer({
  className,
  allowDesktop = false,
}: {
  className?: string;
  allowDesktop?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const notionLight = useNotionLight();
  const isLg = useMediaQuery('(min-width: 1024px)');
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (isLg && open && !allowDesktop) {
      setOpen(false);
    }
  }, [isLg, open, allowDesktop]);

  return (
    <Drawer
      onOpenChange={setOpen}
      open={open}
      showSwipeHandle
      swipeDirection="left"
    >
      <DrawerTrigger
        data-slot="iconbutton"
        render={
          <IconButton
            aria-label={m.a11y_open_navigation()}
            className={className}
            icon="menu"
            size="md"
            variant={notionLight ? 'ghost-hover' : 'dark'}
          />
        }
      />
      <DrawerContent data-app-navigation>
        <Sidebar
          className="m-0 h-full w-full min-w-62 rounded-none bg-surface text-fg"
          onNavigate={() => setOpen(false)}
        />
      </DrawerContent>
    </Drawer>
  );
}
