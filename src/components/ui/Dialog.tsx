import { useRouterState } from '@tanstack/react-router';
import { Dialog as DialogPrimitive } from 'radix-ui';
import * as React from 'react';
import { useRef } from 'react';
import { Card } from '@/components/ui/Card';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
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

function DialogContent({
  className,
  children,
  showCloseButton = true,
  cardClassName,
  cardScrollContainerClassName,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  cardClassName?: string;
  cardScrollContainerClassName?: string;
}) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        // Round centering to pixels; keep the layer stable when motion ends.
        className={cn(
          'motion-modal motion-blur-in fixed top-[var(--dialog-center,50%)] left-[var(--dialog-center,50%)] z-50 grid max-h-[88dvh] w-full max-w-2xl translate-x-[var(--dialog-offset,-50%)] translate-y-[var(--dialog-offset,-50%)] px-4 outline-none will-change-transform',
          'supports-[top:round(50%,1px)]:[--dialog-center:round(50%,1px)] supports-[translate:round(-50%,1px)]:[--dialog-offset:round(-50%,1px)]',
          className
        )}
        data-slot="dialog-content"
        // check github issues for pointer event collisions between dialog and sonner
        // https://github.com/radix-ui/primitives/issues/2690#issuecomment-1945449832
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
            'relative w-full items-stretch gap-0 overflow-hidden p-0',
            cardClassName
          )}
          radius="card-lg"
          raised
        >
          <div
            className={cn(
              'flex h-full max-h-[88dvh] w-full flex-col items-stretch gap-0 overflow-auto px-5.5 py-6.5',
              cardScrollContainerClassName
            )}
          >
            {children}
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

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn(
        't-large-card-title flex items-center justify-between pt-0 pb-6',
        className
      )}
      data-slot="dialog-title"
      {...props}
    />
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
        '-mx-4 -mb-3 flex flex-col-reverse gap-2 px-4 pt-5.5 pb-3 sm:flex-row sm:justify-end',
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
  footer,
  width,
  className,
  showCloseButton = true,
  onCloseAutoFocus,
  onOpenAutoFocus,
  onPointerDownOutside,
  onInteractOutside,
  onEscapeKeyDown,
  onSubmit,
  formClassName,
  cardClassName,
  cardScrollContainerClassName,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  className?: string;
  formClassName?: string;
  showCloseButton?: boolean;
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
  const originalPathname = useRef<string | null>(null);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  React.useEffect(() => {
    if (
      originalPathname.current === null ||
      originalPathname.current === pathname
    ) {
      originalPathname.current = pathname;
      return;
    }
    onClose();
  }, [pathname]);

  const body = (
    <>
      {title != null && <DialogTitle className="pb-2">{title}</DialogTitle>}
      {children}
      {footer && <DialogFooter className="mt-3">{footer}</DialogFooter>}
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
        showCloseButton={showCloseButton}
        style={width ? { maxWidth: width } : undefined}
      >
        {onSubmit ? (
          <form
            className={cn(
              'flex h-full min-h-0 w-full flex-col items-stretch gap-4',
              formClassName
            )}
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
  return (
    <SimpleDialog
      footer={
        <>
          <Button
            disabled={isSubmitting}
            onClick={onClose}
            size="lg"
            type="button"
            variant="ghost-hover"
          >
            {m.action_cancel()}
          </Button>
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
        </>
      }
      onClose={onClose}
      open={open}
      title={title}
    >
      {/* t-body is slightly too small to draw user's attention */}
      {body && <p className="text-base">{body}</p>}
      {children}
    </SimpleDialog>
  );
}

export {
  ConfirmDialog,
  type ConfirmDialogProps,
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
  SimpleDialog,
};
