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
import { ColorScheme } from '@blocksuite/affine/model';
import {
  field,
  type GfxController,
  GfxElementModelView,
  GfxPrimitiveElementModel,
  GfxViewInteractionExtension,
} from '@blocksuite/affine/std/gfx';
import { html, render } from 'lit';
import { inertTex } from '@/features/materials/inertTex';
import mathFieldStyles from '@/features/questions/mathField.css?inline';
import { getLocale, m } from '@/i18n';
import { LATEX_MAX, type Mark } from './boardData';
import {
  type Drawn,
  drawing,
  KATEX_OPTIONS,
  laidOut,
  loadKatex,
  replay,
} from './boardFormulaDraw';
import { type FormulaStart, setFormulaOpener } from './boardTools';

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
  const drawn = laidOut(model.latex);
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
  // Black ink, so on a dark board it's turned light, its colours about kept. The
  // marking image is drawn light.
  if (renderer.getColorScheme() === ColorScheme.Dark)
    ctx.filter = 'invert(1) hue-rotate(180deg)';
  ctx.scale(w / drawn.w, h / drawn.h);
  replay(ctx, drawn);
  ctx.filter = 'none';
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
  // Resizing keeps the formula's shape, as AFFiNE does for images.
  GfxViewInteractionExtension('formula', {
    resizeConstraint: { lockRatio: true },
  }),
];

/** Every formula on the board is drawn, before the board becomes an image. One that
 * can't be drawn is left out, not the whole answer. */
export async function formulasDrawn(gfx: GfxController) {
  const latex = gfx.layer.canvasElements.flatMap((element) => {
    if (element.type === 'formula')
      return [(element as FormulaElementModel).latex];
    // A plane's formulas too.
    const marks = (element as { marks?: Mark[] }).marks ?? [];
    return marks.flatMap((mark) =>
      mark.kind === 'formula' ? [mark.latex] : []
    );
  });
  await Promise.allSettled(
    latex
      .filter((each) => each.length <= LATEX_MAX)
      .map((each) => drawing(each))
  );
}

function boardOf(gfx: GfxController) {
  return gfx.std.host.closest('.capy-board');
}

/** MathLive in a small card; Save draws the formula on the canvas. Double click
 * opens it again. */
function openEditor(gfx: GfxController, model?: FormulaElementModel) {
  return openFormulaCard(gfx, model?.latex ?? '', (latex, drawn) => {
    if (!(latex && drawn)) {
      if (model) gfx.surface?.deleteElement(model.id);
      gfx.doc.captureSync();
      return;
    }
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
  });
}

/** An empty formula card, for the M key: Save puts it in the view's middle. */
export const openBlankFormula = (gfx: GfxController) => openEditor(gfx);

/** The formula card in the middle of the board, holding `latex`. Save hands back what
 * was typed once KaTeX has laid it out (an empty field hands back ''), Cancel or a
 * press elsewhere nothing. A plane's formulas use it too. */
export async function openFormulaCard(
  gfx: GfxController,
  latex: string,
  done: (latex: string, drawn?: Drawn) => void
) {
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
  // The question editor's look inside MathLive's shadow root: the app's selection
  // colours, no dark group highlight, the caret on the line.
  const styles = document.createElement('style');
  styles.textContent = mathFieldStyles;
  field.shadowRoot?.append(styles);
  field.mathVirtualKeyboardPolicy = 'auto';
  const card = document.createElement('div');
  card.className = 'capy-formula';
  // Like a popup: a press anywhere else (another formula piece too) cancels it.
  // MathLive's keyboard, menu and suggestions open outside the card.
  const away = (event: PointerEvent) => {
    const inside = event
      .composedPath()
      .some(
        (el) =>
          el === card ||
          (el instanceof Element &&
            el.matches('.ML__keyboard, .ML__popover, .ui-menu-container'))
      );
    if (!inside) close();
  };
  const close = () => {
    document.removeEventListener('pointerdown', away, true);
    render(null, card);
    card.remove();
  };
  const fail = (message: string) => {
    error.textContent = message;
    error.hidden = false;
  };
  // The card stays open until the formula is on the canvas, so nothing typed is lost.
  const save = async () => {
    const typed = field.value.trim();
    if (!typed) {
      close();
      done('');
      return;
    }
    if (typed.length > LATEX_MAX) {
      fail(m.drawing_board_formula_too_long());
      return;
    }
    let drawn: Drawn;
    try {
      (await loadKatex()).renderToString(typed, {
        ...KATEX_OPTIONS,
        throwOnError: true,
      });
      drawn = await drawing(typed);
    } catch {
      fail(m.drawing_board_formula_error());
      return;
    }
    close();
    done(typed, drawn);
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
  // Once connected, as MathLive selects everything when it connects: the caret after
  // the formula, nothing selected.
  field.setValue(inertTex(latex), {
    selectionMode: 'after',
    silenceNotifications: true,
  });
  document.addEventListener('pointerdown', away, true);
  field.focus();
}

/** A starter from the toolbar's Formulas slot (Epo 2026-11-08): its card where it was
 * dropped, then the editor on it to fill in. */
async function placeFormula(gfx: GfxController, start: FormulaStart) {
  if (gfx.doc.readonly) return;
  let drawn: Drawn;
  try {
    drawn = await drawing(start.latex);
  } catch {
    return;
  }
  const { h, w } = drawn;
  const [cx, cy] = start.at;
  const id = gfx.surface?.addElement({
    latex: start.latex,
    type: 'formula',
    xywh: new Bound(cx - w / 2, cy - h / 2, w, h).serialize(),
  });
  gfx.doc.captureSync();
  gfx.tool.setTool(DefaultTool);
  if (!id) return;
  gfx.selection.set({ editing: false, elements: [id] });
  const model = gfx.getElementById(id);
  if (model instanceof FormulaElementModel) await openEditor(gfx, model);
}

setFormulaOpener(
  (gfx, start) => void (start ? placeFormula(gfx, start) : openEditor(gfx))
);

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
