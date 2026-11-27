import type { MathfieldElement } from 'mathlive';
import {
  type ReactNode,
  type Ref,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { cn } from '@/lib/cn';
import { inertTex } from './inertTex';
import { loadedMathLive, loadMathLive, loadMathLiveModule } from './mathLive';
import { markupIsInert } from './mathTripwire';

/** The editing field's type: its size and weight, and serif text zones
 * (mathlive-static.css reads `--_text-font-family`, which only the field's
 * container sets). */
const DISPLAY_STYLE =
  'font-size:1.21em;font-weight:400;line-height:1.2;--_text-font-family:KaTeX_Main,"Times New Roman",serif';
/** An inline formula sits as the inline field did: capped at its line's
 * width, and the larger formula would otherwise grow its line box and push
 * the text below the baseline of neighbouring text. One wider than its line
 * runs past it, as the field's content did. */
const INLINE_STYLE = `${DISPLAY_STYLE};display:inline-block;max-width:100%;margin-block:-0.25em`;

/** An empty template slot, however MathLive writes it (`\placeholder{}`, or
 * with an id). */
const EMPTY_SLOT = /\\placeholder(?![a-zA-Z])/;

/** The LaTeX drawn, the stored one unchanged. MathLive 0.110 has no \dots;
 * show \ldots. */
const drawn = (tex: string) =>
  inertTex(tex.replace(/\\dots(?![a-zA-Z])/g, '\\ldots'));

/** A formula that is not being edited (Epo 2026-11-27, Q912): MathLive's
 * static markup, the shared page's renderer, with the editing field's layout
 * engine and fonts but no field, listeners or layout reads per formula. A
 * formula with an empty template slot keeps a read-only field, which draws
 * the slot's box where static markup leaves it blank (Q915). */
export function MathPreview(props: { tex: string; displayMode: boolean }) {
  return EMPTY_SLOT.test(props.tex) ? (
    <FieldPreview {...props} />
  ) : (
    <MarkupPreview {...props} />
  );
}

function MarkupPreview({
  tex,
  displayMode,
}: {
  tex: string;
  displayMode: boolean;
}) {
  const host = useRef<HTMLSpanElement>(null);
  const [loaded, setLoaded] = useState(loadedMathLive);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (loaded) return;
    let cancelled = false;
    loadMathLive().then(
      (module) => {
        if (!cancelled) setLoaded(module);
      },
      () => {
        if (!cancelled) setFailed(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [loaded]);

  const formula = useMemo(() => {
    if (!loaded) return;
    const { mathlive } = loaded;
    const source = drawn(tex);
    try {
      // The static renderer lays everything out in display style; an inline
      // formula asks for text style, as an inline field draws it.
      const markup = mathlive.convertLatexToMarkup(
        displayMode ? source : `\\textstyle ${source}`
      );
      return {
        label: mathlive.convertLatexToSpeakableText(source),
        // The markup goes in without a sanitizer: a formula whose markup
        // trips the tripwire shows its TeX instead, as on share pages.
        markup: markupIsInert(markup) ? markup : undefined,
      };
    } catch {
      return { label: undefined, markup: undefined };
    }
  }, [displayMode, loaded, tex]);

  // The markup sits in the host's shadow root, as the field's drawing did, so
  // copying text around it does not pick up its glyphs.
  useLayoutEffect(() => {
    const element = host.current;
    if (!(element && loaded && formula)) return;
    const root = element.shadowRoot ?? element.attachShadow({ mode: 'open' });
    root.adoptedStyleSheets = [loaded.sheet];
    if (formula.markup === undefined) {
      // The TeX as text.
      root.replaceChildren(tex);
      return;
    }
    // MathLive's own markup for the stored LaTeX, which it escapes; the host's
    // label reads it out.
    const style = displayMode ? DISPLAY_STYLE : INLINE_STYLE;
    root.innerHTML = `<span aria-hidden="true" style='${style}'>${formula.markup}</span>`;
  }, [displayMode, formula, loaded, tex]);

  return (
    <MathHost displayMode={displayMode} label={formula?.label} ref={host}>
      {failed && tex}
    </MathHost>
  );
}

/** An inert, read-only MathLive field, in the editing field's layout. */
function FieldPreview({
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
    const mount = (Field: typeof MathfieldElement) => {
      if (cancelled || !host.current) return;
      Field.fontsDirectory = '/mathlive/fonts';
      const element = new Field();
      element.defaultMode = displayMode ? 'math' : 'inline-math';
      element.readOnly = true;
      element.inert = true;
      element.tabIndex = -1;
      element.mathVirtualKeyboardPolicy = 'manual';
      element.style.cssText =
        'padding:0;background:transparent;border:0;outline:0;color:inherit;font-size:1.21em;font-weight:400;font-style:normal;line-height:1.2;pointer-events:none;--text-font-family:KaTeX_Main,"Times New Roman",serif;';
      // A display formula keeps its full width (a capped field clips its own
      // content) and the host scrolls it.
      if (!displayMode) {
        element.style.maxWidth = '100%';
        element.style.marginBlock = '-0.25em';
      }
      // The initial render reads this attribute synchronously on connection.
      element.setAttribute('value', drawn(tex));
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
      loadMathLiveModule()
        .then(({ MathfieldElement }) => mount(MathfieldElement))
        .catch(fail);
    }
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [displayMode, tex]);

  return (
    <MathHost
      className="[&_math-field::part(container)]:min-h-0 [&_math-field::part(container)]:p-0 [&_math-field::part(content)]:p-0 [&_math-field::part(menu-toggle)]:hidden [&_math-field::part(virtual-keyboard-toggle)]:hidden"
      displayMode={displayMode}
      ref={host}
    >
      {failed && tex}
    </MathHost>
  );
}

function MathHost({
  children,
  className,
  displayMode,
  label,
  ref,
}: {
  children: ReactNode;
  className?: string;
  displayMode: boolean;
  label?: string;
  ref: Ref<HTMLSpanElement>;
}) {
  return (
    <span
      aria-label={label}
      className={cn(
        className,
        // A display formula wider than its column scrolls sideways in this
        // box and fades at the edge that hides more of it (so it shows no
        // scrollbar); `relative` keeps the formula's positioned parts inside
        // it, so the page never widens.
        displayMode &&
          'scroll-fade-x relative block overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
      )}
      data-math-preview=""
      ref={ref}
      role="math"
    >
      {children}
    </span>
  );
}
