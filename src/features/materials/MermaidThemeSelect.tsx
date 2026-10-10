import { Popover, PopoverClose, PopoverTrigger } from '@/components/ui/Popover';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import {
  ToolbarPopoverContent,
  ToolbarPopoverItem,
} from '@/components/ui/ToolbarPopover';
import { m } from '@/i18n';
import { MermaidSwatch } from './Mermaid';
import {
  MERMAID_THEME_LABEL,
  MERMAID_THEMES,
  type MermaidTheme,
} from './mermaidThemes';

/** The standalone diagram editor's theme dropdown: the note block toolbar's
 * menu without Plate (its swatch, then the name from `sm` up). */
export function MermaidThemeSelect({
  theme,
  onTheme,
}: {
  theme: MermaidTheme;
  onTheme: (theme: MermaidTheme) => void;
}) {
  return (
    <Popover modal={false}>
      <PopoverTrigger asChild>
        <ToolbarButton
          className="w-auto! px-1.5 text-sm"
          dropdown
          label={m.mermaid_theme()}
          tooltipSide="top"
        >
          <MermaidSwatch theme={theme} />
          <span className="hidden translate-y-px pl-1 sm:inline">
            {MERMAID_THEME_LABEL[theme]()}
          </span>
        </ToolbarButton>
      </PopoverTrigger>
      <ToolbarPopoverContent align="start" className="w-46">
        {MERMAID_THEMES.map((option) => (
          <PopoverClose asChild key={option}>
            <ToolbarPopoverItem
              icon={<MermaidSwatch theme={option} />}
              label={MERMAID_THEME_LABEL[option]()}
              onClick={() => onTheme(option)}
              selected={option === theme}
            />
          </PopoverClose>
        ))}
      </ToolbarPopoverContent>
    </Popover>
  );
}
