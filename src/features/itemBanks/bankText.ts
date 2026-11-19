import type { ItemBank } from '@/api/types';
import { answerLabels } from '@/features/questions/editorFields';
import type { Question } from '@/features/questions/types';
import { m } from '@/i18n';

/** "My bank", or a class's "Biology 101 bank". */
export const bankName = (bank: ItemBank) =>
  bank.kind === 'personal'
    ? m.bank_my_bank()
    : m.bank_workspace_bank({ name: bank.name });

/** Its parts' answer types, each once, in order. */
export const questionTypes = (question: Question) =>
  [...new Set(question.parts.map((part) => part.answer.type))]
    .map((type) => answerLabels[type]())
    .join(', ');
