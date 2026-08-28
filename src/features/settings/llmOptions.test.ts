import { describe, expect, it } from 'vitest';
import type { ModelOption } from '@/api/types';
import { joinModelLabel, sortModelOptions } from './llmOptions';

function option(partial: Partial<ModelOption>): ModelOption {
  return {
    available: true,
    isDefault: false,
    modelName: 'Model',
    modelSlug: 'model',
    providerName: 'Lab',
    providerSlug: 'openai',
    usesUserKey: false,
    ...partial,
  };
}

describe('llm options', () => {
  it('joins provider and model names', () => {
    expect(joinModelLabel('DeepSeek', 'Flash')).toBe('DeepSeek Flash');
    expect(joinModelLabel('  DeepSeek  ', '  Flash ')).toBe('DeepSeek Flash');
    expect(joinModelLabel('', 'Flash')).toBe('Flash');
  });

  it('puts locked models last and platform rows before user-key rows', () => {
    const sorted = sortModelOptions([
      option({
        available: false,
        modelName: 'GPT',
        modelSlug: 'gpt',
        providerName: 'OpenAI',
        usesUserKey: false,
      }),
      option({
        available: true,
        modelName: 'Claude',
        modelSlug: 'claude',
        providerName: 'Anthropic',
        usesUserKey: true,
      }),
      option({
        available: true,
        modelName: 'Flash',
        modelSlug: 'flash',
        providerName: 'DeepSeek',
        usesUserKey: false,
      }),
    ]);
    expect(sorted.map((item) => item.modelSlug)).toEqual([
      'flash',
      'claude',
      'gpt',
    ]);
  });
});
