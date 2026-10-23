import mermaid from 'mermaid';
import { forPage, renderMermaid } from '@/features/materials/Mermaid';
import { drawMermaid } from '@/features/materials/mermaidDraw';
import { MermaidReasonError } from '@/features/materials/mermaidError';
import type { MermaidTheme } from '@/features/materials/mermaidThemes';
import '@/styles/tailwind.css';

/*
 * The worker's drawing of a diagram against the page's own (the same
 * mermaid.js measuring in the browser, which the app no longer does), for
 * the per-type geometry check (mermaid-geometry.spec.ts): every element in
 * document order, its numbers (positions, sizes, path points, transforms,
 * the viewBox) and its text.
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
  /** The type mermaid detects in the source. */
  type: string;
  viewBox: { page: number[]; worker: number[] };
  /** Where it was: element index, tag, attribute, page and worker value. */
  worst: string;
}

function compare(page: string, worker: string): Omit<GeometryReport, 'type'> {
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
    mermaidLabels: (
      code: string,
      theme: MermaidTheme,
      width: number
    ) => Promise<LabelReport>;
    mermaidOutcome: (code: string) => Promise<string>;
  }
}

let draws = 0;

/** Mermaid on this page, in a host styled as the app's diagram box. */
async function drawHere(code: string, theme: MermaidTheme, width: number) {
  const host = document.createElement('div');
  host.className = 'font-normal leading-normal';
  Object.assign(host.style, {
    height: '0',
    left: '0',
    overflow: 'hidden',
    position: 'fixed',
    top: '0',
    visibility: 'hidden',
    width: `${width}px`,
  });
  document.body.append(host);
  try {
    return await drawMermaid(code, theme, host, {
      id: `mmp-${++draws}`,
      width,
    });
  } finally {
    host.remove();
  }
}

window.mermaidGeometry = async (code, theme, width) => {
  const worker = await renderMermaid(code, theme, { width });
  // Through the same page pass as the worker's drawing, which drops what the
  // app never shows (a C4 person's icon is an image).
  const page = await forPage(await drawHere(code, theme, width));
  return {
    ...compare(page.svg, worker.svg),
    type: mermaid.detectType(code.trim()),
  };
};
export interface LabelReport {
  /** Worker labels whose text spills past their foreignObject, by over 1 px. */
  overflow: string[];
  /** Pairs of worker labels that overlap more than on the page, by over
   * 1 px (an overlap's depth is the shorter side of the two boxes' shared
   * rectangle). */
  overlaps: string[];
  /** The type mermaid detects in the source. */
  type: string;
}

/** Inserts a drawing at its natural size, laid out but out of sight. */
function laidOut(svg: string) {
  const host = document.createElement('div');
  host.className = 'font-normal leading-normal';
  Object.assign(host.style, {
    left: '-20000px',
    position: 'absolute',
    top: '0',
  });
  host.innerHTML = svg;
  const root = host.querySelector('svg');
  if (!root) throw new Error('no SVG');
  const { height, width } = root.viewBox.baseVal;
  root.setAttribute('width', String(width));
  root.setAttribute('height', String(height));
  root.style.maxWidth = 'none';
  document.body.append(host);
  return { host, root };
}

/** Each pair of labels that overlap, by their texts, with its depth. */
function overlapsIn(root: SVGSVGElement) {
  const labels = [...root.querySelectorAll('text, foreignObject > *')]
    .map((label) => ({
      box: label.getBoundingClientRect(),
      text: (label.textContent ?? '').trim(),
    }))
    .filter(({ box, text }) => text && box.width > 0 && box.height > 0);
  const depths = new Map<string, number>();
  labels.forEach((a, i) => {
    for (const b of labels.slice(i + 1)) {
      const depth = Math.min(
        Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left),
        Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top)
      );
      const key = [a.text, b.text].sort().join(' | ');
      if (depth > 0) depths.set(key, Math.max(depths.get(key) ?? 0, depth));
    }
  });
  return depths;
}

/** The worker's drawing laid out in this engine against the page's own,
 * for Firefox and WebKit, where positions differ by a few pixels (Epo
 * 2026-10-23): every label fits its box, and nothing overlaps more than on
 * the page. */
window.mermaidLabels = async (code, theme, width) => {
  const worker = laidOut((await renderMermaid(code, theme, { width })).svg);
  const page = laidOut((await forPage(await drawHere(code, theme, width))).svg);
  try {
    const overflow = [...worker.root.querySelectorAll('foreignObject')].flatMap(
      (box) => {
        const label = box.firstElementChild;
        // An empty label shows nothing to clip; Firefox lays its div out
        // wider than a sizeless foreignObject.
        if (!label?.textContent?.trim()) return [];
        const outer = box.getBoundingClientRect();
        const inner = label.getBoundingClientRect();
        const spill = Math.max(
          inner.right - outer.right,
          inner.bottom - outer.bottom,
          outer.left - inner.left,
          outer.top - inner.top
        );
        return spill > 1
          ? [
              `"${(label.textContent ?? '').trim().slice(0, 40)}" ${spill.toFixed(1)} px`,
            ]
          : [];
      }
    );
    const onPage = overlapsIn(page.root);
    const overlaps = [...overlapsIn(worker.root)]
      .filter(([key, depth]) => depth > (onPage.get(key) ?? 0) + 1)
      .map(
        ([key, depth]) =>
          `${key} ${depth.toFixed(1)} px vs ${(onPage.get(key) ?? 0).toFixed(1)} px`
      );
    return { overflow, overlaps, type: mermaid.detectType(code.trim()) };
  } finally {
    worker.host.remove();
    page.host.remove();
  }
};

/** What the worker makes of `code`: the type it drew, or why it did not. */
window.mermaidOutcome = (code) =>
  renderMermaid(code).then(
    (drawn) => drawn.type,
    (error: unknown) =>
      error instanceof MermaidReasonError ? error.reason : 'error'
  );
document.body.dataset.ready = 'true';
