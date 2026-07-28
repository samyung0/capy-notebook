import { Drawer, DrawerContent, DrawerTrigger } from "@/components/ui/Drawer";
import { cn } from "@/lib/cn";
import {
  STYLES,
  type Style,
  THEMES,
  type Theme,
  useTheme,
} from "@/theme/ThemeProvider";
import { useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Card, InputTitle } from "../ui";
import { ButtonCard } from "../ui/ButtonCard";

const ThemeChooser = ({
  selected,
  onChange,
  supportedThemes,
}: {
  selected: Theme;
  onChange: (color: Theme) => void;
  supportedThemes: Theme[];
}) => {
  return (
    <div className="flex flex-wrap gap-3.5">
      {supportedThemes.map((c) => {
        const isSelected = selected === c;
        return (
          <button
            aria-label={c}
            aria-pressed={isSelected}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full hover:scale-105 transition-transform",
              isSelected &&
                "ring-2 ring-action ring-offset-2 ring-offset-surface",
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
};

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
}) => {
  return (
    <div
      className={cn(
        "p-1 rounded-md grid border border-line grid-cols-2 grid-rows-2 gap-0.5 shadow-sm",
        outerClassname,
      )}
      style={{ background }}
    >
      <div
        className={cn("size-1.5 rounded-full", innerClassname)}
        style={{ background: colorOne }}
      />
      <div
        className={cn("size-1.5 rounded-full", innerClassname)}
        style={{ background: colorTwo }}
      />
      <div
        className={cn("size-1.5 rounded-full", innerClassname)}
        style={{ background: colorThree }}
      />
      <div
        className={cn("size-1.5 rounded-full", innerClassname)}
        style={{ background: colorFour }}
      />
    </div>
  );
};

const StyleComponents = ({
  label,
  value,
  className,
  ...rest
}: React.ComponentProps<"button"> & { value: Style; label: string }) => {
  switch (value) {
    case "classroom":
      return (
        <ButtonCard
          size="md"
          componentBeforeText={
            <FourColorIcon
              background="#f4f6f5"
              colorOne="#8c7bd9"
              colorTwo="#7bd9ab"
              colorThree="#fd7287"
              colorFour="#8ec9f9"
            />
          }
          className={cn("min-w-20", className)}
          {...rest}
          buttonText={label}
        />
      );
    case "notion":
      return (
        <ButtonCard
          size="md"
          componentBeforeText={
            <FourColorIcon
              background="#f4f6f5"
              colorOne="#8c7bd9"
              colorTwo="#7bd9ab"
              colorThree="#fd7287"
              colorFour="#8ec9f9"
            />
          }
          className={cn("min-w-20", className)}
          {...rest}
          buttonText={label}
        />
      );
  }
};

export function ThemeSwitchDrawer({
  className,
  trigger,
  open: openProp,
  onOpenChange,
}: {
  className?: string;
  /** Optional trigger — omit when opening from outside (e.g. a menu item). */
  trigger?: React.ComponentProps<typeof DrawerTrigger>["render"];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = onOpenChange ?? setUncontrolledOpen;
  const { theme, style, setTheme, setStyle } = useTheme();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);

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
            "flex shadow-none h-full min-w-62 shrink-0 items-stretch gap-0 overflow-y-auto bg-surface px-4 py-7.5",
            className,
          )}
          radius="card-xl"
          theme="gray"
        >
          <aside>
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-5">
                <p className="t-card-title">Theme</p>
                <div className="flex flex-col gap-3">
                  <InputTitle>Style</InputTitle>
                  <div className="w-full grid grid-cols-3 gap-3">
                    {STYLES.map((o) => (
                      <StyleComponents
                        key={o.value}
                        value={o.value}
                        label={o.label}
                        onClick={() => setStyle(o.value)}
                      />
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-3">
                  <InputTitle>Theme</InputTitle>
                  <div className="w-full grid grid-cols-3 gap-3">
                    <ThemeChooser
                      selected={theme}
                      onChange={setTheme}
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
