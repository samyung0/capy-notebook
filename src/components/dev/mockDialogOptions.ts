export const mockDialogOptions = [
  { id: 'workspace-stats', label: 'Workspace statistics' },
  { id: 'workspace-settings', label: 'Workspace settings' },
  { id: 'workspace-sharing', label: 'Workspace sharing' },
  { id: 'ownership-transfer', label: 'Transfer ownership confirmation' },
  { id: 'task-edit', label: 'Task editor' },
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'source-chooser', label: 'Add sources' },
  { id: 'source-details', label: 'Import details' },
  { id: 'source-upload', label: 'Upload details' },
] as const;
export type MockDialogId = (typeof mockDialogOptions)[number]['id'];
