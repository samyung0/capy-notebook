import {
  type CellTarget,
  type DraftConfig,
  draftConfigSchema,
  type Registry,
  type RegistrySaveRequest,
  reasoningSchema,
  type Surface,
} from './api';

export const matrixSurfaces: Surface[] = [
  'chat',
  'generate',
  'editor',
  'quiz',
  'ingest',
  'embedding',
  'vision',
];

const preferenceSurfaces = new Set<Surface>([
  'chat',
  'generate',
  'editor',
  'quiz',
]);
const reasoningSurfaces = new Set<Surface>([
  'chat',
  'generate',
  'editor',
  'quiz',
  'ingest',
]);

export type RegistryCell = {
  rowKey: string;
  surface: Surface;
  target: CellTarget;
  isDefault: boolean;
};

export type RegistryDraft = {
  baseVersion: number;
  cells: Map<string, RegistryCell>;
  drafts: Map<string, DraftConfig>;
  deprecations: Map<string, string>;
  embeddingUpdates: Map<
    string,
    RegistrySaveRequest['embeddingUpdates'][number]
  >;
};

export type RegistryIssue = {
  code:
    | 'default'
    | 'deprecation'
    | 'draft'
    | 'embedding'
    | 'embedding_acknowledgement';
  message: string;
};

export type RegistryValidation =
  | { valid: true; request: RegistrySaveRequest; embeddingRetargeted: boolean }
  | { valid: false; issues: RegistryIssue[]; embeddingRetargeted: boolean };

export function cellId(rowKey: string, surface: Surface): string {
  return `${rowKey}\u0000${surface}`;
}

export function targetId(target: CellTarget): string {
  return target.kind === 'existing'
    ? `existing:${target.modelKey}:${target.version}`
    : `draft:${target.draftId}`;
}

export function deriveRegistryDraft(registry: Registry): RegistryDraft {
  const cells = new Map<string, RegistryCell>();
  for (const config of registry.configs) {
    if (!config.enabled) {
      continue;
    }
    for (const surface of config.surfaces) {
      const id = cellId(config.modelKey, surface);
      const current = cells.get(id);
      if (
        current?.target.kind === 'existing' &&
        current.target.version >= config.version
      ) {
        continue;
      }
      cells.set(id, {
        isDefault: config.isDefaultFor.includes(surface),
        rowKey: config.modelKey,
        surface,
        target: {
          kind: 'existing',
          modelKey: config.modelKey,
          version: config.version,
        },
      });
    }
  }
  return {
    baseVersion: registry.version,
    cells,
    deprecations: new Map(),
    drafts: new Map(),
    embeddingUpdates: new Map(),
  };
}

export function defaultFor(
  cells: Iterable<RegistryCell>,
  surface: Surface
): RegistryCell | undefined {
  for (const cell of cells) {
    if (cell.surface === surface && cell.isDefault) {
      return cell;
    }
  }
}

function sameTarget(left: CellTarget, right: CellTarget): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === 'draft' && right.kind === 'draft') {
    return left.draftId === right.draftId;
  }
  if (left.kind === 'existing' && right.kind === 'existing') {
    return left.modelKey === right.modelKey && left.version === right.version;
  }
  return false;
}

export function registryDraftChanged(
  registry: Registry,
  draft: RegistryDraft
): boolean {
  if (
    draft.drafts.size > 0 ||
    draft.deprecations.size > 0 ||
    draft.embeddingUpdates.size > 0
  ) {
    return true;
  }
  const original = deriveRegistryDraft(registry).cells;
  if (original.size !== draft.cells.size) {
    return true;
  }
  for (const [id, cell] of draft.cells) {
    const before = original.get(id);
    if (
      !before ||
      before.isDefault !== cell.isDefault ||
      !sameTarget(before.target, cell.target)
    ) {
      return true;
    }
  }
  return false;
}

function targetLabel(target: CellTarget): string {
  return target.kind === 'existing'
    ? `${target.modelKey}@${target.version}`
    : `draft ${target.draftId}`;
}

function validateDraftConfig(
  config: DraftConfig,
  surfaces: Set<Surface>
): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  if (!draftConfigSchema.safeParse(config).success) {
    issues.push({
      code: 'draft',
      message: `${config.modelKey || config.id} has incomplete model fields.`,
    });
    return issues;
  }
  if (
    !URL.canParse(config.baseUrl) ||
    new URL(config.baseUrl).protocol !== 'https:'
  ) {
    issues.push({
      code: 'draft',
      message: `${config.modelKey} needs an absolute HTTPS base URL.`,
    });
  }
  if (config.authMode === 'user_key') {
    if (
      config.microsPerInputToken !== 0 ||
      config.microsPerCachedInputToken !== 0 ||
      config.microsPerOutputToken !== 0
    ) {
      issues.push({
        code: 'draft',
        message: `${config.modelKey} uses customer keys, so platform rates must be zero.`,
      });
    }
  } else if (
    config.microsPerInputToken <= 0 ||
    config.microsPerCachedInputToken <= 0 ||
    config.microsPerOutputToken <= 0
  ) {
    issues.push({
      code: 'draft',
      message: `${config.modelKey} needs positive platform input/output rates.`,
    });
  }
  if ([...surfaces].some((surface) => reasoningSurfaces.has(surface))) {
    const reasoning = reasoningSchema.safeParse(config.params.reasoning);
    if (
      !reasoning.success ||
      !reasoning.data.efforts.includes(reasoning.data.defaultEffort)
    ) {
      issues.push({
        code: 'draft',
        message: `${config.modelKey} needs valid named reasoning settings.`,
      });
    }
  }
  return issues;
}

function originalEmbeddingChanged(
  registry: Registry,
  draft: RegistryDraft
): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const original = deriveRegistryDraft(registry).cells;
  for (const [id, before] of original) {
    if (before.surface !== 'embedding') {
      continue;
    }
    const after = draft.cells.get(id);
    if (!after || !sameTarget(before.target, after.target)) {
      issues.push({
        code: 'embedding',
        message: `${before.rowKey} embedding cannot be cleared, replaced, or rewritten.`,
      });
    }
  }
  for (const cell of draft.cells.values()) {
    if (cell.surface === 'embedding' && cell.target.kind === 'draft') {
      issues.push({
        code: 'embedding',
        message:
          'New embedding models require a schema deployment and cannot be saved here.',
      });
    }
  }
  return issues;
}

export function validateRegistryDraft({
  registry,
  draft,
  embeddingAcknowledged,
}: {
  registry: Registry;
  draft: RegistryDraft;
  embeddingAcknowledged: boolean;
}): RegistryValidation {
  const issues: RegistryIssue[] = [];
  for (const surface of registry.surfaces) {
    const defaults = [...draft.cells.values()].filter(
      (cell) => cell.surface === surface && cell.isDefault
    );
    if (defaults.length !== 1) {
      issues.push({
        code: 'default',
        message: `${surface} needs exactly one default cell.`,
      });
    }
  }

  const original = deriveRegistryDraft(registry).cells;
  for (const [id, before] of original) {
    if (!preferenceSurfaces.has(before.surface) || draft.cells.has(id)) {
      continue;
    }
    const fallback = draft.deprecations.get(id);
    const fallbackCell = fallback
      ? draft.cells.get(cellId(fallback, before.surface))
      : undefined;
    if (!fallback || fallback === before.rowKey || !fallbackCell) {
      issues.push({
        code: 'deprecation',
        message: `Retiring ${before.rowKey} from ${before.surface} needs a served fallback.`,
      });
    }
  }

  const surfacesByDraft = new Map<string, Set<Surface>>();
  for (const cell of draft.cells.values()) {
    if (cell.target.kind !== 'draft') {
      continue;
    }
    const surfaces = surfacesByDraft.get(cell.target.draftId) ?? new Set();
    surfaces.add(cell.surface);
    surfacesByDraft.set(cell.target.draftId, surfaces);
    const config = draft.drafts.get(cell.target.draftId);
    if (!config || config.modelKey !== cell.rowKey) {
      issues.push({
        code: 'draft',
        message: `${cell.rowKey}/${cell.surface} points at a missing draft.`,
      });
    }
  }
  for (const [id, config] of draft.drafts) {
    const surfaces = surfacesByDraft.get(id);
    if (!surfaces || surfaces.size === 0) {
      continue;
    }
    issues.push(...validateDraftConfig(config, surfaces));
  }
  issues.push(...originalEmbeddingChanged(registry, draft));
  for (const update of draft.embeddingUpdates.values()) {
    const source = registry.configs.find(
      (config) =>
        config.modelKey === update.modelKey &&
        config.version === update.version &&
        config.enabled &&
        config.surfaces.includes('embedding')
    );
    if (
      !source ||
      update.providerSlug.trim() === '' ||
      !URL.canParse(update.baseUrl) ||
      new URL(update.baseUrl).protocol !== 'https:'
    ) {
      issues.push({
        code: 'embedding',
        message: `${update.modelKey}@${update.version} needs a valid provider and HTTPS base URL.`,
      });
    }
  }

  const beforeDefault = defaultFor(original.values(), 'embedding');
  const afterDefault = defaultFor(draft.cells.values(), 'embedding');
  const afterDefaultTarget = afterDefault?.target;
  if (afterDefaultTarget?.kind === 'existing') {
    const targetConfig = registry.configs.find(
      (config) =>
        config.modelKey === afterDefaultTarget.modelKey &&
        config.version === afterDefaultTarget.version
    );
    if (!targetConfig?.embeddingDefaultEligible) {
      issues.push({
        code: 'embedding',
        message:
          targetConfig?.embeddingValidationError ||
          `${targetLabel(afterDefaultTarget)} is not ready to become the embedding default.`,
      });
    }
  }
  const embeddingRetargeted =
    beforeDefault !== undefined &&
    afterDefault !== undefined &&
    !sameTarget(beforeDefault.target, afterDefault.target);
  if (embeddingRetargeted && !embeddingAcknowledged) {
    issues.push({
      code: 'embedding_acknowledgement',
      message: 'Embedding default changes require explicit acknowledgement.',
    });
  }
  if (issues.length > 0) {
    return { embeddingRetargeted, issues, valid: false };
  }

  const usedDrafts = new Set(
    [...draft.cells.values()]
      .filter((cell) => cell.target.kind === 'draft')
      .map((cell) => (cell.target.kind === 'draft' ? cell.target.draftId : ''))
  );
  return {
    embeddingRetargeted,
    request: {
      cells: [...draft.cells.values()],
      deprecations: [...draft.deprecations.entries()].map(
        ([id, fallbackKey]) => {
          const before = original.get(id);
          if (!before) {
            throw new Error(`Missing original registry cell ${id}.`);
          }
          return {
            fallbackKey,
            modelKey: before.rowKey,
            surface: before.surface,
          };
        }
      ),
      drafts: [...draft.drafts.entries()]
        .filter(([id]) => usedDrafts.has(id))
        .map(([, config]) => config),
      embeddingAcknowledged,
      embeddingUpdates: [...draft.embeddingUpdates.values()],
      expectedVersion: draft.baseVersion,
    },
    valid: true,
  };
}

export function formatTarget(target: CellTarget): string {
  return targetLabel(target);
}
