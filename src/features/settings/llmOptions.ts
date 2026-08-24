import type { ModelOption, ModelReasoning } from '@/api/types';

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export function sortModelOptions(models: ModelOption[]): ModelOption[] {
  return [...models].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.usesUserKey !== b.usesUserKey) return a.usesUserKey ? 1 : -1;
    return a.displayName.localeCompare(b.displayName);
  });
}

export function effectiveReasoning(
  selected: ModelOption | undefined,
  mode: string,
  effort: string
): { effort: string; mode: string } {
  const spec = selected?.reasoning;
  if (!spec) return { effort: '', mode: '' };
  let nextMode = mode || spec.defaultMode;
  if (nextMode !== 'on' && nextMode !== 'off') nextMode = spec.defaultMode;
  if (!spec.canDisable) nextMode = 'on';
  if (nextMode === 'off') return { effort: '', mode: 'off' };
  let nextEffort = effort;
  if (!spec.efforts.includes(nextEffort)) {
    nextEffort = spec.efforts.includes(spec.defaultEffort)
      ? spec.defaultEffort
      : '';
  }
  return { effort: nextEffort, mode: 'on' };
}

export function reasoningField(
  surface: 'chat' | 'generate',
  kind: 'mode' | 'effort'
):
  | 'chatReasoningMode'
  | 'chatReasoningEffort'
  | 'generateReasoningMode'
  | 'generateReasoningEffort' {
  if (surface === 'chat') {
    return kind === 'mode' ? 'chatReasoningMode' : 'chatReasoningEffort';
  }
  return kind === 'mode' ? 'generateReasoningMode' : 'generateReasoningEffort';
}

export function hasReasoningControls(
  spec: ModelReasoning | undefined
): spec is ModelReasoning {
  return Boolean(spec && (spec.efforts.length > 0 || spec.canDisable));
}
