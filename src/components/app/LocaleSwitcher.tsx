import { Button } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Menu';
import { getLocale, LOCALE_LABELS, locales, setLocale } from '@/i18n';

export function LocaleSwitcher() {
  const current = (() => {
    try {
      return getLocale();
    } catch {
      return 'en';
    }
  })();
  const available: readonly string[] = (locales as
    | readonly string[]
    | undefined) ?? ['en', 'zh'];

  return (
    <Menu
      align="end"
      items={available.map((locale) => ({
        label: LOCALE_LABELS[locale] ?? locale,
        onClick: () => setLocale(locale as never),
      }))}
      trigger={
        <Button iconLeft="globe" size="sm" variant="outline">
          {LOCALE_LABELS[current] ?? current}
        </Button>
      }
    />
  );
}
