import { useRouter } from '@tanstack/react-router';
import { Dialog as DialogPrimitive } from 'radix-ui';
import * as React from 'react';
import { createPortal } from 'react-dom';
import { Card } from '@/components/ui/Card';
import { useEditorHeld } from '@/features/collaboration/CollaborationHold';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { Button } from './Button';
import { Spinner } from './feedback';
import { IconButton } from './IconButton';

function Dialog({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        'motion-fade fixed inset-0 isolate z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs',
        className
      )}
      data-slot="dialog-overlay"
      {...props}
    />
  );
}

/** The phone header's action spot, so content rendered below the title (an
 * embedded form) can put its primary button there. */
const ActionSlotContext = React.createContext<{
  slot: HTMLElement | null;
  setSlot: (slot: HTMLElement | null) => void;
}>({ setSlot: () => {}, slot: null });

function DialogContent({
  className,
  children,
  showCloseButton = true,
  cardClassName,
  cardScrollContainerClassName,
  onOpenAutoFocus,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  cardClassName?: string;
  cardScrollContainerClassName?: string;
}) {
  const held = useEditorHeld();
  const [slot, setSlot] = React.useState<HTMLElement | null>(null);
  const actionSlot = React.useMemo(() => ({ setSlot, slot }), [slot]);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        // Round centering to pixels; keep the layer stable when motion ends.
        className={cn(
          'motion-modal motion-blur-in fixed top-[var(--dialog-center,50%)] left-[var(--dialog-center,50%)] z-50 grid max-h-[88dvh] w-full max-w-2xl translate-x-[var(--dialog-offset,-50%)] translate-y-[var(--dialog-offset,-50%)] px-4 outline-none will-change-transform',
          'supports-[top:round(50%,1px)]:[--dialog-center:round(50%,1px)] supports-[translate:round(-50%,1px)]:[--dialog-offset:round(-50%,1px)]',
          // Phones: a full-screen page the keyboard covers, so its header
          // never moves.
          'max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-h-none max-sm:max-w-none max-sm:translate-x-0 max-sm:translate-y-0 max-sm:px-0',
          className
        )}
        data-slot="dialog-content"
        inert={held}
        // check github issues for pointer event collisions between dialog and sonner
        // https://github.com/radix-ui/primitives/issues/2690#issuecomment-1945449832
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          // Phones: the first tabbable is the header's close, whose focus ring
          // would show on every open; the page takes focus instead.
          if (event.defaultPrevented || !matchMedia(PHONE_QUERY).matches)
            return;
          event.preventDefault();
          (event.currentTarget as HTMLElement).focus();
        }}
        onPointerDownOutside={(e) => {
          if (
            e.target instanceof Element &&
            e.target.closest('[data-sonner-toast]')
          ) {
            e.preventDefault();
          }
          onPointerDownOutside?.(e);
        }}
        {...props}
      >
        <Card
          className={cn(
            'relative w-full items-stretch gap-0 overflow-hidden p-0 max-sm:h-full max-sm:rounded-none max-sm:shadow-none',
            cardClassName
          )}
          radius="card-lg"
          raised
        >
          <div
            className={cn(
              // relative: the close button scrolls away with the content instead of covering it.
              'relative flex h-full max-h-[88dvh] w-full flex-col items-stretch gap-0 overflow-auto px-4 py-5 sm:px-5.5 sm:py-6.5',
              // Phones: the header row carries the close button and sticks to
              // the top; a dialog without a title keeps the corner button.
              // Its scrollbar is hidden there, so one appearing when the keyboard
              // shortens the page never shifts the header's action.
              'max-sm:max-h-none max-sm:pb-[calc(--spacing(16)+max(env(safe-area-inset-bottom),var(--keyboard-inset,0px)))] max-sm:[scrollbar-width:none] max-sm:[&::-webkit-scrollbar]:hidden',
              'max-sm:has-[>[data-slot=dialog-header],>form>[data-slot=dialog-header]]:pt-0 max-sm:has-[>[data-slot=dialog-header],>form>[data-slot=dialog-header]]:[&>[data-slot=dialog-close]]:hidden',
              cardScrollContainerClassName
            )}
          >
            <ActionSlotContext value={actionSlot}>{children}</ActionSlotContext>
            {showCloseButton && (
              <DialogPrimitive.Close asChild data-slot="dialog-close">
                <IconButton
                  className="absolute top-4 right-4"
                  icon="x"
                  size="md"
                  variant="ghost-hover"
                >
                  <span className="sr-only">{m.action_close()}</span>
                </IconButton>
              </DialogPrimitive.Close>
            )}
          </div>
        </Card>
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

const PHONE_QUERY = '(max-width: 639.98px)';

/** Phones lay dialogs out as pages: the primary action moves to the header. */
function useIsPhone() {
  return useMediaQuery(PHONE_QUERY);
}

/**
 * The title, and on phones the dialog's header row: close on the left, the
 * primary `action` on the right, sticky above the scrolling content. Wider
 * screens see only the title (the wrapper is `display: contents`).
 */
function DialogTitle({
  action,
  closable = true,
  closeDisabled,
  onCloseClick,
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title> & {
  action?: React.ReactNode;
  closable?: boolean;
  closeDisabled?: boolean;
  /** Replaces closing, for a dialog whose way out is an action (Skip). */
  onCloseClick?: () => void;
}) {
  const closeButton = (
    <IconButton
      className="shrink-0 -translate-y-px sm:hidden"
      disabled={closeDisabled}
      icon="x"
      onClick={onCloseClick}
      size="sm"
      variant="ghost-hover"
    >
      <span className="sr-only">{m.action_close()}</span>
    </IconButton>
  );
  const { setSlot } = React.useContext(ActionSlotContext);
  return (
    <div
      className="max-sm:sticky max-sm:top-0 max-sm:z-20 max-sm:-mx-4 max-sm:mb-2 max-sm:flex max-sm:min-h-14 max-sm:shrink-0 max-sm:items-start max-sm:gap-1 max-sm:bg-overlay max-sm:pt-3 max-sm:pr-4 max-sm:pb-1 max-sm:pl-1.5 sm:contents"
      data-slot="dialog-header"
    >
      {onCloseClick
        ? closeButton
        : closable && (
            <DialogPrimitive.Close asChild>{closeButton}</DialogPrimitive.Close>
          )}
      <DialogPrimitive.Title
        className={cn(
          't-large-card-title flex items-center justify-between pt-0 pb-6',
          className,
          // At most two lines, so a long title never squeezes the action.
          'max-sm:line-clamp-2 max-sm:min-w-0 max-sm:flex-1 max-sm:py-2 max-sm:text-lg max-sm:leading-tight'
        )}
        data-slot="dialog-title"
        {...props}
      />
      {/* A compact button: the header row is a toolbar, not a footer. */}
      <div
        className="ml-2 flex shrink-0 translate-y-0.5 items-center gap-2 empty:hidden sm:hidden [&>[data-slot=button]]:min-w-0 [&>[data-slot=button]]:px-4 [&>[data-slot=button]]:[--button-h:--spacing(9)]"
        ref={setSlot}
      >
        {action}
      </div>
    </div>
  );
}

/** Puts a primary button in the phone header from below the title, e.g. an
 * embedded form's submit (give it `form=` since it leaves the form's DOM). */
function DialogHeaderAction({ children }: { children: React.ReactNode }) {
  const { slot } = React.useContext(ActionSlotContext);
  return slot && createPortal(children, slot);
}

/** Cancel in a footer; phones drop it, since closing the dialog cancels. */
function DialogCancel({
  disabled,
  label,
}: {
  disabled?: boolean;
  label?: string;
}) {
  return (
    <DialogPrimitive.Close asChild>
      <Button
        className="max-sm:hidden"
        disabled={disabled}
        size="lg"
        type="button"
        variant="ghost-hover"
      >
        {label ?? m.action_cancel()}
      </Button>
    </DialogPrimitive.Close>
  );
}

/**
 * Cancel and the primary inside a body's own DialogFooter; phones move the
 * primary to the header (give a submit button `form=`).
 */
function DialogPrimary({
  children,
  pending,
}: {
  children: React.ReactNode;
  pending?: boolean;
}) {
  return useIsPhone() ? (
    <DialogHeaderAction>{children}</DialogHeaderAction>
  ) : (
    <>
      <DialogCancel disabled={pending} />
      {children}
    </>
  );
}

function DialogFooter({
  className,
  children,
  ...props
}: React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        // empty: a phone footer whose primary went to the header.
        '-mx-4 -mb-3 flex flex-row justify-end gap-2 px-4 pt-5.5 pb-3 empty:hidden',
        // Phones: what is left after the header took the primary action sits
        // at the content's start and scrolls with it, close below the content;
        // a borderless first button sheds its padding so its label lines up
        // with the content's edge.
        'max-sm:flex-wrap max-sm:justify-start max-sm:pt-2',
        // A destructive primary stays out of the header, at the content's end.
        'max-sm:has-[>[data-variant=danger]]:justify-end',
        'max-sm:[&>[data-size=lg]:is([data-variant^=ghost],[data-variant=danger-light]):first-child]:-ml-6.5',
        'max-sm:[&>[data-size=md]:is([data-variant^=ghost],[data-variant=danger-light]):first-child]:-ml-5',
        'max-sm:[&>[data-size=sm]:is([data-variant^=ghost],[data-variant=danger-light]):first-child]:-ml-4',
        className
      )}
      data-slot="dialog-footer"
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * Convenience wrapper for the common "title + body + footer" dialog. Built on
 * the Radix primitives above so every modal in the app shares the same
 * open/close animation. Mirrors the old `Modal` API for a drop-in swap.
 */
function SimpleDialog({
  open,
  onClose,
  title,
  children,
  action,
  footer,
  width,
  className,
  showCloseButton = true,
  pending,
  onCloseClick,
  onCloseAutoFocus,
  onOpenAutoFocus,
  onPointerDownOutside,
  onInteractOutside,
  onEscapeKeyDown,
  onSubmit,
  formClassName,
  formId,
  cardClassName,
  cardScrollContainerClassName,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children?: React.ReactNode;
  /** The primary action: the header's right on phones, the footer's end
   * after Cancel elsewhere. */
  action?: React.ReactNode;
  /** Other actions; phones show them after the content, wider screens
   * before Cancel. */
  footer?: React.ReactNode;
  width?: number;
  className?: string;
  formClassName?: string;
  formId?: string;
  showCloseButton?: boolean;
  /** While the action runs: closing is disabled (the corner close hides). */
  pending?: boolean;
  /** Phones: the header close runs this instead of closing (Onboarding's
   * Skip), shown even without `showCloseButton`. */
  onCloseClick?: () => void;
  onCloseAutoFocus?: React.ComponentProps<
    typeof DialogPrimitive.Content
  >['onCloseAutoFocus'];
  onOpenAutoFocus?: React.ComponentProps<
    typeof DialogPrimitive.Content
  >['onOpenAutoFocus'];
  onPointerDownOutside?: React.ComponentProps<
    typeof DialogPrimitive.Content
  >['onPointerDownOutside'];
  onInteractOutside?: React.ComponentProps<
    typeof DialogPrimitive.Content
  >['onInteractOutside'];
  onEscapeKeyDown?: React.ComponentProps<
    typeof DialogPrimitive.Content
  >['onEscapeKeyDown'];
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
  cardClassName?: string;
  cardScrollContainerClassName?: string;
}) {
  // Close when the app navigates to another path while open. The /share/*
  // entry has no router, so the context is empty there and the dialog only
  // closes itself.
  const router = useRouter({ warn: false }) as ReturnType<
    typeof useRouter
  > | null;
  React.useEffect(() => {
    if (!open) return;
    return router?.subscribe('onBeforeNavigate', ({ pathChanged }) => {
      if (pathChanged) onClose();
    });
  }, [router, onClose, open]);

  const phone = useIsPhone();
  const footerRow =
    action && !phone ? (
      <>
        {footer}
        {showCloseButton && <DialogCancel disabled={pending} />}
        {action}
      </>
    ) : (
      footer
    );
  const body = (
    <>
      {title != null && (
        <DialogTitle
          action={phone && action}
          className="pb-2"
          closable={showCloseButton}
          closeDisabled={pending}
          onCloseClick={onCloseClick}
        >
          {title}
        </DialogTitle>
      )}
      {children}
      {footerRow && <DialogFooter className="mt-3">{footerRow}</DialogFooter>}
    </>
  );

  return (
    <Dialog onOpenChange={(o) => !o && onClose()} open={open}>
      <DialogContent
        cardClassName={cardClassName}
        cardScrollContainerClassName={cardScrollContainerClassName}
        className={className}
        onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={onEscapeKeyDown}
        onInteractOutside={onInteractOutside}
        onOpenAutoFocus={onOpenAutoFocus}
        onPointerDownOutside={onPointerDownOutside}
        showCloseButton={showCloseButton && !pending}
        style={width ? { maxWidth: width } : undefined}
      >
        {onSubmit ? (
          <form
            // min-h-full and shrink-0, not h-full: a form taller than the
            // dialog grows and scrolls with the card's bottom padding below its
            // footer, instead of overflowing past it.
            className={cn(
              'flex min-h-full w-full shrink-0 flex-col items-stretch gap-4',
              formClassName
            )}
            id={formId}
            onSubmit={onSubmit}
          >
            {body}
          </form>
        ) : (
          body
        )}
      </DialogContent>
    </Dialog>
  );
}

interface ConfirmDialogProps {
  body?: string;
  children?: React.ReactNode;
  closeOnConfirm?: boolean;
  confirmLabel?: string;
  danger?: boolean;
  disabled?: boolean;
  isSubmitting?: boolean;
  onClose: () => void;
  onConfirm: () => void;
  open: boolean;
  title: string;
}

function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  body,
  children,
  confirmLabel,
  isSubmitting,
  disabled,
  closeOnConfirm = true,
  danger = true,
}: ConfirmDialogProps) {
  const confirm = (
    <Button
      disabled={disabled || isSubmitting}
      onClick={() => {
        onConfirm();
        if (closeOnConfirm) onClose();
      }}
      size="lg"
      type="button"
      variant={danger ? 'danger' : 'accent'}
    >
      {!isSubmitting && <span>{confirmLabel ?? m.action_confirm()}</span>}
      {isSubmitting && (
        <span>
          <Spinner />
        </span>
      )}
    </Button>
  );
  return (
    <SimpleDialog
      // A destructive confirm stays below the content on phones.
      action={!danger && confirm}
      footer={
        danger && (
          <>
            <DialogCancel disabled={isSubmitting} />
            {confirm}
          </>
        )
      }
      onClose={onClose}
      open={open}
      pending={isSubmitting}
      title={title}
    >
      {/* t-body is slightly too small to draw user's attention */}
      {body && <p className="text-[0.9375rem] sm:text-base">{body}</p>}
      {children}
    </SimpleDialog>
  );
}

export {
  ConfirmDialog,
  type ConfirmDialogProps,
  Dialog,
  DialogCancel,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeaderAction,
  DialogOverlay,
  DialogPortal,
  DialogPrimary,
  DialogTitle,
  DialogTrigger,
  SimpleDialog,
  useIsPhone,
};
