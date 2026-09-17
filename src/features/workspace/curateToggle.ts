/**
 * The curate switch only opens a new chat: a thread's mode is fixed when it is
 * created, so the switch locks once the thread has messages or is streaming,
 * and stays locked while a selected thread's messages are still loading — a
 * flip before then would disagree with the stored flag.
 *
 * A visitor who cannot write to the workspace never sees the switch at all;
 * curate writes materials, and the gateway refuses the turn.
 */
export function curateToggleDisabled(state: {
  hydrating: boolean;
  messageCount: number;
  streaming: boolean;
}): boolean {
  return state.hydrating || state.streaming || state.messageCount > 0;
}

/**
 * The switch is hidden, not merely disabled, for a read-only visitor: curate
 * writes materials into the workspace, so offering the mode at all would
 * promise a turn the gateway refuses with `curate_requires_editor`.
 */
export function curateToggleVisible(state: { readOnly?: boolean }): boolean {
  return !state.readOnly;
}
