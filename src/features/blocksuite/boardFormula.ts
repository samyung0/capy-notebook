import {
  DefaultTool,
  type ElementRenderer,
  ElementRendererExtension,
  elementsCtorMap,
} from '@blocksuite/affine/blocks/surface';
import {
  Bound,
  getPointsFromBoundWithRotation,
  type IVec,
  linePolygonIntersects,
  pointInPolygon,
  polygonNearestPoint,
  type SerializedXYWH,
} from '@blocksuite/affine/global/gfx';
import {
  field,
  type GfxController,
  GfxElementModelView,
  GfxPrimitiveElementModel,
} from '@blocksuite/affine/std/gfx';
import { html, render } from 'lit';
import { inertTex } from '@/features/materials/inertTex';
import { getLocale, m } from '@/i18n';
import { LATEX_MAX } from './boardData';
import { setFormulaOpener } from './boardTools';

const FONT_SIZE = 24;
/** Bitmap pixels per board pixel, so a formula stays sharp when zoomed in. */
const SHARPNESS = 3;
/** The longest bitmap side, whatever a formula asks for. */
const BITMAP_MAX = 4096;
/** Bitmaps' memory: sharp up to the first, plain up to the second, then none. */
const SHARP_BYTES_MAX = 128 * 1024 * 1024;
const BITMAP_BYTES_MAX = 256 * 1024 * 1024;
/** What MathLive writes that KaTeX has no command for. */
const KATEX_OPTIONS = {
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
const loadKatex = () => {
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

type Drawn = { canvas: HTMLCanvasElement; h: number; w: number };

const drawings = new Map<string, Promise<Drawn>>();
const ready = new Map<string, Drawn>();
let bitmapBytes = 0;

class OverBudget extends Error {}

/** KaTeX lays a formula out in HTML, which BlockSuite's export (html2canvas) can't
 * read, so its glyphs, rules and stretched SVGs are drawn onto a canvas from where
 * they sit. The canvas is what the board and the marking image show. */
async function layOut(latex: string): Promise<Drawn> {
  const host = document.createElement('div');
  // The padding keeps tall glyphs and stretched delimiters inside the bitmap.
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
    const canvas = document.createElement('canvas');
    // Past the budget for sharp formulas, new ones are plain, and past the whole
    // budget they aren't kept at all (drawing()).
    const sharpness = Math.min(
      bitmapBytes < SHARP_BYTES_MAX ? SHARPNESS : 1,
      BITMAP_MAX / Math.max(box.width, box.height, 1)
    );
    canvas.width = Math.ceil(box.width * sharpness);
    canvas.height = Math.ceil(box.height * sharpness);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas context');
    ctx.scale(sharpness, sharpness);
    ctx.textRendering = 'geometricPrecision';
    ctx.translate(-box.x, -box.y);
    const stretched: SVGElement[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.textContent?.trim() || !node.parentElement) return;
        const range = document.createRange();
        range.selectNodeContents(node);
        const at = range.getBoundingClientRect();
        const style = getComputedStyle(node.parentElement);
        ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        ctx.fillStyle = style.color;
        ctx.textBaseline = 'alphabetic';
        const metrics = ctx.measureText(node.textContent);
        const ascent = metrics.fontBoundingBoxAscent;
        const height = ascent + metrics.fontBoundingBoxDescent;
        ctx.fillText(
          node.textContent,
          at.left,
          at.top + (at.height - height) / 2 + ascent
        );
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
      if (bottom > 0 && style.borderBottomStyle !== 'none') {
        ctx.fillStyle = style.borderBottomColor;
        ctx.fillRect(at.left, at.bottom - bottom, at.width, bottom);
      }
      const top = Number.parseFloat(style.borderTopWidth);
      if (top > 0 && style.borderTopStyle !== 'none') {
        ctx.fillStyle = style.borderTopColor;
        ctx.fillRect(at.left, at.top, at.width, top);
      }
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
      ctx.save();
      if (cut) {
        ctx.beginPath();
        ctx.rect(cut.left, cut.top, cut.width, cut.height);
        ctx.clip();
      }
      ctx.drawImage(image, at.left, at.top, at.width, at.height);
      ctx.restore();
    }
    return { canvas, h: box.height, w: box.width };
  } finally {
    host.remove();
  }
}

/** Lets go of every bitmap, when the board closes. */
export function forgetFormulas() {
  ready.clear();
  drawings.clear();
  bitmapBytes = 0;
}

export function drawing(latex: string) {
  let pending = drawings.get(latex);
  if (!pending) {
    pending = layOut(latex).then(
      (drawn) => {
        // Nothing is thrown out to make room: the renderer would draw it again, for
        // ever, on a board with many formulas. Over budget stays a failed draw.
        const bytes = drawn.canvas.width * drawn.canvas.height * 4;
        if (bitmapBytes + bytes > BITMAP_BYTES_MAX) throw new OverBudget();
        bitmapBytes += bytes;
        ready.set(latex, drawn);
        return drawn;
      },
      (error) => {
        // Not kept, so the next draw tries again.
        if (!(error instanceof OverBudget)) drawings.delete(latex);
        throw error;
      }
    );
    drawings.set(latex, pending);
  }
  return pending;
}

export class FormulaElementModel extends GfxPrimitiveElementModel<{
  index: string;
  latex: string;
  rotate: number;
  seed: number;
  xywh: SerializedXYWH;
}> {
  get type() {
    return 'formula';
  }

  override containsBound(bounds: Bound) {
    return getPointsFromBoundWithRotation(this).some((point) =>
      bounds.containsPoint(point)
    );
  }

  override getLineIntersections(start: IVec, end: IVec) {
    return linePolygonIntersects(
      start,
      end,
      getPointsFromBoundWithRotation(this)
    );
  }

  override getNearestPoint(point: IVec) {
    return polygonNearestPoint(
      Bound.deserialize(this.xywh).points,
      point
    ) as IVec;
  }

  override includesPoint(x: number, y: number) {
    return pointInPolygon([x, y], getPointsFromBoundWithRotation(this));
  }

  @field()
  accessor latex = '';

  @field(0)
  accessor rotate = 0;

  @field()
  accessor xywh: SerializedXYWH = '[0,0,16,16]';
}

// The surface builds its elements from this map when a board opens.
Object.assign(elementsCtorMap, { formula: FormulaElementModel });

const formulaRenderer: ElementRenderer<FormulaElementModel> = (
  model,
  ctx,
  matrix,
  renderer
) => {
  if (model.latex.length > LATEX_MAX) return;
  const drawn = ready.get(model.latex);
  if (!drawn) {
    drawing(model.latex).then(
      () => renderer.refresh(),
      () => undefined
    );
    return;
  }
  const [, , w, h] = model.deserializedXYWH;
  ctx.setTransform(
    matrix
      .translateSelf(w / 2, h / 2)
      .rotateSelf(model.rotate)
      .translateSelf(-w / 2, -h / 2)
  );
  ctx.drawImage(drawn.canvas, 0, 0, w, h);
};

class FormulaElementView extends GfxElementModelView<FormulaElementModel> {
  static override type = 'formula';

  override onCreated() {
    super.onCreated();
    this.on('dblclick', () => openEditor(this.gfx, this.model));
  }
}

export const formulaExtensions = [
  ElementRendererExtension('formula', formulaRenderer),
  FormulaElementView,
];

/** Every formula on the board is drawn, before the board becomes an image. One that
 * can't be drawn is left out, not the whole answer. */
export async function formulasDrawn(gfx: GfxController) {
  await Promise.allSettled(
    gfx.layer.canvasElements
      .filter(
        (element) =>
          element.type === 'formula' &&
          (element as FormulaElementModel).latex.length <= LATEX_MAX
      )
      .map((element) => drawing((element as FormulaElementModel).latex))
  );
}

function boardOf(gfx: GfxController) {
  return gfx.std.host.closest('.capy-board');
}

/** MathLive in a small card; Save draws the formula on the canvas. Double click
 * opens it again. */
async function openEditor(gfx: GfxController, model?: FormulaElementModel) {
  const board = boardOf(gfx);
  // A teacher's board loads no MathLive.
  if (gfx.doc.readonly || !board || board.querySelector('.capy-formula'))
    return;
  // Save draws with KaTeX: it loads while MathLive does.
  loadKatex().catch(() => undefined);
  const { MathfieldElement } = await import('mathlive');
  MathfieldElement.fontsDirectory = '/mathlive/fonts';
  MathfieldElement.soundsDirectory = null;
  MathfieldElement.locale = getLocale();
  const field = new MathfieldElement();
  field.value = inertTex(model?.latex ?? '');
  field.mathVirtualKeyboardPolicy = 'auto';
  const card = document.createElement('div');
  card.className = 'capy-formula';
  const close = () => {
    render(null, card);
    card.remove();
  };
  const fail = (message: string) => {
    error.textContent = message;
    error.hidden = false;
  };
  // The card stays open until the formula is on the canvas, so nothing typed is lost.
  const save = async () => {
    const latex = field.value.trim();
    if (!latex) {
      close();
      if (model) gfx.surface?.deleteElement(model.id);
      gfx.doc.captureSync();
      return;
    }
    if (latex.length > LATEX_MAX) {
      fail(m.drawing_board_formula_too_long());
      return;
    }
    let drawn: Drawn;
    try {
      (await loadKatex()).renderToString(latex, {
        ...KATEX_OPTIONS,
        throwOnError: true,
      });
      drawn = await drawing(latex);
    } catch {
      fail(m.drawing_board_formula_error());
      return;
    }
    close();
    const { h, w } = drawn;
    const { centerX, centerY } = gfx.viewport;
    const box = model
      ? new Bound(model.x, model.y, w, h)
      : new Bound(centerX - w / 2, centerY - h / 2, w, h);
    if (model)
      gfx.surface?.updateElement(model.id, { latex, xywh: box.serialize() });
    else {
      const id = gfx.surface?.addElement({
        latex,
        type: 'formula',
        xywh: box.serialize(),
      });
      gfx.tool.setTool(DefaultTool);
      if (id) gfx.selection.set({ editing: false, elements: [id] });
    }
    gfx.doc.captureSync();
  };
  render(
    html`<div class="capy-formula-field"></div>
      <p class="capy-formula-error" hidden></p>
      <div class="capy-formula-actions">
        <button class="ghost" type="button" @click=${close}>
          ${m.action_cancel()}
        </button>
        <button class="primary" type="button" @click=${save}>
          ${m.action_save()}
        </button>
      </div>`,
    card
  );
  card.querySelector('.capy-formula-field')?.append(field);
  const error = card.querySelector('.capy-formula-error') as HTMLElement;
  // The board's shortcuts (S, V, Escape) stay out of the field.
  for (const type of [
    'keydown',
    'keyup',
    'pointerdown',
    'mousedown',
    'dblclick',
  ])
    card.addEventListener(type, (event) => event.stopPropagation());
  card.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key === 'Escape') close();
  });
  board.append(card);
  field.focus();
}

setFormulaOpener((gfx) => void openEditor(gfx));

const SYMBOLS = ['²', '³', '√', 'π', 'θ', '±', '≤', '≥', '≠', '∞', '→', '°'];
/** Superscripts read better with something under them on the button. */
const symbolLabel = (symbol: string) =>
  '²³'.includes(symbol) ? `x${symbol}` : symbol;

/** A row of maths symbols under a canvas label while it's being typed. */
export function mountSymbolRow(gfx: GfxController) {
  const row = document.createElement('div');
  row.className = 'capy-symbols';
  row.hidden = true;
  const insert = (symbol: string) => {
    const editor = gfx.std.host
      .closest('.capy-board')
      ?.querySelector('edgeless-text-editor') as HTMLElement & {
      inlineEditor?: {
        getInlineRange: () => { index: number; length: number } | null;
        insertText: (
          range: { index: number; length: number },
          text: string
        ) => void;
        setInlineRange: (range: { index: number; length: number }) => void;
      };
    };
    const inline = editor?.inlineEditor;
    const range = inline?.getInlineRange();
    if (!inline || !range) return;
    inline.insertText(range, symbol);
    inline.setInlineRange({ index: range.index + symbol.length, length: 0 });
  };
  render(
    html`${SYMBOLS.map(
      (symbol) =>
        html`<button
          type="button"
          @click=${() => insert(symbol)}
          @mousedown=${(event: Event) => event.preventDefault()}
        >
          ${symbolLabel(symbol)}
        </button>`
    )}`,
    row
  );
  const place = () => {
    const [element] = gfx.selection.selectedElements;
    const typing =
      gfx.selection.editing &&
      element &&
      (element as { type?: string }).type === 'text' &&
      element;
    row.hidden = !typing;
    if (!typing) return;
    const bound = Bound.deserialize(typing.xywh);
    const [left, top] = gfx.viewport.toViewCoord(bound.x, bound.y + bound.h);
    row.style.left = `${Math.max(8, left)}px`;
    row.style.top = `${top + 8}px`;
  };
  const selection = gfx.selection.slots.updated.subscribe(() =>
    queueMicrotask(place)
  );
  const viewport = gfx.viewport.viewportUpdated.subscribe(place);
  // A label grows as it's typed, and the row stays under its last line.
  const updates = gfx.surface?.elementUpdated.subscribe(place);
  return {
    element: row,
    unmount: () => {
      selection.unsubscribe();
      viewport.unsubscribe();
      updates?.unsubscribe();
      row.remove();
    },
  };
}
