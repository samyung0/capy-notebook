import { useLayoutEffect, useRef, useState } from 'react';
import { m } from '@/i18n';
import { ContentSwap } from './ContentSwap';
import { Icon, type IconName } from './Icon';
import './toast.css';

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

/** Ding's glyphs: 24×24 strokes drawn in by CSS (`pathLength` 1). The first
 * is the ring, an arc while working. */
const RING = 'M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18';
const GLYPH: Record<Exclude<ToastVariant, 'default'>, string[]> = {
  error: [RING, 'M9.3 9.3l5.4 5.4', 'M14.7 9.3l-5.4 5.4'],
  loading: [RING],
  success: [RING, 'M7.9 12.4l3 3 5.3-6'],
  warning: [RING, 'M12 7.6v5.2', 'M12 16.3h.01'],
};

function Glyph({ paths }: { paths: string[] }) {
  return (
    <svg
      aria-hidden
      className="tst-svg"
      height={22}
      viewBox="0 0 24 24"
      width={22}
    >
      {paths.map((d) => (
        <path d={d} key={d} pathLength={1} />
      ))}
    </svg>
  );
}

/**
 * Ding's toast (toast.css, Epo 2026-11-12): the 44px icon cell with its
 * glyph, the copy (title, count, description; at most 340px), then the
 * filled action and the close (every toast, Epo 2026-11-12) beside it. A
 * screen too narrow for both puts the buttons on a row of their own at the
 * right. A plain toast is a green check; one with its own icon (Link
 * copied) shows it in the glyph's place, in the text colour.
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
  // A plain toast confirms something (Moved, Invitation submitted): the green
  // check, unless it brings its own icon (Epo 2026-11-12).
  const type = variant === 'default' ? (icon ? undefined : 'success') : variant;
  const pill = useRef<HTMLDivElement>(null);
  const copy = useRef<HTMLDivElement>(null);
  const buttons = useRef<HTMLButtonElement>(null);
  const [wrapped, setWrapped] = useState(false);
  // Ding's test: the first button starts below the copy, not beside it.
  useLayoutEffect(() => {
    const node = pill.current;
    if (!node) return;
    const measure = () =>
      setWrapped(
        !!copy.current &&
          !!buttons.current &&
          buttons.current.offsetTop >=
            copy.current.offsetTop + copy.current.offsetHeight
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      className="tst pointer-events-auto"
      data-toast={variant}
      data-type={type}
      ref={pill}
      role={variant === 'error' ? 'alert' : 'status'}
    >
      {/* Keyed, so a working toast turning into its done toast draws in again. */}
      <div className="tst-icon" key={variant}>
        <div className="tst-badge">
          {variant === 'default' && icon ? (
            <Icon name={icon} />
          ) : (
            <Glyph paths={GLYPH[type ?? 'success']} />
          )}
        </div>
      </div>
      <div className="tst-body" data-wrapped={wrapped || undefined}>
        <div className="tst-copy" ref={copy}>
          {/* A working toast turning into its done toast swaps its copy in place. */}
          <ContentSwap contentKey={JSON.stringify([title, description])}>
            <div className="tst-title">
              {title}
              {count > 1 && <span className="tst-count">×{count}</span>}
            </div>
            {description && <div className="tst-desc">{description}</div>}
          </ContentSwap>
        </div>
        {button && (
          <button
            className="tst-action"
            onClick={() => {
              button.onClick();
              onClose();
            }}
            ref={buttons}
            type="button"
          >
            {button.label}
          </button>
        )}
        <button
          aria-label={m.action_close()}
          className="tst-close"
          onClick={onClose}
          ref={button ? undefined : buttons}
          type="button"
        >
          <svg aria-hidden height={12} viewBox="0 0 24 24" width={12}>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
    </div>
  );
}

export { Toast, type ToastOptions, type ToastVariant };
