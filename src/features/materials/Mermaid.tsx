import { useEffect, useRef, useState } from 'react';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';
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
 * without it a failed parse shows the message and the raw source.
 */
export function Mermaid({
  className,
  code,
  fill = false,
  theme,
  onError,
}: {
  /** Extra classes for the rendered diagram box. */
  className?: string;
  code: string;
  /** Stretch past the diagram's natural width to fill the box (a resized block). */
  fill?: boolean;
  theme?: MermaidTheme;
  onError?: (message: string | null) => void;
}) {
  const [result, setResult] = useState<{
    background: string;
    svg: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

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
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : '';
        setError(message);
        onErrorRef.current?.(message);
      })
      .finally(() => renderHost.remove());

    return () => {
      cancelled = true;
    };
  }, [code, theme]);

  if (error != null && !onError) {
    return (
      <div ref={containerRef}>
        <p className="mb-2 font-medium text-solid-error text-xs">
          {m.mermaid_failed()}
          {error ? `: ${error}` : ''}
        </p>
        <pre className="overflow-auto text-fg-muted text-xs">{code}</pre>
      </div>
    );
  }
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
