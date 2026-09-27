import type { MathfieldElement } from 'mathlive';
import { useEffect, useRef, useState } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

export interface MathFieldProps {
  autoFocus?: boolean;
  displayMode?: boolean;
  onCancel?: () => void;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  onKeyboardControl?: (toggle: (() => void) | null) => void;
  value: string;
}

/** Shared by the small question editor and the note equation voids. */
export function MathField({
  value,
  onChange,
  onCommit,
  onCancel,
  onKeyboardControl,
  displayMode,
  autoFocus = true,
}: MathFieldProps) {
  const host = useRef<HTMLSpanElement>(null);
  const field = useRef<MathfieldElement | null>(null);
  const callbacks = useRef({ onCancel, onChange, onCommit, onKeyboardControl });
  callbacks.current = { onCancel, onChange, onCommit, onKeyboardControl };
  const initial = useRef(value);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    import('mathlive')
      .then(({ MathfieldElement }) => {
        if (cancelled || !host.current) return;
        MathfieldElement.fontsDirectory = '/mathlive/fonts';
        MathfieldElement.soundsDirectory = null;
        const element = new MathfieldElement();
        element.value = initial.current;
        element.mathVirtualKeyboardPolicy = 'manual';
        element.setAttribute('aria-label', m.question_ui_formula());
        element.style.cssText =
          'min-width:1em;max-width:100%;padding:0;background:transparent;border:0;outline:0;';
        // MathLive owns these edits; Slate would cancel its beforeinput event.
        const beforeInput = (event: Event) => event.stopPropagation();
        const input = (event: Event) => {
          event.stopPropagation();
          callbacks.current.onChange(element.value);
        };
        let finished = false;
        const commit = () => {
          if (!finished) {
            finished = true;
            callbacks.current.onCommit?.(element.value);
          }
        };
        const blur = commit;
        const key = (event: KeyboardEvent) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            finished = true;
            callbacks.current.onCancel?.();
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            commit();
          }
        };
        element.addEventListener('beforeinput', beforeInput);
        element.addEventListener('input', input);
        element.addEventListener('blur', blur);
        element.addEventListener('keydown', key);
        host.current.append(element);
        field.current = element;
        // Keep keyboard taps inside the modal's focus and pointer boundary.
        window.mathVirtualKeyboard.container =
          host.current.closest<HTMLElement>('[data-slot="dialog-content"]') ??
          document.body;
        callbacks.current.onKeyboardControl?.(() => {
          element.focus();
          window.mathVirtualKeyboard.visible =
            !window.mathVirtualKeyboard.visible;
        });
        if (autoFocus) element.focus();
        cleanup = () => {
          if (callbacks.current.onKeyboardControl) {
            callbacks.current.onKeyboardControl(null);
            window.mathVirtualKeyboard.hide();
            window.mathVirtualKeyboard.container = document.body;
          }
          element.removeEventListener('beforeinput', beforeInput);
          element.removeEventListener('input', input);
          element.removeEventListener('blur', blur);
          element.removeEventListener('keydown', key);
          element.remove();
          field.current = null;
        };
      })
      .catch(() =>
        setError(
          m.question_ui_formula_editor_could_not_load_close_and_try_again()
        )
      );
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [autoFocus]);
  useEffect(() => {
    if (field.current && field.current.value !== value)
      field.current.value = value;
  }, [value]);
  return (
    <span
      className={cn(
        'inline-block max-w-full align-baseline outline-2 outline-action-accent -outline-offset-2 [&_math-field::part(menu-toggle)]:hidden',
        onKeyboardControl &&
          '[&_math-field::part(virtual-keyboard-toggle)]:hidden',
        displayMode && 'block text-center'
      )}
      contentEditable={false}
      ref={host}
    >
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
