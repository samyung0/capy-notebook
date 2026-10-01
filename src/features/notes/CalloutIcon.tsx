import { EditorIcon } from './EditorIcon';
import { CALLOUT_ICON, type CalloutVariant } from './richBlockConfig';

export function CalloutIcon({ variant }: { variant: CalloutVariant }) {
  return (
    <span
      // Center on the first paragraph line, including its 6px top padding.
      className="mt-[calc((1lh-1.25rem)/2+0.375rem)] size-5 shrink-0 -translate-y-px"
      contentEditable={false}
      data-callout-icon
    >
      <EditorIcon className="size-5" name={CALLOUT_ICON[variant]} />
    </span>
  );
}
