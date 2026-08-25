import { UserButton } from '@clerk/react';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  BarChart3,
  Gauge,
  Menu,
  Search,
  Settings2,
  ShieldCheck,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { useOpsApp } from '@/app-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const navItems = [
  { adminOnly: false, icon: Gauge, label: 'Overview', to: '/' },
  { adminOnly: false, icon: Activity, label: 'Health', to: '/health' },
  { adminOnly: false, icon: Search, label: 'User lookup', to: '/users' },
  { adminOnly: false, icon: BarChart3, label: 'Cost explorer', to: '/costs' },
  {
    adminOnly: true,
    icon: Settings2,
    label: 'Model registry',
    to: '/registry',
  },
] as const;

function Navigation({ close }: { close?: () => void }) {
  const { session } = useOpsApp();
  return (
    <nav aria-label="Operator navigation" className="space-y-1">
      {navItems
        .filter((item) => !item.adminOnly || session.role === 'admin')
        .map((item) => (
          <Link
            activeOptions={{ exact: item.to === '/' }}
            activeProps={{
              className: 'bg-accent text-accent-foreground',
            }}
            className="flex min-h-10 items-center gap-3 rounded-md px-3 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            key={item.to}
            onClick={close}
            to={item.to}
          >
            <item.icon aria-hidden="true" className="size-4" />
            {item.label}
          </Link>
        ))}
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">
        <ShieldCheck aria-hidden="true" className="size-5" />
      </span>
      <div>
        <p className="font-semibold leading-tight">Evo Notes</p>
        <p className="text-muted-foreground text-xs">Internal operations</p>
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const { session } = useOpsApp();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="min-h-dvh bg-background">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r bg-card lg:flex lg:flex-col">
        <div className="border-b p-5">
          <Brand />
        </div>
        <div className="flex-1 p-3">
          <Navigation />
        </div>
        <div className="border-t p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-muted-foreground text-xs">
                {session.userId}
              </p>
              <Badge className="mt-1 capitalize" variant="secondary">
                {session.role}
              </Badge>
            </div>
            <UserButton />
          </div>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b bg-background/95 px-4 backdrop-blur lg:hidden">
          <Sheet onOpenChange={setMobileOpen} open={mobileOpen}>
            <SheetTrigger asChild>
              <Button aria-label="Open navigation" size="icon" variant="ghost">
                <Menu aria-hidden="true" />
              </Button>
            </SheetTrigger>
            <SheetContent className="w-72 p-0" side="left">
              <SheetHeader className="border-b p-5 text-left">
                <SheetTitle>
                  <Brand />
                </SheetTitle>
                <SheetDescription className="sr-only">
                  Operator dashboard navigation
                </SheetDescription>
              </SheetHeader>
              <div className="p-3">
                <Navigation close={() => setMobileOpen(false)} />
              </div>
            </SheetContent>
          </Sheet>
          <p className="font-semibold text-sm">Operations</p>
          <UserButton />
        </header>

        <main
          className={cn(
            'mx-auto w-full max-w-[1600px] space-y-6 p-4 sm:p-6 lg:p-8'
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
