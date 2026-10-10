import { Outlet } from '@tanstack/react-router';
import { ItemLeaveGuard } from '@/features/collaboration/unsentItems';
import { AnalyticsRoot } from './AnalyticsRoot';
import { AppShell } from './AppShell';
import { AuthGate } from './AuthProvider';

export function RootRoute() {
  return (
    <>
      <AnalyticsRoot />
      <Outlet />
      {/* <TanStackRouterDevtools /> */}
    </>
  );
}

export function AuthShellRoute() {
  return (
    <AuthGate>
      <ItemLeaveGuard />
      <AppShell />
    </AuthGate>
  );
}
