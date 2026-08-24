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
import {
  effectiveReasoning,
  hasReasoningControls,
  reasoningField,
} from './llmOptions';

const EFFORT_LABEL: Record<string, () => string> = {
  high: () => m.settings_llm_effort_high(),
  low: () => m.settings_llm_effort_low(),
  max: () => m.settings_llm_effort_max(),
  medium: () => m.settings_llm_effort_medium(),
  xhigh: () => m.settings_llm_effort_xhigh(),
};

export function ReasoningControls({
  disabled,
  effort,
  mode,
  selected,
  surface,
}: {
  disabled?: boolean;
  effort: string;
  mode: string;
  selected: ModelOption | undefined;
  surface: Exclude<ModelSurface, 'editor' | 'quiz'>;
}) {
  const { isPending, mutate } = useSetModelPrefs();
  if (!hasReasoningControls(selected?.reasoning)) return null;
  const spec = selected.reasoning;
  const resolved = effectiveReasoning(selected, mode, effort);
  const busy = disabled || isPending || !selected.available;

  return (
    <div className="flex min-w-0 flex-wrap items-start gap-2">
      {spec.canDisable ? (
        <Select
          disabled={busy}
          onValueChange={(value) => {
            mutate({ [reasoningField(surface, 'mode')]: value });
          }}
          value={resolved.mode}
        >
          <SelectTrigger
            aria-label={m.settings_llm_thinking()}
            className="w-30"
            size="md"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="off">{m.settings_llm_thinking_off()}</SelectItem>
            <SelectItem value="on">{m.settings_llm_thinking_on()}</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
      {resolved.mode === 'on' && spec.efforts.length > 0 ? (
        <Select
          disabled={busy}
          onValueChange={(value) => {
            mutate({ [reasoningField(surface, 'effort')]: value });
          }}
          value={resolved.effort || spec.defaultEffort}
        >
          <SelectTrigger aria-label={m.settings_llm_effort()} className="w-34">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {spec.efforts.map((item) => (
              <SelectItem key={item} value={item}>
                {EFFORT_LABEL[item]?.() ?? item}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
