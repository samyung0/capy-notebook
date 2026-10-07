import type { Locale } from '@/components/app/PublicHeader';
import { BASE_BUTTON_STYLE } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { IconButton } from '@/components/ui/IconButton';
import { m } from '@/i18n';
import { type CloneKind, cloneHref, cloneLabel } from '@/lib/cloneLink';
import { cn } from '@/lib/cn';

/** The ⋮ beside a public page's title, the same for every visitor. Clone opens
 * the dashboard, which asks first and signs visitors in when needed. A native
 * popover anchored to the button, so server-rendered pages need no script to
 * open it (publicChrome.ts places it where anchoring is unsupported). */
export function PublicActionMenu({
  id,
  kind,
  locale,
}: {
  id: string;
  kind: CloneKind;
  locale?: Locale;
}) {
  return (
    <>
      <IconButton
        className="p-2 [anchor-name:--public-actions]"
        icon="moreVertical"
        label={m.a11y_open_menu({}, { locale })}
        popoverTarget="public-actions"
        size="md"
        type="button"
        variant="ghost-hover"
      />
      <div
        className="inset-auto top-[anchor(bottom)] right-[anchor(right)] m-0 mt-1 min-w-40 overflow-hidden rounded-card border border-overlay-line bg-overlay p-1 py-1.5 text-fg shadow-pop [position-anchor:--public-actions]"
        data-public-menu=""
        id="public-actions"
        popover="auto"
        role="menu"
      >
        <a
          className={cn(
            BASE_BUTTON_STYLE,
            'flex w-full justify-start gap-2 px-2.5 py-2 font-medium text-fg leading-(--body-line-height) hover:bg-overlay-hover focus-visible:bg-overlay-hover'
          )}
          href={cloneHref(kind, id)}
          role="menuitem"
        >
          <Icon className="-translate-y-px" name="clone" />
          {cloneLabel(kind, locale)}
        </a>
      </div>
    </>
  );
}
