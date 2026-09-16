import type { IconName } from '@/components/ui/Icon';
import type { MaterialMode } from './modePolicy';

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
