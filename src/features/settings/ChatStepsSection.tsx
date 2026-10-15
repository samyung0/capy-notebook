import { useMe, useSetChatSteps } from '@/api/hooks';
import type { ChatSteps } from '@/api/types';
import { SettingRow, TabHeader } from '@/components/app/tabPanel';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';

const CHOICES: { label: () => string; value: ChatSteps }[] = [
  { label: m.settings_chat_steps_normal, value: 'normal' },
  { label: m.settings_chat_steps_verbose, value: 'verbose' },
];

/** Settings → Customizations → Chat: how many steps the chat shows while it
 * works. Saved with the account; unset means Normal. */
export function ChatStepsSection() {
  const { data: me } = useMe();
  const { mutate: setChatSteps } = useSetChatSteps();
  return (
    <>
      <div className="border-divider border-t" />
      <TabHeader
        description={m.settings_chat_hint()}
        title={m.settings_chat_title()}
      />
      <SettingRow
        hint={m.settings_chat_steps_hint()}
        title={m.settings_chat_steps()}
      >
        <Select
          disabled={!me}
          onValueChange={(value) => setChatSteps(value as ChatSteps)}
          value={me?.chatSteps ?? 'normal'}
        >
          <SelectTrigger aria-label={m.settings_chat_steps()} className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CHOICES.map((choice) => (
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
