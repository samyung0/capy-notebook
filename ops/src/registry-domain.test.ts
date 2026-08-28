import { describe, expect, it } from 'vitest';
import type { CatalogConfig, Registry } from './api';
import {
  assembleRegistryRequest,
  cloneCatalogToDraft,
  createRegistryState,
  modelRefId,
  registryReducer,
} from './registry-domain';

function config(
  name: string,
  surfaces: CatalogConfig['surfaces'],
  defaults: CatalogConfig['isDefaultFor']
): CatalogConfig {
  return {
    byokEnabled: false,
    contextWindowTokens: 128_000,
    createdAt: '2026-08-24T12:00:00Z',
    createdBy: '',
    defaultThinking: surfaces.includes('embedding') ? '' : 'instant',
    embeddingDefaultEligible: surfaces.includes('embedding'),
    embeddingValidationError: '',
    enabled: true,
    isDefaultFor: defaults,
    microsPerCachedInputToken: 1,
    microsPerInputToken: 2,
    microsPerOutputToken: 6,
    modelName: name,
    modelSlug: `test/${name}`,
    params: {},
    platformEnabled: true,
    providerName: 'Test',
    providerSlug: 'deepseek',
    surfaces,
    thinkingLevels: surfaces.includes('embedding')
      ? []
      : ['instant', 'low', 'mid', 'high', 'max'],
    updatedAt: '2026-08-24T12:00:00Z',
    updatedBy: '',
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
      {
        count: 12,
        dim: 1536,
        modelSlug: 'test/alpha',
        providerSlug: 'deepseek',
        version: 1,
      },
    ],
    providerCredentials: [
      {
        configured: true,
        environment: 'DEEPSEEK_API_KEY',
        providerSlug: 'deepseek',
      },
    ],
    revision: 7,
    surfaces: ['chat', 'embedding'],
  };
}

describe('registry reducer', () => {
  it('moves defaults without mutating the prior state', () => {
    const initial = createRegistryState(registry());
    const alpha = modelRefId(registry().configs[0]);
    const beta = modelRefId(registry().configs[1]);
    const changed = registryReducer(initial, {
      rowId: beta,
      surface: 'chat',
      type: 'set-default',
    });

    expect(initial.cells.get(`${alpha}\u0000chat`)?.isDefault).toBe(true);
    expect(changed.cells.get(`${alpha}\u0000chat`)?.isDefault).toBe(false);
    expect(changed.cells.get(`${beta}\u0000chat`)?.isDefault).toBe(true);
  });
});

describe('registry request assembly', () => {
  it('assembles exact cells and only assigned drafts', () => {
    const snapshot = registry();
    let state = createRegistryState(snapshot);
    const draft = cloneCatalogToDraft(snapshot.configs[0], 'draft-alpha');
    const alpha = modelRefId(draft);
    state = registryReducer(state, { draft, type: 'upsert-draft' });
    state = registryReducer(state, {
      cell: {
        isDefault: true,
        rowId: alpha,
        surface: 'chat',
        target: { draftId: draft.id, kind: 'draft' },
      },
      type: 'set-cell',
    });
    state = registryReducer(state, {
      cell: {
        isDefault: true,
        rowId: alpha,
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
          modelSlug: 'test/alpha',
          platformEnabled: true,
          providerSlug: 'deepseek',
          surfaces: ['chat', 'embedding'],
        },
        {
          defaultFor: [],
          modelSlug: 'test/beta',
          providerSlug: 'deepseek',
          surfaces: ['chat', 'embedding'],
        },
      ],
      revision: 7,
    });
  });

  it('allows clearing a preference cell without a fallback picker', () => {
    const snapshot = registry();
    const alpha = modelRefId(snapshot.configs[0]);
    const beta = modelRefId(snapshot.configs[1]);
    let state = createRegistryState(snapshot);
    state = registryReducer(state, {
      rowId: alpha,
      surface: 'chat',
      type: 'clear-cell',
    });
    state = registryReducer(state, {
      rowId: beta,
      surface: 'chat',
      type: 'set-default',
    });
    const assembled = assembleRegistryRequest(snapshot, state);
    expect(assembled.valid).toBe(true);
    if (assembled.valid) {
      expect(
        assembled.request.active.find(
          (row) =>
            row.providerSlug === 'deepseek' && row.modelSlug === 'test/alpha'
        )?.surfaces
      ).toEqual(['embedding']);
    }
  });

  it('blocks embedding changes until acknowledged', () => {
    const snapshot = registry();
    const beta = modelRefId(snapshot.configs[1]);
    let state = createRegistryState(snapshot);
    state = registryReducer(state, {
      rowId: beta,
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
