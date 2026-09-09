import type { MaterialKind } from '@/api/types';

export type MaterialMode = 'view' | 'edit' | 'comment';

export interface MaterialModeCapabilities {
  canEdit: boolean;
}

export interface MaterialModePolicy {
  defaultMode: MaterialMode;
  modes: readonly MaterialMode[];
}

export function materialModePolicy(
  kind: MaterialKind,
  capabilities: MaterialModeCapabilities
): MaterialModePolicy {
  const modes: MaterialMode[] = [];

  // Editors may edit, comment, or view; everyone else views statically.
  if (capabilities.canEdit) modes.push('edit', 'comment');
  modes.push('view');

  return {
    defaultMode:
      kind === 'quiz' || kind === 'flashcards'
        ? 'view'
        : capabilities.canEdit
          ? 'edit'
          : 'view',
    modes,
  };
}

export function resolveMaterialMode(
  requested: MaterialMode | null,
  policy: MaterialModePolicy
): MaterialMode {
  return requested && policy.modes.includes(requested)
    ? requested
    : policy.defaultMode;
}

export function isInteractiveMaterialMode(
  mode: MaterialMode
): mode is Extract<MaterialMode, 'edit' | 'comment'> {
  return mode === 'edit' || mode === 'comment';
}
