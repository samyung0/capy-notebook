import { EditorIcon } from './EditorIcon';
import type { CalloutVariant } from './richBlockConfig';

const icons = {
  danger: 'circleX',
  info: 'info',
  success: 'circleCheck',
  warning: 'error',
} as const;

export function CalloutIcon({ variant }: { variant: CalloutVariant }) {
  return (
    <span
      // Center on the first paragraph line, including its 4px top padding.
      className="mt-[calc((1lh-1.25rem)/2+0.25rem)] size-5 shrink-0 -translate-y-px"
      contentEditable={false}
      data-callout-icon
    >
      <EditorIcon className="size-5" name={icons[variant]} />
    </span>
  );
}
