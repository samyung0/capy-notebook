import { useClerk, useUser } from '@clerk/react';
import { Component, type ReactNode, useState } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { USE_MSW } from '@/api/auth';
import fileIcons from '@/assets/catppuccin.svg?no-inline';
import { AppAuthProvider } from '@/components/app/AuthProvider';
import { PublicThemeToggle } from '@/components/app/PublicThemeToggle';
import { ThemeDrawer } from '@/components/app/ThemeDrawer';
import { Avatar } from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Menu } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { track } from '@/lib/observability';
import { ThemeProvider } from '@/theme/ThemeProvider';
import { SummaryFailure } from './SummaryFailure';

const authRoot = document.getElementById('summary-auth');
const errorRoot = document.getElementById('summary-error');
const workspaceId = authRoot?.dataset.workspaceId;
const locale = (authRoot ?? errorRoot)?.dataset.locale === 'zh' ? 'zh' : 'en';
const options = { locale } as const;
const returnTo = workspaceId ? `/workspaces/${workspaceId}` : '/';
const signInURL = `/sign-in?${new URLSearchParams({ redirect_url: returnTo })}`;
const signUpURL = `/sign-up?${new URLSearchParams({ redirect_url: returnTo })}`;

export function PublicNavigation() {
  return (
    <nav
      aria-label={m.summary_profile({}, options)}
      className="summary-actions"
    >
      <PublicThemeToggle locale={locale} />
      <Button asChild variant="ghost-hover">
        <a href={signInURL}>{m.action_sign_in({}, options)}</a>
      </Button>
      <Button asChild size="lg">
        <a href={signUpURL}>{m.summary_sign_up({}, options)}</a>
      </Button>
    </nav>
  );
}

export function AccountBar() {
  const { user, isSignedIn } = useUser();
  const { signOut } = useClerk();
  const [themeOpen, setThemeOpen] = useState(false);
  if (!isSignedIn) return <PublicNavigation />;
  return (
    <>
      <div className="summary-actions">
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
                className="size-7.5 text-xs"
                name={user?.fullName ?? undefined}
                src={user?.imageUrl}
              />
              <span>{user?.firstName}</span>
              <Icon name="chevronDown" size={14} />
            </button>
          }
        />
      </div>
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

if (errorRoot) {
  hydrateRoot(
    errorRoot,
    <ThemeProvider>
      <SummaryFailure
        locale={locale}
        status={Number(errorRoot.dataset.status)}
      />
    </ThemeProvider>
  );
}

// The summary and file panel reference the same Vite-hashed sprite.
for (const icon of document.querySelectorAll<SVGUseElement>(
  'use[data-file-icon]'
)) {
  icon.setAttribute('href', `${fileIcons}#${icon.dataset.fileIcon}`);
}
