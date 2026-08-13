import type { CognitiveLevel } from '@/api/types';
import { m } from '@/i18n';

/** Cognitive levels ordered from lowest to highest cognitive load. */
export const LEVELS: CognitiveLevel[] = ['recall', 'application', 'analysis'];

/** Human-readable label shown on badges, chips, and pickers. */
export function levelLabel(level: CognitiveLevel): string {
  switch (level) {
    case 'analysis':
      return m.quiz_level_analysis();
    case 'application':
      return m.quiz_level_application();
    case 'recall':
      return m.quiz_level_recall();
  }
}

/** Short explanation of what each level asks of the student. */
export function levelHint(level: CognitiveLevel): string {
  switch (level) {
    case 'analysis':
      return m.quiz_level_analysis_hint();
    case 'application':
      return m.quiz_level_application_hint();
    case 'recall':
      return m.quiz_level_recall_hint();
  }
}

/** Badge tone per level (mirrors the old easy/medium/hard colour scale). */
export const LEVEL_TONE: Record<
  CognitiveLevel,
  'success' | 'warning' | 'error'
> = {
  analysis: 'error',
  application: 'warning',
  recall: 'success',
};
