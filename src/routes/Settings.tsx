import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import {
  useMe,
  useNotificationPrefs,
  useSetModelPrefs,
  useSetNotificationPrefs,
} from '@/api/hooks';
import { PageHeader, PagePanel } from '@/components/app/layout';
import { SettingsNav, type SettingsNavTab } from '@/components/app/SettingsNav';
import { STYLE_LABELS, StyleIcon } from '@/components/app/ThemeDrawer';
import {
  DangerZone,
  SettingRow,
  TabContent,
  TabHeader,
} from '@/components/app/tabPanel';
import { Button } from '@/components/ui/Button';
import { useIsPhone } from '@/components/ui/Dialog';
import { IconButton } from '@/components/ui/IconButton';
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
import { EditorSection } from '@/features/settings/EditorSection';
import { LanguageRow } from '@/features/settings/LanguageRow';
import { ModelPicker } from '@/features/settings/ModelPicker';
import { StudyPreferencesSection } from '@/features/settings/StudyPreferencesSection';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
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
        <EditorSection />
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

/** The tabs with what each holds, for the phone list's search. */
function settingsTabs(): SettingsNavTab<SettingsTab>[] {
  return [
    {
      icon: 'profile',
      label: m.settings_tab_account(),
      terms: [m.settings_avatar(), m.onboarding_name(), m.settings_email()],
      value: 'account',
    },
    {
      icon: 'palette',
      label: m.settings_tab_customizations(),
      terms: [
        m.settings_language(),
        m.settings_theme(),
        m.settings_mode(),
        m.settings_chat_title(),
        m.settings_chat_steps(),
        m.settings_chat_send_key(),
        m.settings_editor_title(),
        m.settings_show_others(),
      ],
      value: 'customizations',
    },
    {
      icon: 'book',
      label: m.settings_tab_study(),
      terms: [
        m.study_pref_review_title(),
        m.study_prefs_title(),
        m.study_pref_checks(),
      ],
      value: 'study',
    },
    {
      icon: 'bell',
      label: m.settings_tab_notifications(),
      terms: NOTIFICATION_ROWS.map((row) => row.title()),
      value: 'notifications',
    },
    {
      icon: 'ai',
      label: m.settings_tab_llm(),
      terms: [m.settings_llm_chat(), m.settings_llm_note_ai()],
      value: 'llm',
    },
    {
      icon: 'alert',
      label: m.workspace_tab_danger(),
      terms: [m.settings_danger_zone_title()],
      tone: 'danger',
      value: 'danger',
    },
  ];
}

/** Top tabs from sm. Phones open on the tab list with its search, and each tab
 * is a page with an arrow back; the browser's Back also returns to the list. */
export default function Settings() {
  const navigate = useNavigate();
  const { q, tab: picked } = useSearch({ from: '/auth-shell/settings' });
  const phone = useIsPhone();
  const tab = picked ?? 'account';
  const tabs = settingsTabs();
  const openTab = (value: SettingsTab | undefined) =>
    navigate({
      replace: !(phone && value),
      search: { q, tab: value },
      to: '/settings',
    });

  if (phone && !picked)
    return (
      <PagePanel header={<PageHeader title={m.profile_menu_settings()} />}>
        <TabContent narrow>
          <SettingsNav
            label={m.profile_menu_settings()}
            onChange={(value) => void openTab(value)}
            onQueryChange={(query) =>
              void navigate({
                replace: true,
                search: { q: query || undefined },
                to: '/settings',
              })
            }
            query={q}
            tabs={tabs}
            value=""
          />
        </TabContent>
      </PagePanel>
    );

  return (
    <PagePanel
      header={
        <PageHeader
          className={cn(phone && '-mt-1.5 pt-0')}
          title={
            phone ? (
              <div className="flex items-center gap-1">
                <IconButton
                  className="-ml-2.5"
                  icon="navigationBack"
                  onClick={() => void openTab(undefined)}
                  size="sm"
                  variant="ghost-hover"
                >
                  <span className="sr-only">{m.action_back()}</span>
                </IconButton>
                <h1 className="t-large-card-title text-lg leading-tight">
                  {tabs.find((item) => item.value === tab)?.label}
                </h1>
              </div>
            ) : (
              m.profile_menu_settings()
            )
          }
        />
      }
    >
      {!phone && (
        <Tabs
          className="page-tabs-px"
          onChange={(value) => void openTab(value as SettingsTab)}
          tabs={tabs}
          value={tab}
        />
      )}
      <TabContent narrow>
        {/* A phone's header already names the tab, as a dialog's title does. */}
        <div className="max-sm:-mt-4 max-sm:[&_[data-slot=tab-header]]:hidden">
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
        </div>
      </TabContent>
    </PagePanel>
  );
}
