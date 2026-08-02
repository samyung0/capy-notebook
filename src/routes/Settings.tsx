import {
  useNotificationPrefs,
  useSetLocale,
  useSetNotificationPrefs,
} from '@/api/hooks';
import { LocaleSwitcher } from '@/components/app/LocaleSwitcher';
import { PageHeader, Panel } from '@/components/app/layout';
import { Switch } from '@/components/ui/Switch';
import { getLocale, m, setLocale as setParaglideLocale } from '@/i18n';
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
  const prefs = useNotificationPrefs();
  const setPrefs = useSetNotificationPrefs();
  const setLocale = useSetLocale();
  const currentPrefs = prefs.data;

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
              <LocaleSwitcher
                disabled={setLocale.isPending}
                onChange={(locale, previousLocale) => {
                  if (locale !== 'en' && locale !== 'zh') return;
                  void setLocale.mutateAsync(locale).catch(() => {
                    if (getLocale() === locale) {
                      setParaglideLocale(previousLocale as never);
                    }
                  });
                }}
              />
            </Row>
          </div>

          <p className="t-label mt-6 mb-1 text-fg-muted">
            {m.settings_notifications()}
          </p>
          <div className="rounded-card border border-line bg-surface px-5">
            <Row label={m.settings_email_workspace_invite()}>
              <Switch
                aria-label={m.settings_email_workspace_invite()}
                checked={currentPrefs?.emailWorkspaceInvite ?? false}
                disabled={!prefs.isSuccess || setPrefs.isPending}
                onChange={(emailWorkspaceInvite) => {
                  if (!currentPrefs || setPrefs.isPending) return;
                  setPrefs.mutate({ ...currentPrefs, emailWorkspaceInvite });
                }}
              />
            </Row>
            <Row label={m.settings_email_membership()}>
              <Switch
                aria-label={m.settings_email_membership()}
                checked={currentPrefs?.emailMembership ?? false}
                disabled={!prefs.isSuccess || setPrefs.isPending}
                onChange={(emailMembership) => {
                  if (!currentPrefs || setPrefs.isPending) return;
                  setPrefs.mutate({ ...currentPrefs, emailMembership });
                }}
              />
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
