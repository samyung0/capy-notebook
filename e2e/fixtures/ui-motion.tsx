import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { qk } from '@/api/client';
import type { AppNotification } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { ContentSwap } from '@/components/ui/ContentSwap';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/ContextMenu';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/Dialog';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/Drawer';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Menu } from '@/components/ui/Menu';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { PopupMotion } from '@/components/ui/PopupMotion';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/Tooltip';
import { NotificationsBell } from '@/features/notification/NotificationBell';
import { NotificationItem } from '@/features/notification/NotificationItem';
import { useLoadingReveal } from '@/lib/useLoadingReveal';
import '@/styles/tailwind.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { enabled: false } },
});
const initialNotice: AppNotification = {
  at: '2026-09-14T00:00:00Z',
  data: { code: 'welcome' },
  id: 'existing',
  kind: 'system',
};
let notices = [initialNotice];
function publishNotices(items: AppNotification[]) {
  notices = items;
  queryClient.setQueryData(qk.notifications, {
    pageParams: [''],
    pages: [{ items }],
  });
}
publishNotices(notices);
queryClient.setQueryData(qk.notificationUnread, { count: 1 });

function MotionChecks() {
  const [open, setOpen] = useState(false);
  const [moved, setMoved] = useState(false);
  const [copy, setCopy] = useState(false);
  const [read, setRead] = useState(false);
  const [action, setAction] = useState('none');
  const [executions, setExecutions] = useState(0);
  const [loading, setLoading] = useState(true);
  const revealRef = useLoadingReveal(loading);

  return (
    <main className="flex flex-col items-start gap-2 p-4">
      <section data-testid="notices">
        <NotificationsBell />
      </section>
      <Button
        onClick={() =>
          publishNotices([
            { ...initialNotice, at: '2026-09-14T00:00:01.001Z', id: 'new' },
            ...notices,
          ])
        }
      >
        Insert notice
      </Button>
      <Button onClick={() => publishNotices([...notices])}>
        Refresh notices
      </Button>
      <Button
        onClick={() =>
          publishNotices([
            ...notices,
            { ...initialNotice, at: '2026-09-13T00:00:00Z', id: 'older' },
          ])
        }
      >
        Load earlier notice
      </Button>
      <Button
        onClick={() => {
          setOpen(!open);
          if (open) setMoved(false);
        }}
      >
        Toggle tool
      </Button>
      <Button onClick={() => setMoved(true)}>Move anchor</Button>
      <PopupMotion
        className="rounded-card bg-surface p-4 shadow-pop"
        data-testid="tool"
        open={open}
        positionClassName="fixed z-50"
        style={{
          left: 0,
          top: 0,
          transform: `translate(${moved ? 480 : 360}px, 80px)`,
        }}
      >
        <button type="button">{moved ? 'Moved content' : 'Tool action'}</button>
      </PopupMotion>
      <Button onClick={() => setCopy(!copy)}>Change copy</Button>
      <ContentSwap contentKey={String(copy)}>
        {copy ? 'Copied' : 'Copy'}
      </ContentSwap>
      <Button onClick={() => setRead(!read)}>Mark read</Button>
      <NotificationItem
        notification={{
          at: '2026-09-14T00:00:00Z',
          data: {
            code: 'source_ready',
            fileName: copy ? 'Updated file' : 'Original file',
          },
          id: 'one',
          kind: 'system',
          readAt: read ? '2026-09-14T00:00:01Z' : undefined,
        }}
      />
      <Menu
        alignWidthToTrigger
        items={[
          {
            label: 'Rename',
            onClick: () => {
              setAction('rename');
              setExecutions((count) => count + 1);
            },
          },
          { disabled: true, label: 'Unavailable' },
          {
            danger: true,
            label: 'Delete',
            onClick: () => {
              setAction('delete');
              setExecutions((count) => count + 1);
            },
          },
        ]}
        trigger={<Button className="w-64">Actions</Button>}
      />
      <output>{action}</output>
      <span data-testid="executions">{executions}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Nested actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                onSelect={() => setExecutions((count) => count + 1)}
              >
                Nested action
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Button>Context actions</Button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger>More actions</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem
                onSelect={() => setExecutions((count) => count + 1)}
              >
                Nested action
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
      <Popover>
        <PopoverTrigger asChild>
          <Button>Open popover</Button>
        </PopoverTrigger>
        <PopoverContent>
          <Button>Popover action</Button>
        </PopoverContent>
      </Popover>
      <Select defaultValue="one">
        <SelectTrigger aria-label="Pick option">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="one">One</SelectItem>
          <SelectItem value="two">Two</SelectItem>
        </SelectContent>
      </Select>
      <Dialog>
        <DialogTrigger asChild>
          <Button>Open dialog</Button>
        </DialogTrigger>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Motion dialog</DialogTitle>
        </DialogContent>
      </Dialog>
      <Drawer showSwipeHandle>
        <DrawerTrigger render={<Button />}>Open drawer</DrawerTrigger>
        <DrawerContent>
          <DrawerTitle>Motion drawer</DrawerTitle>
          <DrawerDescription>Swipe or close this panel.</DrawerDescription>
          <div className="h-56" />
          <DrawerClose render={<Button />}>Close drawer</DrawerClose>
        </DrawerContent>
      </Drawer>
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>Hover help</TooltipTrigger>
          <TooltipContent>Helpful text</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Button onClick={() => setLoading(false)}>Resolve loading</Button>
      {loading ? (
        <div>Loading rows</div>
      ) : (
        <div ref={revealRef}>
          <div data-testid="loaded-row">Loaded row</div>
        </div>
      )}
    </main>
  );
}

const router = createRouter({
  history: createMemoryHistory({ initialEntries: ['/'] }),
  routeTree: createRootRoute({ component: MotionChecks }),
});
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
);
