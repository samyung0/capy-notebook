import type {
  CatalogConfig,
  DraftConfig,
  Registry,
  RegistrySaveRequest,
  Surface,
} from './api';

export type CellTarget =
  | { kind: 'catalog'; modelKey: string; version: number }
  | { kind: 'draft'; draftId: string };

export type RegistryCell = {
  rowKey: string;
  surface: Surface;
  target: CellTarget;
  isDefault: boolean;
};

export type RegistryState = {
  expectedVersion: number;
  surfaces: Surface[];
  rows: string[];
  cells: Map<string, RegistryCell>;
  originalCells: Map<string, RegistryCell>;
  drafts: Map<string, DraftConfig>;
  deprecations: Map<string, string>;
  embeddingAcknowledged: boolean;
  dirty: boolean;
};

export type RegistryAction =
  | { type: 'set-cell'; cell: RegistryCell }
  | { type: 'clear-cell'; rowKey: string; surface: Surface }
  | { type: 'set-default'; rowKey: string; surface: Surface }
  | { type: 'upsert-draft'; draft: DraftConfig }
  | {
      type: 'set-deprecation';
      modelKey: string;
      surface: Surface;
      fallbackKey: string;
    }
  | { type: 'acknowledge-embedding'; checked: boolean }
  | { type: 'reset'; registry: Registry };

export type RegistryIssue = {
  code:
    | 'aliases'
    | 'missing-default'
    | 'missing-fallback'
    | 'embedding-acknowledgement'
    | 'draft-not-used';
  message: string;
  rowKey?: string;
  surface?: Surface;
};

export type RequestAssembly =
  | { valid: true; request: RegistrySaveRequest; embeddingChanged: boolean }
  | { valid: false; issues: RegistryIssue[]; embeddingChanged: boolean };

export function cellId(rowKey: string, surface: Surface): string {
  return `${rowKey}\u0000${surface}`;
}

function deprecationId(modelKey: string, surface: Surface): string {
  return `${modelKey}\u0000${surface}`;
}

function copyCell(cell: RegistryCell): RegistryCell {
  return { ...cell, target: { ...cell.target } };
}

function initialCells(registry: Registry): Map<string, RegistryCell> {
  const cells = new Map<string, RegistryCell>();
  const enabled = registry.configs
    .filter((config) => config.enabled)
    .sort((left, right) => left.version - right.version);

  for (const config of enabled) {
    for (const surface of config.surfaces) {
      const cell: RegistryCell = {
        isDefault: config.isDefaultFor.includes(surface),
        rowKey: config.modelKey,
        surface,
        target: {
          kind: 'catalog',
          modelKey: config.modelKey,
          version: config.version,
        },
      };
      cells.set(cellId(cell.rowKey, surface), cell);
    }
  }
  return cells;
}

export function createRegistryState(registry: Registry): RegistryState {
  const cells = initialCells(registry);
  return {
    cells,
    deprecations: new Map(),
    dirty: false,
    drafts: new Map(),
    embeddingAcknowledged: false,
    expectedVersion: registry.revision,
    originalCells: new Map(
      [...cells].map(([id, cell]) => [id, copyCell(cell)])
    ),
    rows: [
      ...new Set(registry.configs.map((config) => config.modelKey)),
    ].sort(),
    surfaces: registry.surfaces,
  };
}

export function registryReducer(
  state: RegistryState,
  action: RegistryAction
): RegistryState {
  if (action.type === 'reset') {
    return createRegistryState(action.registry);
  }
  if (action.type === 'acknowledge-embedding') {
    return {
      ...state,
      dirty: true,
      embeddingAcknowledged: action.checked,
    };
  }
  if (action.type === 'set-deprecation') {
    const deprecations = new Map(state.deprecations);
    const id = deprecationId(action.modelKey, action.surface);
    if (action.fallbackKey) {
      deprecations.set(id, action.fallbackKey);
    } else {
      deprecations.delete(id);
    }
    return { ...state, deprecations, dirty: true };
  }
  if (action.type === 'upsert-draft') {
    const drafts = new Map(state.drafts);
    drafts.set(action.draft.id, {
      ...action.draft,
      params: { ...action.draft.params },
    });
    return {
      ...state,
      dirty: true,
      drafts,
      rows: [...new Set([...state.rows, action.draft.modelKey])].sort(),
    };
  }

  const cells = new Map(state.cells);
  if (action.type === 'clear-cell') {
    const id = cellId(action.rowKey, action.surface);
    if (!cells.has(id)) {
      return state;
    }
    cells.delete(id);
    return { ...state, cells, dirty: true };
  }
  if (action.type === 'set-cell') {
    cells.set(
      cellId(action.cell.rowKey, action.cell.surface),
      copyCell(action.cell)
    );
    return { ...state, cells, dirty: true };
  }

  const selectedId = cellId(action.rowKey, action.surface);
  const selected = cells.get(selectedId);
  if (!selected) {
    return state;
  }
  for (const [id, cell] of cells) {
    if (cell.surface === action.surface && cell.isDefault) {
      cells.set(id, { ...cell, isDefault: false });
    }
  }
  cells.set(selectedId, { ...selected, isDefault: true });
  return { ...state, cells, dirty: true };
}

function sameTarget(left: CellTarget, right: CellTarget): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'draft') {
    return right.kind === 'draft' && left.draftId === right.draftId;
  }
  return (
    right.kind === 'catalog' &&
    left.modelKey === right.modelKey &&
    left.version === right.version
  );
}

export function embeddingChanged(state: RegistryState): boolean {
  const original = [...state.originalCells.values()].filter(
    (cell) => cell.surface === 'embedding'
  );
  const current = [...state.cells.values()].filter(
    (cell) => cell.surface === 'embedding'
  );
  if (original.length !== current.length) {
    return true;
  }
  return original.some((cell) => {
    const desired = state.cells.get(cellId(cell.rowKey, cell.surface));
    return (
      !desired ||
      desired.isDefault !== cell.isDefault ||
      !sameTarget(desired.target, cell.target)
    );
  });
}

export function removedPreferenceCells(state: RegistryState): RegistryCell[] {
  const preferenceSurfaces = new Set<Surface>([
    'chat',
    'generate',
    'editor',
    'quiz',
  ]);
  return [...state.originalCells.values()].filter(
    (cell) =>
      preferenceSurfaces.has(cell.surface) &&
      !state.cells.has(cellId(cell.rowKey, cell.surface))
  );
}

export function targetForRow(
  registry: Registry,
  state: RegistryState,
  rowKey: string
): CellTarget | undefined {
  const draft = [...state.drafts.values()].find(
    (candidate) => candidate.modelKey === rowKey
  );
  if (draft) {
    return { draftId: draft.id, kind: 'draft' };
  }
  const latest = registry.configs
    .filter((config) => config.modelKey === rowKey)
    .sort((left, right) => right.version - left.version)[0];
  return latest
    ? { kind: 'catalog', modelKey: latest.modelKey, version: latest.version }
    : undefined;
}

export function cloneCatalogToDraft(
  config: CatalogConfig,
  id: string
): DraftConfig {
  return {
    authMode: config.authMode,
    baseUrl: config.baseUrl,
    contextWindowTokens: config.contextWindowTokens,
    displayName: config.displayName,
    id,
    microsPerCachedInputToken: config.microsPerCachedInputToken,
    microsPerInputToken: config.microsPerInputToken,
    microsPerOutputToken: config.microsPerOutputToken,
    modelKey: config.modelKey,
    params: { ...config.params },
    providerModelId: config.providerModelId,
    providerSlug: config.providerSlug,
  };
}

export function assembleRegistryRequest(
  registry: Registry,
  state: RegistryState
): RequestAssembly {
  const issues: RegistryIssue[] = [];
  if (registry.aliasesAllowed) {
    issues.push({
      code: 'aliases',
      message: 'This dashboard does not support model aliases.',
    });
  }

  for (const surface of state.surfaces) {
    const cells = [...state.cells.values()].filter(
      (cell) => cell.surface === surface
    );
    if (cells.filter((cell) => cell.isDefault).length !== 1) {
      issues.push({
        code: 'missing-default',
        message: `${surface} needs exactly one default.`,
        surface,
      });
    }
  }

  const deprecations: Array<{
    modelKey: string;
    surface: Surface;
    fallbackKey: string;
  }> = [];
  for (const removed of removedPreferenceCells(state)) {
    const fallbackKey = state.deprecations.get(
      deprecationId(removed.rowKey, removed.surface)
    );
    const fallbackCell = fallbackKey
      ? state.cells.get(cellId(fallbackKey, removed.surface))
      : undefined;
    if (!fallbackKey || !fallbackCell || fallbackKey === removed.rowKey) {
      issues.push({
        code: 'missing-fallback',
        message: `Choose a ${removed.surface} fallback for ${removed.rowKey}.`,
        rowKey: removed.rowKey,
        surface: removed.surface,
      });
      continue;
    }
    deprecations.push({
      fallbackKey,
      modelKey: removed.rowKey,
      surface: removed.surface,
    });
  }

  const usedDraftIds = new Set(
    [...state.cells.values()]
      .filter((cell) => cell.target.kind === 'draft')
      .map((cell) => (cell.target.kind === 'draft' ? cell.target.draftId : ''))
  );
  for (const draft of state.drafts.values()) {
    if (!usedDraftIds.has(draft.id)) {
      issues.push({
        code: 'draft-not-used',
        message: `${draft.modelKey} draft is not assigned to a surface.`,
        rowKey: draft.modelKey,
      });
    }
  }

  const changedEmbedding = embeddingChanged(state);
  if (changedEmbedding && !state.embeddingAcknowledged) {
    issues.push({
      code: 'embedding-acknowledgement',
      message: 'Acknowledge the embedding re-indexing impact before saving.',
      surface: 'embedding',
    });
  }
  if (issues.length > 0) {
    return { embeddingChanged: changedEmbedding, issues, valid: false };
  }

  const active: RegistrySaveRequest['active'] = [];
  for (const rowKey of state.rows) {
    const rowCells = [...state.cells.values()].filter(
      (cell) => cell.rowKey === rowKey
    );
    if (rowCells.length === 0) {
      continue;
    }
    const target = rowCells[0]?.target;
    if (!target || rowCells.some((cell) => !sameTarget(cell.target, target))) {
      issues.push({
        code: 'draft-not-used',
        message: `${rowKey} must use one configuration across all surfaces.`,
        rowKey,
      });
      continue;
    }
    const source =
      target?.kind === 'draft'
        ? state.drafts.get(target.draftId)
        : registry.configs.find(
            (config) =>
              config.modelKey === target?.modelKey &&
              config.version === target.version
          );
    if (!source) {
      issues.push({
        code: 'draft-not-used',
        message: `${rowKey} has no usable configuration.`,
        rowKey,
      });
      continue;
    }
    active.push({
      authMode: source.authMode,
      baseUrl: source.baseUrl,
      contextWindowTokens: source.contextWindowTokens,
      defaultFor: rowCells
        .filter((cell) => cell.isDefault)
        .map((cell) => cell.surface),
      displayName: source.displayName,
      modelKey: source.modelKey,
      params: { ...source.params },
      providerModelId: source.providerModelId,
      providerSlug: source.providerSlug,
      rates: {
        cachedInputMicros: source.microsPerCachedInputToken,
        inputMicros: source.microsPerInputToken,
        outputMicros: source.microsPerOutputToken,
      },
      surfaces: rowCells.map((cell) => cell.surface),
    });
  }
  if (issues.length > 0) {
    return { embeddingChanged: changedEmbedding, issues, valid: false };
  }

  return {
    embeddingChanged: changedEmbedding,
    request: {
      acknowledgeEmbeddingRetarget: state.embeddingAcknowledged,
      active,
      fallbacks: deprecations.map((item) => ({
        fromKey: item.modelKey,
        surface: item.surface,
        toKey: item.fallbackKey,
      })),
      revision: state.expectedVersion,
    },
    valid: true,
  };
}

export function canMutateRegistry(role: 'viewer' | 'admin'): boolean {
  return role === 'admin';
}
