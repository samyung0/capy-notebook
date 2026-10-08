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
  const label =
    mode === 'edit' ? m.material_mode_edit() : m.material_mode_view();
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
        <Icon className="lg:-translate-y-px" name={MATERIALMODE_ICON[mode]} />
        {/* Phones and tablets keep the icon only: the header has no room. */}
        <span className="hidden lg:inline">{label}</span>
      </ToolbarButton>
    </Toggle.Root>
  );
}
