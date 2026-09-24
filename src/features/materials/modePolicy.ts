export type MaterialMode = 'view' | 'edit';

export interface MaterialModeCapabilities {
  canEdit: boolean;
}

export interface MaterialModePolicy {
  defaultMode: MaterialMode;
  modes: readonly MaterialMode[];
}

export function materialModePolicy(
  capabilities: MaterialModeCapabilities
): MaterialModePolicy {
  const modes: MaterialMode[] = [];

  if (capabilities.canEdit) modes.push('edit');
  modes.push('view');

  return {
    defaultMode: 'view',
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
