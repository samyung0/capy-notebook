import { m } from '@/i18n';

/** Public pages' Clone opens the dashboard with `?clone=<kind>:<id>`; the
 * dashboard's sign-in check brings signed-out visitors back to it. */
export const CLONE_KINDS = ['workspace', 'quiz', 'flashcards', 'note'] as const;
export type CloneKind = (typeof CLONE_KINDS)[number];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export interface CloneTarget {
  id: string;
  kind: CloneKind;
}

const LABELS = {
  flashcards: m.action_clone_flashcards,
  note: m.action_clone_note,
  quiz: m.action_clone_quiz,
  workspace: m.action_clone_workspace,
} satisfies Record<CloneKind, unknown>;

/** "Clone quiz" and the like, for the ⋮ item and the dashboard's dialog. */
export const cloneLabel = (kind: CloneKind, locale?: 'en' | 'zh') =>
  LABELS[kind]({}, { locale });

export const cloneHref = (kind: CloneKind, id: string) =>
  `/?${new URLSearchParams({ clone: `${kind}:${id}` })}`;

export function parseCloneTarget(value: unknown): CloneTarget | null {
  if (typeof value !== 'string') return null;
  const [kind, id, ...rest] = value.split(':');
  if (rest.length || !id || !ID.test(id)) return null;
  return CLONE_KINDS.includes(kind as CloneKind)
    ? { id, kind: kind as CloneKind }
    : null;
}
