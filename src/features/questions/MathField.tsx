import type { MathfieldElement } from 'mathlive';
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { IconButton } from '@/components/ui/IconButton';
import { getLocale, m } from '@/i18n';
import { cn } from '@/lib/cn';
import mathFieldStyles from './mathField.css?inline';

export interface MathFieldControls {
  showMenu: (event: MouseEvent<HTMLButtonElement>) => void;
  toggleKeyboard?: () => void;
}

export interface MathFieldProps {
  autoFocus?: boolean;
  displayMode?: boolean;
  minHeight?: number;
  onCancel?: () => void;
  onChange: (value: string) => void;
  onCommit?: (value: string) => void;
  onControlsReady?: (controls: MathFieldControls | null) => void;
  value: string;
}

/** Shared by the small question editor and the note equation voids. */
export function MathField({
  value,
  onChange,
  onCommit,
  onCancel,
  onControlsReady,
  displayMode,
  minHeight,
  autoFocus = true,
}: MathFieldProps) {
  const host = useRef<HTMLSpanElement>(null);
  const field = useRef<MathfieldElement | null>(null);
  const callbacks = useRef({ onCancel, onChange, onCommit, onControlsReady });
  callbacks.current = { onCancel, onChange, onCommit, onControlsReady };
  const initial = useRef(value);
  const [error, setError] = useState('');
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  const toggleKeyboard = useCallback(() => {
    if (!field.current) return;
    field.current.focus();
    window.mathVirtualKeyboard.visible = !window.mathVirtualKeyboard.visible;
  }, []);
  const showMenu = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const element = field.current;
    if (!element) return;
    element.focus();
    const button = event.currentTarget.getBoundingClientRect();
    element.showMenu({
      location: { x: button.left, y: button.bottom + 4 },
      modifiers: { alt: false, control: false, meta: false, shift: false },
    });
  }, []);
  useLayoutEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    const mount = (
      MathfieldElement: typeof import('mathlive').MathfieldElement
    ) => {
      if (cancelled || !host.current) return;
      MathfieldElement.fontsDirectory = '/mathlive/fonts';
      MathfieldElement.soundsDirectory = null;
      MathfieldElement.locale = getLocale();
      const element = new MathfieldElement();
      element.defaultMode = displayMode ? 'math' : 'inline-math';
      element.mathVirtualKeyboardPolicy = 'manual';
      element.setAttribute('aria-label', m.question_ui_formula());
      element.style.cssText =
        'min-width:1em;max-width:100%;padding:0;background:transparent;border:0;outline:0;color:inherit;font-size:1.21em;font-weight:400;font-style:normal;line-height:1.2;';
      if (initial.current) element.style.minWidth = '0';
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
          element.menuItems = [];
          callbacks.current.onCommit?.(element.value);
        }
      };
      const blur = commit;
      const isConjugateBoundary = (position: number) => {
        if (position < 0 || position > element.lastOffset) return false;
        const info = element.getElementInfo(position);
        if (!info?.depth) return false;
        // Match MathLive's accent navigation: omit the empty first child
        // and the last child position that duplicates the enclosing overline.
        for (let end = position + 1; end <= element.lastOffset; end++) {
          const parent = element.getElementInfo(end);
          if (parent?.depth !== undefined && parent.depth < info.depth) {
            return (
              parent.depth === info.depth - 1 &&
              !!parent.latex?.startsWith('\\overline{')
            );
          }
          if (info.latex !== '') return false;
        }
        return false;
      };
      const conjugateArrow = (event: KeyboardEvent) => {
        if (
          (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') ||
          event.shiftKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          !element.selectionIsCollapsed ||
          event
            .composedPath()
            .some(
              (target) =>
                target instanceof Element && target.matches('[role="menu"]')
            )
        )
          return;
        const forward = event.key === 'ArrowRight';
        if (!isConjugateBoundary(element.position + (forward ? 1 : -1))) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        let previous: number;
        do {
          previous = element.position;
          element.executeCommand(
            forward ? 'moveToNextChar' : 'moveToPreviousChar'
          );
        } while (
          element.position !== previous &&
          isConjugateBoundary(element.position)
        );
      };
      const textBoundaryKey = (event: KeyboardEvent) => {
        if (
          event.key !== '-' ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          element.mode !== 'text' ||
          !element.selectionIsCollapsed
        )
          return;
        const position = element.position;
        // Let MathLive's native -> shortcut start outside a text run.
        const before = element.getValue(
          Math.max(0, position - 1),
          position,
          'latex-unstyled'
        );
        const after = element.getValue(
          position,
          Math.min(element.lastOffset, position + 1),
          'latex-unstyled'
        );
        if (!before.startsWith('\\text{') || !after.startsWith('\\text{')) {
          element.mode = 'math';
        }
      };
      const key = (event: KeyboardEvent) => {
        event.stopPropagation();
        // Menu Escape/Enter belong to MathLive, not the enclosing editor.
        if (
          event
            .composedPath()
            .some(
              (target) =>
                target instanceof Element && target.matches('[role="menu"]')
            )
        )
          return;
        if (event.key === 'Escape') {
          event.preventDefault();
          if (window.mathVirtualKeyboard.visible) {
            window.mathVirtualKeyboard.hide();
            return;
          }
          finished = true;
          element.menuItems = [];
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
      element.addEventListener('keydown', textBoundaryKey, true);
      element.addEventListener('keydown', conjugateArrow, true);
      host.current.append(element);
      element.menuItems = element.menuItems.filter((item) =>
        ['insert-matrix', 'insert', 'mode', 'copy', 'paste'].includes(
          'id' in item ? (item.id ?? '') : ''
        )
      );
      const styles = document.createElement('style');
      styles.textContent = mathFieldStyles;
      element.shadowRoot?.append(styles);
      element.setValue(initial.current, {
        selectionMode: 'after',
        silenceNotifications: true,
      });
      field.current = element;
      // Keep keyboard taps inside the modal's focus and pointer boundary.
      window.mathVirtualKeyboard.container =
        host.current.closest<HTMLElement>('[data-slot="dialog-content"]') ??
        document.body;
      const keyboardChanged = () =>
        setKeyboardVisible(window.mathVirtualKeyboard.visible);
      window.mathVirtualKeyboard.addEventListener(
        'virtual-keyboard-toggle',
        keyboardChanged
      );
      callbacks.current.onControlsReady?.({
        showMenu,
        toggleKeyboard: displayMode ? toggleKeyboard : undefined,
      });
      const dismissKeyboard = (event: PointerEvent) => {
        if (!window.mathVirtualKeyboard.visible) return;
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (
          host.current?.parentElement?.contains(target) ||
          target.closest(
            '.ML__keyboard, .MLK__variant-panel, [data-math-keyboard-toggle]'
          )
        )
          return;
        window.mathVirtualKeyboard.hide();
      };
      document.addEventListener('pointerdown', dismissKeyboard, true);
      if (autoFocus) element.focus();
      cleanup = () => {
        finished = true;
        // MathLive doesn't dispose its shared menu overlay on disconnect.
        // Close it while the field is still mounted, including pending submenus.
        element.menuItems = [];
        document.removeEventListener('pointerdown', dismissKeyboard, true);
        callbacks.current.onControlsReady?.(null);
        window.mathVirtualKeyboard.removeEventListener(
          'virtual-keyboard-toggle',
          keyboardChanged
        );
        window.mathVirtualKeyboard.hide();
        window.mathVirtualKeyboard.container = document.body;
        element.removeEventListener('beforeinput', beforeInput);
        element.removeEventListener('input', input);
        element.removeEventListener('blur', blur);
        element.removeEventListener('keydown', key);
        element.removeEventListener('keydown', textBoundaryKey, true);
        element.removeEventListener('keydown', conjugateArrow, true);
        element.remove();
        field.current = null;
      };
    };
    const failed = () =>
      setError(
        m.question_ui_formula_editor_could_not_load_close_and_try_again()
      );
    // A preview already registered MathLive. Mount before React's first paint
    // instead of leaving an empty wrapper while a cached import resolves.
    const registered = customElements.get('math-field') as
      | typeof MathfieldElement
      | undefined;
    if (registered) {
      try {
        mount(registered);
      } catch {
        failed();
      }
    } else {
      import('mathlive')
        .then(({ MathfieldElement }) => mount(MathfieldElement))
        .catch(failed);
    }
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [autoFocus, displayMode, toggleKeyboard, showMenu]);
  useEffect(() => {
    if (field.current && field.current.value !== value)
      field.current.value = value;
  }, [value]);
  return (
    <span
      className={cn(
        'relative inline-block max-w-full align-baseline outline-2 outline-action-accent -outline-offset-2 [&_math-field::part(container)]:min-h-0 [&_math-field::part(content)]:p-0 [&_math-field::part(menu-toggle)]:hidden [&_math-field::part(virtual-keyboard-toggle)]:hidden',
        !onControlsReady &&
          !displayMode &&
          'z-10 -my-2 -mr-9 -ml-2 py-2 pr-9 pl-2',
        displayMode
          ? 'block min-h-14 text-center [&_math-field::part(container)]:px-6 [&_math-field::part(container)]:py-4 [&_math-field::part(content)]:justify-center [&_math-field]:block'
          : '[&_math-field::part(container)]:p-0'
      )}
      contentEditable={false}
      style={displayMode ? { minHeight } : undefined}
    >
      <span ref={host} />
      {!onControlsReady && (
        <span
          className={cn(
            'absolute top-1/2 right-2 flex -translate-y-1/2 flex-col gap-0.5',
            !displayMode && 'rounded bg-surface'
          )}
        >
          {displayMode && (
            <IconButton
              aria-expanded={keyboardVisible}
              className="size-5 p-0.5"
              icon="keyboard"
              label={m.question_ui_formula_keyboard()}
              onClick={toggleKeyboard}
              onMouseDown={(event) => event.preventDefault()}
              size="sm"
              tooltip={false}
              type="button"
              variant="ghost"
            />
          )}
          <IconButton
            aria-haspopup="menu"
            className="size-5 p-0.5"
            icon="menu"
            label={m.question_ui_formula_menu()}
            onClick={showMenu}
            onMouseDown={(event) => event.preventDefault()}
            size="sm"
            tooltip={false}
            type="button"
            variant="ghost"
          />
        </span>
      )}
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
