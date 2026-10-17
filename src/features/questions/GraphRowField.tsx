import type { MathfieldElement } from 'mathlive';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { getLocale } from '@/i18n';
import { COMMAND_SHORTCUTS } from './graphSyntax';
import mathFieldStyles from './mathField.css?inline';

export interface GraphRowFieldProps {
  autoFocus?: boolean;
  label: string;
  latex: string;
  /** LaTeX for the field and ASCII-math for the row parser. */
  onChange: (latex: string, ascii: string) => void;
  onEnter: () => void;
  /** Arrow keys past the first or last line of the formula. */
  onMoveOut: (direction: 'up' | 'down') => void;
  /** Backspace in an empty row. */
  onRemoveEmpty?: () => void;
  /** Registers the field so neighbouring rows can focus it. */
  register: (field: MathfieldElement | null) => void;
}

/** One expression row of the graph editor: a typeset MathLive field. */
export function GraphRowField({
  latex,
  label,
  onChange,
  onEnter,
  onRemoveEmpty,
  onMoveOut,
  register,
  autoFocus,
}: GraphRowFieldProps) {
  const host = useRef<HTMLSpanElement>(null);
  const field = useRef<MathfieldElement | null>(null);
  const callbacks = useRef({
    onChange,
    onEnter,
    onMoveOut,
    onRemoveEmpty,
    register,
  });
  callbacks.current = { onChange, onEnter, onMoveOut, onRemoveEmpty, register };
  const initial = useRef(latex);
  useLayoutEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    const mount = (Element: typeof MathfieldElement) => {
      if (cancelled || !host.current) return;
      Element.fontsDirectory = '/mathlive/fonts';
      Element.soundsDirectory = null;
      Element.locale = getLocale();
      const element = new Element();
      element.defaultMode = 'math';
      element.smartFence = true;
      element.mathVirtualKeyboardPolicy = 'auto';
      element.style.cssText =
        'display:block;width:100%;padding:0;background:transparent;border:0;outline:0;color:inherit;font-size:1.21em;line-height:1.2;';
      const input = () =>
        callbacks.current.onChange(
          element.value,
          element.getValue('ascii-math')
        );
      // Row keys stop here, before MathLive's handler inside the shadow root.
      const key = (event: KeyboardEvent) => {
        const action =
          event.key === 'Enter'
            ? callbacks.current.onEnter
            : event.key === 'Backspace' && !element.value
              ? callbacks.current.onRemoveEmpty
              : undefined;
        if (!action) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        action();
      };
      const moveOut = (event: Event) => {
        const { direction } = (event as CustomEvent<{ direction: string }>)
          .detail;
        if (direction !== 'upward' && direction !== 'downward') return;
        event.preventDefault();
        const move = callbacks.current.onMoveOut;
        setTimeout(() => move(direction === 'upward' ? 'up' : 'down'));
      };
      element.addEventListener('input', input);
      // Capture: MathLive handles keys inside its shadow root first.
      element.addEventListener('keydown', key, true);
      element.addEventListener('move-out', moveOut);
      host.current.append(element);
      // The note formula's caret and selection colours.
      const styles = document.createElement('style');
      styles.textContent = mathFieldStyles;
      element.shadowRoot?.append(styles);
      element.menuItems = [];
      element.inlineShortcuts = {
        ...element.inlineShortcuts,
        ...COMMAND_SHORTCUTS,
      };
      element.setValue(initial.current, { silenceNotifications: true });
      field.current = element;
      callbacks.current.register(element);
      if (autoFocus) element.focus();
      // Keep the phone keyboard inside the dialog's focus boundary.
      const dialog = host.current.closest<HTMLElement>(
        '[data-slot="dialog-content"]'
      );
      const focus = () => {
        window.mathVirtualKeyboard.container = dialog ?? document.body;
      };
      element.addEventListener('focus', focus);
      cleanup = () => {
        element.removeEventListener('input', input);
        element.removeEventListener('keydown', key, true);
        element.removeEventListener('move-out', moveOut);
        element.removeEventListener('focus', focus);
        callbacks.current.register(null);
        element.remove();
        field.current = null;
      };
    };
    const registered = customElements.get('math-field') as
      | typeof MathfieldElement
      | undefined;
    if (registered) mount(registered);
    else
      import('mathlive').then(({ MathfieldElement }) =>
        mount(MathfieldElement)
      );
    return () => {
      cancelled = true;
      cleanup();
    };
  }, []);
  useEffect(() => {
    field.current?.setAttribute('aria-label', label);
  });
  // A point dragged on the board rewrites its row.
  useEffect(() => {
    if (field.current && field.current.value !== latex)
      field.current.setValue(latex, { silenceNotifications: true });
  }, [latex]);
  return (
    <span
      className="block min-w-0 [&_math-field::part(container)]:min-h-0 [&_math-field::part(content)]:p-0 [&_math-field::part(menu-toggle)]:hidden [&_math-field::part(virtual-keyboard-toggle)]:hidden"
      ref={host}
    />
  );
}
