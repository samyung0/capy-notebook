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

  it('resolves empty stored prefs to the catalog off default', () => {
    const selected = option({
      reasoning: {
        canDisable: true,
        defaultEffort: 'max',
        defaultMode: 'off',
        efforts: ['low', 'high', 'max'],
      },
    });
    expect(effectiveReasoning(selected, '', '')).toEqual({
      effort: '',
      mode: 'off',
    });
  });

  it('uses catalog defaultEffort when the stored effort is not on this model', () => {
    const selected = option({
      reasoning: {
        canDisable: true,
        defaultEffort: 'max',
        defaultMode: 'off',
        efforts: ['low', 'high', 'max'],
      },
    });
    expect(effectiveReasoning(selected, '', '')).toEqual({
      effort: '',
      mode: 'off',
    });
    expect(effectiveReasoning(selected, 'on', 'medium')).toEqual({
      effort: 'max',
      mode: 'on',
    });
    expect(effectiveReasoning(selected, 'on', 'max')).toEqual({
      effort: 'max',
      mode: 'on',
    });
    expect(effectiveReasoning(selected, 'on', '')).toEqual({
      effort: 'max',
      mode: 'on',
    });
  });

  it('does not invent an effort when the catalog default is missing', () => {
    const selected = option({
      reasoning: {
        canDisable: true,
        defaultEffort: '',
        defaultMode: 'on',
        efforts: ['low', 'high', 'max'],
      },
    });
    expect(effectiveReasoning(selected, 'on', '')).toEqual({
      effort: '',
      mode: 'on',
    });
  });
});
