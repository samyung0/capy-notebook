import { useEffect, useRef, useState } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
import { type MermaidFailure, mermaidFailure } from './mermaidError';
import type { MermaidFont } from './mermaidPresets';
import {
  MERMAID_THEME_SWATCH,
  type MermaidTheme,
  mermaidTheme,
} from './mermaidThemes';

const fonts = new Map<string, Promise<void>>();

function loadFont({ family, url, weight = '400' }: MermaidFont) {
  const key = `${family}|${weight}`;
  let loading = fonts.get(key);
  if (!loading) {
    loading = new FontFace(family, `url(${url})`, { weight })
      .load()
      .then((face) => {
        document.fonts.add(face);
      })
      // The diagram still draws in the theme's fallback font; retry next time.
      .catch(() => {
        fonts.delete(key);
      });
    fonts.set(key, loading);
  }
  return loading;
}

const SVG_OPEN = /<svg[^>]*>/;

let queue: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

/**
 * Renders one diagram in a theme. mermaid.initialize is global, so renders run
 * one at a time and each sets its own preset; the output CSS is scoped to the
 * SVG's id, so blocks with different themes coexist on a page.
 */
export function renderMermaid(
  code: string,
  theme?: MermaidTheme,
  container?: Element
) {
  const run = queue.then(async () => {
    const [{ default: mermaid }, { MERMAID_PRESETS, roughenFilters }] =
      await Promise.all([import('mermaid'), import('./mermaidPresets')]);
    const preset = MERMAID_PRESETS[mermaidTheme(theme)];
    await Promise.all((preset.fonts ?? []).map(loadFont));
    mermaid.initialize({
      securityLevel: 'strict',
      startOnLoad: false,
      ...preset.config,
    });
    // A fresh id each time: mermaid removes any element that already has it.
    const id = `mmd-${++renderSeq}`;
    let { svg } = await mermaid.render(id, code.trim(), container);
    if (preset.roughen) {
      svg = svg
        .replaceAll('url(#roughen', `url(#${id}-roughen`)
        .replace(SVG_OPEN, (open) => open + roughenFilters(`${id}-`));
    }
    return {
      background: String(preset.config.themeVariables?.background),
      svg,
    };
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Renders a mermaid code block to inline SVG on its theme's background. With
 * `onError` the last good diagram stays up and the parent shows the error;
 * without it a failed parse shows `MermaidError`.
 */
export function Mermaid({
  className,
  code,
  fill = false,
  theme,
  onDrawn,
  onError,
}: {
  /** Extra classes for the rendered diagram box. */
  className?: string;
  code: string;
  /** Stretch past the diagram's natural width to fill the box (a resized block). */
  fill?: boolean;
  theme?: MermaidTheme;
  /** Whether the current code drew; a failed one has nothing to preview. */
  onDrawn?: (drawn: boolean) => void;
  onError?: (failure: MermaidFailure | null) => void;
}) {
  const [result, setResult] = useState<{
    background: string;
    svg: string;
  } | null>(null);
  const [error, setError] = useState<MermaidFailure | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onDrawnRef = useRef(onDrawn);
  onDrawnRef.current = onDrawn;

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;
    // Same text styles as the display box, so measured labels fit when shown.
    const renderHost = document.createElement('div');
    renderHost.className = MERMAID_TEXT_CLASS;
    Object.assign(renderHost.style, {
      height: '0',
      left: '0',
      overflow: 'hidden',
      position: 'fixed',
      top: '0',
      visibility: 'hidden',
      width: `${container.clientWidth || window.innerWidth}px`,
    });
    document.body.append(renderHost);

    renderMermaid(code, theme, renderHost)
      .then((next) => {
        if (cancelled) return;
        setResult(next);
        setError(null);
        onErrorRef.current?.(null);
        onDrawnRef.current?.(true);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const failure = mermaidFailure(e, code);
        setError(failure);
        onErrorRef.current?.(failure);
        onDrawnRef.current?.(false);
      })
      .finally(() => renderHost.remove());

    return () => {
      cancelled = true;
    };
  }, [code, theme]);

  if (error != null && !onError) {
    return (
      <div ref={containerRef}>
        <MermaidError code={code} failure={error} />
      </div>
    );
  }
  // The parent shows the error and nothing has drawn yet: an empty box.
  if (!result && error != null)
    return <div className="h-40" ref={containerRef} />;
  if (!result) {
    return (
      <div
        className="grid h-40 place-items-center text-fg-muted"
        ref={containerRef}
      >
        <span className="text-xs">{m.mermaid_rendering()}</span>
      </div>
    );
  }
  return (
    <div
      className={cn(
        'mermaid-render flex justify-center overflow-auto rounded-lg p-3',
        // Matches MediaFrame's MAX_HEIGHT; the SVG scales down to fit.
        '[&>svg]:max-h-[min(70vh,48rem)]',
        // Mermaid caps the SVG at its natural width with an inline style.
        fill && '[&>svg]:max-w-none!',
        className,
        MERMAID_TEXT_CLASS
      )}
      // eslint-disable-next-line react/no-danger -- mermaid returns sanitized SVG (securityLevel: strict)
      dangerouslySetInnerHTML={{ __html: result.svg }}
      ref={containerRef}
      style={{ background: result.background }}
    />
  );
}

const MERMAID_TEXT_CLASS = 'font-normal leading-normal';

/** A theme's panel with one node in its fill and border, for theme menus. */
export function MermaidSwatch({
  theme,
  className,
}: {
  theme: MermaidTheme;
  className?: string;
}) {
  const [panel, fill, border] = MERMAID_THEME_SWATCH[theme];
  return (
    <span
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-sm ring-1 ring-fg/40',
        className
      )}
      style={{ background: panel }}
    >
      <span
        className="h-1.5 w-2.5 rounded-[2px] border"
        style={{ background: fill, borderColor: border }}
      />
    </span>
  );
}

/** The line mermaid blamed, or that the diagram could not be drawn at all. */
export function mermaidFailureMessage(failure: MermaidFailure) {
  return failure.line == null
    ? m.mermaid_failed()
    : m.mermaid_syntax_error({ line: failure.line });
}

/** A diagram that cannot be drawn: the message, then its source with the
 * blamed line marked, the way the source editor marks it. */
export function MermaidError({
  code,
  failure,
}: {
  code: string;
  failure: MermaidFailure;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="font-semibold text-sm text-solid-error">
        {mermaidFailureMessage(failure)}
      </p>
      <pre className="overflow-x-auto font-mono text-[13px] leading-[22px] [font-variant-ligatures:none]">
        {code.split('\n').map((text, index) => {
          const bad = index + 1 === failure.line;
          return (
            // Lines never reorder; the index is the line number.
            <div className={cn('flex', bad && 'bg-tint-error')} key={index}>
              <span
                className={cn(
                  'w-11 shrink-0 select-none pr-3.5 text-right text-fg-muted',
                  bad && 'font-bold text-solid-error'
                )}
              >
                {index + 1}
              </span>
              <span
                className={cn(
                  'pr-4',
                  bad &&
                    'underline decoration-solid-error decoration-wavy underline-offset-4'
                )}
              >
                {text || ' '}
              </span>
            </div>
          );
        })}
      </pre>
    </div>
  );
}
