import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useMe,
  useNotificationPrefs,
  useSetModelPrefs,
  useSetNotificationPrefs,
} from '@/api/hooks';
import { PageHeader, PagePanel } from '@/components/app/layout';
import { STYLE_LABELS, StyleIcon } from '@/components/app/ThemeDrawer';
import {
  DangerZone,
  SettingRow,
  TabContent,
  TabHeader,
} from '@/components/app/tabPanel';
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
import { ChatSection } from '@/features/settings/ChatSection';
import { DeleteAccountDialog } from '@/features/settings/DeleteAccountDialog';
import { LanguageRow } from '@/features/settings/LanguageRow';
import { ModelPicker } from '@/features/settings/ModelPicker';
import { StudyPreferencesSection } from '@/features/settings/StudyPreferencesSection';
import { m } from '@/i18n';
import type { SettingsTab } from '@/lib/tabSearch';
import { STYLES, THEMES, themeSwatch, useTheme } from '@/theme/theme';

function CustomizationsTab() {
  const { style, theme, setStyle, setTheme } = useTheme();
  return (
    <>
      <TabHeader title={m.settings_tab_customizations()} />
      <div className="flex flex-col gap-6">
        <LanguageRow />
        <SettingRow hint={m.settings_theme_hint()} title={m.settings_theme()}>
          <Select
            onValueChange={(v) => setStyle(v as typeof style)}
            value={style}
          >
            <SelectTrigger aria-label={m.settings_theme()} layout="row">
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
                    {STYLE_LABELS[t.value]()}
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
            <SelectTrigger aria-label={m.settings_mode()} layout="row">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {THEMES.map((t) => (
                <SelectItem key={t.value} value={t.value}>
                  <span className="flex items-center gap-2">
                    <span
                      className="size-4 shrink-0 rounded-full border border-line-strong"
                      style={{ background: themeSwatch(style, t.value) }}
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
        <ChatSection />
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
  const { data: prefs, isSuccess } = useNotificationPrefs();
  const { mutate: setPrefs } = useSetNotificationPrefs();
  return (
    <>
      <TabHeader title={m.settings_tab_notifications()} />
      <div className="flex flex-col gap-6">
        {NOTIFICATION_ROWS.map((row) => (
          <SettingRow hint={row.hint()} key={row.field} title={row.title()}>
            <Switch
              aria-label={row.title()}
              checked={prefs?.[row.field] ?? false}
              disabled={!isSuccess}
              onCheckedChange={(checked) => {
                if (!prefs) return;
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
  const { data: me } = useMe();
  const { mutate: setPrefs } = useSetModelPrefs();
  return (
    <>
      <TabHeader title={m.settings_tab_llm()} />
      <div className="flex flex-col gap-6">
        <SettingRow
          hint={m.settings_llm_chat_hint()}
          title={m.settings_llm_chat()}
        >
          <ModelPicker slot="chat" />
        </SettingRow>
        <SettingRow
          hint={m.settings_llm_note_ai_hint()}
          title={m.settings_llm_note_ai()}
        >
          <Switch
            aria-label={m.settings_llm_note_ai()}
            checked={me?.noteAiEnabled ?? false}
            disabled={!me}
            onCheckedChange={(noteAiEnabled) => setPrefs({ noteAiEnabled })}
          />
        </SettingRow>
      </div>
    </>
  );
}

function DangerTab() {
  const [deleting, setDeleting] = useState(false);
  return (
    <>
      <TabHeader title={m.workspace_tab_danger()} />
      <DangerZone>
        <SettingRow
          hint={m.settings_delete_account_hint()}
          title={m.settings_danger_zone_title()}
        >
          <Button
            className="shrink-0"
            iconLeft="trash"
            onClick={() => setDeleting(true)}
            rounded="large"
            variant="danger"
          >
            {m.action_delete()}
          </Button>
        </SettingRow>
      </DangerZone>
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
    <PagePanel header={<PageHeader title={m.profile_menu_settings()} />}>
      <Tabs
        className="page-tabs-px"
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
          { label: m.settings_tab_study(), value: 'study' },
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
      <TabContent narrow>
        {tab === 'customizations' ? (
          <CustomizationsTab />
        ) : tab === 'study' ? (
          <StudyPreferencesSection />
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
    </PagePanel>
  );
}
