import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useMediaQuery } from 'usehooks-ts';
import { useUnreadNotificationCount } from '@/api/hooks';
import { Icon, type IconName } from '@/components/ui/Icon';
import { GettingStartedRow } from '@/features/guide/GettingStartedRow';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { features } from '@/lib/features';
import { useFrosted } from '@/theme/theme';
import { BASE_BUTTON_STYLE } from '../ui/Button';
import { ButtonGroup } from '../ui/ButtonGroup';
import { Card } from '../ui/Card';
import { Drawer, DrawerContent, DrawerTrigger } from '../ui/Drawer';
import { IconButton } from '../ui/IconButton';
import { LogoMark } from '../ui/Logo';
import { ProfileMenu, ProfileRow } from './ProfileMenu';
import { RecentQuickOpen } from './RecentQuickOpen';
import { SearchDialog } from './SearchDialog';

interface NavItem {
  exact?: boolean;
  icon: IconName;
  label: string;
  to: string;
}

function items(): {
  sections: { label: string; items: NavItem[] }[];
  bottom: NavItem[];
} {
  return {
    bottom: [
      { icon: 'settings', label: m.profile_menu_settings(), to: '/settings' },
      { icon: 'chart', label: m.profile_menu_billing(), to: '/billing' },
    ],
    sections: [
      { items: general(), label: m.nav_section_general() },
      { items: tools(), label: m.nav_section_tools() },
      {
        items: [
          { icon: 'quiz', label: m.question_ui_question_bank(), to: '/qb' },
        ],
        label: m.nav_section_explore(),
      },
    ],
  };
}

function general(): NavItem[] {
  return [
    { exact: true, icon: 'dashboard', label: m.nav_dashboard(), to: '/' },
    { icon: 'workspaces', label: m.nav_workspaces(), to: '/workspaces' },
    { icon: 'knowledge', label: m.nav_learning(), to: '/learning' },
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
  ];
}

function tools(): NavItem[] {
  return [
    { icon: 'filesNav', label: m.nav_files(), to: '/files' },
    ...(features.tasks
      ? [{ icon: 'todo' as IconName, label: m.nav_tasks(), to: '/tasks' }]
      : []),
  ];
}

function isActive(pathname: string, item: NavItem): boolean {
  if (item.exact) return pathname === item.to;
  return pathname === item.to || pathname.startsWith(item.to + '/');
}

// Rows clip their own label so the 70px rail shows only the icon.
const ROW_CLASS =
  'flex h-fit w-full justify-start gap-3 overflow-hidden whitespace-nowrap px-3 py-2 leading-(--body-line-height) active:-rotate-1';

/* The rail fades every `data-label` (row labels, the profile's name) in as it
   widens and out as it narrows. */
const RAIL_LABELS =
  '[&_[data-label]]:opacity-0 [&_[data-label]]:transition-opacity [&_[data-label]]:duration-(--motion-duration-fast) rail-open:[&_[data-label]]:opacity-100 group-hover/rail:[&_[data-label]]:delay-100';
const ROW_IDLE = 'font-medium text-fg hover:bg-page-hover';

function Row({
  item,
  active,
  onNavigate,
  unreadCount,
}: {
  item: NavItem;
  active: boolean;
  onNavigate?: () => void;
  /** Notifications only: the dot, and the count for tests and screen readers. */
  unreadCount?: number;
}) {
  return (
    <Link
      aria-label={
        unreadCount
          ? m.notifications_unread_count({ count: String(unreadCount) })
          : undefined
      }
      className={cn(
        BASE_BUTTON_STYLE,
        ROW_CLASS,
        active ? 'bg-action font-bold text-action-fg' : ROW_IDLE
      )}
      data-unread-count={unreadCount}
      onClick={onNavigate}
      preload="intent"
      to={item.to}
    >
      <span className="relative shrink-0">
        <Icon name={item.icon} size={19} />
        {!!unreadCount && (
          <span
            className={cn(
              'absolute -top-0.5 -right-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-solid-error ring-1',
              active ? 'ring-action' : 'ring-page'
            )}
          />
        )}
      </span>
      <span className="translate-y-px font-semibold" data-label>
        {item.label}
      </span>
    </Link>
  );
}

/** A nav-style row that opens the search dialog. */
function SearchRow() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={cn(BASE_BUTTON_STYLE, ROW_CLASS, ROW_IDLE)}
        onClick={() => setOpen(true)}
        type="button"
      >
        <Icon className="shrink-0" name="search" size={19} />
        <span className="translate-y-px font-semibold" data-label>
          {m.nav_search()}
        </span>
      </button>
      <SearchDialog open={open} setOpen={setOpen} />
    </>
  );
}

const NOTIFICATIONS = '/notifications';

/**
 * The app nav. With `account` it also carries search and notifications under
 * the app name and, at its foot, your profile row, which opens the profile
 * menu (Settings, Billing, Theme, Log out); in the phone drawer the row links
 * to account settings and has its own Log out button instead.
 *
 * `rail` is the 640–1023px sidebar: the same rows clipped to 70px, where a
 * row's icon already sits at the rail's centre, without section labels. On
 * hover (or keyboard focus, or while one of its menus is open) it widens over
 * the page to the full sidebar, so only its width animates.
 */
export function Sidebar({
  account = false,
  rail = false,
  className,
  onNavigate,
}: {
  account?: boolean;
  rail?: boolean;
  className?: string;
  onNavigate?: () => void;
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { data: unread } = useUnreadNotificationCount({
    errorBoundary: false,
  });
  const nav = items();
  const withAccount = rail || account;
  const frosted = useFrosted('left');

  const body = (
    <nav aria-label={m.a11y_main_navigation()}>
      {rail ? (
        // The logo smokes out as the rail widens and the app name fades in
        // in line with the row icons, as on the full sidebar; narrowing drops
        // the name at once and the logo fades back.
        <div className="relative flex items-center px-0.75 pb-5">
          <span className="motion-smoke rail-open:motion-smoked shrink-0 group-hover/rail:delay-100">
            <LogoMark size={36} />
          </span>
          <p className="t-card-title absolute top-1 left-3 whitespace-nowrap font-extrabold tracking-tight opacity-0 rail-open:opacity-100 transition-opacity duration-0 rail-open:duration-(--motion-duration-fast) group-hover/rail:delay-(--motion-duration-fast)">
            {m.app_name()}
          </p>
        </div>
      ) : (
        <div className="flex items-center justify-between px-3 pt-1 pb-5">
          <p className="t-card-title font-extrabold tracking-tight">
            {m.app_name()}
          </p>
          {onNavigate && (
            // The drawer's swipe handle adds 12px past the card's right
            // edge; pull the X out so its glyph sits as far from the
            // drawer's edge as the title does from the left.
            <IconButton
              className="-mr-5.5"
              icon="x"
              label={m.action_close()}
              onClick={onNavigate}
              size="sm"
              variant="ghost-hover"
            />
          )}
        </div>
      )}

      {withAccount && (
        <div className="mb-4 flex flex-col gap-1">
          <SearchRow />
          <Row
            active={pathname === NOTIFICATIONS}
            item={{
              icon: 'bell',
              label: m.notifications_title(),
              to: NOTIFICATIONS,
            }}
            onNavigate={onNavigate}
            unreadCount={unread?.count ?? 0}
          />
        </div>
      )}

      {rail ? (
        <div className="flex flex-col gap-1">
          {nav.sections.flatMap((section) =>
            section.items.map((i) => (
              <Row active={isActive(pathname, i)} item={i} key={i.to} />
            ))
          )}
        </div>
      ) : (
        nav.sections.map((section, index) => (
          <div key={section.label}>
            <div
              className={cn(
                't-label px-3 pt-0 pb-1.5 text-fg-muted',
                index > 0 && 'mt-4'
              )}
            >
              {section.label}
            </div>
            <div className="flex flex-col gap-1">
              {section.items.map((i) => (
                <Row
                  active={isActive(pathname, i)}
                  item={i}
                  key={i.to}
                  onNavigate={onNavigate}
                />
              ))}
            </div>
          </div>
        ))
      )}

      <div className="mt-auto" />
      <div className="mt-3 flex flex-col gap-1 border-divider border-t pt-2">
        {withAccount && (
          <GettingStartedRow
            className={cn(BASE_BUTTON_STYLE, ROW_CLASS, ROW_IDLE)}
            onNavigate={onNavigate}
          />
        )}
        {nav.bottom.map((i) => (
          <Row
            active={isActive(pathname, i)}
            item={i}
            key={i.to}
            onNavigate={onNavigate}
          />
        ))}
        {withAccount &&
          (onNavigate ? (
            // The phone drawer: a link to account settings and Log out.
            <ProfileRow onNavigate={onNavigate} />
          ) : (
            <div className="flex flex-col">
              <ProfileMenu trigger="row" />
            </div>
          ))}
      </div>
    </nav>
  );

  if (rail)
    return (
      // The hover area is the whole strip from the window edge to the page
      // panel; it reaches over the shell's 10px padding without taking layout
      // width (-mr). The 70px card sits 4px in from both, its rows centred in
      // the strip, and widens over the page. Frosted, it blurs the page it
      // covers.
      <div className="group/rail relative z-40 -mr-2.5 w-19.5 shrink-0">
        {/* Once the widening starts, the hover area is the full width at
            once, so moving right while the card still grows keeps it open.
            A pass across the rail under the 100ms delay never catches it. */}
        <div className="invisible absolute inset-y-2.5 left-1 w-56 transition-[visibility] duration-0 group-hover/rail:visible group-hover/rail:delay-100" />
        <Card
          asChild
          className={cn(
            RAIL_LABELS,
            'absolute inset-y-2.5 left-1 z-40 flex rail-open:w-56 w-[70px] items-stretch gap-0 overflow-y-auto overflow-x-hidden px-3.5 pt-4 pb-2.5 transition-[width,box-shadow] duration-(--motion-duration-fast) ease-(--motion-ease-smooth-out) group-hover/rail:shadow-pop group-hover/rail:delay-100',
            frosted && 'backdrop-blur-[16px]'
          )}
          data-frosted={frosted || undefined}
          radius="card-xl"
          theme="page"
        >
          {body}
        </Card>
      </div>
    );

  // Frosted over the page frame's paint in the shell (`.page-frame`) when the
  // Theme drawer picks the left panel; the phone drawer's copy is portalled
  // outside it and stays opaque.
  return (
    <Card
      asChild
      className={cn(
        'm-2.5 mr-0 ml-1 flex w-56 shrink-0 items-stretch gap-0 overflow-y-auto px-2.5 pt-4 pb-2.5',
        className
      )}
      data-frosted={frosted || undefined}
      radius="card-xl"
      theme="page"
    >
      {body}
    </Card>
  );
}

/**
 * The hamburger that slides the full nav in from the left; the drawer closes
 * itself whenever the route changes. With `account` (phones) the drawer
 * carries search, notifications and the profile; without it (next to the top
 * bar on the opened workspace) the drawer is nav only.
 */
export function MobileNavDrawer({
  account = false,
  className,
}: {
  account?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const pressed = useRef(false);
  // The trigger hides from sm (rail) or lg (sidebar); close with it.
  const triggerGone = useMediaQuery(
    account ? '(min-width: 640px)' : '(min-width: 1024px)'
  );
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (triggerGone && open) {
      setOpen(false);
    }
  }, [triggerGone, open]);

  return (
    <Drawer
      onOpenChange={(next, details) => {
        // The click that ends the opening press lands outside the trigger.
        if (!next && pressed.current && details.reason === 'outside-press') {
          details.cancel();
          return;
        }
        setOpen(next);
      }}
      open={open}
      showSwipeHandle
      swipeDirection="left"
    >
      {/* Opens on pointerdown like the menus; the click after the press
          must not toggle it again. Keyboard clicks still open it. */}
      <DrawerTrigger
        onClick={(event) => {
          if (pressed.current && event.detail > 0) event.preventBaseUIHandler();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.ctrlKey) return;
          pressed.current = true;
          setOpen(true);
          // The press ends after the click its release fires.
          const release = () => {
            window.removeEventListener('pointerup', release);
            window.removeEventListener('pointercancel', release);
            setTimeout(() => {
              pressed.current = false;
            });
          };
          window.addEventListener('pointerup', release);
          window.addEventListener('pointercancel', release);
        }}
        render={
          <IconButton
            aria-label={m.a11y_open_navigation()}
            className={className}
            icon="menu"
            size="md"
            variant="outline"
          />
        }
      />
      <DrawerContent>
        <Sidebar
          account={account}
          className="m-0 h-full w-full min-w-62 rounded-none bg-surface text-fg"
          onNavigate={() => setOpen(false)}
        />
      </DrawerContent>
    </Drawer>
  );
}

/** The phone (below sm) top of a page, scrolling with it: the nav drawer's
 * menu button joined with the arrow that opens the recent files, and the
 * profile menu behind an avatar a little larger than it
 * that carries the unread notifications dot; its Notifications item opens
 * the notifications page. */
export function PhoneTopRow({ className }: { className?: string }) {
  // Shared with the nav's own query, so this costs no extra request.
  const { data: unread } = useUnreadNotificationCount({
    errorBoundary: false,
  });
  const [recentOpen, setRecentOpen] = useState(false);
  return (
    <div
      className={cn('flex items-center justify-between sm:hidden', className)}
    >
      {/* Neither half shrinks on press: one scaling alone opens a seam. On a
          frosted panel both show the frost instead of painting over it. */}
      <ButtonGroup aria-label={m.a11y_main_navigation()}>
        <MobileNavDrawer
          account
          className="frosted:bg-(--frost-fill) px-3.5 frosted:hover:bg-surface-hover-bg active:scale-100"
        />
        <IconButton
          className="frosted:bg-(--frost-fill) px-3 frosted:hover:bg-surface-hover-bg active:scale-100"
          icon="navigationForward"
          label={m.quick_open_title()}
          onClick={() => setRecentOpen(true)}
          size="md"
          variant="outline"
        />
      </ButtonGroup>
      {recentOpen && <RecentQuickOpen onClose={() => setRecentOpen(false)} />}
      <ProfileMenu
        dot={(unread?.count ?? 0) > 0}
        notifications
        trigger="avatar"
      />
    </div>
  );
}
