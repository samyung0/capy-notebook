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

/**
 * Saves the account language (emails use it), then applies it. Applying
 * reloads the page, which would cancel a save still in flight; a failed save
 * changes nothing and shows the default mutation toast.
 */
export async function changeLocale(
  locale: 'en' | 'zh',
  save: (locale: 'en' | 'zh') => Promise<unknown>,
  apply: (locale: 'en' | 'zh') => void
) {
  await save(locale);
  apply(locale);
}

/** Account language: saved for emails, then applied to the app. */
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
          void changeLocale(locale, setLocale, setParaglideLocale).catch(
            () => undefined
          );
        }}
        value={current}
      >
        <SelectTrigger aria-label={m.settings_language()} layout="row">
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
