import { describe, expect, it } from 'vitest';
import type { ModelOption } from '@/api/types';
import { effectiveReasoning, sortModelOptions } from './llmOptions';

function option(partial: Partial<ModelOption>): ModelOption {
  return {
    available: true,
    displayName: 'Model',
    isDefault: false,
    key: 'model',
    providerSlug: 'openai',
    usesUserKey: false,
    ...partial,
  };
}

describe('llm options', () => {
  it('puts locked models last and platform rows before user-key rows', () => {
    const sorted = sortModelOptions([
      option({
        available: false,
        displayName: 'GPT',
        key: 'gpt',
        usesUserKey: false,
      }),
      option({
        available: true,
        displayName: 'Claude',
        key: 'claude',
        usesUserKey: true,
      }),
      option({
        available: true,
        displayName: 'Flash',
        key: 'flash',
        usesUserKey: false,
      }),
    ]);
    expect(sorted.map((item) => item.key)).toEqual(['flash', 'claude', 'gpt']);
  });

  it('clamps thinking to what the selected model accepts', () => {
    const selected = option({
      reasoning: {
        canDisable: true,
        defaultEffort: 'high',
        defaultMode: 'off',
        efforts: ['low', 'high', 'max'],
      },
    });
    expect(effectiveReasoning(selected, '', '')).toEqual({
      effort: '',
      mode: 'off',
    });
    expect(effectiveReasoning(selected, 'on', 'medium')).toEqual({
      effort: 'high',
      mode: 'on',
    });
    expect(effectiveReasoning(selected, 'on', 'max')).toEqual({
      effort: 'max',
      mode: 'on',
    });
  });
});
