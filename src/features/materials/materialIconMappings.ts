import type { MaterialKind } from '@/api/types';
import type { IconName } from '@/components/ui';
import type { MaterialMode } from './modePolicy';

export function materialIcon(kind: MaterialKind): IconName {
  switch (kind) {
    case 'diagram':
      return 'diagram';
    case 'quiz':
      return 'quiz';
    case 'flashcards':
      return 'flashcards';
    case 'note':
      return 'write';
    default:
      return 'workspaces';
  }
}

export const MATERIALMODE_ICON: Record<MaterialMode, IconName> = {
  comment: 'message',
  edit: 'write',
  view: 'view',
};

export const MATERIALMODE_LABEL: Record<MaterialMode, string> = {
  comment: 'Comment',
  edit: 'Edit',
  view: 'View',
};
