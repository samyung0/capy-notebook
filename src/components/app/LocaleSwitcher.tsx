import { Button } from '@/components/ui/Button';
import { Menu } from '@/components/ui/Menu';
import {
  getLocale,
  LOCALE_LABELS,
  locales,
  setLocale as setParaglideLocale,
} from '@/i18n';

export function LocaleSwitcher({
  disabled = false,
  onChange,
}: {
  disabled?: boolean;
  onChange?: (locale: string, previousLocale: string) => void;
}) {
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
        onClick: () => {
          const previous = current;
          setParaglideLocale(locale as never);
          onChange?.(locale, previous);
        },
      }))}
      trigger={
        <Button
          disabled={disabled}
          iconLeft="globe"
          size="sm"
          variant="outline"
        >
          {LOCALE_LABELS[current] ?? current}
        </Button>
      }
    />
  );
}
