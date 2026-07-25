import type { CognitiveLevel } from '@/api/types';

/** Cognitive levels ordered from lowest to highest cognitive load. */
export const LEVELS: CognitiveLevel[] = ['recall', 'application', 'analysis'];

/** Human-readable label shown on badges, chips, and pickers. */
export const LEVEL_LABEL: Record<CognitiveLevel, string> = {
  analysis: 'Analysis',
  application: 'Application',
  recall: 'Recall',
};

/** Short explanation of what each level asks of the student. */
export const LEVEL_HINT: Record<CognitiveLevel, string> = {
  analysis: 'Break down, compare, or reason',
  application: 'Use a concept to solve something',
  recall: 'Remember a fact or definition',
};

/** Badge tone per level (mirrors the old easy/medium/hard colour scale). */
export const LEVEL_TONE: Record<
  CognitiveLevel,
  'success' | 'warning' | 'error'
> = {
  analysis: 'error',
  application: 'warning',
  recall: 'success',
};
