import { useState } from 'react';
import { LocaleSwitcher } from '@/components/app/LocaleSwitcher';
import { PageHeader, Panel } from '@/components/app/layout';
import { SegmentedControl, Text } from '@/components/ui';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { STYLES, useTheme } from '@/theme/ThemeProvider';

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between border-divider border-b py-4 last:border-0">
      <Text variant="subtitle">{label}</Text>
      {children}
    </div>
  );
}

export default function Settings() {
  const { theme, style, setTheme, setStyle } = useTheme();
  const [privacy, setPrivacy] = useState('private');

  return (
    <Panel>
      <PageHeader showTopBar={false} title={m.profile_menu_settings()} />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-2xl">
          <Text className="mb-1 block" tone="muted" variant="label">
            {m.settings_appearance()}
          </Text>
          <div className="rounded-card border border-line bg-surface px-5">
            <Row label={m.settings_theme()}>
              <div className="flex gap-1 rounded-pill border border-line p-[3px]">
                {STYLES.map((t) => (
                  <button
                    className={cn(
                      'rounded-pill px-3 py-1.5 font-semibold text-sm',
                      style === t.value
                        ? 'bg-action text-action-fg'
                        : 'text-fg-muted'
                    )}
                    key={t.value}
                    onClick={() => setStyle(t.value)}
                    type="button"
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </Row>
            <Row label={m.settings_mode()}>
              <SegmentedControl
                onChange={(v) => setTheme(v as 'light' | 'dark')}
                options={[
                  { label: m.mode_light(), value: 'light' },
                  { label: m.mode_dark(), value: 'dark' },
                ]}
                size="sm"
                value={theme}
              />
            </Row>
            <Row label={m.settings_language()}>
              <LocaleSwitcher />
            </Row>
          </div>

          <Text className="mt-6 mb-1 block" tone="muted" variant="label">
            Workspaces
          </Text>
          <div className="rounded-card border border-line bg-surface px-5">
            <Row label="Default visibility">
              <SegmentedControl
                onChange={setPrivacy}
                options={[
                  { label: 'Private', value: 'private' },
                  { label: 'Public', value: 'public' },
                  { label: 'Shared link', value: 'link' },
                ]}
                size="sm"
                value={privacy}
              />
            </Row>
          </div>
        </div>
      </div>
    </Panel>
  );
}
