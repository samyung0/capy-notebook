import type { MathfieldElement } from 'mathlive';
import { useEffect, useLayoutEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import { getLocale } from '@/i18n';
import { COMMAND_SHORTCUTS } from './graphSyntax';
import mathFieldStyles from './mathField.css?inline';

export interface GraphRowFieldProps {
  autoFocus?: boolean;
  label: string;
  latex: string;
  /** The row's LaTeX, which the row parser reads. */
  onChange: (latex: string) => void;
  onEnter: () => void;
  /** Arrow keys past the first or last line of the formula. */
  onMoveOut: (direction: 'up' | 'down') => void;
  /** Backspace in an empty row. */
  onRemoveEmpty?: () => void;
  /** What the empty new row shows, as the plane's list: "Type a formula". */
  placeholder?: string;
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
  placeholder,
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
  // What the row last heard or was set to: MathLive reports typing a task
  // later, so a key that acts on the row sends what is typed first.
  const sent = useRef(latex);
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
        'display:block;width:100%;padding:0;background:transparent;border:0;outline:0;color:inherit;font-size:15px;line-height:1.2;';
      const input = () => {
        if (element.value === sent.current) return;
        sent.current = element.value;
        callbacks.current.onChange(element.value);
      };
      // Row keys stop here, before MathLive's handler inside the shadow root.
      const key = (event: KeyboardEvent) => {
        // Escape leaves the row first, as the plane's list did (the editor
        // closes on the next one), not MathLive's LaTeX mode.
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopImmediatePropagation();
          element.blur();
          return;
        }
        const enter = event.key === 'Enter';
        const removes =
          event.key === 'Backspace' &&
          !element.value &&
          callbacks.current.onRemoveEmpty;
        if (!(enter || removes)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        // The typing still on its way lands and renders first: Enter typed
        // fast in the new row moves to the row that typing made after it.
        flushSync(input);
        const { onEnter, onRemoveEmpty } = callbacks.current;
        (enter ? onEnter : onRemoveEmpty)?.();
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
      if (placeholder) element.placeholder = `\\text{${placeholder}}`;
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
    if (field.current && field.current.value !== latex) {
      field.current.setValue(latex, { silenceNotifications: true });
      sent.current = latex;
    }
  }, [latex]);
  return (
    <span
      className="block min-w-0 [&_math-field::part(container)]:min-h-0 [&_math-field::part(content)]:p-0 [&_math-field::part(menu-toggle)]:hidden [&_math-field::part(placeholder)]:text-placeholder [&_math-field::part(virtual-keyboard-toggle)]:hidden"
      ref={host}
    />
  );
}
