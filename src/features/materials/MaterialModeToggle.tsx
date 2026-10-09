import { Toggle } from 'radix-ui';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { MATERIALMODE_ICON } from './materialIconMappings';
import type { MaterialMode } from './modePolicy';

export function MaterialModeToggle({
  mode,
  onChange,
}: {
  mode: MaterialMode;
  onChange: (mode: MaterialMode) => void;
}) {
  // The button names the mode it switches to; pressed still means editing.
  const next: MaterialMode = mode === 'edit' ? 'view' : 'edit';
  const label =
    next === 'edit' ? m.material_mode_edit() : m.material_mode_view();
  return (
    <Toggle.Root
      asChild
      onPressedChange={(pressed) => onChange(pressed ? 'edit' : 'view')}
      pressed={mode === 'edit'}
    >
      <ToolbarButton
        aria-label={m.material_mode()}
        className="lg:w-auto lg:gap-1.5 lg:px-2"
        label={label}
      >
        <Icon className="lg:-translate-y-px" name={MATERIALMODE_ICON[next]} />
        {/* Phones and tablets keep the icon only: the header has no room. */}
        <span className="hidden lg:inline">{label}</span>
      </ToolbarButton>
    </Toggle.Root>
  );
}
