/** A formula laid out by KaTeX, kept as drawing steps any canvas replays: the board's
 * formula cards and formulas on a plane. KaTeX loads on first use. */

const FONT_SIZE = 24;
/** What MathLive writes that KaTeX has no command for. */
export const KATEX_OPTIONS = {
  macros: {
    '\\differentialD': '\\mathrm{d}',
    '\\exponentialE': '\\mathrm{e}',
    '\\imaginaryI': '\\mathrm{i}',
    '\\placeholder': '\\square',
  },
  // A formula asks for no more than this many ems, or expansions, whoever wrote it.
  maxExpand: 500,
  maxSize: 12,
  output: 'html',
  trust: false,
} as const;

/** KaTeX and its stylesheet, loaded once a board holds a formula or the formula editor
 * opens: most boards have none (84 KB gzipped). */
let katexLoad: Promise<typeof import('katex').default> | null = null;
export const loadKatex = () => {
  katexLoad ??= Promise.all([
    import('katex'),
    import('katex/dist/katex.min.css'),
  ]).then(
    ([module]) => module.default,
    (error) => {
      katexLoad = null;
      throw error;
    }
  );
  return katexLoad;
};

/** One step of drawing a formula, at its laid-out size from its top left. */
type Step =
  | {
      color: string;
      font: string;
      kind: 'text';
      text: string;
      x: number;
      y: number;
    }
  | { color: string; h: number; kind: 'rule'; w: number; x: number; y: number }
  | {
      clip: { h: number; w: number; x: number; y: number } | null;
      h: number;
      image: HTMLImageElement;
      kind: 'shape';
      w: number;
      x: number;
      y: number;
    };
/** A formula as glyphs, rules and stretched shapes, replayed at whatever size its card
 * has, so it stays sharp when the card grows or the board zooms in. */
export type Drawn = { h: number; steps: Step[]; w: number };

const drawings = new Map<string, Promise<Drawn>>();
const ready = new Map<string, Drawn>();

/** KaTeX lays a formula out in HTML, which BlockSuite's export (html2canvas) can't
 * read, so where its glyphs, rules and stretched SVGs sit is kept as steps the board
 * and the marking image draw. */
async function layOut(latex: string): Promise<Drawn> {
  const host = document.createElement('div');
  // The padding keeps tall glyphs and stretched delimiters inside the card.
  host.style.cssText = `position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;padding:${FONT_SIZE / 3}px 2px;font-size:${FONT_SIZE}px;font-weight:400;color:#000;white-space:nowrap;width:max-content`;
  const katex = await loadKatex();
  document.body.append(host);
  try {
    // Its own macros, or a \\gdef in one formula would change the others.
    katex.render(latex, host, {
      ...KATEX_OPTIONS,
      macros: { ...KATEX_OPTIONS.macros },
      throwOnError: false,
    });
    await document.fonts.ready;
    const box = host.getBoundingClientRect();
    const measure = document.createElement('canvas').getContext('2d');
    if (!measure) throw new Error('no canvas context');
    const steps: Step[] = [];
    const stretched: SVGElement[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.textContent?.trim() || !node.parentElement) return;
        const range = document.createRange();
        range.selectNodeContents(node);
        const at = range.getBoundingClientRect();
        const style = getComputedStyle(node.parentElement);
        const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        measure.font = font;
        const metrics = measure.measureText(node.textContent);
        const ascent = metrics.fontBoundingBoxAscent;
        const height = ascent + metrics.fontBoundingBoxDescent;
        steps.push({
          color: style.color,
          font,
          kind: 'text',
          text: node.textContent,
          x: at.left - box.x,
          y: at.top - box.y + (at.height - height) / 2 + ascent,
        });
        return;
      }
      if (!(node instanceof Element)) return;
      if (node instanceof SVGElement) {
        stretched.push(node);
        return;
      }
      const style = getComputedStyle(node);
      const at = node.getBoundingClientRect();
      const bottom = Number.parseFloat(style.borderBottomWidth);
      if (bottom > 0 && style.borderBottomStyle !== 'none')
        steps.push({
          color: style.borderBottomColor,
          h: bottom,
          kind: 'rule',
          w: at.width,
          x: at.left - box.x,
          y: at.bottom - bottom - box.y,
        });
      const top = Number.parseFloat(style.borderTopWidth);
      if (top > 0 && style.borderTopStyle !== 'none')
        steps.push({
          color: style.borderTopColor,
          h: top,
          kind: 'rule',
          w: at.width,
          x: at.left - box.x,
          y: at.top - box.y,
        });
      for (const child of node.childNodes) walk(child);
    };
    walk(host);
    for (const shape of stretched) {
      const at = shape.getBoundingClientRect();
      const copy = shape.cloneNode(true) as SVGElement;
      copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      copy.setAttribute('width', `${at.width}`);
      copy.setAttribute('height', `${at.height}`);
      copy.setAttribute('fill', '#000');
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(copy))}`;
      await image.decode();
      // KaTeX stretches a root's bar with a 400em SVG cut off by a parent.
      const cut = (function clipOf(el: Element | null): Element | null {
        if (!el || el === host) return null;
        return getComputedStyle(el).overflow === 'hidden'
          ? el
          : clipOf(el.parentElement);
      })(shape.parentElement)?.getBoundingClientRect();
      steps.push({
        clip: cut
          ? {
              h: cut.height,
              w: cut.width,
              x: cut.left - box.x,
              y: cut.top - box.y,
            }
          : null,
        h: at.height,
        image,
        kind: 'shape',
        w: at.width,
        x: at.left - box.x,
        y: at.top - box.y,
      });
    }
    return { h: box.height, steps, w: box.width };
  } finally {
    host.remove();
  }
}

/** Draws a laid-out formula from the context's origin at its laid-out size. */
export function replay(ctx: CanvasRenderingContext2D, { steps }: Drawn) {
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (const step of steps) {
    if (step.kind === 'text') {
      ctx.font = step.font;
      ctx.fillStyle = step.color;
      ctx.fillText(step.text, step.x, step.y);
    } else if (step.kind === 'rule') {
      ctx.fillStyle = step.color;
      ctx.fillRect(step.x, step.y, step.w, step.h);
    } else {
      ctx.save();
      if (step.clip) {
        ctx.beginPath();
        ctx.rect(step.clip.x, step.clip.y, step.clip.w, step.clip.h);
        ctx.clip();
      }
      ctx.drawImage(step.image, step.x, step.y, step.w, step.h);
      ctx.restore();
    }
  }
}

/** A formula laid out already, or nothing yet (`drawing` lays it out). */
export const laidOut = (latex: string) => ready.get(latex);

/** Forgets every laid-out formula, when the board closes. */
export function forgetFormulas() {
  ready.clear();
  drawings.clear();
}

export function drawing(latex: string) {
  let pending = drawings.get(latex);
  if (!pending) {
    pending = layOut(latex).then(
      (drawn) => {
        ready.set(latex, drawn);
        return drawn;
      },
      (error) => {
        // Not kept, so the next draw tries again.
        drawings.delete(latex);
        throw error;
      }
    );
    drawings.set(latex, pending);
  }
  return pending;
}
