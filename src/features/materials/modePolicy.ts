export type MaterialMode = 'view' | 'edit';

export interface MaterialModeCapabilities {
  /** Edit mode (and comments): off for viewers, a frozen account and an
   * owner at its storage limit. */
  canEditContent: boolean;
}

export interface MaterialModePolicy {
  defaultMode: MaterialMode;
  modes: readonly MaterialMode[];
}

export function materialModePolicy(
  capabilities: MaterialModeCapabilities
): MaterialModePolicy {
  const modes: MaterialMode[] = [];

  if (capabilities.canEditContent) modes.push('edit');
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
