import { LocaleSwitcher } from '@/components/app/LocaleSwitcher';
import { PageHeader, Panel } from '@/components/app/layout';
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
      <p className="t-subtitle">{label}</p>
      {children}
    </div>
  );
}

export default function Settings() {
  const { style, setStyle } = useTheme();

  return (
    <Panel>
      <PageHeader showTopBar={false} title={m.profile_menu_settings()} />
      <div className="min-h-0 flex-1 overflow-auto px-6 py-5">
        <div className="mx-auto max-w-2xl">
          <p className="t-label mb-1 block text-fg-muted">
            {m.settings_appearance()}
          </p>
          <div className="rounded-card border border-line bg-surface px-5">
            <Row label={m.settings_theme()}>
              <div className="flex gap-1 rounded-full border border-line p-0.75">
                {STYLES.map((t) => (
                  <button
                    className={cn(
                      'rounded-full px-3 py-1.5 font-semibold text-sm',
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
            {/* TODO: change */}
            {/* <Row label={m.settings_mode()}>
              <SegmentedControl
                onChange={(v) => setTheme(v as "latte" | "mocha")}
                options={[
                  { label: m.mode_light(), value: "latte" },
                  { label: m.mode_dark(), value: "mocha" },
                ]}
                size="sm"
                value={theme}
              />
            </Row> */}
            <Row label={m.settings_language()}>
              <LocaleSwitcher />
            </Row>
          </div>

          <p className="t-label mt-6 mb-1 text-fg-muted">Workspaces</p>
          <div className="rounded-card border border-line bg-surface px-5">
            {/* TODO: change */}
            {/* <Row label="Default visibility">
              <SegmentedControl
                onChange={setPrivacy}
                options={[
                  { label: "Private", value: "private" },
                  { label: "Public", value: "public" },
                  { label: "Shared link", value: "link" },
                ]}
                size="sm"
                value={privacy}
              />
            </Row> */}
          </div>
        </div>
      </div>
    </Panel>
  );
}
