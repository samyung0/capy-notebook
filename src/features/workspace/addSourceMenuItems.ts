import type { MenuItem } from '@/components/ui/Menu';
import { m } from '@/i18n';
import type { AddSourceMode } from './AddSourceDialog';

export function addSourceMenuItems(
  onAddSource: (mode: AddSourceMode) => void,
  onAddTopic?: () => void
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
    // TODO: refine with agentic harness. AI generate is hidden until then.
    ...(onAddTopic
      ? [
          {
            icon: 'topic' as const,
            label: m.action_add_topic(),
            onClick: onAddTopic,
          },
        ]
      : []),
  ];
}
