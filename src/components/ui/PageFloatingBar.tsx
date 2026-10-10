import { cn } from '@/lib/cn';
import { FloatingToolbar } from './BlockToolbar';
import { Icon, type IconName } from './Icon';
import { ToolbarButton } from './ToolbarButton';

/**
 * A page's bottom floating bar (workspace tools, bank navigation), shown when
 * the side panel is hidden; `open` hides it while that panel's sheet is up.
 * `className` sets when it shows, e.g. `lg:hidden`.
 */
export function PageFloatingBar({
  open,
  className,
  children,
  'aria-label': label,
}: {
  open: boolean;
  className?: string;
  children: React.ReactNode;
  'aria-label': string;
}) {
  return (
    <FloatingToolbar
      aria-label={label}
      className="min-w-40 justify-center gap-0.5 rounded-full! px-1.5 py-0.5 sm:gap-0 sm:px-2 sm:py-1"
      open={open}
      positionClassName={cn(
        'absolute bottom-4 left-1/2 z-10 -translate-x-1/2',
        className
      )}
    >
      {children}
    </FloatingToolbar>
  );
}

/**
 * A PageFloatingBar button. The label stays visible at every width, small under
 * the icon on phones and beside it from `sm`, so it reads the same to sighted
 * and screen reader users.
 */
export function PageFloatingBarButton({
  icon,
  text,
  ...rest
}: Omit<React.ComponentProps<typeof ToolbarButton>, 'children'> & {
  icon: IconName;
  /** The visible label; defaults to `label`. */
  text?: string;
}) {
  return (
    <ToolbarButton
      className="h-11 w-auto min-w-13 flex-col gap-1 rounded-card-xl px-2 text-[0.6875rem] leading-none sm:h-10 sm:min-w-0 sm:flex-row sm:gap-2 sm:px-3 sm:text-[1em] sm:leading-normal [&_svg]:size-4.5 sm:[&_svg]:size-5"
      tooltipSide="top"
      {...rest}
    >
      <Icon name={icon} />
      <span className="whitespace-nowrap">{text ?? rest.label}</span>
    </ToolbarButton>
  );
}
