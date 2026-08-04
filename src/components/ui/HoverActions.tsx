import { cn } from '@/lib/cn';
import { Menu, type MenuItem } from './Menu';

export interface HoverActionsProps {
  align?: 'start' | 'center' | 'end';
  /** Extra classes for the reveal wrapper. */
  className?: string;
  iconContainerClassName?: string;
  items: MenuItem[];
  radialBackground?: boolean;
}

/**
 * Action menu that stays hidden until the nearest `group` ancestor is hovered
 * (or something inside receives focus). Lifted from the dashboard task row so
 * the reveal behaviour is shared.
 */
export function HoverActions({
  items,
  align = 'end',
  iconContainerClassName,
  className,
  radialBackground = true,
}: HoverActionsProps) {
  return (
    <div
      className={cn(
        'opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100',
        // keep the trigger visible while its popover/menu is open
        'has-data-[state=open]:opacity-100',
        radialBackground &&
          'bg-radial from-40% from-surface to-transparent group-hover:from-surface-hover-bg',
        className
      )}
    >
      <Menu
        align={align}
        iconContainerClassName={cn(
          'p-1.5 active:scale-[0.8]',
          radialBackground &&
            'translate-x-0.5 -translate-y-0.5 p-2.5 hover:bg-transparent',
          iconContainerClassName
        )}
        items={items}
      />
    </div>
  );
}
