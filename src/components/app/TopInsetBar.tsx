import { useClerk } from '@clerk/react';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { USE_MSW } from '@/api/auth';
import {
  useMarkNotificationsRead,
  useMe,
  useNotifications,
  useSearch,
} from '@/api/hooks';
import type { SearchKind } from '@/api/types';
import { Avatar } from '@/components/ui/Avatar';
import { Card } from '@/components/ui/Card';
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Menu } from '@/components/ui/Menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/Popover';
import { SkeletonList } from '@/components/ui/feedback';
import { cn } from '@/lib/cn';
import { useDebounced } from '@/lib/useDebounced';
import { userColorPair } from '@/lib/userColor';

const CLERK_PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as
  | string
  | undefined;
const CLERK_ACTIVE = !USE_MSW && !!CLERK_PUBLISHABLE_KEY;

import { VisuallyHidden } from 'radix-ui';
import { m } from '@/i18n';
import { usePortals } from '@/stores/portals';
import { MobileNavDrawer } from './Sidebar';
import { ThemeSwitchDrawer } from './ThemeSwitchDrawer';

const KIND_ICON: Record<SearchKind, Parameters<typeof Icon>[0]['name']> = {
  event: 'schedule',
  file: 'files',
  flashcards: 'flashcards',
  thinking: 'write',
  workspace: 'workspaces',
};

export function SearchDialog({
  open,
  setOpen,
}: {
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const debounced = useDebounced(q, 400);
  const { data, isFetching } = useSearch(debounced);
  const navigate = useNavigate();
  const query = debounced.trim();

  return (
    <Dialog
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        if (isOpen) setQ('');
      }}
      open={open}
    >
      <DialogContent
        cardScrollContainerClassName="p-0"
        className="top-[12vh] translate-y-0"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).querySelector('input')?.focus();
        }}
        showCloseButton={false}
      >
        <VisuallyHidden.Root asChild>
          <DialogTitle>{m.search_placeholder()}</DialogTitle>
        </VisuallyHidden.Root>
        <div className="flex max-h-[70vh] flex-col">
          <div className="flex items-center gap-2.5 border-divider border-b px-4 py-3">
            <Icon name="search" size={18} />
            <Input
              onChange={(e) => setQ(e.target.value)}
              placeholder={m.search_placeholder()}
              value={q}
              variant="transparent"
              wrapperClassName="flex-1 translate-y-px"
            />
            <DialogClose asChild>
              <IconButton icon="x" label="Close" size="sm" variant="ghost" />
            </DialogClose>
          </div>
          <div className="relative min-h-40 flex-1 overflow-auto py-1">
            {isFetching && (
              <SkeletonList className="p-1" count={5} rowHeight={48} />
            )}
            {!isFetching && !query && (
              <div className="absolute inset-0 flex items-center justify-center text-center">
                <span className="-translate-y-1/2">
                  {m.search_result_placeholder()}
                </span>
              </div>
            )}
            {!isFetching && query && !data?.length && (
              <div className="absolute inset-0 flex items-center justify-center text-center">
                <span className="-translate-y-1/2">
                  No matches for "{query}".
                </span>
              </div>
            )}
            {!isFetching &&
              data?.map((r) => {
                const c = r.color ? userColorPair(r.color) : null;
                return (
                  <button
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-hover-bg"
                    key={`${r.kind}-${r.id}`}
                    onClick={() => {
                      setOpen(false);
                      navigate({ to: r.href });
                    }}
                    type="button"
                  >
                    <span
                      className="flex h-8 w-8 items-center justify-center rounded-button bg-surface-hover-bg text-fg-secondary"
                      style={c ? { background: c.bg, color: c.fg } : undefined}
                    >
                      <Icon name={KIND_ICON[r.kind]} size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-fg text-sm">
                        {r.title}
                      </span>
                      {r.subtitle && (
                        <span className="block truncate text-fg-muted text-xs">
                          {r.subtitle}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SearchButton() {
  const setTopBarSearchOpen = usePortals((s) => s.setTopBarSearchOpen);
  return (
    <IconButton
      className="shrink-0"
      icon="search"
      label={m.search_placeholder()}
      onClick={() => setTopBarSearchOpen(true)}
      size="md"
      variant="dark"
    />
  );
}

function NotificationsBell() {
  const { data } = useNotifications();
  const markRead = useMarkNotificationsRead();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const unread = data?.some((n) => !n.read);

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <IconButton
          className="shrink-0"
          dot={unread}
          icon="bell"
          label="Notifications"
          onClick={() => {
            if (unread) markRead.mutate();
          }}
          size="md"
          variant="surface"
        />
      </PopoverTrigger>
      <PopoverContent>
        <Card
          border="solid"
          className="block min-w-[320px] max-w-[480px] p-1"
          radius="card"
        >
          <div className="t-label border-divider border-b px-4 py-3 text-fg-muted">
            {m.notifications_title()}
          </div>
          <div className="max-h-96 overflow-auto">
            {!data?.length && (
              <div className="px-4 py-6 text-center text-fg-muted">
                {m.notifications_empty()}
              </div>
            )}
            {data?.map((n) => {
              const content = (
                <>
                  <span className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-button text-solid-accent-1">
                    <Icon
                      name={
                        n.kind === 'event'
                          ? 'schedule'
                          : n.kind === 'quiz'
                            ? 'quiz'
                            : n.kind === 'workspace_invite'
                              ? 'workspaces'
                              : 'bell'
                      }
                      size={20}
                    />
                  </span>
                  <span className="flex flex-col text-left">
                    <span className="font-semibold">{n.title}</span>
                    <span className="text-fg-secondary">{n.body}</span>
                  </span>
                </>
              );
              const itemClass =
                'flex w-full gap-3 border-b border-divider px-4 py-3 last:border-0';
              return n.href ? (
                <button
                  className={`${itemClass} hover:bg-surface-hover-bg`}
                  key={n.id}
                  onClick={() => {
                    setOpen(false);
                    navigate({ to: n.href });
                  }}
                  type="button"
                >
                  {content}
                </button>
              ) : (
                <div className={itemClass} key={n.id}>
                  {content}
                </div>
              );
            })}
          </div>
        </Card>
      </PopoverContent>
    </Popover>
  );
}

function ProfilePillInner({ onLogout }: { onLogout?: () => void }) {
  const { data: me } = useMe();
  const navigate = useNavigate();
  const [themeOpen, setThemeOpen] = useState(false);

  return (
    <>
      <Menu
        align="end"
        alignWidthToTrigger
        items={[
          {
            icon: 'profile',
            label: m.profile_menu_profile(),
            onClick: () => navigate({ to: '/profile' }),
          },
          {
            icon: 'settings',
            label: m.profile_menu_subscription(),
            onClick: () => navigate({ to: '/subscription' }),
          },
          {
            icon: 'settings',
            label: m.profile_menu_settings(),
            onClick: () => navigate({ to: '/settings' }),
          },
          {
            icon: 'palette',
            label: m.settings_theme(),
            onClick: () => setThemeOpen(true),
          },
          {
            danger: true,
            icon: 'logout',
            label: m.profile_menu_logout(),
            onClick: onLogout,
          },
        ]}
        trigger={
          <button
            className="flex items-center gap-2.5 rounded-full bg-surface py-1 pr-3 pl-1 hover:bg-surface-hover-bg"
            type="button"
          >
            <Avatar name={me?.name} size="md" src={me?.avatarUrl} />
            <span className="text-left">
              <span className="block font-bold">{me?.name ?? '—'}</span>
            </span>
            <Icon className="text-fg-muted" name="chevronDown" size={16} />
          </button>
        }
      />
      <ThemeSwitchDrawer onOpenChange={setThemeOpen} open={themeOpen} />
    </>
  );
}

function ClerkProfilePill() {
  const { signOut } = useClerk();
  return <ProfilePillInner onLogout={() => void signOut()} />;
}

function ProfilePill() {
  if (!CLERK_ACTIVE) return <ProfilePillInner />;
  return <ClerkProfilePill />;
}

export function TopInsetBar({ className }: { className?: string }) {
  return (
    // the border radius should match the large panel/panel with inverted radius
    <Card
      className={cn(
        'top-inset-bar-shape flex-row items-center justify-between gap-2.5 py-1.5 pr-3 pl-4',
        className
      )}
      radius="unset"
      theme="surface-dark"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <MobileNavDrawer className="lg:hidden" />
        <div className="hidden lg:block">
          <SearchButton />
        </div>
        <NotificationsBell />
      </div>
      <ProfilePill />
    </Card>
  );
}
