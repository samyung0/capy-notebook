import type {
  CatalogConfig,
  DraftConfig,
  Registry,
  RegistrySaveRequest,
  Surface,
} from './api';

export type CellTarget =
  | {
      kind: 'catalog';
      providerSlug: string;
      modelSlug: string;
      version: number;
    }
  | { kind: 'draft'; draftId: string };

export type RegistryCell = {
  rowId: string;
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
  embeddingAcknowledged: boolean;
  dirty: boolean;
};

export type RegistryAction =
  | { type: 'set-cell'; cell: RegistryCell }
  | { type: 'clear-cell'; rowId: string; surface: Surface }
  | { type: 'set-default'; rowId: string; surface: Surface }
  | { type: 'upsert-draft'; draft: DraftConfig }
  | { type: 'acknowledge-embedding'; checked: boolean }
  | { type: 'reset'; registry: Registry };

export type RegistryIssue = {
  code:
    | 'aliases'
    | 'missing-default'
    | 'embedding-acknowledgement'
    | 'draft-not-used';
  message: string;
  rowId?: string;
  surface?: Surface;
};

export type RequestAssembly =
  | { valid: true; request: RegistrySaveRequest; embeddingChanged: boolean }
  | { valid: false; issues: RegistryIssue[]; embeddingChanged: boolean };

export function modelRefId(ref: {
  providerSlug: string;
  modelSlug: string;
}): string {
  return JSON.stringify([ref.providerSlug, ref.modelSlug]);
}

export function modelRefLabel(ref: {
  providerSlug: string;
  modelSlug: string;
}): string {
  return `${ref.providerSlug} / ${ref.modelSlug}`;
}

export function cellId(rowId: string, surface: Surface): string {
  return `${rowId}\u0000${surface}`;
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
        rowId: modelRefId(config),
        surface,
        target: {
          kind: 'catalog',
          modelSlug: config.modelSlug,
          providerSlug: config.providerSlug,
          version: config.version,
        },
      };
      cells.set(cellId(cell.rowId, surface), cell);
    }
  }
  return cells;
}

export function createRegistryState(registry: Registry): RegistryState {
  const cells = initialCells(registry);
  return {
    cells,
    dirty: false,
    drafts: new Map(),
    embeddingAcknowledged: false,
    expectedVersion: registry.revision,
    originalCells: new Map(
      [...cells].map(([id, cell]) => [id, copyCell(cell)])
    ),
    rows: [...new Set(registry.configs.map(modelRefId))].sort(),
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
      rows: [...new Set([...state.rows, modelRefId(action.draft)])].sort(),
    };
  }

  const cells = new Map(state.cells);
  if (action.type === 'clear-cell') {
    const id = cellId(action.rowId, action.surface);
    if (!cells.has(id)) {
      return state;
    }
    cells.delete(id);
    return { ...state, cells, dirty: true };
  }
  if (action.type === 'set-cell') {
    cells.set(
      cellId(action.cell.rowId, action.cell.surface),
      copyCell(action.cell)
    );
    return { ...state, cells, dirty: true };
  }

  const selectedId = cellId(action.rowId, action.surface);
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
    left.providerSlug === right.providerSlug &&
    left.modelSlug === right.modelSlug &&
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
    const desired = state.cells.get(cellId(cell.rowId, cell.surface));
    return (
      !desired ||
      desired.isDefault !== cell.isDefault ||
      !sameTarget(desired.target, cell.target)
    );
  });
}

export function targetForRow(
  registry: Registry,
  state: RegistryState,
  rowId: string
): CellTarget | undefined {
  const draft = [...state.drafts.values()].find(
    (candidate) => modelRefId(candidate) === rowId
  );
  if (draft) {
    return { draftId: draft.id, kind: 'draft' };
  }
  const latest = registry.configs
    .filter((config) => modelRefId(config) === rowId)
    .sort((left, right) => right.version - left.version)[0];
  return latest
    ? {
        kind: 'catalog',
        modelSlug: latest.modelSlug,
        providerSlug: latest.providerSlug,
        version: latest.version,
      }
    : undefined;
}

export function cloneCatalogToDraft(
  config: CatalogConfig,
  id: string
): DraftConfig {
  return {
    byokEnabled: config.byokEnabled,
    contextWindowTokens: config.contextWindowTokens,
    defaultThinking: config.defaultThinking,
    id,
    microsPerCachedInputToken: config.microsPerCachedInputToken,
    microsPerInputToken: config.microsPerInputToken,
    microsPerOutputToken: config.microsPerOutputToken,
    modelName: config.modelName,
    modelSlug: config.modelSlug,
    params: { ...config.params },
    platformEnabled: config.platformEnabled,
    providerName: config.providerName,
    providerSlug: config.providerSlug,
    thinkingLevels: [...config.thinkingLevels],
  };
}

export function emptyDraft(id: string): DraftConfig {
  return {
    byokEnabled: false,
    contextWindowTokens: 0,
    defaultThinking: 'instant',
    id,
    microsPerCachedInputToken: 0,
    microsPerInputToken: 0,
    microsPerOutputToken: 0,
    modelName: '',
    modelSlug: '',
    params: {},
    platformEnabled: true,
    providerName: '',
    providerSlug: '',
    thinkingLevels: ['instant'],
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

  const usedDraftIds = new Set(
    [...state.cells.values()]
      .filter((cell) => cell.target.kind === 'draft')
      .map((cell) => (cell.target.kind === 'draft' ? cell.target.draftId : ''))
  );
  for (const draft of state.drafts.values()) {
    if (!usedDraftIds.has(draft.id)) {
      issues.push({
        code: 'draft-not-used',
        message: `${modelRefLabel(draft)} draft is not assigned to a surface.`,
        rowId: modelRefId(draft),
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
  for (const rowId of state.rows) {
    const rowCells = [...state.cells.values()].filter(
      (cell) => cell.rowId === rowId
    );
    if (rowCells.length === 0) {
      continue;
    }
    const target = rowCells[0]?.target;
    if (!target || rowCells.some((cell) => !sameTarget(cell.target, target))) {
      issues.push({
        code: 'draft-not-used',
        message: `${rowId} must use one configuration across all surfaces.`,
        rowId,
      });
      continue;
    }
    const source =
      target?.kind === 'draft'
        ? state.drafts.get(target.draftId)
        : registry.configs.find(
            (config) =>
              config.providerSlug === target?.providerSlug &&
              config.modelSlug === target.modelSlug &&
              config.version === target.version
          );
    if (!source) {
      issues.push({
        code: 'draft-not-used',
        message: `${rowId} has no usable configuration.`,
        rowId,
      });
      continue;
    }
    active.push({
      byokEnabled: source.byokEnabled,
      contextWindowTokens: source.contextWindowTokens,
      defaultFor: rowCells
        .filter((cell) => cell.isDefault)
        .map((cell) => cell.surface),
      defaultThinking: source.defaultThinking,
      modelName: source.modelName,
      modelSlug: source.modelSlug,
      params: { ...source.params },
      platformEnabled: source.platformEnabled,
      providerName: source.providerName,
      providerSlug: source.providerSlug,
      rates: {
        cachedInputMicros: source.microsPerCachedInputToken,
        inputMicros: source.microsPerInputToken,
        outputMicros: source.microsPerOutputToken,
      },
      surfaces: rowCells.map((cell) => cell.surface),
      thinkingLevels: [...source.thinkingLevels],
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
      revision: state.expectedVersion,
    },
    valid: true,
  };
}

export function canMutateRegistry(permissions: readonly string[]): boolean {
  return permissions.includes('write_registry');
}
