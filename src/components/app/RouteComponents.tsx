import { Outlet } from '@tanstack/react-router';
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
      <AppShell />
    </AuthGate>
  );
}
