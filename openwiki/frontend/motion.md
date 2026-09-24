# Frontend motion

`src/styles/tokens/motion.css` contains the transitions.dev scale under
`--motion-*`. Tailwind's default transition and easing variables stay unchanged.
Choose tokens by purpose: popup/modal open 250ms and close 150ms; drawers open
400ms and close 350ms; copy swaps 150ms; icon swaps 250ms. Drawer dismissal still
multiplies its duration by swipe strength, and direct swipes use zero duration.

The CSS recipes share timing while keeping component semantics separate:

- Popover contains arbitrary controls; Select chooses a value; DropdownMenu
  contains commands, checkboxes and submenus. `Menu` is the data-driven action
  list over DropdownMenu. Paragraph styles use `ToolbarMenuContent` and `MenuRow`. Other Plate toolbar
  command lists use `ToolbarPopoverContent` and `ToolbarPopoverRow`, with ordinary
  button keyboard behavior and preserved editor/command focus on close. PDF Draw
  and Shape also use Popover; these converted toolbar triggers have no chevron.
  Shared command-menu content becomes inert during its retained exit, including
  submenus, so keyboard activation cannot execute a closing item again.
  Dropdown triggers retain their button semantics and press animation inside a
  stationary MenuAnchor. A shared Radix scope connects that anchor to dropdown
  content, including trigger-width matching; submenu triggers retain their own anchors.
  Shared PopoverTrigger owns a stationary PopoverAnchor wrapper, including for
  Workspaces Filter and the notification bell. Triggerless editor popovers keep
  their explicit anchors. The motion browser suite samples Filter positioning through
  repeated opening animations at desktop and mobile widths.
- Popovers, dropdowns and dropdown submenus share `motion-anchored-popup`: fade,
  97% entry scale, 2px entry blur and a directional 16px entry slide; exit fades
  and shrinks to 99%. Dialogs also get a short 2px entrance blur. Tooltips stay
  crisp. Drawer blur belongs to its inner content, separate from the
  root's nested-drawer brightness filter.
  Its entrance filter follows `data-starting-style` and stays clear after
  cancelled or nested swipes.
- Shared `DialogContent` uses `will-change: transform` while mounted to keep
  its rendering layer stable at animation completion. Without it, Chromium can
  paint body controls 1px higher on the final frame while the title stays fixed,
  despite unchanged layout positions. Center offsets and translations round to
  CSS pixels so settled text avoids fractional translation. Feature queries enable
  rounded centering variables only when supported; otherwise the offsets stay at
  50% and translations at -50%. Scale, blur and timing remain unchanged.
  Share dialog member content follows the dialog's mount lifetime, so closing
  does not remove the member section before the exit animation finishes.
- `PopupMotion` keeps custom popup content mounted through its CSS exit, freezes
  the last open position/content, and makes it inert immediately.
  The exit animation retains its final transparent frame until React removes the
  node, preventing a full-opacity flash after the animation finishes. Positioning
  belongs to the outer node; animation belongs to the inner node. Changes to
  query results, selection, copy or stream state do not remount the animation.
  AI and command-palette inputs focus on open, since retained nodes do not
  rerun mount-only autofocus.
  Slate owns mention/slash node removal, so committing these inline inputs
  removes their popup immediately rather than delaying the editor command.
- `ContentSwap` keys only on meaningful copy or icon changes, keeps outgoing
  copy inaccessible, and overlaps both copies in a grid during the swap.
  Notification read state changes title color without replaying the message.
  New notification IDs arriving while the popup is open reveal once; opening
  existing messages, pagination and ordinary refetches do not stagger the list.
- `useLoadingReveal` runs once after an initial skeleton resolves and applies
  blur/opacity only to visible rows/cards, never the full scroll container.

Shared `PopoverContent` supplies `border border-line bg-surface shadow-pop`.
Editor and PDF popovers inherit these styles. Filter and notification popovers
keep their inner Card styling with `border-0 bg-transparent shadow-none!` on the
outer content; tag autocomplete keeps its `shadow-lg!` override, explicit because tailwind-merge does not classify the custom shadow-pop token. The floating Add
menu uses DropdownMenu with its separate morph styling.

The workspace tag picker uses the shared Popover anchored to its input container.
Focus stays in the combobox input while its listbox handles pointer selection;
Radix owns positioning, outside dismissal and exit lifetime.

The workspace creation form stays mounted to preserve dismissal motion. It resets
on a closed-to-open transition, independently of autofocus; failed submissions
keep their current input.

Reduced motion disables keyframes globally. Custom exits use the actual browser
animation lifetime and remove immediately when no animation runs. Reopening
cancels pending removal. Foreground filters settle back to `none`.

Input, Textarea and TagSelect shake their bordered control once when invalid,
using the reference error shake's 280ms timing and 6px/4px travel. Remaining
invalid does not replay the shake; becoming valid resets it. Border widths stay
constant. InputError fades in for 280ms without moving and remains visible until
validation clears it, with no timer or delayed removal. Reduced motion disables
both animations. Repeated submission of an unchanged invalid field does not
restart the shake.

Sonner still owns its wrapper exit and 200ms removal lifetime. Changing its CSS
alone to a 350ms exit would truncate the animation; that lifecycle change remains
separate. Toast copy updates use the same compact swap as other changing text.

Browser checks: `VITE_FEATURE_EDITOR_AI=true pnpm run e2e:msw:editor --workers=1 ui-motion.spec.ts`.
The feature flag includes the AI input's rapid-reopen focus check.

Manual dialog rendering check: at 10% animation speed in Chromium DevTools,
compare the final moving frame with the settled frame for the icon picker,
workspace edit/create and task edit dialogs. Body controls should stay in place.
Compare page screenshots; Playwright locator screenshots wait for stability and
can miss the final-frame jump.

Signup code sends disable resend immediately. Success shows “Code sent” for
1.5 seconds, then a 60-second wall-clock countdown. `ContentSwap`'s `text-state`
variant exits upward with 2px blur before entering from 4px below, 150ms per phase.
Failed sends remain retryable. Countdown digits update without replaying the swap.
Workspace statistics use `NumberPopIn`: 8px travel, 2px blur, 500ms bounce easing
and 70ms digit stagger. Reduced motion renders both transitions without animation.
