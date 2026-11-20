import type { ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import {
  Popover,
  PopoverAnchor,
  PopoverArrow,
  PopoverContent,
} from '@/components/ui/Popover';
import { ButtonTooltip } from '@/components/ui/Tooltip';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { isBoolean, PREF_KEYS, useLocalPref } from '@/lib/localPrefs';

/** The eye mark on a row of an item hidden from members (boards T3 and U1):
 * only the workspace's owners and editors ever get such a row. */
export function HiddenMark({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-flex shrink-0 text-fg-muted', className)}
      title={m.content_hidden()}
    >
      <Icon aria-hidden name="viewOffSlash" size={14} />
      <span className="sr-only">{m.content_hidden()}</span>
    </span>
  );
}

const CHIP =
  'inline-flex h-5.5 shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-page-hover px-1.75 font-semibold text-[12.5px] text-fg-muted';
// A chip under its callout is ringed in the callout's colour.
const TIP_RING =
  'text-fg ring-2 ring-action-accent-hover dark:ring-action-accent';

/** A chip's first-run callout (Epo 2026-11-20, the hidden quiz callout mock):
 * open until closed once on this browser (`flag`, a localStorage key). */
function useChipTip(flag: string, wanted: boolean) {
  const [seen, setSeen] = useLocalPref(flag, false, isBoolean);
  return { close: () => setSeen(true), open: wanted && !seen };
}

/** The callout under a chip (board A): the accent with an arrow, its title,
 * a line and Got it. It takes no focus and stays through clicks elsewhere;
 * Got it and Esc close it. The accent's deeper shade in light themes, where
 * white text on the plain accent falls short of 4.5:1; the accent in dark. */
function ChipTip({
  body,
  children,
  close,
  title,
}: {
  body: string;
  children: ReactNode;
  close: () => void;
  title: string;
}) {
  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) close();
      }}
      open
    >
      <PopoverAnchor asChild>
        <span className="inline-flex shrink-0">{children}</span>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        alignOffset={-14}
        aria-label={title}
        className="w-75 max-w-[calc(100vw-32px)] gap-1.5 rounded-xl border-0 bg-action-accent-hover px-4.5 pt-4 pb-3.5 text-action-accent-fg shadow-pop dark:bg-action-accent"
        collisionPadding={16}
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => event.preventDefault()}
        side="bottom"
        sideOffset={6}
      >
        <PopoverArrow
          className="fill-action-accent-hover dark:fill-action-accent"
          height={7}
          width={14}
        />
        <p className="font-bold text-base leading-5.5">{title}</p>
        <p className="text-sm leading-5">{body}</p>
        <div className="mt-2 flex justify-end">
          <Button
            className="bg-action-accent-fg text-action-accent-hover hover:bg-action-accent-fg/90 dark:text-action-accent"
            onClick={close}
            size="sm"
            variant="ghost"
          >
            {m.action_got_it()}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** "Hidden" after an item's name (X2, Epo 2026-11-03; the state alone, not
 * "Hidden from members", Epo 2026-11-16): an item only the workspace's owners
 * and editors see. With onShow (an owner or editor who may change it) the chip
 * is a button that shares the item with members, as the ⋮ menu's "Shared with
 * members" switch does. Phones keep the icon alone.
 *
 * With `tip` (a quiz), the first one opened on this browser by someone who may
 * share it says so in the callout (Epo 2026-11-20, board A), until Got it, the
 * chip itself or Esc closes it (`PREF_KEYS.hiddenQuizTip`). */
export function HiddenChip({
  onShow,
  tip = false,
}: {
  onShow?: () => void;
  tip?: boolean;
}) {
  const callout = useChipTip(PREF_KEYS.hiddenQuizTip, tip && !!onShow);
  if (!onShow)
    return (
      <span className={CHIP} title={m.content_hidden()}>
        <Icon name="viewOffSlash" size={16} />
        <span className="sr-only sm:not-sr-only">{m.content_hidden()}</span>
      </span>
    );
  const chip = (
    <button
      className={cn(
        CHIP,
        'cursor-pointer outline-none transition duration-150 ease-out hover:bg-surface-dark-hover-bg hover:text-fg focus-visible:ring-2 focus-visible:ring-action active:scale-[0.96]',
        callout.open && TIP_RING
      )}
      data-testid="hidden-chip"
      onClick={() => {
        if (callout.open) callout.close();
        onShow();
      }}
      type="button"
    >
      <Icon name="viewOffSlash" size={16} />
      <span className="sr-only sm:not-sr-only">{m.content_hidden()}</span>
      {/* The action, for screen readers; sighted users get the tooltip. */}
      <span className="sr-only">{m.content_share_with_members()}</span>
    </button>
  );
  // The tooltip would sit on the callout: the callout says it instead.
  if (callout.open)
    return (
      <ChipTip
        body={m.content_hidden_tip_body()}
        close={callout.close}
        title={m.content_hidden_tip_title()}
      >
        {chip}
      </ChipTip>
    );
  return (
    <ButtonTooltip label={m.content_share_with_members()} side="bottom">
      {chip}
    </ButtonTooltip>
  );
}

/** "Only you" after a class member's own practice quiz's name on its attempt
 * page (Epo 2026-11-20, board D): Practice's lock and words, as the Hidden
 * chip looks. Nobody can share such a quiz (it is in no workspace, which the
 * Hidden switch needs), so it is no button; the first one opened on this
 * browser says so in the callout (`PREF_KEYS.ownPracticeTip`). */
export function OnlyYouChip() {
  const callout = useChipTip(PREF_KEYS.ownPracticeTip, true);
  const chip = (
    <span className={cn(CHIP, callout.open && TIP_RING)}>
      <Icon name="lock" size={16} />
      <span className="sr-only sm:not-sr-only">{m.practice_only_you()}</span>
    </span>
  );
  return callout.open ? (
    <ChipTip
      body={m.practice_only_you_tip_body()}
      close={callout.close}
      title={m.practice_only_you_tip_title()}
    >
      {chip}
    </ChipTip>
  ) : (
    chip
  );
}
