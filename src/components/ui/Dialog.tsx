import { useRouterState } from '@tanstack/react-router';
import { Dialog as DialogPrimitive } from 'radix-ui';
import * as React from 'react';
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
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 isolate z-50 bg-black/10 duration-100 data-[state=closed]:animate-out data-[state=open]:animate-in supports-backdrop-filter:backdrop-blur-xs',
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
        className={cn(
          'data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid w-full max-w-2xl -translate-x-1/2 -translate-y-1/2 px-4 outline-none duration-100 data-[state=closed]:animate-out data-[state=open]:animate-in',
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
              'flex max-h-[88vh] w-full flex-col items-stretch gap-0 overflow-auto p-5.5',
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
                  <span className="sr-only">Close</span>
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
        '-mx-4 -mb-4 flex flex-col-reverse gap-2 p-4 sm:flex-row sm:justify-end',
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
  onPointerDownOutside,
  onInteractOutside,
  onEscapeKeyDown,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  className?: string;
  showCloseButton?: boolean;
  onPointerDownOutside?: React.ComponentProps<
    typeof DialogPrimitive.Content
  >['onPointerDownOutside'];
  onInteractOutside?: React.ComponentProps<
    typeof DialogPrimitive.Content
  >['onInteractOutside'];
  onEscapeKeyDown?: React.ComponentProps<
    typeof DialogPrimitive.Content
  >['onEscapeKeyDown'];
}) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  React.useEffect(() => {
    onClose();
  }, [pathname]);

  return (
    <Dialog onOpenChange={(o) => !o && onClose()} open={open}>
      <DialogContent
        className={className}
        onEscapeKeyDown={onEscapeKeyDown}
        onInteractOutside={onInteractOutside}
        onPointerDownOutside={onPointerDownOutside}
        showCloseButton={showCloseButton}
        style={width ? { maxWidth: width } : undefined}
      >
        {title != null && (
          <DialogTitle className="pr-10 pb-4">{title}</DialogTitle>
        )}
        {children}
        {footer && <DialogFooter>{footer}</DialogFooter>}
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
            variant="ghost-hover"
          >
            Cancel
          </Button>
          <Button
            disabled={disabled || isSubmitting}
            onClick={() => {
              onConfirm();
              if (closeOnConfirm) onClose();
            }}
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
      {body && <p>{body}</p>}
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
