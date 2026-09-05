import { useState } from 'react';
import { Drawer, DrawerContent, DrawerTrigger } from '@/components/ui/Drawer';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import {
  STYLES,
  type Style,
  THEMES,
  type Theme,
  useTheme,
} from '@/theme/ThemeProvider';
import { ButtonCard } from '../ui/ButtonCard';
import { Card } from '../ui/Card';
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
  <div className="flex flex-wrap gap-3.5">
    {supportedThemes.map((c) => {
      const isSelected = selected === c;
      return (
        <button
          aria-label={c}
          aria-pressed={isSelected}
          className={cn(
            'flex h-8 w-8 items-center justify-center rounded-full transition-transform hover:scale-105',
            isSelected && 'ring-2 ring-action ring-offset-2 ring-offset-surface'
          )}
          key={c}
          onClick={() => onChange(c)}
          style={{
            background: THEMES.find((t) => t.value === c)!.displayColor,
          }}
          type="button"
        />
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
          componentBeforeText={
            <FourColorIcon
              background="#f4f6f5"
              colorFour="#8ec9f9"
              colorOne="#8c7bd9"
              colorThree="#fd7287"
              colorTwo="#7bd9ab"
            />
          }
          size="md"
          {...rest}
          buttonText={label}
        />
      );
    case 'notion':
      return (
        <ButtonCard
          className={cn('min-w-20', className)}
          componentBeforeText={
            <FourColorIcon
              background="#f4f6f5"
              colorFour="#8ec9f9"
              colorOne="#8c7bd9"
              colorThree="#fd7287"
              colorTwo="#7bd9ab"
            />
          }
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
            'flex h-full min-w-62 shrink-0 items-stretch gap-0 overflow-y-auto bg-surface px-4 py-7.5 shadow-none',
            className
          )}
          radius="card-xl"
          theme="surface-dark"
        >
          <aside>
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-5">
                <p className="t-card-title">{m.settings_theme()}</p>
                <div className="flex flex-col gap-3">
                  <InputTitle>{m.common_style()}</InputTitle>
                  <div className="grid w-full grid-cols-3 gap-3">
                    {STYLES.map((o) => (
                      <StyleComponents
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
                  <div className="grid w-full grid-cols-3 gap-3">
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
