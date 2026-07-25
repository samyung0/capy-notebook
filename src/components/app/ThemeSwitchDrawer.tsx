import { useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/Drawer';
import { cn } from '@/lib/cn';
import {
  STYLES,
  type Style,
  THEMES,
  type Theme,
  useTheme,
} from '@/theme/ThemeProvider';
import {
  Card,
  InputTitle,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui';

export function ThemeSwitchDrawer({
  className,
  trigger,
  open: openProp,
  onOpenChange,
}: {
  className?: string;
  /** Optional trigger — omit when opening from outside (e.g. a menu item). */
  trigger?: React.ComponentProps<typeof DrawerTrigger>['render'];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const { theme, style, setTheme, setStyle } = useTheme();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);

  return (
    <Drawer
      modal={false}
      onOpenChange={setOpen}
      open={open}
      showSwipeHandle
      swipeDirection="right"
    >
      {trigger != null && <DrawerTrigger render={trigger} />}
      <DrawerContent>
        <Card
          asChild
          className={cn(
            'm-0 flex h-full w-full min-w-62 shrink-0 items-stretch gap-0 overflow-y-auto rounded-none bg-surface px-2.5 py-4 text-surface-fg',
            className
          )}
          radius="card-xl"
          theme="gray"
        >
          <aside>
            <div className="flex flex-col gap-6">
              <p className="t-card-title">Theme</p>
              <div className="flex flex-col gap-1">
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <InputTitle>Style</InputTitle>
                  </div>
                  <div className="min-w-45 max-w-70">
                    <Select
                      onValueChange={(v) => setStyle(v as Style)}
                      value={style}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {STYLES.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              <div className="flex items-center gap-1.5">
                                <span className="translate-y-px">
                                  {o.label}
                                </span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="mt-3 flex items-center justify-between gap-3">
                  <div className="flex flex-col gap-1">
                    <InputTitle>Theme</InputTitle>
                  </div>
                  <div className="min-w-45 max-w-70">
                    <Select
                      onValueChange={(v) => setTheme(v as Theme)}
                      value={theme}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectGroup>
                          {THEMES.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              <div className="flex items-center gap-1.5">
                                <span className="translate-y-px">
                                  {o.label}
                                </span>
                              </div>
                            </SelectItem>
                          ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </Card>
      </DrawerContent>
    </Drawer>
  );
}
