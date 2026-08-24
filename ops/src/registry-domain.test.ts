import { describe, expect, it } from 'vitest';
import type { CatalogConfig, Registry, Surface } from './api';
import {
  cellId,
  deriveRegistryDraft,
  validateRegistryDraft,
} from './registry-domain';

function config(
  modelKey: string,
  surfaces: Surface[],
  defaults: Surface[],
  version = 1
): CatalogConfig & {
  credentialEnv: string;
  credentialConfigured: boolean;
} {
  const embedding = surfaces.includes('embedding');
  return {
    authMode: 'platform',
    baseUrl: 'https://provider.example/v1',
    contextWindowTokens: embedding ? 0 : 128_000,
    createdAt: '2026-08-24T12:00:00Z',
    credentialConfigured: true,
    credentialEnv: 'PROVIDER_API_KEY',
    displayName: modelKey,
    embeddingDefaultEligible: embedding,
    embeddingValidationError: '',
    enabled: true,
    isDefaultFor: defaults,
    microsPerCachedInputToken: embedding ? 0 : 1,
    microsPerInputToken: 1,
    microsPerOutputToken: embedding ? 0 : 1,
    modelKey,
    params: embedding
      ? { dimensions: 2560, vector_table: `vectors_${modelKey}` }
      : {
          reasoning: {
            canDisable: true,
            defaultEffort: 'medium',
            defaultMode: 'on',
            efforts: ['low', 'medium', 'high'],
          },
        },
    providerModelId: `${modelKey}-provider`,
    providerSlug: 'provider',
    surfaces,
    version,
  };
}

function registry(): Registry {
  return {
    aliasesAllowed: false,
    configs: [
      config('chat-a', ['chat'], ['chat']),
      config('chat-b', ['chat'], []),
      config('embed-a', ['embedding'], ['embedding']),
      config('embed-b', ['embedding'], []),
    ],
    embeddingWorkspaceCounts: [
      { count: 12, dim: 2560, modelKey: 'embed-a', version: 1 },
    ],
    surfaces: ['chat', 'embedding'],
    version: 7,
  };
}

describe('registry grid validation', () => {
  it('derives each cell independently from the latest enabled pin', () => {
    const source = registry();
    source.configs.push(config('chat-a', ['quiz'], [], 2));
    source.surfaces.push('quiz');
    const draft = deriveRegistryDraft(source);

    expect(draft.cells.get(cellId('chat-a', 'chat'))?.target).toEqual({
      kind: 'existing',
      modelKey: 'chat-a',
      version: 1,
    });
    expect(draft.cells.get(cellId('chat-a', 'quiz'))?.target).toEqual({
      kind: 'existing',
      modelKey: 'chat-a',
      version: 2,
    });
  });

  it('requires a fallback when a preference cell is retired', () => {
    const source = registry();
    const draft = deriveRegistryDraft(source);
    draft.cells.delete(cellId('chat-a', 'chat'));
    const chatB = draft.cells.get(cellId('chat-b', 'chat'));
    if (!chatB) {
      throw new Error('fixture is missing chat-b');
    }
    chatB.isDefault = true;

    const invalid = validateRegistryDraft({
      draft,
      embeddingAcknowledged: false,
      registry: source,
    });
    expect(invalid.valid).toBe(false);
    if (!invalid.valid) {
      expect(invalid.issues.map((issue) => issue.code)).toContain(
        'deprecation'
      );
    }

    draft.deprecations.set(cellId('chat-a', 'chat'), 'chat-b');
    const valid = validateRegistryDraft({
      draft,
      embeddingAcknowledged: false,
      registry: source,
    });
    expect(valid.valid).toBe(true);
  });

  it('hard-refuses embedding removal and draft assignment', () => {
    const source = registry();
    const removed = deriveRegistryDraft(source);
    removed.cells.delete(cellId('embed-a', 'embedding'));
    const result = validateRegistryDraft({
      draft: removed,
      embeddingAcknowledged: true,
      registry: source,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toContain('embedding');
    }
  });

  it('requires acknowledgement when the embedding default moves', () => {
    const source = registry();
    const draft = deriveRegistryDraft(source);
    const oldDefault = draft.cells.get(cellId('embed-a', 'embedding'));
    const newDefault = draft.cells.get(cellId('embed-b', 'embedding'));
    if (!oldDefault || !newDefault) {
      throw new Error('fixture embedding cells are missing');
    }
    oldDefault.isDefault = false;
    newDefault.isDefault = true;

    const result = validateRegistryDraft({
      draft,
      embeddingAcknowledged: false,
      registry: source,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues.map((issue) => issue.code)).toContain(
        'embedding_acknowledgement'
      );
    }
    expect(
      validateRegistryDraft({
        draft,
        embeddingAcknowledged: true,
        registry: source,
      }).valid
    ).toBe(true);
  });

  it('refuses an embedding target rejected by the server allowlist', () => {
    const source = registry();
    const rejected = source.configs.find((item) => item.modelKey === 'embed-b');
    if (!rejected) {
      throw new Error('fixture embedding target is missing');
    }
    rejected.embeddingDefaultEligible = false;
    rejected.embeddingValidationError =
      'Embedding pin has no deployed vector table.';
    const draft = deriveRegistryDraft(source);
    const oldDefault = draft.cells.get(cellId('embed-a', 'embedding'));
    const newDefault = draft.cells.get(cellId('embed-b', 'embedding'));
    if (!oldDefault || !newDefault) {
      throw new Error('fixture embedding cells are missing');
    }
    oldDefault.isDefault = false;
    newDefault.isDefault = true;

    const result = validateRegistryDraft({
      draft,
      embeddingAcknowledged: true,
      registry: source,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toContainEqual({
        code: 'embedding',
        message: 'Embedding pin has no deployed vector table.',
      });
    }
  });

  it('keeps the draft base version when polling sees a newer registry', () => {
    const source = registry();
    const draft = deriveRegistryDraft(source);
    source.version = 8;

    const result = validateRegistryDraft({
      draft,
      embeddingAcknowledged: false,
      registry: source,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.request.expectedVersion).toBe(7);
    }
  });
});
