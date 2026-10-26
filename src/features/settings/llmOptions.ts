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

export function hasThinkingControls(
  spec: ModelThinking | undefined
): spec is ModelThinking {
  return Boolean(spec && spec.levels.length > 0);
}
