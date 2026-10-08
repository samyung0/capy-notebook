import type { MathfieldElement } from 'mathlive';
import { useLayoutEffect, useRef, useState } from 'react';

/** Use the same layout as editing, including MathLive's empty template slots. */
export function MathPreview({
  tex,
  displayMode,
}: {
  tex: string;
  displayMode: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState(false);

  useLayoutEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    setFailed(false);
    const mount = (
      MathfieldElement: typeof import('mathlive').MathfieldElement
    ) => {
      if (cancelled || !host.current) return;
      MathfieldElement.fontsDirectory = '/mathlive/fonts';
      const element = new MathfieldElement();
      element.defaultMode = displayMode ? 'math' : 'inline-math';
      element.readOnly = true;
      element.inert = true;
      element.tabIndex = -1;
      element.mathVirtualKeyboardPolicy = 'manual';
      element.style.cssText =
        'max-width:100%;padding:0;background:transparent;border:0;outline:0;color:inherit;font-size:1.21em;font-weight:400;font-style:normal;line-height:1.2;pointer-events:none;--text-font-family:KaTeX_Main,"Times New Roman",serif;';
      // The larger inline formula would otherwise grow its line box and push
      // the text below the baseline of neighbouring text.
      if (!displayMode) element.style.marginBlock = '-0.25em';
      // The initial render reads this attribute synchronously on connection.
      // MathLive 0.110 has no \dots; show \ldots, keeping the stored LaTeX.
      element.setAttribute(
        'value',
        tex.replace(/\\dots(?![a-zA-Z])/g, '\\ldots')
      );
      host.current.append(element);
      cleanup = () => element.remove();
      host.current.setAttribute('aria-label', element.getValue('spoken-text'));
    };
    const fail = () => {
      cleanup();
      if (!cancelled) setFailed(true);
    };
    // Editing has already loaded MathLive; avoid an empty paint while importing.
    const registered = customElements.get('math-field') as
      | typeof MathfieldElement
      | undefined;
    if (registered) {
      try {
        mount(registered);
      } catch {
        fail();
      }
    } else {
      import('mathlive')
        .then(({ MathfieldElement }) => mount(MathfieldElement))
        .catch(fail);
    }
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [displayMode, tex]);

  return (
    <span
      className="[&_math-field::part(container)]:min-h-0 [&_math-field::part(container)]:p-0 [&_math-field::part(content)]:p-0 [&_math-field::part(menu-toggle)]:hidden [&_math-field::part(virtual-keyboard-toggle)]:hidden"
      data-math-preview=""
      ref={host}
      role="math"
    >
      {failed && tex}
    </span>
  );
}
