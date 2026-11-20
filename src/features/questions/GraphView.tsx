import { type CSSProperties, useContext, useEffect, useRef } from 'react';
import { graphCode, useCodeFailed } from '@/features/materials/blockCode';
import { CannotShow } from '@/features/materials/CannotShow';
import { ThemeContext } from '@/theme/theme';
import type { GraphBlock } from './types';

/**
 * A quiz, note or bank graph drawn from its elements by the engine wherever
 * it shows: no picture is stored (Epo 2026-11-16). The box has the graph's
 * size and shape before anything draws, at most its column's width, so a
 * shared page's server HTML holds it and nothing shifts; the browser draws
 * into it once its script runs. On screen it follows the app's theme as a
 * plane card does; exports draw light (`graphSvg`). If the engine could not
 * load, it says so in the graph's place (Epo 2026-11-20), never staying
 * blank; its formulas load KaTeX as they draw, and a failure there leaves
 * the rest of the graph.
 */
export function GraphView({ block }: { block: GraphBlock }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  // Shared pages have no ThemeProvider: their theme is the page's class.
  const themeDark = useContext(ThemeContext)?.isDark;
  const failed = useCodeFailed(graphCode);
  // Again once its notice goes: a Preview opened again draws what it gave up on.
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    const dark =
      themeDark ?? document.documentElement.classList.contains('dark');
    let stop: (() => void) | undefined;
    let cancelled = false;
    graphCode.load().then(
      ({ paintGraph }) => {
        if (!cancelled) stop = paintGraph(target, block, dark);
      },
      // Shown through useCodeFailed.
      () => undefined
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, [block, failed, themeDark]);
  if (failed) return <CannotShow />;
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
