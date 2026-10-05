import { useState } from 'react';
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
  useTheme,
} from '@/theme/theme';
import { ButtonCard } from '../ui/ButtonCard';
import { Card } from '../ui/Card';
import { IconButton } from '../ui/IconButton';
import { InputTitle } from '../ui/Input';

const ThemeChooser = ({
  selected,
  onChange,
  supportedThemes,
}: {
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
          className="group flex w-16 flex-col items-center gap-1.5 rounded-button px-3 py-2 transition-colors ease-(--motion-ease-smooth-out) hover:bg-surface-hover-bg"
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
            style={{ background: t.displayColor }}
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
  style === 'classroom' ? (
    <FourColorIcon
      background="var(--surface-page)"
      colorFour="#8ec9f9"
      colorOne="#8c7bd9"
      colorThree="#fd7287"
      colorTwo="#7bd9ab"
      innerClassname={dotClassName}
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

const StyleComponents = ({
  label,
  value,
  className,
  ...rest
}: React.ComponentProps<'button'> & { value: Style; label: string }) => {
  switch (value) {
    case 'classroom':
      return (
        <ButtonCard
          className={cn('min-w-20', className)}
          componentBeforeText={<StyleIcon style="classroom" />}
          size="md"
          {...rest}
          buttonText={label}
        />
      );
    case 'notion':
      return (
        <ButtonCard
          className={cn('min-w-20', className)}
          componentBeforeText={<StyleIcon style="notion" />}
          size="md"
          {...rest}
          buttonText={label}
        />
      );
  }
};

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
  const { theme, style, setTheme, setStyle } = useTheme();

  return (
    <Drawer
      modal={false}
      onOpenChange={setOpen}
      open={open}
      showSwipeHandle
      swipeDirection="right"
    >
      {trigger != null && <DrawerTrigger render={trigger} />}
      <DrawerContent className="shadow-2xl">
        <Card
          asChild
          className={cn(
            'relative flex h-full min-w-62 shrink-0 items-stretch gap-0 overflow-y-auto bg-surface px-4 py-7.5 shadow-none',
            className
          )}
          radius="card-xl"
          theme="surface-dark"
        >
          <aside>
            <DrawerClose
              render={
                <IconButton
                  className="absolute top-5 right-4 z-10"
                  icon="x"
                  label={m.action_close()}
                  size="md"
                  variant="ghost-hover"
                />
              }
            />
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-8">
                <p className="t-card-title">{m.settings_theme()}</p>
                <div className="flex flex-col gap-3">
                  <InputTitle>{m.common_style()}</InputTitle>
                  <div className="grid w-full grid-cols-2 gap-3">
                    {STYLES.map((o) => (
                      <StyleComponents
                        aria-pressed={style === o.value}
                        key={o.value}
                        label={
                          o.value === 'classroom'
                            ? m.theme_style_classroom()
                            : m.theme_style_notion()
                        }
                        onClick={() => setStyle(o.value)}
                        value={o.value}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-3">
                  <InputTitle>{m.settings_theme()}</InputTitle>
                  <div className="flex w-full">
                    <ThemeChooser
                      onChange={setTheme}
                      selected={theme}
                      supportedThemes={
                        STYLES.find((s) => s.value === style)
                          ?.supportedThemes || []
                      }
                    />
                  </div>
                </div>
              </div>
            </div>
          </aside>
        </Card>
      </DrawerContent>
    </Drawer>
  );
}
