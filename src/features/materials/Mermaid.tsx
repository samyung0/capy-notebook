import { useEffect, useRef, useState } from 'react';
import { getLocale, m } from '@/i18n';
import { THEMES } from '@/theme/ThemeProvider';

/** Lazily-initialized mermaid singleton so the (heavy) library is only loaded
 * when a diagram is actually rendered. */
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;
async function getMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const mermaid = mod.default;
      const dark = THEMES.filter((theme) => theme.isDark).some((theme) =>
        document.documentElement.classList.contains(theme.value)
      );
      mermaid.initialize({
        fontFamily: 'inherit',
        securityLevel: 'strict',
        startOnLoad: false,
        theme: dark ? 'dark' : 'default',
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

let idSeq = 0;

/** Renders a mermaid code block to inline SVG. Falls back to the raw source in
 * a <pre> if the diagram fails to parse. */
export function Mermaid({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idRef = useRef(`mmd-${++idSeq}`);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let rendering = false;
    const container = containerRef.current;
    if (!container) return;
    const renderHost = document.createElement('div');
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
    setError(null);

    void (async () => {
      try {
        const mermaid = await getMermaid();
        if (cancelled) return;
        rendering = true;
        const result = await mermaid.render(
          idRef.current,
          code.trim(),
          renderHost
        );
        if (!cancelled) setSvg(result.svg);
      } catch (e: unknown) {
        if (!cancelled) setError(e instanceof Error ? e.message : '');
      } finally {
        renderHost.remove();
      }
    })();

    return () => {
      cancelled = true;
      if (!rendering) renderHost.remove();
    };
    // getLocale is referenced so a locale change (and its theme) re-renders.
  }, [code, getLocale?.()]);

  if (error != null) {
    return (
      <div
        className="my-3 rounded-card border border-solid-error/40 bg-tint-error/40 p-3"
        ref={containerRef}
      >
        <p className="mb-2 font-medium text-solid-error text-xs">
          {m.mermaid_failed()}
          {error ? `: ${error}` : ''}
        </p>
        <pre className="overflow-auto text-fg-muted text-xs">{code}</pre>
      </div>
    );
  }
  if (!svg) {
    return (
      <div
        className="my-3 grid h-40 place-items-center rounded-card border border-line bg-surface text-fg-muted"
        ref={containerRef}
      >
        <span className="text-xs">{m.mermaid_rendering()}</span>
      </div>
    );
  }
  return (
    <div
      className="mermaid-render my-3 flex justify-center overflow-auto rounded-card border border-line bg-surface p-4"
      // eslint-disable-next-line react/no-danger -- mermaid returns sanitized SVG (securityLevel: strict)
      dangerouslySetInnerHTML={{ __html: svg }}
      ref={containerRef}
    />
  );
}
