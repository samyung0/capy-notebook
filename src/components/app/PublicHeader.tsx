import type { ReactNode } from 'react';
import type { MaterialAuthor } from '@/api/types';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { getLocale, m } from '@/i18n';

/**
 * Layout pieces for pages signed-out visitors can open: the workspace summary
 * (islands in server-rendered HTML) and shared standalone quizzes, flashcard
 * sets and notes. They need no router, so both can mount them.
 */

export type Locale = 'en' | 'zh' | undefined;

/** Shows the moon in light themes and the sun in dark ones by CSS alone, so
 * the server renders it for every visitor; publicChrome.ts switches the theme
 * on click. */
function PublicThemeButton({ locale }: { locale?: Locale }) {
  return (
    <IconButton
      data-public-theme-toggle=""
      icon="moon"
      // Important: Icon sets an inline display.
      iconClassName="dark:hidden!"
      type="button"
      variant="ghost-hover"
    >
      <Icon className="hidden! dark:block!" name="sun" />
      <span className="sr-only dark:hidden">
        {m.public_theme_dark({}, { locale })}
      </span>
      <span className="sr-only hidden dark:inline">
        {m.public_theme_light({}, { locale })}
      </span>
    </IconButton>
  );
}

/** Every visitor gets the same header: it never reads auth, so it cannot shift
 * or flash, and the edge cache stays shared. Signed-in visitors who press Sign
 * in land on the dashboard. */
export function PublicNav({ locale }: { locale?: Locale }) {
  return (
    <nav
      aria-label={m.summary_profile({}, { locale })}
      className="flex items-center gap-2"
    >
      <PublicThemeButton locale={locale} />
      <Button asChild size="lg" variant="ghost-hover">
        <a href="/sign-in">{m.action_sign_in({}, { locale })}</a>
      </Button>
      <Button asChild size="lg">
        <a href="/sign-up">{m.summary_sign_up({}, { locale })}</a>
      </Button>
    </nav>
  );
}

/** The owner, avatar first (1px high to meet the text), then when the item
 * last changed. */
export function PublicByline({
  author,
  updatedAt,
}: {
  author: MaterialAuthor;
  updatedAt: string;
}) {
  return (
    <p className="t-meta flex items-center gap-2 text-fg-muted">
      {author.avatarUrl && (
        <img
          alt=""
          className="size-6 shrink-0 -translate-y-px rounded-full object-cover"
          height={24}
          src={author.avatarUrl}
          width={24}
        />
      )}
      <span>
        {author.name} ·{' '}
        {m.note_updated({
          // UTC, so the server's render and the browser's agree on the day.
          date: new Intl.DateTimeFormat(getLocale(), {
            dateStyle: 'medium',
            timeZone: 'UTC',
          }).format(new Date(updatedAt)),
        })}
      </span>
    </p>
  );
}

/** The summary page's card layout for SPA pages signed-out visitors open. */
export function PublicPage({ children }: { children: ReactNode }) {
  return (
    <div className="t-body flex h-dvh flex-col bg-page p-2.5 text-fg">
      <div className="flex min-h-0 flex-1 flex-col overflow-auto rounded-card-xl bg-surface shadow-card">
        <header className="flex min-h-[98px] shrink-0 items-center justify-between gap-4 px-4 sm:px-7">
          <a className="font-extrabold text-base" href="/">
            Capy Notebook
          </a>
          <PublicNav />
        </header>
        <main className="mx-auto flex w-full max-w-[760px] flex-1 flex-col px-4 pb-6 sm:px-0">
          {children}
        </main>
      </div>
    </div>
  );
}
