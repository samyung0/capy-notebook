import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { useMediaQuery } from 'usehooks-ts';
import { Icon, type IconName } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { features } from '@/lib/features';
import {
  Card,
  Drawer,
  DrawerContent,
  DrawerTrigger,
  IconButton,
  LogoMark,
} from '../ui';
import { ThemeSwitcher } from './ThemeSwitcher';

interface NavItem {
  exact?: boolean;
  icon: IconName;
  label: string;
  to: string;
}

function items(): { general: NavItem[]; tools: NavItem[]; bottom: NavItem[] } {
  return {
    bottom: [{ icon: 'help', label: m.nav_support(), to: '/support' }],
    general: [
      { exact: true, icon: 'dashboard', label: m.nav_dashboard(), to: '/' },
      { icon: 'workspaces', label: m.nav_workspaces(), to: '/workspaces' },
      { icon: 'schedule', label: m.nav_schedule(), to: '/schedule' },
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
      { icon: 'quiz', label: m.nav_quizzes(), to: '/quizzes' },
      { icon: 'flashcards', label: m.nav_flashcards(), to: '/flashcards' },
      { icon: 'files', label: m.nav_files(), to: '/files' },
      { icon: 'tasks', label: m.nav_tasks(), to: '/tasks' },
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
        'flex items-center rounded-button transition-colors',
        collapsed ? 'h-10 w-10 justify-center' : 'w-full gap-3 px-3 py-2',
        active
          ? 'bg-action font-bold text-action-fg'
          : 'font-medium text-fg hover:bg-surface-dark-hover-bg'
      )}
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
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const nav = items();

  // TODO: untested
  if (collapsed) {
    return (
      <Card
        asChild
        className="m-2.5 mr-0 flex w-15 shrink-0 items-stretch gap-0 overflow-y-auto px-2.5 py-4"
        radius="row"
        theme="gray"
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
          <ThemeSwitcher collapsed />
          <Link
            className="flex h-10 w-10 items-center justify-center rounded-button text-fg hover:bg-surface-hover-bg"
            preload="intent"
            title={m.nav_support()}
            to="/support"
          >
            <Icon name="help" size={19} />
          </Link>
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
      radius="card-xl"
      theme="page"
    >
      <nav>
        <div className="flex items-center justify-between px-2 pt-1 pb-6">
          <div className="flex items-center gap-3">
            <LogoMark size={36} />
            <h1
              className={cn(
                't-card-title translate-y-px font-extrabold tracking-[-0.02rem]'
              )}
            >
              {m.app_name()}
            </h1>
          </div>
          <IconButton
            className="lg:hidden"
            icon="x"
            label="Close"
            onClick={onNavigate}
            size="sm"
            variant="ghost"
          />
        </div>

        <div className="t-label px-3 pt-0 pb-1.5 text-fg-muted">
          {m.nav_section_general()}
        </div>
        <div className="flex flex-col gap-1">
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
        <div className="t-label mt-4 px-3 pt-0 pb-1.5 text-fg-muted">
          {m.nav_section_tools()}
        </div>
        <div className="flex flex-col gap-1">
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
        <div className="mt-3 border-divider border-t pt-2">
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
      </nav>
    </Card>
  );
}

/**
 * Mobile-only hamburger that slides the full nav in from the left.
 * The trigger is meant to live in the top inset bar; the drawer closes
 * itself whenever the route changes.
 */
export function MobileNavDrawer({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const isLg = useMediaQuery('(min-width: 1024px)');
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (isLg && open) {
      setOpen(false);
    }
  }, [isLg, open]);

  return (
    <Drawer
      onOpenChange={setOpen}
      open={open}
      showSwipeHandle
      swipeDirection="left"
    >
      <DrawerTrigger
        render={
          <IconButton
            aria-label="Open navigation"
            className={className}
            icon="menu"
            size="md"
            variant="dark"
          />
        }
      />
      <DrawerContent>
        <Sidebar
          className="m-0 h-full w-full min-w-62 rounded-none bg-surface text-surface-fg"
          onNavigate={() => setOpen(false)}
        />
      </DrawerContent>
    </Drawer>
  );
}
