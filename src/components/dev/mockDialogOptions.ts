import { dialogFiles } from '@/mocks/dialogFiles';

export const mockDialogOptions = [
  { id: 'workspace-stats', label: 'Workspace statistics' },
  { id: 'ownership-transfer', label: 'Transfer ownership confirmation' },
  { id: 'task-edit', label: 'Task editor' },
  ...dialogFiles.map(({ id, name }) => ({ id, label: name })),
  { id: 'onboarding', label: 'Onboarding' },
  { id: 'source-chooser', label: 'Add sources' },
  { id: 'source-details', label: 'Import details with dummy files' },
  { id: 'source-analysis-error', label: 'Import analysis error' },
] as const;
export type MockDialogId = (typeof mockDialogOptions)[number]['id'];
