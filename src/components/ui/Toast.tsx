import { useLayoutEffect, useRef, useState } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { ContentSwap } from './ContentSwap';
import { Icon, type IconName } from './Icon';

type ToastVariant = 'default' | 'error' | 'loading' | 'success' | 'warning';

/** A toast's button; pressing it also closes the toast. */
interface ToastButton {
  label: string;
  onClick: () => void;
}

/** What a toast says; `userToast` shows it. */
interface ToastOptions {
  /** The filled action after the copy. */
  button?: ToastButton;
  /** A second line under the title. */
  description?: string;
  /** A plain toast's icon (Link copied: `link`); other kinds have their own. */
  icon?: IconName;
  id?: string | number;
  /** It closed: its × or its button (not replaced by a toast of its id). */
  onClose?: () => void;
  title: string;
  /** `loading` is a working toast: it stays until the same id updates it. */
  variant?: ToastVariant;
}

/* Every kind is the same black pill; only the icon and its colour change
   (board K2, Epo 2026-11-03). Dark themes draw it as an overlay surface. */
const ICON_COLOUR: Partial<Record<ToastVariant, string>> = {
  error: 'text-[#ff9b9b]',
  success: 'text-[#86d6a8]',
  warning: 'text-[#f2c46d]',
};
const ICON: Record<Exclude<ToastVariant, 'loading'>, IconName> = {
  default: 'info',
  error: 'alertCircle',
  success: 'check',
  warning: 'alert',
};

/** The ring spinner of a working toast. */
function Working() {
  return (
    <svg
      aria-hidden
      className="size-4.5 animate-spin"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeWidth={1.6}
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" opacity={0.25} r="8" />
      <path d="M12 4a8 8 0 0 1 8 8" />
    </svg>
  );
}

/* Ding's buttons (Epo 2026-11-09): 30px tall, a 44px tall hit area that
   never reaches a neighbour 8px away, a press that shrinks them a little. */
const TOAST_BUTTON =
  'relative h-7.5 shrink-0 cursor-pointer whitespace-nowrap rounded-full font-semibold text-[13px] transition-[background-color,color,scale] duration-150 ease-out before:absolute before:-inset-x-0.75 before:-inset-y-1.75 focus-visible:outline-2 focus-visible:outline-current focus-visible:outline-offset-2 active:scale-96';

/**
 * The pill: icon, copy and count, then the buttons: the filled action and
 * the close (errors and working toasts), 7px in from the pill's edge.
 * One line is a 44px pill; a description or a title that wraps takes more
 * lines with rounder (18px) corners, as wide as 384px. Copy too wide to sit
 * beside the buttons puts them on their own row at the right.
 */
function Toast({
  toast,
  count = 1,
  onClose,
}: {
  toast: Omit<ToastOptions, 'id'>;
  count?: number;
  onClose: () => void;
}) {
  const { button, description, icon, title, variant = 'default' } = toast;
  const pill = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const buttons = useRef<HTMLDivElement>(null);
  const [wraps, setWraps] = useState(false);
  const [stacked, setStacked] = useState(false);
  // A title too long for one line wraps; the pill then rounds less.
  useLayoutEffect(() => {
    const node = pill.current;
    if (!node) return;
    const measure = () => {
      setWraps(node.offsetHeight > 44);
      setStacked(
        !!copy.current &&
          !!buttons.current &&
          buttons.current.offsetTop > copy.current.offsetTop
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const tall = Boolean(description) || wraps;
  // Toasts that stay until something happens can be closed.
  const closes = variant === 'error' || variant === 'loading';
  const hasButtons = Boolean(button) || closes;
  return (
    <div
      className={cn(
        'pointer-events-auto flex min-h-11 items-start rounded-[22px] bg-[#222] font-semibold text-sm text-white shadow-[0_8px_24px_rgba(20,22,21,0.18)] dark:bg-overlay dark:text-fg dark:shadow-[inset_0_0_0_1px_var(--border-overlay),0_8px_24px_rgba(0,0,0,0.35)]',
        tall && 'rounded-[18px]',
        // The padding stays put when a title wraps, so it cannot unwrap it.
        hasButtons ? 'pr-1.75' : description ? 'pr-4.5' : 'pr-5',
        description
          ? 'w-[min(384px,calc(100vw-32px))]'
          : 'w-max max-w-[min(384px,calc(100vw-32px))]'
      )}
      data-toast={variant}
      ref={pill}
      role={variant === 'error' ? 'alert' : 'status'}
    >
      <span
        className={cn(
          'flex h-11 w-11 shrink-0 items-center justify-center',
          ICON_COLOUR[variant]
        )}
      >
        {variant === 'loading' ? (
          <Working />
        ) : (
          <Icon name={icon && variant === 'default' ? icon : ICON[variant]} />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-start">
        <div
          className={cn(
            'flex min-w-0 flex-[1_1_auto] items-start pt-2.5',
            !stacked && 'pb-2.5'
          )}
          ref={copy}
        >
          {/* A working toast turning into its done toast swaps its copy in place. */}
          <ContentSwap
            className={cn('min-w-0 leading-6', tall && 'flex-1')}
            contentKey={JSON.stringify([title, description])}
          >
            <span className="wrap-anywhere block">{title}</span>
            {description && (
              <span className="wrap-anywhere mt-0.5 block whitespace-pre-line font-medium text-[13px] text-white/72 leading-[1.45] dark:text-fg-secondary">
                {description}
              </span>
            )}
          </ContentSwap>
          {count > 1 && (
            <span className="mt-px ml-3 inline-flex h-5.5 shrink-0 items-center rounded-[11px] bg-white/16 px-2 font-bold text-[12.5px]">
              ×{count}
            </span>
          )}
        </div>
        {hasButtons && (
          <div
            className="ml-auto flex h-11 shrink-0 items-center gap-2 pl-3"
            ref={buttons}
          >
            {button && (
              <button
                className={cn(
                  TOAST_BUTTON,
                  'bg-white px-3.5 text-[#222] hover:bg-white/85 dark:bg-fg dark:text-overlay dark:hover:bg-fg/85'
                )}
                onClick={() => {
                  button.onClick();
                  onClose();
                }}
                type="button"
              >
                {button.label}
              </button>
            )}
            {closes && (
              <button
                aria-label={m.action_close()}
                className={cn(
                  TOAST_BUTTON,
                  'grid size-7.5 place-items-center text-white/65 hover:bg-white/10 hover:text-white dark:text-fg-secondary dark:hover:bg-fg/10 dark:hover:text-fg'
                )}
                onClick={onClose}
                type="button"
              >
                <Icon name="x" size={16} />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export { Toast, type ToastOptions, type ToastVariant };
