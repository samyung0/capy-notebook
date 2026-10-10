import { m } from '@/i18n';

export function questionCountLabel(count: number): string {
  return count === 1
    ? m.material_ref_questions_one()
    : m.material_ref_questions({ count });
}

export function cardCountLabel(count: number): string {
  return count === 1
    ? m.material_ref_cards_one()
    : m.material_ref_cards({ count });
}
