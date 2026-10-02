import { useClerk, useUser } from '@clerk/react';
import { type ReactNode, useState } from 'react';
import { USE_MSW } from '@/api/auth';
import { PublicThemeToggle } from '@/components/app/PublicThemeToggle';
import { ThemeDrawer } from '@/components/app/ThemeDrawer';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/feedback';
import { Menu } from '@/components/ui/Menu';
import { m } from '@/i18n';
import { ProfilePillButton } from './ProfilePillButton';

/**
 * Header for pages signed-out visitors can open: the workspace summary (an
 * island in server-rendered HTML) and shared standalone quizzes and flashcard
 * sets. It needs no router, so both can mount it. Auth is read client side: a
 * skeleton while Clerk loads, then sign-in and sign-up or the profile pill.
 */

type Locale = 'en' | 'zh' | undefined;

const CLERK_ACTIVE =
  !USE_MSW && Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

const authURL = (page: 'sign-in' | 'sign-up', returnTo: string) =>
  `/${page}?${new URLSearchParams({ redirect_url: returnTo })}`;

export function PublicAccountSkeleton({ locale }: { locale?: Locale }) {
  return (
    <div
      aria-label={m.a11y_loading({}, { locale })}
      className="flex h-11.5 items-center"
      role="status"
    >
      <Skeleton className="h-11.5 w-[176px] rounded-full" />
    </div>
  );
}

export function PublicSignedOutNav({
  locale,
  returnTo,
}: {
  locale?: Locale;
  returnTo: string;
}) {
  return (
    <nav
      aria-label={m.summary_profile({}, { locale })}
      className="flex items-center gap-2"
    >
      <PublicThemeToggle locale={locale} />
      <Button asChild size="lg" variant="ghost-hover">
        <a href={authURL('sign-in', returnTo)}>
          {m.action_sign_in({}, { locale })}
        </a>
      </Button>
      <Button asChild size="lg">
        <a href={authURL('sign-up', returnTo)}>
          {m.summary_sign_up({}, { locale })}
        </a>
      </Button>
    </nav>
  );
}

function PublicProfilePill({ locale }: { locale?: Locale }) {
  const { user } = useUser();
  const { signOut } = useClerk();
  const [themeOpen, setThemeOpen] = useState(false);
  const options = { locale };
  return (
    <>
      <Menu
        align="end"
        alignWidthToTrigger
        items={[
          {
            icon: 'settings',
            label: m.profile_menu_settings({}, options),
            onClick: () => window.location.assign('/settings'),
          },
          {
            icon: 'chart',
            label: m.profile_menu_billing({}, options),
            onClick: () => window.location.assign('/billing'),
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
          <ProfilePillButton
            avatarUrl={user?.imageUrl}
            name={user?.fullName ?? user?.firstName ?? undefined}
          />
        }
      />
      <ThemeDrawer onOpenChange={setThemeOpen} open={themeOpen} />
    </>
  );
}

function ClerkAccountNav({
  locale,
  returnTo,
}: {
  locale?: Locale;
  returnTo: string;
}) {
  const { isLoaded, isSignedIn } = useUser();
  if (!isLoaded) return <PublicAccountSkeleton locale={locale} />;
  if (isSignedIn) return <PublicProfilePill locale={locale} />;
  return <PublicSignedOutNav locale={locale} returnTo={returnTo} />;
}

/** The header's right side. Without Clerk (MSW, key-less local runs) there is
 * no session, so it always offers sign-in and sign-up. */
export function PublicAccountNav({
  locale,
  returnTo,
}: {
  locale?: Locale;
  returnTo: string;
}) {
  if (!CLERK_ACTIVE)
    return <PublicSignedOutNav locale={locale} returnTo={returnTo} />;
  return <ClerkAccountNav locale={locale} returnTo={returnTo} />;
}

/** The summary page's card layout for SPA pages signed-out visitors open. */
export function PublicPage({
  children,
  returnTo,
}: {
  children: ReactNode;
  returnTo: string;
}) {
  return (
    <div className="t-body flex h-dvh flex-col bg-page p-2.5 text-fg">
      <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-card-xl bg-surface shadow-card">
        <header className="flex min-h-[98px] shrink-0 items-center justify-between gap-4 px-4 sm:px-7">
          <a className="font-extrabold text-base" href="/">
            Capy Notebook
          </a>
          <PublicAccountNav returnTo={returnTo} />
        </header>
        <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col px-4 pb-6 sm:px-0">
          {children}
        </main>
      </div>
    </div>
  );
}
