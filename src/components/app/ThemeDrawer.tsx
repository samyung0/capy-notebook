import { useState } from 'react';
import { useMediaQuery } from 'usehooks-ts';
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTrigger,
} from '@/components/ui/Drawer';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  STYLES,
  type Style,
  THEMES,
  type Theme,
  themeSwatch,
  useTheme,
} from '@/theme/theme';
import { Card } from '../ui/Card';
import { IconButton } from '../ui/IconButton';
import { InputTitle } from '../ui/Input';
import { PageFrameSection } from './PageFrameSection';

const ThemeChooser = ({
  style,
  selected,
  onChange,
  supportedThemes,
}: {
  style: Style;
  selected: Theme;
  onChange: (color: Theme) => void;
  supportedThemes: Theme[];
}) => (
  <div className="flex w-full -translate-x-1 flex-wrap gap-0.5">
    {supportedThemes.map((c) => {
      const t = THEMES.find((t) => t.value === c)!;
      const isSelected = selected === c;
      return (
        <button
          aria-label={t.label}
          aria-pressed={isSelected}
          className="group flex w-16 flex-col items-center gap-1.5 rounded-button px-3 py-2 transition-colors ease-(--motion-ease-smooth-out) hover:bg-surface-hover-bg focus-visible:bg-surface-hover-bg focus-visible:outline-none"
          key={c}
          onClick={() => onChange(c)}
          type="button"
        >
          <span
            className={cn(
              'block size-8 rounded-full border border-line-strong transition-transform ease-(--motion-ease-smooth-out) group-hover:scale-105',
              isSelected &&
                'ring-2 ring-action ring-offset-2 ring-offset-surface'
            )}
            style={{ background: themeSwatch(style, c) }}
          />
          <span
            className={cn(
              't-muted font-medium',
              isSelected ? 'text-fg' : 'text-fg-muted'
            )}
          >
            {t.label}
          </span>
        </button>
      );
    })}
  </div>
);

/** Each drawer style's corner at its own radii (not the active style's
 * tokens): a panel's top-left corner holding a button. */
const STYLE_CORNERS: { style: Style; panel: string; button: string }[] = [
  { button: 'rounded-[3px]', panel: 'rounded-tl-[6px]', style: 'capy' },
  { button: 'rounded-full', panel: 'rounded-tl-[16px]', style: 'fisheye' },
];

const StyleChooser = ({
  selected,
  onChange,
}: {
  selected: Style;
  onChange: (style: Style) => void;
}) => (
  <div className="flex w-full -translate-x-1 flex-wrap gap-0.5">
    {STYLE_CORNERS.map(({ style, panel, button }) => {
      const isSelected = selected === style;
      return (
        <button
          aria-pressed={isSelected}
          className="group flex w-22 flex-col items-center gap-1.5 rounded-button px-3 py-2 transition-colors ease-(--motion-ease-smooth-out) hover:bg-surface-hover-bg focus-visible:bg-surface-hover-bg focus-visible:outline-none"
          key={style}
          onClick={() => onChange(style)}
          type="button"
        >
          <span
            aria-hidden
            className={cn(
              'relative block h-11 w-16 overflow-hidden rounded-md border border-line-strong bg-page transition-transform ease-(--motion-ease-smooth-out) group-hover:scale-105',
              isSelected &&
                'ring-2 ring-action ring-offset-2 ring-offset-surface'
            )}
          >
            <span
              className={cn(
                'absolute top-2.5 left-2.5 size-full border-fg-muted border-t-2 border-l-2 bg-surface',
                panel
              )}
            />
            <span
              className={cn(
                'absolute top-6 left-5.5 h-2.5 w-8 bg-fg-muted',
                button
              )}
            />
          </span>
          <span
            className={cn(
              't-muted font-medium',
              isSelected ? 'text-fg' : 'text-fg-muted'
            )}
          >
            {STYLE_LABELS[style]()}
          </span>
        </button>
      );
    })}
  </div>
);

const FourColorIcon = ({
  background,
  colorOne,
  colorTwo,
  colorThree,
  colorFour,
  outerClassname,
  innerClassname,
}: {
  background: string;
  colorOne: string;
  colorTwo: string;
  colorThree: string;
  colorFour: string;
  outerClassname?: string;
  innerClassname?: string;
}) => (
  <div
    className={cn(
      'grid grid-cols-2 grid-rows-2 gap-0.5 rounded-md border border-line p-1 shadow-sm',
      outerClassname
    )}
    style={{ background }}
  >
    <div
      className={cn('size-1.5 rounded-full', innerClassname)}
      style={{ background: colorOne }}
    />
    <div
      className={cn('size-1.5 rounded-full', innerClassname)}
      style={{ background: colorTwo }}
    />
    <div
      className={cn('size-1.5 rounded-full', innerClassname)}
      style={{ background: colorThree }}
    />
    <div
      className={cn('size-1.5 rounded-full', innerClassname)}
      style={{ background: colorFour }}
    />
  </div>
);

/** Each style's name, in the drawer and in Settings. */
export const STYLE_LABELS: Record<Style, () => string> = {
  capy: m.theme_style_capy,
  fisheye: m.theme_style_fisheye,
  notion: m.theme_style_notion,
};

/** The four-dot swatch that stands for a style, in the drawer and in Settings. */
export const StyleIcon = ({
  style,
  className,
  dotClassName,
}: {
  style: Style;
  className?: string;
  dotClassName?: string;
}) =>
  style === 'capy' || style === 'fisheye' ? (
    // Same colours; capy's square-ish dots echo its smaller radii.
    <FourColorIcon
      background="var(--surface-page)"
      colorFour="#8ec9f9"
      colorOne="#8c7bd9"
      colorThree="#fd7287"
      colorTwo="#7bd9ab"
      innerClassname={cn(style === 'capy' && 'rounded-[2px]', dotClassName)}
      outerClassname={className}
    />
  ) : (
    <FourColorIcon
      background="var(--surface-page)"
      colorFour="#2383e2"
      colorOne="#37352f"
      colorThree="#9b9a97"
      colorTwo="#d4d4d2"
      innerClassname={cn('rounded-[2px]', dotClassName)}
      outerClassname={className}
    />
  );

export function ThemeDrawer({
  className,
  trigger,
  open: openProp,
  onOpenChange,
}: {
  className?: string;
  /** Optional trigger — omit when opening from outside (e.g. a menu item). */
  trigger?: React.ComponentProps<typeof DrawerTrigger>['render'];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const { theme, style, setStyle, setTheme } = useTheme();
  // Phones get a full-screen sheet laid out like a phone dialog (close on the
  // left of the title); wider screens slide it in from the right.
  const phone = useMediaQuery('(max-width: 639px)');
  const close = (
    <DrawerClose
      render={
        <IconButton
          className={cn(phone && 'shrink-0 -translate-y-px')}
          icon="x"
          label={m.action_close()}
          size="sm"
          variant="ghost-hover"
        />
      }
    />
  );

  return (
    <Drawer
      modal={false}
      onOpenChange={setOpen}
      open={open}
      showSwipeHandle={!phone}
      swipeDirection={phone ? 'down' : 'right'}
    >
      {trigger != null && <DrawerTrigger render={trigger} />}
      <DrawerContent className="shadow-2xl max-sm:m-0 max-sm:h-dvh max-sm:max-h-none max-sm:rounded-none">
        <Card
          asChild
          className={cn(
            'relative flex min-h-0 min-w-62 flex-1 shrink-0 items-stretch gap-0 overflow-y-auto bg-surface px-2 py-5 shadow-none [scrollbar-width:none] max-sm:rounded-none max-sm:px-0 max-sm:pt-0 [&::-webkit-scrollbar]:hidden',
            className
          )}
          radius="card-xl"
          theme="surface-dark"
        >
          <aside>
            {phone ? (
              // The phone dialog's header row (DialogTitle in ui/Dialog.tsx).
              <div className="sticky top-0 z-20 flex min-h-14 shrink-0 items-start gap-1 bg-surface pt-3 pr-4 pb-1 pl-1.5">
                {close}
                <h2 className="t-large-card-title min-w-0 flex-1 py-2 text-lg leading-tight">
                  {m.settings_theme()}
                </h2>
              </div>
            ) : (
              // The dialog title's style on wider screens (DialogTitle).
              <div className="flex items-center gap-1 pr-2 pl-4">
                <h2 className="t-large-card-title mr-auto min-w-0 truncate">
                  {m.settings_theme()}
                </h2>
                {close}
              </div>
            )}
            <div className="mt-8 flex flex-col gap-6 px-4 max-sm:mt-2">
              <div className="flex flex-col gap-6">
                {/* Notion stays out of the drawer until it is finished;
                    Settings still lists it. */}
                <div className="flex flex-col gap-3">
                  <InputTitle>{m.settings_theme()}</InputTitle>
                  <StyleChooser onChange={setStyle} selected={style} />
                </div>
                <div className="flex flex-col gap-3">
                  <InputTitle>{m.settings_mode()}</InputTitle>
                  <div className="flex w-full">
                    <ThemeChooser
                      onChange={setTheme}
                      selected={theme}
                      style={style}
                      supportedThemes={
                        STYLES.find((s) => s.value === style)
                          ?.supportedThemes || []
                      }
                    />
                  </div>
                </div>
                <PageFrameSection />
              </div>
            </div>
          </aside>
        </Card>
      </DrawerContent>
    </Drawer>
  );
}
