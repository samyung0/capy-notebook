/** The scenario panel's button list, kept apart from `scenarioJourneys` so the
 * panel can render it without loading the editors the journeys drive. */
import { features } from '@/lib/features';
import { type MockScenarioId, mockScenarioOptions } from './scenarios';

export const editorScenarios = [
  { id: 'source-save-failed', label: 'Text source: save failed' },
  { id: 'source-save-refused', label: 'Text source: save refused for good' },
  { id: 'source-replaced', label: 'Text source: replaced with unsaved edits' },
  {
    id: 'source-draft-recovery',
    label: 'Text source: reopen a recovered draft',
  },
  { id: 'note-permission-lost', label: 'Note: edit access removed' },
  { id: 'office-docx-save', label: 'Word: save failed after editing' },
  { id: 'office-xlsx-save', label: 'Spreadsheet: save failed after editing' },
  { id: 'office-pptx-save', label: 'Slides: save failed after editing' },
  {
    id: 'office-runtime-error',
    label: 'Spreadsheet: export failed after editing',
  },
] as const;
export type JourneyId =
  | Exclude<MockScenarioId, 'none'>
  | (typeof editorScenarios)[number]['id'];
export const journeyOptions = [
  ...mockScenarioOptions.filter((option) => option.id !== 'none'),
  ...editorScenarios,
];

export function journeyGroup(id: string) {
  if (id.startsWith('auth-') || id.startsWith('onboarding-'))
    return 'Authentication';
  if (
    id.startsWith('chat-') ||
    id.startsWith('ai-') ||
    id.startsWith('generation') ||
    id === 'conversations-load'
  )
    return 'Chat and generation';
  if (/^(source-|office-|note-|collab)/.test(id)) return 'Editors and recovery';
  if (/^(file|upload|import|annotations|trash|storage)/.test(id))
    return 'Files and imports';
  if (/^(quiz|attempt|flashcard)/.test(id)) return 'Study';
  if (
    /^(account|profile|billing|checkout|models|credentials|notification|integrations|deletion)/.test(
      id
    )
  )
    return 'Account and settings';
  if (
    /^(workspace|chapter|member|sharing|invite|ownership|material|tags)/.test(
      id
    )
  )
    return 'Workspaces and materials';
  return 'Application';
}

export function journeyUnavailable(id: string): string | undefined {
  const flag = (
    {
      explore: 'explore',
      schedule: 'schedule',
      tasks: 'tasks',
      thinking: 'thinking',
    } as const
  )[id as 'explore'];
  return flag && !features[flag]
    ? `Enable VITE_FEATURE_${flag.toUpperCase()} to use this application page.`
    : undefined;
}
