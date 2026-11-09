import { Icon } from '@/components/ui/Icon';
import { ButtonTooltip } from '@/components/ui/Tooltip';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

/** The eye mark on a row of an item hidden from members (boards T3 and U1):
 * only the workspace's owners and editors ever get such a row. */
export function HiddenMark({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-flex shrink-0 text-fg-muted', className)}
      title={m.content_hidden_from_members()}
    >
      <Icon aria-hidden name="viewOffSlash" size={14} />
      <span className="sr-only">{m.content_hidden_from_members()}</span>
    </span>
  );
}

/** "Hidden from members" after an item's name (X2, Epo 2026-11-03): an item
 * only the workspace's owners and editors see. With onShow (an owner or
 * editor who may change it) the chip is a button that shows the item to
 * members, as the ⋮ menu's Unhide file does. Phones keep the icon alone. */
export function HiddenChip({ onShow }: { onShow?: () => void }) {
  if (!onShow)
    return (
      <span
        className="inline-flex h-5.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-page-hover px-1.75 font-semibold text-[12.5px] text-fg-muted"
        title={m.content_hidden_from_members()}
      >
        <Icon name="viewOffSlash" size={16} />
        <span className="sr-only sm:not-sr-only">
          {m.content_hidden_from_members()}
        </span>
      </span>
    );
  return (
    <ButtonTooltip label={m.content_unhide_file()} side="bottom">
      <button
        className="inline-flex h-5.5 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md bg-page-hover px-1.75 font-semibold text-[12.5px] text-fg-muted outline-none transition duration-150 ease-out hover:bg-surface-dark-hover-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-action active:scale-[0.96]"
        data-testid="hidden-chip"
        onClick={onShow}
        type="button"
      >
        <Icon name="viewOffSlash" size={16} />
        <span className="sr-only sm:not-sr-only">
          {m.content_hidden_from_members()}
        </span>
        {/* The action, for screen readers; sighted users get the tooltip. */}
        <span className="sr-only">{m.content_unhide_file()}</span>
      </button>
    </ButtonTooltip>
  );
}

/** Where the chip sits on an item members can see (Epo 2026-11-06). Small screens
 * leave it out for the name's room; the ⋮ menu's Hide file stays. */
export function HideFileButton({ onHide }: { onHide: () => void }) {
  return (
    <button
      className="hidden h-5.5 shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-md bg-page-hover px-1.75 font-semibold text-[12.5px] text-fg-muted outline-none transition duration-150 ease-out hover:bg-surface-dark-hover-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-action active:scale-[0.96] sm:inline-flex"
      data-testid="hide-file"
      onClick={onHide}
      type="button"
    >
      <Icon name="viewOffSlash" size={16} />
      {m.content_hide_file()}
    </button>
  );
}
