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

/** An ordering question's length, shown instead of its items. */
export function orderItemsLabel(count: number): string {
  return count === 1
    ? m.material_preview_items_one()
    : m.material_preview_items({ count });
}
