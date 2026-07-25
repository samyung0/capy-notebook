import { useEffect, useState } from 'react';

/** Lazily-initialized KaTeX singleton so the (heavy) library and its CSS are
 * only loaded when an equation is actually rendered. */
let katexPromise: Promise<typeof import('katex').default> | null = null;
function getKatex() {
  if (!katexPromise) {
    katexPromise = Promise.all([
      import('katex'),
      import('katex/dist/katex.min.css'),
    ]).then(([mod]) => mod.default);
  }
  return katexPromise;
}

/** Renders a TeX expression to HTML. Shows the raw source until KaTeX loads,
 * or if rendering fails. */
export function Katex({
  tex,
  displayMode,
}: {
  tex: string;
  displayMode: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getKatex()
      .then((katex) => {
        if (cancelled) return;
        try {
          setHtml(
            katex.renderToString(tex || '', {
              displayMode,
              throwOnError: false,
            })
          );
        } catch {
          setHtml(null);
        }
      })
      .catch(() => {
        if (!cancelled) setHtml(null);
      });
    return () => {
      cancelled = true;
    };
  }, [tex, displayMode]);

  if (html == null) return <span>{tex}</span>;
  // eslint-disable-next-line react/no-danger -- KaTeX output with throwOnError: false
  return <span dangerouslySetInnerHTML={{ __html: html }} />;
}
