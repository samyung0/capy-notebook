import { useChatModelSaving } from '@/api/hooks';
import type { ModelOption } from '@/api/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';
import { hasThinkingControls } from './llmOptions';

const THINKING_LABEL: Record<string, () => string> = {
  high: () => m.settings_llm_thinking_high(),
  instant: () => m.settings_llm_thinking_instant(),
  low: () => m.settings_llm_thinking_low(),
  max: () => m.settings_llm_thinking_max(),
  mid: () => m.settings_llm_thinking_mid(),
};

export function ReasoningControls({
  onChange,
  selected,
  stored,
}: {
  onChange: (thinking: string) => void;
  selected: ModelOption | undefined;
  stored: string;
}) {
  // Locked only while a model change saves: the new model's stored level
  // arrives with the refetch.
  const modelSaving = useChatModelSaving();
  if (!hasThinkingControls(selected?.thinking)) return null;
  const spec = selected.thinking;
  const busy = modelSaving || !selected.available;

  return (
    <Select disabled={busy} onValueChange={onChange} value={stored}>
      <SelectTrigger
        aria-label={m.settings_llm_thinking()}
        className="w-auto shrink-0 sm:w-34"
        size="md"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {spec.levels.map((item) => (
          <SelectItem key={item} value={item}>
            {THINKING_LABEL[item]?.() ?? item}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
