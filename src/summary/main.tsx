import { useClerk, useUser } from '@clerk/react';
import { Component, type ReactNode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { USE_MSW } from '@/api/auth';
import { AppAuthProvider } from '@/components/app/AuthProvider';
import { ThemeDrawer } from '@/components/app/ThemeDrawer';
import { Avatar } from '@/components/ui/Avatar';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { track } from '@/lib/observability';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { TopInsetFrame } from './TopInsetFrame';

const authRoot = document.getElementById('summary-auth');
const workspaceId = authRoot?.dataset.workspaceId;
const locale = authRoot?.dataset.locale === 'zh' ? 'zh' : 'en';
const options = { locale } as const;
const returnTo = workspaceId ? `/workspaces/${workspaceId}` : '/';
const signInURL = `/sign-in?${new URLSearchParams({ redirect_url: returnTo })}`;

function PublicNavigation() {
  return (
    <TopInsetFrame className="summary-inset">
      <a href="/explore">{m.nav_explore({}, options)}</a>
      <a href={signInURL}>{m.action_sign_in({}, options)}</a>
    </TopInsetFrame>
  );
}

export function AccountBar() {
  const { user, isSignedIn } = useUser();
  const { signOut } = useClerk();
  const [themeOpen, setThemeOpen] = useState(false);
  if (!isSignedIn) return <PublicNavigation />;
  return (
    <>
      <TopInsetFrame className="summary-inset">
        <a href="/explore">{m.nav_explore({}, options)}</a>
        <Menu
          align="end"
          items={[
            {
              icon: 'settings',
              label: m.profile_menu_settings({}, options),
              onClick: () => {
                window.location.href = '/settings';
              },
            },
            {
              icon: 'chart',
              label: m.profile_menu_billing({}, options),
              onClick: () => {
                window.location.href = '/billing';
              },
            },
            {
              icon: 'palette',
              label: m.settings_theme({}, options),
              onClick: () => setThemeOpen(true),
            },
            {
              danger: true,
              icon: 'logout',
              label: m.profile_menu_logout({}, options),
              onClick: () => {
                void signOut({ redirectUrl: window.location.pathname });
              },
            },
          ]}
          trigger={
            <button
              aria-label={m.summary_profile({}, options)}
              className="summary-profile"
              type="button"
            >
              <Avatar
                name={user?.fullName ?? undefined}
                size="sm"
                src={user?.imageUrl}
              />
              <span>{user?.firstName}</span>
              <Icon name="chevronDown" size={14} />
            </button>
          }
        />
      </TopInsetFrame>
      <ThemeDrawer onOpenChange={setThemeOpen} open={themeOpen} />
    </>
  );
}

// biome-ignore lint/style/useReactFunctionComponents: React error boundaries require a class.
class IslandBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <PublicNavigation /> : this.props.children;
  }
}

if (authRoot) {
  if (workspaceId) track('summary_viewed', { workspaceId });
  const clerkActive =
    !USE_MSW && Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);
  createRoot(authRoot).render(
    <ThemeProvider>
      <IslandBoundary>
        {clerkActive ? (
          <AppAuthProvider pending={<PublicNavigation />}>
            <AccountBar />
          </AppAuthProvider>
        ) : (
          <PublicNavigation />
        )}
      </IslandBoundary>
    </ThemeProvider>
  );
}
