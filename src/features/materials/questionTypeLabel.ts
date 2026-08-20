import type { QuestionType } from '@/api/types';

export function questionTypeLabel(type: QuestionType): string {
  switch (type) {
    case 'mcq':
      return 'Multiple choice';
    case 'multi':
      return 'Multiple response';
    case 'boolean':
      return 'True or false';
    case 'short':
      return 'Short answer';
    case 'ordering':
      return 'Ordering';
    case 'matching':
      return 'Matching';
    case 'open':
      return 'Open answer';
  }
}
