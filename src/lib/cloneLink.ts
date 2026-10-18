import { m } from '@/i18n';

/** Public pages' Clone opens the dashboard with `?clone=<kind>:<token>`,
 * the page's share token (`{id}.{signature}`), which the dashboard presents
 * once before reading the item (shareRedeem.ts); its sign-in check brings
 * signed-out visitors back to it. */
export const CLONE_KINDS = ['workspace', 'quiz', 'flashcards', 'note'] as const;
export type CloneKind = (typeof CLONE_KINDS)[number];
const TOKEN = /^([A-Za-z0-9_-]{1,64})\.[A-Za-z0-9_-]{16}$/;
export interface CloneTarget {
  id: string;
  kind: CloneKind;
  token: string;
}

const LABELS = {
  flashcards: m.action_clone_flashcards,
  note: m.action_clone_note,
  quiz: m.action_clone_quiz,
  workspace: m.action_clone_workspace,
} satisfies Record<CloneKind, unknown>;

/** "Clone quiz" and the like, for the ⋮ item and the dashboard's dialog. */
export const cloneLabel = (kind: CloneKind) => LABELS[kind]();

export const cloneHref = (kind: CloneKind, token: string) =>
  `/?${new URLSearchParams({ clone: `${kind}:${token}` })}`;

export function parseCloneTarget(value: unknown): CloneTarget | null {
  if (typeof value !== 'string') return null;
  const [kind, token, ...rest] = value.split(':');
  const id = token?.match(TOKEN)?.[1];
  if (rest.length || !token || !id) return null;
  return CLONE_KINDS.includes(kind as CloneKind)
    ? { id, kind: kind as CloneKind, token }
    : null;
}
