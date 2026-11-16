import * as Y from 'yjs';
import { applyTextChange } from '@/features/collaboration/yText';
import type { YMap } from '@/features/figures/yMaps';

/* A quiz's live documents' roots and text helpers (liveQuiz.ts); the map
 * helpers are shared with note figures (figures/yMaps.ts). */

export {
  alignAxis,
  child,
  type Entry,
  keysBetween,
  mapAt,
  ordered,
  orderedKeys,
  plain,
  reorder,
  risingOrders,
  samePlain,
  setPlain,
  type YMap,
} from '@/features/figures/yMaps';

export const QUESTIONS_ROOT = 'questions';
export const KEYS_ROOT = 'keys';

export function text(map: YMap | undefined, key: string): string {
  const value = map?.get(key);
  return value instanceof Y.Text ? value.toString() : '';
}

export function setText(map: YMap, key: string, value: string) {
  const current = map.get(key);
  if (current instanceof Y.Text) applyTextChange(current, value, null);
  else map.set(key, new Y.Text(value));
}
