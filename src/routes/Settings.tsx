import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useMe,
  useNotificationPrefs,
  useSetNotificationPrefs,
} from '@/api/hooks';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { StyleIcon } from '@/components/app/ThemeDrawer';
import { SettingRow, TabContent, TabHeader } from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { Switch } from '@/components/ui/Switch';
import { Tabs } from '@/components/ui/Tabs';
import { AccountTab } from '@/features/settings/AccountTab';
import { DeleteAccountDialog } from '@/features/settings/DeleteAccountDialog';
import { KeysSection } from '@/features/settings/KeysSection';
import { LanguageRow } from '@/features/settings/LanguageRow';
import { ModelPicker } from '@/features/settings/ModelPicker';
import { StudyPreferencesSection } from '@/features/settings/StudyPreferencesSection';
import { m } from '@/i18n';
import { features } from '@/lib/features';
import type { SettingsTab } from '@/lib/tabSearch';
import { STYLES, THEMES, useTheme } from '@/theme/theme';

function CustomizationsTab() {
  const { style, theme, setStyle, setTheme } = useTheme();
  return (
    <>
      <TabHeader
        description={m.settings_customizations_hint()}
        title={m.settings_tab_customizations()}
      />
      <div className="flex flex-col gap-6">
        <LanguageRow />
        <SettingRow hint={m.settings_theme_hint()} title={m.settings_theme()}>
          <Select
            onValueChange={(v) => setStyle(v as typeof style)}
            value={style}
          >
            <SelectTrigger aria-label={m.settings_theme()} className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STYLES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  <span className="flex items-center gap-2">
                    <StyleIcon
                      className="gap-px rounded-sm p-0.5"
                      dotClassName="size-1.5"
                      style={t.value}
                    />
                    {t.value === 'classroom'
                      ? m.theme_style_classroom()
                      : m.theme_style_notion()}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow hint={m.settings_mode_hint()} title={m.settings_mode()}>
          <Select
            onValueChange={(v) => setTheme(v as typeof theme)}
            value={theme}
          >
            <SelectTrigger aria-label={m.settings_mode()} className="w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEMES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  <span className="flex items-center gap-2">
                    <span
                      className="size-4 shrink-0 rounded-full border border-line-strong"
                      style={{ background: t.displayColor }}
                    />
                    {t.value === 'latte'
                      ? m.mode_light()
                      : t.value === 'mocha'
                        ? m.mode_dark()
                        : t.label}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <div className="border-divider border-t" />
        <StudyPreferencesSection />
      </div>
    </>
  );
}

const NOTIFICATION_ROWS: {
  field: 'emailWorkspaceInvite' | 'emailBilling';
  title: () => string;
  hint: () => string;
}[] = [
  {
    field: 'emailWorkspaceInvite',
    hint: m.settings_email_workspace_invite_hint,
    title: m.settings_email_workspace_invite,
  },
  {
    field: 'emailBilling',
    hint: m.settings_email_billing_hint,
    title: m.settings_email_billing,
  },
];

function NotificationsTab() {
  const { data: me } = useMe();
  const { data: prefs, isSuccess } = useNotificationPrefs();
  const { isPending, mutate: setPrefs } = useSetNotificationPrefs();
  return (
    <>
      <TabHeader
        description={m.settings_notifications_hint({ email: me?.email ?? '' })}
        title={m.settings_tab_notifications()}
      />
      <div className="flex flex-col gap-6">
        {NOTIFICATION_ROWS.map((row) => (
          <SettingRow hint={row.hint()} key={row.field} title={row.title()}>
            <Switch
              aria-label={row.title()}
              checked={prefs?.[row.field] ?? false}
              disabled={!isSuccess || isPending}
              onCheckedChange={(checked) => {
                if (!prefs || isPending) return;
                setPrefs({ ...prefs, [row.field]: checked });
              }}
            />
          </SettingRow>
        ))}
      </div>
    </>
  );
}

function LlmTab() {
  return (
    <>
      <TabHeader
        description={m.settings_llm_hint()}
        title={m.settings_tab_llm()}
      />
      <div className="flex flex-col gap-6">
        <SettingRow
          hint={m.settings_llm_chat_hint()}
          title={m.settings_llm_chat()}
        >
          <ModelPicker slot="chat" />
        </SettingRow>
        {features.editorAi && (
          <SettingRow
            hint={m.settings_llm_editor_hint()}
            title={m.settings_llm_editor()}
          >
            <ModelPicker slot="editor" />
          </SettingRow>
        )}
        <div className="border-divider border-t" />
        <KeysSection />
      </div>
    </>
  );
}

function DangerTab() {
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <TabHeader
        description={m.settings_danger_hint()}
        title={m.workspace_tab_danger()}
      />
      <SettingRow
        hint={m.settings_delete_account_hint()}
        title={m.settings_danger_zone_title()}
      >
        <Button
          className="shrink-0 rounded-input"
          iconLeft="trash"
          onClick={() => setDeleting(true)}
          variant="danger"
        >
          {m.action_delete()}
        </Button>
      </SettingRow>
      {/* Mounted only while open: the preflight asks Stripe live. */}
      {deleting && (
        <DeleteAccountDialog onClose={() => setDeleting(false)} open />
      )}
    </>
  );
}

export default function Settings() {
  const navigate = useNavigate();
  const { tab = 'account' } = useSearch({ from: '/auth-shell/settings' });

  return (
    <PanelWithInvertedRadius>
      <PageHeader title={m.profile_menu_settings()} />
      <Tabs
        className="px-6"
        onChange={(value) => {
          void navigate({
            replace: true,
            search: { tab: value as SettingsTab },
            to: '/settings',
          });
        }}
        tabs={[
          { label: m.settings_tab_account(), value: 'account' },
          {
            label: m.settings_tab_customizations(),
            value: 'customizations',
          },
          { label: m.settings_tab_notifications(), value: 'notifications' },
          { label: m.settings_tab_llm(), value: 'llm' },
          {
            label: m.workspace_tab_danger(),
            tone: 'danger',
            value: 'danger',
          },
        ]}
        value={tab}
      />
      <TabContent>
        {tab === 'customizations' ? (
          <CustomizationsTab />
        ) : tab === 'notifications' ? (
          <NotificationsTab />
        ) : tab === 'llm' ? (
          <LlmTab />
        ) : tab === 'danger' ? (
          <DangerTab />
        ) : (
          <AccountTab />
        )}
      </TabContent>
    </PanelWithInvertedRadius>
  );
}
