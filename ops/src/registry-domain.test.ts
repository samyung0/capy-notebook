import { describe, expect, it } from 'vitest';
import type { CatalogConfig, Registry } from './api';
import {
  assembleRegistryRequest,
  cloneCatalogToDraft,
  createRegistryState,
  registryReducer,
} from './registry-domain';

function config(
  modelKey: string,
  surfaces: CatalogConfig['surfaces'],
  defaults: CatalogConfig['isDefaultFor']
): CatalogConfig {
  return {
    authMode: 'platform',
    baseUrl: 'https://models.example.test',
    contextWindowTokens: 128_000,
    createdAt: '2026-08-24T12:00:00Z',
    displayName: modelKey,
    embeddingDefaultEligible: surfaces.includes('embedding'),
    embeddingValidationError: '',
    enabled: true,
    isDefaultFor: defaults,
    microsPerCachedInputToken: 1,
    microsPerInputToken: 2,
    microsPerOutputToken: 6,
    modelKey,
    params: {},
    providerModelId: modelKey,
    providerSlug: 'test-provider',
    surfaces,
    version: 1,
  };
}

function registry(): Registry {
  return {
    aliasesAllowed: false,
    configs: [
      config('alpha', ['chat', 'embedding'], ['chat', 'embedding']),
      config('beta', ['chat', 'embedding'], []),
    ],
    embeddingWorkspaceCounts: [
      { count: 12, dim: 1536, modelKey: 'alpha', version: 1 },
    ],
    providerCredentials: [
      {
        configured: true,
        environment: 'TEST_API_KEY',
        providerSlug: 'test-provider',
      },
    ],
    revision: 7,
    surfaces: ['chat', 'embedding'],
  };
}

describe('registry reducer', () => {
  it('moves defaults without mutating the prior state', () => {
    const initial = createRegistryState(registry());
    const changed = registryReducer(initial, {
      rowKey: 'beta',
      surface: 'chat',
      type: 'set-default',
    });

    expect(initial.cells.get('alpha\u0000chat')?.isDefault).toBe(true);
    expect(changed.cells.get('alpha\u0000chat')?.isDefault).toBe(false);
    expect(changed.cells.get('beta\u0000chat')?.isDefault).toBe(true);
  });
});

describe('registry request assembly', () => {
  it('assembles exact cells and only assigned drafts', () => {
    const snapshot = registry();
    let state = createRegistryState(snapshot);
    const draft = cloneCatalogToDraft(snapshot.configs[0], 'draft-alpha');
    state = registryReducer(state, { draft, type: 'upsert-draft' });
    state = registryReducer(state, {
      cell: {
        isDefault: true,
        rowKey: 'alpha',
        surface: 'chat',
        target: { draftId: draft.id, kind: 'draft' },
      },
      type: 'set-cell',
    });
    state = registryReducer(state, {
      cell: {
        isDefault: true,
        rowKey: 'alpha',
        surface: 'embedding',
        target: { draftId: draft.id, kind: 'draft' },
      },
      type: 'set-cell',
    });
    state = registryReducer(state, {
      checked: true,
      type: 'acknowledge-embedding',
    });

    const assembled = assembleRegistryRequest(snapshot, state);
    expect(assembled.valid).toBe(true);
    if (!assembled.valid) {
      return;
    }
    expect(assembled.request).toMatchObject({
      acknowledgeEmbeddingRetarget: true,
      active: [
        {
          defaultFor: ['chat', 'embedding'],
          modelKey: 'alpha',
          surfaces: ['chat', 'embedding'],
        },
        {
          defaultFor: [],
          modelKey: 'beta',
          surfaces: ['chat', 'embedding'],
        },
      ],
      fallbacks: [],
      revision: 7,
    });
  });

  it('requires a fallback when clearing a preference cell', () => {
    const snapshot = registry();
    let state = createRegistryState(snapshot);
    state = registryReducer(state, {
      rowKey: 'alpha',
      surface: 'chat',
      type: 'clear-cell',
    });
    state = registryReducer(state, {
      rowKey: 'beta',
      surface: 'chat',
      type: 'set-default',
    });
    const missing = assembleRegistryRequest(snapshot, state);
    expect(missing.valid).toBe(false);

    state = registryReducer(state, {
      fallbackKey: 'beta',
      modelKey: 'alpha',
      surface: 'chat',
      type: 'set-deprecation',
    });
    const complete = assembleRegistryRequest(snapshot, state);
    expect(complete.valid).toBe(true);
    if (complete.valid) {
      expect(complete.request.fallbacks).toEqual([
        { fromKey: 'alpha', surface: 'chat', toKey: 'beta' },
      ]);
    }
  });

  it('blocks embedding changes until acknowledged', () => {
    const snapshot = registry();
    let state = createRegistryState(snapshot);
    state = registryReducer(state, {
      rowKey: 'beta',
      surface: 'embedding',
      type: 'set-default',
    });

    const blocked = assembleRegistryRequest(snapshot, state);
    expect(blocked.valid).toBe(false);
    if (!blocked.valid) {
      expect(blocked.issues.map((issue) => issue.code)).toContain(
        'embedding-acknowledgement'
      );
    }
  });
});
