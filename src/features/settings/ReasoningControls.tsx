import { useSetModelPrefs } from '@/api/hooks';
import type { ModelOption, ModelSurface } from '@/api/types';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { m } from '@/i18n';
import { hasThinkingControls, thinkingField } from './llmOptions';

const THINKING_LABEL: Record<string, () => string> = {
  high: () => m.settings_llm_thinking_high(),
  instant: () => m.settings_llm_thinking_instant(),
  low: () => m.settings_llm_thinking_low(),
  max: () => m.settings_llm_thinking_max(),
  mid: () => m.settings_llm_thinking_mid(),
};

export function ReasoningControls({
  disabled,
  selected,
  stored,
  surface,
}: {
  disabled?: boolean;
  selected: ModelOption | undefined;
  stored: string;
  surface: Exclude<ModelSurface, 'editor' | 'quiz'>;
}) {
  const { isPending, mutate } = useSetModelPrefs();
  if (!hasThinkingControls(selected?.thinking)) return null;
  const spec = selected.thinking;
  const busy = disabled || isPending || !selected.available;

  return (
    <Select
      disabled={busy}
      onValueChange={(next) => {
        mutate({ [thinkingField(surface)]: next });
      }}
      value={stored}
    >
      <SelectTrigger
        aria-label={m.settings_llm_thinking()}
        className="w-34"
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
