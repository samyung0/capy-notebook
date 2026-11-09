import type { ReactNode } from 'react';
import { Icon } from '@/components/ui/Icon';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** New assignment's Advanced (Epo 2026-11-04): the app's accordion recipe, whose
 * panel stays mounted so it animates both ways and is inert while closed. */
export function AdvancedSection({
  children,
  onToggle,
  open,
}: {
  children: ReactNode;
  onToggle: () => void;
  open: boolean;
}) {
  return (
    <div>
      <button
        aria-expanded={open}
        className="-mx-2 flex min-h-8 items-center gap-1.5 rounded-button px-2 font-medium hover:bg-surface-hover-bg"
        onClick={onToggle}
        type="button"
      >
        <Icon
          className={cn(
            'motion-accordion-chevron shrink-0 text-fg-muted',
            !open && '-rotate-90'
          )}
          name="chevronDown"
          size={16}
        />
        {m.assignment_advanced()}
      </button>
      <div
        className="motion-accordion"
        data-open={open}
        inert={!open}
        // It opens at the dialog's foot, which on a phone is below the fold.
        onTransitionEnd={(event) => {
          if (open && event.propertyName === 'grid-template-rows')
            event.currentTarget.scrollIntoView({
              behavior: 'smooth',
              block: 'nearest',
            });
        }}
      >
        {/* The child clips, so it keeps room for the controls' focus rings; the
            rows pad inside it, since padding can't collapse. */}
        <div className="-mx-1 px-1">
          <div className="flex flex-col gap-2 pt-1.5 pb-0.5">{children}</div>
        </div>
      </div>
    </div>
  );
}
