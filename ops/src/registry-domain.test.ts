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
  slots: CatalogConfig['slots'],
  defaults: CatalogConfig['isDefaultFor']
): CatalogConfig {
  return {
    byokEnabled: false,
    capabilities: slots.includes('retrieval') ? ['embedding'] : [],
    contextWindowTokens: 128_000,
    createdAt: '2026-08-24T12:00:00Z',
    createdBy: '',
    defaultThinking: slots.includes('retrieval') ? '' : 'instant',
    embeddingDefaultEligible: slots.includes('retrieval'),
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
    slots,
    thinkingLevels: slots.includes('retrieval')
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
    capabilities: ['vision', 'pdf', 'embedding'],
    configs: [
      config('alpha', ['chat', 'retrieval'], ['chat', 'retrieval']),
      config('beta', ['chat', 'retrieval'], []),
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
    slots: ['chat', 'retrieval'],
  };
}

describe('registry reducer', () => {
  it('moves defaults without mutating the prior state', () => {
    const initial = createRegistryState(registry());
    const alpha = modelRefId(registry().configs[0]);
    const beta = modelRefId(registry().configs[1]);
    const changed = registryReducer(initial, {
      rowId: beta,
      slot: 'chat',
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
        slot: 'chat',
        target: { draftId: draft.id, kind: 'draft' },
      },
      type: 'set-cell',
    });
    state = registryReducer(state, {
      cell: {
        isDefault: true,
        rowId: alpha,
        slot: 'retrieval',
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
          defaultFor: ['chat', 'retrieval'],
          modelSlug: 'test/alpha',
          platformEnabled: true,
          providerSlug: 'deepseek',
          slots: ['chat', 'retrieval'],
        },
        {
          defaultFor: [],
          modelSlug: 'test/beta',
          providerSlug: 'deepseek',
          slots: ['chat', 'retrieval'],
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
      slot: 'chat',
      type: 'clear-cell',
    });
    state = registryReducer(state, {
      rowId: beta,
      slot: 'chat',
      type: 'set-default',
    });
    const assembled = assembleRegistryRequest(snapshot, state);
    expect(assembled.valid).toBe(true);
    if (assembled.valid) {
      expect(
        assembled.request.active.find(
          (row) =>
            row.providerSlug === 'deepseek' && row.modelSlug === 'test/alpha'
        )?.slots
      ).toEqual(['retrieval']);
    }
  });

  it('blocks embedding changes until acknowledged', () => {
    const snapshot = registry();
    const beta = modelRefId(snapshot.configs[1]);
    let state = createRegistryState(snapshot);
    state = registryReducer(state, {
      rowId: beta,
      slot: 'retrieval',
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
