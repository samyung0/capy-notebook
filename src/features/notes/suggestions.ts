import type { MaterialValue } from '@/features/materials/document';

export type SuggestionDecision = 'accept' | 'reject';

export interface SuggestionMetadata {
  createdAt?: string;
  id: string;
  isLineBreak?: boolean;
  newProperties?: Record<string, unknown>;
  newText?: string;
  operation: 'insert' | 'remove' | 'update' | 'replace';
  properties?: Record<string, unknown>;
  text?: string;
  userId?: string;
}

export interface SuggestionChange {
  blockId: string;
  createdAt?: string;
  metadata: SuggestionMetadata[];
  operation: SuggestionMetadata['operation'];
  plateSuggestionId: string;
  previewAfter: string;
  previewBefore: string;
  userId?: string;
}

export interface SuggestionResolution {
  hasPendingSuggestions: boolean;
  resolvedIds: string[];
  value: MaterialValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOperation(value: unknown): SuggestionMetadata['operation'] {
  return value === 'insert' ||
    value === 'remove' ||
    value === 'replace' ||
    value === 'update'
    ? value
    : 'update';
}

function metadataForNode(
  node: Record<string, unknown>
): Array<[string, SuggestionMetadata]> {
  const result: Array<[string, SuggestionMetadata]> = [];
  const add = (key: string, raw: unknown, fallbackId = '') => {
    if (!isRecord(raw)) return;
    const id = typeof raw.id === 'string' && raw.id ? raw.id : fallbackId;
    if (!id) return;
    const metadata: SuggestionMetadata = {
      id,
      operation: normalizeOperation(raw.type),
    };
    if (typeof raw.createdAt === 'string') metadata.createdAt = raw.createdAt;
    if (raw.isLineBreak === true) metadata.isLineBreak = true;
    if (isRecord(raw.newProperties)) metadata.newProperties = raw.newProperties;
    if (typeof raw.newText === 'string') metadata.newText = raw.newText;
    if (isRecord(raw.properties)) metadata.properties = raw.properties;
    if (typeof raw.text === 'string') metadata.text = raw.text;
    if (typeof raw.userId === 'string') metadata.userId = raw.userId;
    result.push([key, metadata]);
  };
  add('suggestion', node.suggestion);
  for (const [key, raw] of Object.entries(node)) {
    if (key.startsWith('suggestion_'))
      add(key, raw, key.slice('suggestion_'.length));
  }
  return result;
}

function nodeText(node: unknown): string {
  if (!isRecord(node)) return '';
  if (typeof node.text === 'string') return node.text;
  return Array.isArray(node.children)
    ? node.children.map(nodeText).join('')
    : '';
}

function compact(value?: Record<string, unknown>): string {
  if (!value || Object.keys(value).length === 0) return '';
  return JSON.stringify(value);
}

const SUGGESTION_TYPE_LABELS: Record<string, string> = {
  audio: 'Audio',
  blockquote: 'Blockquote',
  callout: 'Callout',
  code_block: 'Code Block',
  equation: 'Equation',
  file: 'File',
  hr: 'Horizontal Rule',
  img: 'Image',
  inline_equation: 'Equation',
  media_embed: 'Media',
  table: 'Table',
  video: 'Video',
};

function previews(
  node: Record<string, unknown>,
  metadata: SuggestionMetadata
): [string, string] {
  if (metadata.isLineBreak) {
    return metadata.operation === 'remove'
      ? ['(line break)', '']
      : ['', '(line break)'];
  }
  const nodeContent = nodeText(node).trim();
  const text =
    nodeContent ||
    (typeof node.type === 'string'
      ? (SUGGESTION_TYPE_LABELS[node.type] ??
        node.type
          .split('_')
          .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
          .join(' '))
      : '');
  if (metadata.operation === 'insert') return ['', text];
  if (metadata.operation === 'remove') return [text, ''];
  return [
    metadata.text || compact(metadata.properties),
    metadata.newText || compact(metadata.newProperties),
  ];
}

function mergeOperation(
  current: SuggestionMetadata['operation'],
  next: SuggestionMetadata['operation']
): SuggestionMetadata['operation'] {
  if (current === next) return current;
  if (
    current === 'replace' ||
    next === 'replace' ||
    (current === 'insert' && next === 'remove') ||
    (current === 'remove' && next === 'insert')
  ) {
    return 'replace';
  }
  return 'update';
}

function appendPreview(current: string, next: string): string {
  if (!next || current === next) return current;
  return current ? `${current} … ${next}` : next;
}

/** Mirrors materialdoc.ScanSuggestions: one row per Plate id and top-level block. */
export function scanSuggestions(value: MaterialValue): SuggestionChange[] {
  const changes = new Map<string, SuggestionChange>();
  const walk = (node: unknown, blockId: string) => {
    if (!isRecord(node)) return;
    for (const [, metadata] of metadataForNode(node)) {
      const key = `${blockId}\u0000${metadata.id}`;
      const [before, after] = previews(node, metadata);
      const current = changes.get(key);
      if (current) {
        current.metadata.push(metadata);
        current.createdAt ??= metadata.createdAt;
        current.userId ??= metadata.userId;
        current.operation = mergeOperation(
          current.operation,
          metadata.operation
        );
        current.previewBefore = appendPreview(current.previewBefore, before);
        current.previewAfter = appendPreview(current.previewAfter, after);
      } else {
        const change: SuggestionChange = {
          blockId,
          metadata: [metadata],
          operation: metadata.operation,
          plateSuggestionId: metadata.id,
          previewAfter: after,
          previewBefore: before,
        };
        if (metadata.createdAt) change.createdAt = metadata.createdAt;
        if (metadata.userId) change.userId = metadata.userId;
        changes.set(key, change);
      }
    }
    if (Array.isArray(node.children)) {
      node.children.forEach((child) => {
        walk(child, blockId);
      });
    }
  };
  for (const block of value) {
    // Suggestion lifecycle rows are keyed by the persisted block id. Falling
    // back to an array index makes the same suggestion appear to move after a
    // reorder and can join it to the wrong lifecycle row.
    const blockId =
      typeof block.id === 'string' && block.id.trim() ? block.id : null;
    if (!blockId) continue;
    walk(block, blockId);
  }
  return [...changes.values()].sort(
    (a, b) =>
      a.blockId.localeCompare(b.blockId) ||
      a.plateSuggestionId.localeCompare(b.plateSuggestionId)
  );
}

export function suggestionIds(value: MaterialValue): Set<string> {
  return new Set(
    scanSuggestions(value).map((change) => change.plateSuggestionId)
  );
}

function applyUpdate(
  node: Record<string, unknown>,
  metadata: SuggestionMetadata,
  decision: SuggestionDecision
) {
  const properties =
    decision === 'accept' ? metadata.newProperties : metadata.properties;
  const text = decision === 'accept' ? metadata.newText : metadata.text;
  for (const key of [
    ...Object.keys(metadata.properties ?? {}),
    ...Object.keys(metadata.newProperties ?? {}),
  ]) {
    if (
      key !== 'children' &&
      key !== 'suggestion' &&
      !key.startsWith('suggestion_')
    ) {
      delete node[key];
    }
  }
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (
      key === 'children' ||
      key === 'suggestion' ||
      key.startsWith('suggestion_')
    )
      continue;
    if (value == null) delete node[key];
    else node[key] = value;
  }
  if (
    'text' in node &&
    (metadata.text !== undefined || metadata.newText !== undefined)
  ) {
    node.text = text ?? '';
  }
}

function sameLeafProperties(
  left: Record<string, unknown>,
  right: Record<string, unknown>
) {
  const leftEntries = Object.entries(left).filter(([key]) => key !== 'text');
  const rightEntries = Object.entries(right).filter(([key]) => key !== 'text');
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(
    ([key, value]) =>
      key in right && JSON.stringify(value) === JSON.stringify(right[key])
  );
}

function mergeAdjacentLeaves(children: Record<string, unknown>[]) {
  return children.reduce<Record<string, unknown>[]>((merged, child) => {
    const previous = merged.at(-1);
    if (
      previous &&
      typeof previous.text === 'string' &&
      typeof child.text === 'string' &&
      sameLeafProperties(previous, child)
    ) {
      previous.text += child.text;
    } else {
      merged.push(child);
    }
    return merged;
  }, []);
}

function resolveNode(
  input: unknown,
  selected: Set<string>,
  all: boolean,
  decision: SuggestionDecision,
  resolved: Set<string>
): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  const node = structuredClone(input);
  let drop = false;
  for (const [key, metadata] of metadataForNode(node)) {
    if (!all && !selected.has(metadata.id)) continue;
    resolved.add(metadata.id);
    if (metadata.operation === 'insert') drop = decision === 'reject';
    else if (metadata.operation === 'remove') drop = decision === 'accept';
    else applyUpdate(node, metadata, decision);
    delete node[key];
  }
  if (drop) return null;
  if (
    !isRecord(node.suggestion) &&
    !Object.keys(node).some((key) => key.startsWith('suggestion_'))
  ) {
    delete node.suggestion;
  }
  if (typeof node.text === 'string' || !Array.isArray(node.children))
    return node;
  const children = node.children
    .map((child) => resolveNode(child, selected, all, decision, resolved))
    .filter((child): child is Record<string, unknown> => child !== null);
  node.children = children.length
    ? mergeAdjacentLeaves(children)
    : [{ text: '' }];
  return node;
}

/** Resolve selected IDs; omitting IDs resolves every pending suggestion. */
export function resolveSuggestions(
  value: MaterialValue,
  decision: SuggestionDecision,
  ids?: Iterable<string>
): SuggestionResolution {
  const selected = new Set(ids ?? []);
  const all = selected.size === 0;
  const resolved = new Set<string>();
  const projected = value
    .map((node) => resolveNode(node, selected, all, decision, resolved))
    .filter(
      (node): node is MaterialValue[number] => node !== null
    ) as MaterialValue;
  const safeValue =
    projected.length > 0
      ? projected
      : ([{ children: [{ text: '' }], type: 'p' }] as MaterialValue);
  return {
    hasPendingSuggestions: scanSuggestions(safeValue).length > 0,
    resolvedIds: [...resolved].sort(),
    value: safeValue,
  };
}

/** Clean accepted/rejected projection used by exports and study consumers. */
export function finalizeSuggestionValue(
  value: MaterialValue,
  decision: SuggestionDecision
): MaterialValue {
  return resolveSuggestions(value, decision).value;
}

function isCommentDecorationKey(key: string): boolean {
  return key === 'comment' || key.startsWith('comment_');
}

/**
 * Comment marks are a runtime decoration rebuilt from discussion anchors.
 * Persisting them in the material creates stale ranges after later edits.
 */
export function stripCommentDecorations(value: MaterialValue): MaterialValue {
  const strip = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(strip);
    if (!isRecord(input)) return input;

    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input)) {
      if (isCommentDecorationKey(key)) continue;
      result[key] = strip(child);
    }
    return result;
  };

  return strip(value) as MaterialValue;
}

export function materialValueText(value: MaterialValue | null): string {
  if (!value) return '';
  const text = (node: unknown): string => {
    if (!isRecord(node)) return '';
    if (typeof node.text === 'string') return node.text;
    return Array.isArray(node.children) ? node.children.map(text).join('') : '';
  };
  return value.map(text).join('\n').trim();
}

export interface SuggestionChangeItem {
  text: string;
  type: 'insert' | 'remove';
}

/** Human-readable change rows for diagnostics and compact previews. */
export function suggestionChangeItems(
  value: MaterialValue | null
): SuggestionChangeItem[] {
  return value
    ? scanSuggestions(value).flatMap((change) => [
        ...(change.previewBefore
          ? [{ text: change.previewBefore, type: 'remove' as const }]
          : []),
        ...(change.previewAfter
          ? [{ text: change.previewAfter, type: 'insert' as const }]
          : []),
      ])
    : [];
}
