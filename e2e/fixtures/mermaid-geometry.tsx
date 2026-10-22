import { drawOnPage, renderMermaid } from '@/features/materials/Mermaid';
import type { MermaidTheme } from '@/features/materials/mermaidThemes';
import '@/styles/tailwind.css';

/*
 * The worker's drawing of a diagram against the page's own (the same
 * mermaid.js measuring in the browser), for the per-type geometry check
 * (mermaid-geometry.spec.ts): every element in document order, its numbers
 * (positions, sizes, path points, transforms, the viewBox) and its text.
 */

/** Attributes that place or size an element. */
const NUMERIC = [
  'cx',
  'cy',
  'd',
  'dx',
  'dy',
  'height',
  'points',
  'r',
  'rx',
  'ry',
  'transform',
  'viewBox',
  'width',
  'x',
  'x1',
  'x2',
  'y',
  'y1',
  'y2',
];
const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi;

interface Shape {
  /** Its id or class, to name it in a report. */
  name: string;
  numbers: Record<string, number[]>;
  path: string;
  text: string;
}

/** The drawing's elements, its own render id replaced so two drawings of
 * one source compare. */
function shapes(svg: string): Shape[] {
  const id = /<svg[^>]*\sid="([^"]+)"/.exec(svg)?.[1] ?? '';
  const doc = new DOMParser().parseFromString(
    svg.replaceAll(id, 'mmd-geometry'),
    'text/html'
  );
  const root = doc.querySelector('svg');
  if (!root) throw new Error('no SVG');
  return [root, ...root.querySelectorAll('*')].map((element) => {
    const numbers: Record<string, number[]> = {};
    for (const name of NUMERIC) {
      const value = element.getAttribute(name);
      if (value != null)
        numbers[name] = (value.match(NUMBER) ?? []).map(Number);
    }
    const maxWidth = /max-width:\s*([\d.]+)px/.exec(
      element.getAttribute('style') ?? ''
    );
    if (maxWidth) numbers['max-width'] = [Number(maxWidth[1])];
    const tag = element.tagName.toLowerCase();
    return {
      name: element.id || (element.getAttribute('class') ?? ''),
      numbers,
      path: tag,
      // The stylesheet differs in text only: the page's mermaid reads the
      // theme CSS back through the browser's parser, the worker keeps it.
      text:
        element.children.length === 0 && tag !== 'style'
          ? (element.textContent ?? '').trim()
          : '',
    };
  });
}

export interface GeometryReport {
  /** The first element below the root off by more than 1 px, for a failure
   * to name where the drawings part (the root's viewBox only sums it up). */
  first: string;
  /** Largest difference of any number, in px. */
  maxDiff: number;
  /** Element sequence or text that differs, if any. */
  structure: string | null;
  viewBox: { page: number[]; worker: number[] };
  /** Where it was: element index, tag, attribute, page and worker value. */
  worst: string;
}

function compare(page: string, worker: string): GeometryReport {
  const a = shapes(page);
  const b = shapes(worker);
  let structure: string | null =
    a.length === b.length ? null : `${a.length} elements vs ${b.length}`;
  let maxDiff = 0;
  let worst = '';
  let first = '';
  for (let i = 0; i < Math.min(a.length, b.length) && !structure; i++) {
    const [pa, pb] = [a[i]!, b[i]!];
    if (pa.path !== pb.path || pa.text !== pb.text) {
      structure = `#${i}: ${pa.path} "${pa.text}" vs ${pb.path} "${pb.text}"`;
      break;
    }
    for (const [name, values] of Object.entries(pa.numbers)) {
      const other = pb.numbers[name] ?? [];
      if (other.length !== values.length) {
        structure = `#${i} ${pa.path} ${name}: ${values.length} numbers vs ${other.length}`;
        break;
      }
      values.forEach((value, k) => {
        const diff = Math.abs(value - other[k]!);
        if (i > 0 && diff > 1 && !first)
          first = `#${i} ${pa.path} "${pa.name}" "${pa.text.slice(0, 40)}" ${name}[${k}]: ${value} vs ${other[k]}`;
        if (diff > maxDiff) {
          maxDiff = diff;
          worst = `#${i} ${pa.path} "${pa.name}" ${name}[${k}]: ${value} vs ${other[k]}`;
        }
      });
    }
  }
  return {
    first,
    maxDiff,
    structure,
    viewBox: {
      page: a[0]?.numbers.viewBox ?? [],
      worker: b[0]?.numbers.viewBox ?? [],
    },
    worst,
  };
}

declare global {
  interface Window {
    mermaidGeometry: (
      code: string,
      theme: MermaidTheme,
      width: number
    ) => Promise<GeometryReport>;
  }
}

window.mermaidGeometry = async (code, theme, width) => {
  // The worker first: the page's drawing then replaces it in the cache.
  const worker = await renderMermaid(code, theme, { width });
  const page = await drawOnPage(code, theme, width);
  return compare(page.svg, worker.svg);
};
document.body.dataset.ready = 'true';
