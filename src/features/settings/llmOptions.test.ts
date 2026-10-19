import { describe, expect, it } from 'vitest';
import type { ModelOption } from '@/api/types';
import { sortModelOptions } from './llmOptions';

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
  it('puts locked models last and sorts the rest by label', () => {
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
        usesUserKey: false,
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
      'claude',
      'flash',
      'gpt',
    ]);
  });
});
