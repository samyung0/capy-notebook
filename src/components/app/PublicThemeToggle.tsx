import { IconButton } from '@/components/ui/IconButton';
import { m } from '@/i18n';
import { useTheme } from '@/theme/theme';

export function PublicThemeToggle({ locale }: { locale?: 'en' | 'zh' }) {
  const { isDark, setTheme } = useTheme();
  return (
    <IconButton
      icon={isDark ? 'sun' : 'moon'}
      label={
        isDark
          ? m.public_theme_light({}, { locale })
          : m.public_theme_dark({}, { locale })
      }
      onClick={() => setTheme(isDark ? 'latte' : 'mocha')}
      type="button"
      variant="ghost-hover"
    />
  );
}
