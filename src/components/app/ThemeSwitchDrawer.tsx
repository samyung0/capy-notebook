import { useRouterState } from '@tanstack/react-router';
import { type ComponentProps, useEffect, useState } from 'react';
import { ThemeDrawer } from './ThemeDrawer';

export function ThemeSwitchDrawer({
  open: controlledOpen,
  onOpenChange,
  ...props
}: ComponentProps<typeof ThemeDrawer>) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = onOpenChange ?? setLocalOpen;
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);
  return <ThemeDrawer {...props} onOpenChange={setOpen} open={open} />;
}
