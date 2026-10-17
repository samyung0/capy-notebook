import { useMe, useSetChatPrefs } from '@/api/hooks';
import type { ChatSendKey, ChatSteps } from '@/api/types';
import { SectionTitle, SettingRow } from '@/components/app/tabPanel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';

const STEPS: { label: () => string; value: ChatSteps }[] = [
  { label: m.settings_chat_steps_normal, value: 'normal' },
  { label: m.settings_chat_steps_verbose, value: 'verbose' },
];

const SEND_KEYS: { label: () => string; value: ChatSendKey }[] = [
  { label: m.settings_chat_send_key_enter, value: 'enter' },
  { label: m.settings_chat_send_key_shift_enter, value: 'shift_enter' },
];

/** Settings → Customizations → Chat: how many steps the chat shows while it
 * works (unset means Normal) and which key sends a message (unset means
 * Enter). Both are saved with the account. */
export function ChatSection() {
  const { data: me } = useMe();
  const { mutate: setChatPrefs } = useSetChatPrefs();
  return (
    <>
      <div className="border-divider border-t" />
      <SectionTitle title={m.settings_chat_title()} />
      <SettingRow
        hint={m.settings_chat_steps_hint()}
        title={m.settings_chat_steps()}
      >
        <Select
          disabled={!me}
          onValueChange={(value) => setChatPrefs({ steps: value as ChatSteps })}
          value={me?.chatSteps ?? 'normal'}
        >
          <SelectTrigger aria-label={m.settings_chat_steps()} layout="row">
            <SelectValue />
          </SelectTrigger>
          <SelectContent layout="row">
            {STEPS.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow
        hint={m.settings_chat_send_key_hint()}
        title={m.settings_chat_send_key()}
      >
        <Select
          disabled={!me}
          onValueChange={(value) =>
            setChatPrefs({ sendKey: value as ChatSendKey })
          }
          value={me?.chatSendKey ?? 'enter'}
        >
          <SelectTrigger aria-label={m.settings_chat_send_key()} layout="row">
            <SelectValue />
          </SelectTrigger>
          <SelectContent layout="row">
            {SEND_KEYS.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label()}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
    </>
  );
}
