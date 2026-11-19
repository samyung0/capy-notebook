import { type CSSProperties, useContext, useEffect, useRef } from 'react';
import { ThemeContext } from '@/theme/theme';
import type { GraphBlock } from './types';

/**
 * A quiz, note or bank graph drawn from its elements by the engine wherever
 * it shows: no picture is stored (Epo 2026-11-16). The box has the graph's
 * size and shape before anything draws, at most its column's width, so a
 * shared page's server HTML holds it and nothing shifts; the browser draws
 * into it once its script runs. On screen it follows the app's theme as a
 * plane card does; exports draw light (`graphSvg`).
 */
export function GraphView({ block }: { block: GraphBlock }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Shared pages have no ThemeProvider: their theme is the page's class.
  const themeDark = useContext(ThemeContext)?.isDark;
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const dark =
      themeDark ?? document.documentElement.classList.contains('dark');
    let stop: (() => void) | undefined;
    let cancelled = false;
    import('./graphPaint').then(({ paintGraph }) => {
      if (!cancelled) stop = paintGraph(target, block, dark);
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [block, themeDark]);
  return (
    <canvas
      // Without a description it is decorative, as an image without alt text.
      {...(block.description
        ? { 'aria-label': block.description, role: 'img' }
        : { 'aria-hidden': true })}
      className="block h-auto w-(--graph-width) max-w-full"
      ref={canvas}
      style={
        {
          '--graph-width': `${block.width}px`,
          aspectRatio: `${block.width} / ${block.height}`,
        } as CSSProperties
      }
    />
  );
}
