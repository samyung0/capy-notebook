import { useEffect, useRef, useState } from 'react';
import { getLocale } from '@/i18n';
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

  useEffect(() => {
    let cancelled = false;
    setError(null);
    getMermaid()
      .then((mermaid) => mermaid.render(idRef.current, code.trim()))
      .then(({ svg }) => {
        if (!cancelled) setSvg(svg);
      })
      .catch((e: unknown) => {
        if (!cancelled)
          setError(e instanceof Error ? e.message : 'Failed to render diagram');
      });
    return () => {
      cancelled = true;
    };
    // getLocale is referenced so a locale change (and its theme) re-renders.
  }, [code, getLocale?.()]);

  if (error) {
    return (
      <div className="my-3 rounded-card border border-solid-error/40 bg-tint-error/40 p-3">
        <p className="mb-2 font-medium text-solid-error text-xs">
          Diagram error: {error}
        </p>
        <pre className="overflow-auto text-fg-muted text-xs">{code}</pre>
      </div>
    );
  }
  if (!svg) {
    return (
      <div className="my-3 grid h-40 place-items-center rounded-card border border-line bg-surface text-fg-muted">
        <span className="text-xs">Rendering diagram…</span>
      </div>
    );
  }
  return (
    <div
      className="mermaid-render my-3 flex justify-center overflow-auto rounded-card border border-line bg-surface p-4"
      // eslint-disable-next-line react/no-danger -- mermaid returns sanitized SVG (securityLevel: strict)
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
