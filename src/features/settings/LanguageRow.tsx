import { useSetLocale } from '@/api/hooks';
import { SettingRow } from '@/components/app/tabPanel';
import { Icon } from '@/components/ui/Icon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import {
  getLocale,
  LOCALE_LABELS,
  locales,
  m,
  setLocale as setParaglideLocale,
} from '@/i18n';

/** Account language: applies as soon as it changes and is saved for emails. */
export function LanguageRow() {
  const { isPending, mutateAsync: setLocale } = useSetLocale();
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
    <SettingRow hint={m.settings_language_hint()} title={m.settings_language()}>
      <Select
        disabled={isPending}
        onValueChange={(locale) => {
          if (locale !== 'en' && locale !== 'zh') return;
          const previous = current;
          setParaglideLocale(locale);
          void setLocale(locale).catch(() => {
            if (getLocale() === locale) setParaglideLocale(previous as never);
          });
        }}
        value={current}
      >
        <SelectTrigger aria-label={m.settings_language()} className="w-56">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {available.map((locale) => (
            <SelectItem key={locale} value={locale}>
              <span className="flex items-center gap-2">
                <Icon className="size-4.5 -translate-y-px" name="globe" />
                {LOCALE_LABELS[locale] ?? locale}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}
