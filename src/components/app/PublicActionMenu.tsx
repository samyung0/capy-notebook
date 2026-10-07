import type { Locale } from '@/components/app/PublicHeader';
import { Menu } from '@/components/ui/Menu';
import { type CloneKind, cloneHref, cloneLabel } from '@/lib/cloneLink';

/** The ⋮ beside a public page's title, the same for every visitor. Clone opens
 * the dashboard, which asks first and signs visitors in when needed. */
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
    <Menu
      items={[
        {
          icon: 'clone',
          label: cloneLabel(kind, locale),
          onClick: () => window.location.assign(cloneHref(kind, id)),
        },
      ]}
    />
  );
}
