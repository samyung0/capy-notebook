import { Toggle } from 'radix-ui';
import { Icon } from '@/components/ui/Icon';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { MATERIALMODE_ICON } from './materialIconMappings';
import type { MaterialMode } from './modePolicy';

export function MaterialModeToggle({
  disabled,
  mode,
  onChange,
}: {
  disabled?: boolean;
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
      disabled={disabled}
      onPressedChange={(pressed) => onChange(pressed ? 'edit' : 'view')}
      pressed={mode === 'edit'}
    >
      <ToolbarButton
        aria-label={m.material_mode()}
        className="@2xl/header:w-auto @2xl/header:gap-1.5 @2xl/header:px-2 group-data-wide/header:w-auto group-data-wide/header:gap-1.5 group-data-wide/header:px-2"
        disabled={disabled}
        label={label}
      >
        <Icon
          className="@2xl/header:-translate-y-px group-data-wide/header:-translate-y-px"
          name={MATERIALMODE_ICON[next]}
        />
        {/* A narrow header keeps the icon only, measured on the header so a
            dragged panel drops the label too. */}
        <span className="@2xl/header:inline hidden group-data-wide/header:inline">
          {label}
        </span>
      </ToolbarButton>
    </Toggle.Root>
  );
}
