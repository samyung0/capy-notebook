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
  return (
    <Toggle.Root
      asChild
      onPressedChange={(pressed) => onChange(pressed ? 'edit' : 'view')}
      pressed={mode === 'edit'}
    >
      <ToolbarButton
        aria-label={m.material_mode()}
        label={
          mode === 'edit' ? m.material_mode_edit() : m.material_mode_view()
        }
      >
        <Icon name={MATERIALMODE_ICON[mode]} />
      </ToolbarButton>
    </Toggle.Root>
  );
}
