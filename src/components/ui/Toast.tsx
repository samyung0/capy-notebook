import { useLayoutEffect, useRef, useState } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { ContentSwap } from './ContentSwap';
import { Icon, type IconName } from './Icon';

type ToastVariant = 'default' | 'error' | 'loading' | 'success' | 'warning';

/** What a toast says; `userToast` shows it. */
interface ToastOptions {
  /** An underlined action after the copy; it also closes the toast. */
  button?: {
    label: string;
    onClick: () => void;
  };
  /** A second line under the title. */
  description?: string;
  /** A plain toast's icon (Link copied: `link`); other kinds have their own. */
  icon?: IconName;
  id?: string | number;
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

/**
 * The pill: icon, copy, then the count, action and close (errors only). One
 * line is a 44px pill; a description or a title that wraps takes more lines
 * with rounder (18px) corners, as wide as 384px.
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
  const [wraps, setWraps] = useState(false);
  // A title too long for one line wraps; the pill then rounds less.
  useLayoutEffect(() => {
    const node = pill.current;
    if (!node) return;
    const measure = () => setWraps(node.offsetHeight > 44);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const tall = Boolean(description) || wraps;
  return (
    <div
      className={cn(
        'pointer-events-auto flex min-h-11 items-start rounded-[22px] bg-[#222] py-2.5 font-semibold text-sm text-white shadow-[0_8px_24px_rgba(20,22,21,0.18)] dark:bg-overlay dark:text-fg dark:shadow-[inset_0_0_0_1px_var(--border-overlay),0_8px_24px_rgba(0,0,0,0.35)]',
        tall && 'rounded-[18px]',
        // The padding stays put when a title wraps, so it cannot unwrap it.
        description ? 'pr-4.5' : 'pr-5',
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
          'flex h-6 w-11 shrink-0 items-center justify-center',
          ICON_COLOUR[variant]
        )}
      >
        {variant === 'loading' ? (
          <Working />
        ) : (
          <Icon name={icon && variant === 'default' ? icon : ICON[variant]} />
        )}
      </span>
      {/* A working toast turning into its done toast swaps its copy in place. */}
      <ContentSwap
        className={cn('leading-6', tall && 'flex-1')}
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
      {button && (
        <button
          className="ml-3 h-6 shrink-0 cursor-pointer whitespace-nowrap underline decoration-1 underline-offset-3"
          onClick={() => {
            button.onClick();
            onClose();
          }}
          type="button"
        >
          {button.label}
        </button>
      )}
      {variant === 'error' && (
        <button
          aria-label={m.action_close()}
          className={cn(
            'relative flex h-6 shrink-0 cursor-pointer items-center text-white/70 after:absolute after:-inset-x-2 after:inset-y-0 hover:text-white dark:text-fg-muted dark:hover:text-fg',
            tall ? 'ml-auto pl-3' : 'ml-2'
          )}
          onClick={onClose}
          type="button"
        >
          <Icon name="x" size={16} />
        </button>
      )}
    </div>
  );
}

export { Toast, type ToastOptions, type ToastVariant };
