import type { MenuItem } from '@/components/ui/Menu';
import { m } from '@/i18n';
import type { AddSourceMode } from './AddSourceDialog';

export function addSourceMenuItems(
  onAddSource: (mode: AddSourceMode) => void,
  onAddChapter?: () => void
): MenuItem[] {
  return [
    {
      icon: 'upload',
      label: m.action_upload_or_import(),
      onClick: () => onAddSource('upload'),
    },
    {
      icon: 'newFile',
      label: m.action_new_file(),
      onClick: () => onAddSource('create'),
    },
    ...(onAddChapter
      ? [
          {
            icon: 'archive' as const,
            label: m.action_add_chapter(),
            onClick: onAddChapter,
          },
        ]
      : []),
  ];
}
