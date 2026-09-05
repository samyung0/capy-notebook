import type { ModelOption, ModelRef, ModelThinking } from '@/api/types';

export type ThinkingLevel = 'instant' | 'low' | 'mid' | 'high' | 'max';

export function optionRef(option: ModelOption): ModelRef {
  return { modelSlug: option.modelSlug, providerSlug: option.providerSlug };
}

export function sameModel(left: ModelRef, right: ModelRef): boolean {
  return (
    left.providerSlug === right.providerSlug &&
    left.modelSlug === right.modelSlug
  );
}

export function modelRefValue(ref: ModelRef): string {
  return JSON.stringify([ref.providerSlug, ref.modelSlug]);
}

export function parseModelRef(value: string): ModelRef {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !parsed[0] ||
    !parsed[1]
  ) {
    throw new Error('invalid model reference');
  }
  return { modelSlug: parsed[1], providerSlug: parsed[0] };
}

export function joinModelLabel(
  providerName: string,
  modelName: string
): string {
  const provider = providerName.trim();
  const model = modelName.trim();
  if (!provider) return model;
  if (!model) return provider;
  return `${provider} ${model}`;
}

export function sortModelOptions(models: ModelOption[]): ModelOption[] {
  return [...models].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.usesUserKey !== b.usesUserKey) return a.usesUserKey ? 1 : -1;
    return joinModelLabel(a.providerName, a.modelName).localeCompare(
      joinModelLabel(b.providerName, b.modelName)
    );
  });
}

export function thinkingField(
  slot: 'chat' | 'generate'
): 'chatThinking' | 'generateThinking' {
  return slot === 'chat' ? 'chatThinking' : 'generateThinking';
}

export function hasThinkingControls(
  spec: ModelThinking | undefined
): spec is ModelThinking {
  return Boolean(spec && spec.levels.length > 0);
}
