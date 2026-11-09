import {
  DefaultTool,
  EdgelessCRUDIdentifier,
} from '@blocksuite/affine/blocks/surface';
import { ConnectorTool } from '@blocksuite/affine/gfx/connector';
import {
  EdgelessShapeToolButton,
  ShapeTool,
} from '@blocksuite/affine/gfx/shape';
import { Bound } from '@blocksuite/affine/global/gfx';
import { SignalWatcher, WithDisposable } from '@blocksuite/affine/global/lit';
import { LatexExtension } from '@blocksuite/affine/inlines/latex';
import {
  type Color,
  ConnectorMode,
  DEFAULT_CONNECTOR_MODE,
  DefaultTheme,
  isTransparent,
  MindmapStyle,
  PointStyle,
  type ShapeName,
  ShapeType,
} from '@blocksuite/affine/model';
import {
  DocModeExtension,
  DocModeService,
  EditPropsStore,
  ThemeProvider,
  type ToolbarContext,
  ToolbarModuleExtension,
} from '@blocksuite/affine/shared/services';
import {
  type BlockComponent,
  BlockFlavourIdentifier,
  type PointerEventState,
} from '@blocksuite/affine/std';
import {
  BaseTool,
  type GfxController,
  GfxControllerIdentifier,
} from '@blocksuite/affine/std/gfx';
import type { ExtensionType } from '@blocksuite/affine/store';
import {
  EdgelessDraggableElementController,
  EdgelessToolbarToolMixin,
  SeniorToolIdentifier,
} from '@blocksuite/affine/widgets/edgeless-toolbar';
import { Pen01Icon } from '@hugeicons/core-free-icons';
import {
  css,
  html,
  LitElement,
  nothing,
  svg,
  type TemplateResult,
  unsafeCSS,
} from 'lit';
import { property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import * as Y from 'yjs';
import { m } from '@/i18n';
import { addChart, type ChartElementModel, openChart } from './boardChart';
import type { BoardKind } from './boardLoad';
import {
  addPlane,
  fitCard,
  openPlane,
  type PlaneElementModel,
} from './boardPlane';

type Vec = [number, number];

const SHAPE_NAMES: ShapeName[] = [
  ShapeType.Rect,
  ShapeType.Ellipse,
  ShapeType.Diamond,
  ShapeType.Triangle,
  'roundedRect',
];

/** New shapes have no fill and a black outline, so the grid and the strokes under
 * them stay readable for marking. */
export function outlineNewShapes(gfx: GfxController) {
  setShapeFill(gfx, 'transparent');
}

function setShapeFill(gfx: GfxController, fillColor: Color) {
  const props = gfx.std.get(EditPropsStore);
  for (const name of SHAPE_NAMES)
    props.recordLastProps(`shape:${name}`, {
      fillColor,
      filled: !isTransparent(fillColor),
      strokeColor: DefaultTheme.black,
    });
}

const PREVIEW = '#1e96eb';

const previews = new WeakMap<GfxController, SVGSVGElement>();

/** The layer under the strokes that shows a preset being sized. It moves and scales
 * with the board and never reaches the answer. */
export function setBoardPreview(gfx: GfxController, layer: SVGSVGElement) {
  previews.set(gfx, layer);
}

function addSegment(
  gfx: GfxController,
  from: Vec,
  to: Vec,
  ends: { front?: boolean; rear?: boolean } = {}
) {
  return gfx.surface?.addElement({
    frontEndpointStyle: ends.front ? PointStyle.Arrow : PointStyle.None,
    mode: ConnectorMode.Straight,
    rearEndpointStyle: ends.rear ? PointStyle.Arrow : PointStyle.None,
    source: { position: from },
    stroke: DefaultTheme.black,
    strokeWidth: 2,
    target: { position: to },
    type: 'connector',
  });
}

function addGroup(gfx: GfxController, ids: (string | undefined)[]) {
  const children = Object.fromEntries(
    ids.filter((id) => id !== undefined).map((id) => [id, true])
  );
  return gfx.surface?.addElement({
    children,
    title: new Y.Text(),
    type: 'group',
  });
}

function finishPlacing(gfx: GfxController, id: string | undefined) {
  gfx.doc.captureSync();
  gfx.tool.setTool(DefaultTool);
  if (id) gfx.selection.set({ editing: false, elements: [id] });
}

// ---------------------------------------------------------------- presets

type Part =
  | { arrow?: 'front' | 'rear' | 'both'; from: Vec; to: Vec }
  | { ellipse: [number, number, number, number] }
  | { at: Vec; text: string };

const closed = (...points: Vec[]): Part[] =>
  points.map((from, i) => ({ from, to: points[(i + 1) % points.length] }));

/** Common shapes BlockSuite has no type for: straight connectors and ellipses
 * grouped together, in a 100 by 100 box. A pen stroke would smear at the corners. */
const PRESETS: Record<string, { h: number; parts: Part[]; w: number }> = {
  axes: {
    h: 160,
    parts: [
      { arrow: 'rear', from: [14, 100], to: [14, 0] },
      { arrow: 'rear', from: [0, 86], to: [100, 86] },
      ...[34, 54, 74].map((x): Part => ({ from: [x, 83], to: [x, 89] })),
      ...[66, 46, 26].map((y): Part => ({ from: [11, y], to: [17, y] })),
      { at: [96, 90], text: 'x' },
      { at: [0, -2], text: 'y' },
    ],
    w: 160,
  },
  cone: {
    h: 140,
    parts: [
      { from: [50, 0], to: [0, 85] },
      { from: [50, 0], to: [100, 85] },
      { ellipse: [0, 70, 100, 30] },
    ],
    w: 110,
  },
  cube: {
    h: 120,
    parts: [
      ...closed([0, 28], [72, 28], [72, 100], [0, 100]),
      { from: [0, 28], to: [28, 0] },
      { from: [72, 28], to: [100, 0] },
      { from: [72, 100], to: [100, 72] },
      { from: [28, 0], to: [100, 0] },
      { from: [100, 0], to: [100, 72] },
    ],
    w: 120,
  },
  cylinder: {
    h: 140,
    parts: [
      { ellipse: [0, 0, 100, 24] },
      { ellipse: [0, 76, 100, 24] },
      { from: [0, 12], to: [0, 88] },
      { from: [100, 12], to: [100, 88] },
    ],
    w: 100,
  },
  force: {
    h: 160,
    parts: [
      { ellipse: [44, 44, 12, 12] },
      { arrow: 'rear', from: [50, 44], to: [50, 0] },
      { arrow: 'rear', from: [50, 56], to: [50, 100] },
      { arrow: 'rear', from: [56, 50], to: [100, 50] },
      { arrow: 'rear', from: [44, 50], to: [0, 50] },
    ],
    w: 160,
  },
  hexagon: {
    h: 110,
    parts: closed([25, 0], [75, 0], [100, 50], [75, 100], [25, 100], [0, 50]),
    w: 126,
  },
  numberLine: {
    h: 30,
    parts: [
      { arrow: 'both', from: [0, 50], to: [100, 50] },
      ...[10, 26, 42, 58, 74, 90].map(
        (x): Part => ({ from: [x, 15], to: [x, 85] })
      ),
    ],
    w: 280,
  },
  parallelogram: {
    h: 90,
    parts: closed([28, 0], [100, 0], [72, 100], [0, 100]),
    w: 150,
  },
  pentagon: {
    h: 120,
    parts: closed([50, 0], [100, 38], [81, 100], [19, 100], [0, 38]),
    w: 124,
  },
  rightTriangle: {
    h: 120,
    parts: [
      ...closed([0, 0], [100, 100], [0, 100]),
      { from: [0, 86], to: [14, 86] },
      { from: [14, 86], to: [14, 100] },
    ],
    w: 140,
  },
  trapezium: {
    h: 90,
    parts: closed([25, 0], [75, 0], [100, 100], [0, 100]),
    w: 150,
  },
  venn: {
    h: 120,
    parts: [{ ellipse: [0, 0, 62, 100] }, { ellipse: [38, 0, 62, 100] }],
    w: 200,
  },
};

function placePreset(gfx: GfxController, name: string, box: Bound) {
  const scaled = ([x, y]: Vec): Vec => [
    box.x + (x / 100) * box.w,
    box.y + (y / 100) * box.h,
  ];
  const ids = PRESETS[name].parts.map((part) => {
    if ('ellipse' in part) {
      const [x, y, w, h] = part.ellipse;
      const [left, top] = scaled([x, y]);
      return gfx.surface?.addElement({
        fillColor: 'transparent',
        filled: false,
        shapeType: 'ellipse',
        strokeColor: DefaultTheme.black,
        strokeWidth: 2,
        type: 'shape',
        xywh: new Bound(
          left,
          top,
          (w / 100) * box.w,
          (h / 100) * box.h
        ).serialize(),
      });
    }
    if ('text' in part) {
      const [left, top] = scaled(part.at);
      return gfx.surface?.addElement({
        fontSize: 18,
        text: new Y.Text(part.text),
        type: 'text',
        xywh: new Bound(left, top, 14, 24).serialize(),
      });
    }
    return addSegment(gfx, scaled(part.from), scaled(part.to), {
      front: part.arrow === 'both',
      rear: part.arrow === 'rear' || part.arrow === 'both',
    });
  });
  return addGroup(gfx, ids);
}

const LINE_ENDS: Record<string, { front?: boolean; rear?: boolean }> = {
  arrow: { rear: true },
  doubleArrow: { front: true, rear: true },
  line: {},
};

/** A preset or line from the shapes panel: drag to size it, or click for the
 * default size. */
export class StampTool extends BaseTool<{ preset: string }> {
  static override toolName = 'capy-stamp';

  private start: Vec | null = null;
  private end: Vec | null = null;

  private model(e: PointerEventState): Vec {
    return this.gfx.viewport.toModelCoord(e.x, e.y) as Vec;
  }

  private place(from: Vec, to: Vec | null) {
    const { gfx } = this;
    const { preset } = this.activatedOption;
    const ends = LINE_ENDS[preset];
    if (ends) {
      const target: Vec = to ?? [from[0] + 120, from[1]];
      finishPlacing(gfx, addSegment(gfx, from, target, ends));
      return;
    }
    const { h, w } = PRESETS[preset];
    const box = to
      ? new Bound(
          Math.min(from[0], to[0]),
          Math.min(from[1], to[1]),
          Math.max(Math.abs(to[0] - from[0]), 8),
          Math.max(Math.abs(to[1] - from[1]), 8)
        )
      : new Bound(from[0] - w / 2, from[1] - h / 2, w, h);
    finishPlacing(gfx, placePreset(gfx, preset, box));
  }

  override click(e: PointerEventState) {
    this.place(this.model(e), null);
  }

  override dragStart(e: PointerEventState) {
    this.start = this.model(e);
  }

  override dragMove(e: PointerEventState) {
    if (!this.start) return;
    this.end = this.model(e);
    const layer = previews.get(this.gfx);
    if (!layer) return;
    const [x1, y1] = this.start;
    const [x2, y2] = this.end;
    layer.innerHTML = LINE_ENDS[this.activatedOption.preset]
      ? `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${PREVIEW}" stroke-width="2"/>`
      : `<rect x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}" width="${Math.abs(x2 - x1)}" height="${Math.abs(y2 - y1)}" fill="none" stroke="${PREVIEW}" stroke-dasharray="4 4"/>`;
  }

  override dragEnd() {
    const { end, start } = this;
    this.start = null;
    this.end = null;
    const layer = previews.get(this.gfx);
    if (layer) layer.innerHTML = '';
    if (start && end) this.place(start, end);
  }
}

// ---------------------------------------------------------------- shapes panel

const shape = (d: string) => svg`${unsafeSVG(d)}`;

type PanelItem = { icon: string; label: () => string } & (
  | { shapeName: ShapeName }
  | { preset: string }
);

const PANEL: { items: PanelItem[]; label: () => string }[] = [
  {
    items: [
      {
        icon: '<rect x="4" y="4" width="16" height="16"/>',
        label: m.drawing_board_square,
        shapeName: ShapeType.Rect,
      },
      {
        icon: '<circle cx="12" cy="12" r="8.5"/>',
        label: m.drawing_board_ellipse,
        shapeName: ShapeType.Ellipse,
      },
      {
        icon: '<path d="M12 3l9 9-9 9-9-9z"/>',
        label: m.drawing_board_diamond,
        shapeName: ShapeType.Diamond,
      },
      {
        icon: '<path d="M12 4l9 16H3z"/>',
        label: m.drawing_board_triangle,
        shapeName: ShapeType.Triangle,
      },
      {
        icon: '<rect x="3" y="6" width="18" height="12" rx="4"/>',
        label: m.drawing_board_rounded_rectangle,
        shapeName: 'roundedRect',
      },
      {
        icon: '<path d="M5 4v16h15zM5 16h4v4"/>',
        label: m.drawing_board_right_triangle,
        preset: 'rightTriangle',
      },
      {
        icon: '<path d="M8 6h13l-5 12H3z"/>',
        label: m.drawing_board_parallelogram,
        preset: 'parallelogram',
      },
      {
        icon: '<path d="M7 6h10l4 12H3z"/>',
        label: m.drawing_board_trapezium,
        preset: 'trapezium',
      },
      {
        icon: '<path d="M12 3l9 7-3.5 11h-11L3 10z"/>',
        label: m.drawing_board_pentagon,
        preset: 'pentagon',
      },
      {
        icon: '<path d="M7 4h10l5 8-5 8H7l-5-8z"/>',
        label: m.drawing_board_hexagon,
        preset: 'hexagon',
      },
    ],
    label: m.drawing_board_shapes,
  },
  {
    items: [
      {
        icon: '<path d="M4 20 20 4"/>',
        label: m.drawing_board_line,
        preset: 'line',
      },
      {
        icon: '<path d="M4 20 20 4M12 4h8v8"/>',
        label: m.drawing_board_arrow,
        preset: 'arrow',
      },
      {
        icon: '<path d="M5 19 19 5M13 5h6v6M11 19H5v-6"/>',
        label: m.drawing_board_double_arrow,
        preset: 'doubleArrow',
      },
    ],
    label: m.drawing_board_lines,
  },
  {
    items: [
      {
        icon: '<path d="M4 8h12v12H4zM4 8l4-4h12l-4 4M20 4v12l-4 4"/>',
        label: m.drawing_board_cube,
        preset: 'cube',
      },
      {
        icon: '<ellipse cx="12" cy="5.5" rx="7" ry="2.5"/><path d="M5 5.5v13c0 1.4 3 2.5 7 2.5s7-1.1 7-2.5v-13"/>',
        label: m.drawing_board_cylinder,
        preset: 'cylinder',
      },
      {
        icon: '<path d="M12 3 5 18.5c0 1.4 3 2.5 7 2.5s7-1.1 7-2.5z"/>',
        label: m.drawing_board_cone,
        preset: 'cone',
      },
    ],
    label: m.drawing_board_solids,
  },
  {
    items: [
      {
        icon: '<path d="M6 21V3M6 18h15M3.5 5.5 6 3l2.5 2.5M18.5 15.5 21 18l-2.5 2.5"/>',
        label: m.drawing_board_axes,
        preset: 'axes',
      },
      {
        icon: '<path d="M2 12h20M5 9v6M9.5 9v6M14.5 9v6M19 9v6"/>',
        label: m.drawing_board_number_line,
        preset: 'numberLine',
      },
      {
        icon: '<circle cx="9" cy="12" r="6.5"/><circle cx="15" cy="12" r="6.5"/>',
        label: m.drawing_board_venn,
        preset: 'venn',
      },
      {
        icon: '<path d="M12 12V3M12 12v9M12 12h9M9.5 5.5 12 3l2.5 2.5M9.5 18.5 12 21l2.5-2.5M18.5 9.5 21 12l-2.5 2.5"/><circle cx="12" cy="12" r="2"/>',
        label: m.drawing_board_force_arrows,
        preset: 'force',
      },
    ],
    label: m.drawing_board_diagrams,
  },
];

const FILL_NAMES: Record<string, () => string> = {
  Blue: m.drawing_board_fill_blue,
  Green: m.drawing_board_fill_green,
  Grey: m.drawing_board_fill_grey,
  Magenta: m.drawing_board_fill_magenta,
  Orange: m.drawing_board_fill_orange,
  Purple: m.drawing_board_fill_purple,
  Red: m.drawing_board_fill_red,
  Yellow: m.drawing_board_fill_yellow,
};

const FILLS = DefaultTheme.FillColorShortPalettes.filter(
  ({ value }) => !isTransparent(value)
).slice(0, 7);

const POPPER_STYLES = css`
  :host {
    display: block;
    box-sizing: border-box;
    color: var(--affine-icon-color);
    font-family: var(--affine-font-family);
    user-select: none;
  }
  button {
    all: unset;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 36px;
    height: 36px;
    border-radius: 6px;
    cursor: pointer;
  }
  button:hover {
    background: var(--affine-hover-color);
  }
  button:focus-visible {
    outline: 2px solid var(--affine-primary-color);
  }
  button[aria-pressed='true'] {
    background: var(--affine-hover-color);
    color: var(--affine-primary-color);
  }
  svg {
    display: block;
  }
  .fills {
    display: flex;
    align-items: center;
    gap: 2px;
  }
    .fills button {
      width: 30px;
      height: 30px;
      border-radius: 50%;
    }
    .fills i {
      display: block;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      box-sizing: border-box;
      box-shadow: inset 0 0 0 1px rgb(0 0 0 / 14%);
    }
    .fills .none {
      background: linear-gradient(
        to top right,
        #fff calc(50% - 1px),
        #d9483b calc(50% - 1px),
        #d9483b calc(50% + 1px),
        #fff calc(50% + 1px)
      );
    }
    .fills button[aria-pressed='true'] {
      background: none;
      box-shadow: 0 0 0 2px var(--affine-primary-color) inset;
    }
`;

/** The fill new shapes and bars take: none, or a colour. */
export function fillRow(gfx: GfxController, onPick?: () => void) {
  const props = gfx.std.get(EditPropsStore).lastProps$.value;
  const theme = gfx.std.get(ThemeProvider);
  const current = props['shape:rect'].fillColor;
  const swatch = (color: Color, label: string, cls = '') =>
    html`<button
      aria-label=${label}
      aria-pressed=${JSON.stringify(current) === JSON.stringify(color)}
      title=${label}
      type="button"
      @click=${() => {
        setShapeFill(gfx, color);
        onPick?.();
      }}
    >
      <i
        class=${cls}
        style=${cls ? '' : `background:${theme.generateColorProperty(color)}`}
      ></i>
    </button>`;
  return html`<div class="fills" role="group" aria-label=${m.drawing_board_fill()}>
    ${swatch('transparent', m.drawing_board_no_fill(), 'none')}
    ${FILLS.map(({ key, value }) => swatch(value, FILL_NAMES[key]?.() ?? key))}
  </div>`;
}

class CapyShapePanel extends SignalWatcher(LitElement) {
  static override styles = [
    POPPER_STYLES,
    css`
      :host {
        background: var(--affine-background-overlay-panel-color);
        border: 1px solid var(--affine-border-color);
        border-bottom: 0;
        border-radius: 10px 10px 0 0;
        box-shadow: 0 -6px 20px rgb(0 0 0 / 6%);
        padding: 12px 14px 10px;
      }
      h3 {
        margin: 0 0 2px;
        color: var(--affine-text-secondary-color);
        font-size: 12px;
        font-weight: 600;
      }
      .group + .group {
        margin-top: 8px;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        margin-left: -6px;
      }
      .groups {
        display: grid;
        grid-template-columns: auto auto;
        gap: 8px 20px;
        justify-content: start;
      }
      .wide {
        grid-column: 1 / -1;
      }
      .groups .group + .group {
        margin-top: 0;
      }
      .fills {
        margin: 10px -14px 0;
        padding: 8px 14px 0 8px;
        border-top: 1px solid var(--affine-border-color);
      }
    `,
  ];

  private get gfx() {
    return this.edgeless.std.get(GfxControllerIdentifier);
  }

  private pick(item: PanelItem) {
    if ('shapeName' in item)
      this.gfx.tool.setTool(ShapeTool, { shapeName: item.shapeName });
    else this.gfx.tool.setTool(StampTool, { preset: item.preset });
  }

  private pressed(item: PanelItem) {
    const option = this.gfx.tool.currentToolOption$.value;
    if (!option) return false;
    return 'shapeName' in item
      ? option.toolType === ShapeTool &&
          option.options?.shapeName === item.shapeName
      : option.toolType === StampTool && option.options?.preset === item.preset;
  }

  private renderGroup(group: (typeof PANEL)[number], wide: boolean) {
    return html`<div class=${wide ? 'group wide' : 'group'}>
      <h3>${group.label()}</h3>
      <div class="row">
        ${group.items.map(
          (item) =>
            html`<button
              aria-label=${item.label()}
              aria-pressed=${this.pressed(item)}
              title=${item.label()}
              type="button"
              @click=${() => this.pick(item)}
            >
              <svg
                fill="none"
                height="22"
                stroke="currentColor"
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="1.5"
                viewBox="0 0 24 24"
                width="22"
              >
                ${shape(item.icon)}
              </svg>
            </button>`
        )}
      </div>
    </div>`;
  }

  override render() {
    return html`<div class="groups">
        ${PANEL.map((group, i) => this.renderGroup(group, i === 0))}
      </div>
      ${fillRow(this.gfx)}`;
  }

  @property({ attribute: false })
  accessor edgeless!: EdgelessShapeToolButton['edgeless'];
}

type PopperButton = LitElement & {
  createPopper: EdgelessShapeToolButton['createPopper'];
  edgeless: EdgelessShapeToolButton['edgeless'];
  popper: EdgelessShapeToolButton['popper'];
};

/** A popper taller than AFFiNE's 100 px clip, spanning the toolbar. */
function openPopper(
  button: PopperButton,
  tag: string,
  height: number,
  style: Partial<CSSStyleDeclaration>
) {
  const popper = button.createPopper(tag as 'div', button, {
    setProps: (element: HTMLElement & { edgeless?: unknown }) => {
      element.edgeless = button.edgeless;
    },
  });
  const { element } = popper;
  const clip = element.parentElement;
  if (clip) clip.style.height = `${height}px`;
  Object.assign(element.style, style);
  return element;
}

/** Leaving the tool closes its menu. Forgetting it at once lets a quick click open
 * it again while it's still sliding away. */
function closePopper(button: PopperButton) {
  const { popper } = button;
  if (!popper) return;
  button.popper = null;
  popper.dispose();
}

/** AFFiNE's draggable pieces, opening the grouped panel for its one-row menu. */
// @ts-expect-error `_toggleMenu` is private in the base, which calls it through `this`.
class CapyShapeButton extends EdgelessShapeToolButton {
  // @ts-expect-error the mixin defines it as a getter, typed as a property.
  override get active() {
    const active = this.edgelessTool?.toolType;
    return active === ShapeTool || active === StampTool;
  }

  override updated(changed: Map<PropertyKey, unknown>) {
    super.updated(changed);
    if (!this.active) closePopper(this);
  }

  override _toggleMenu() {
    openPopper(this, 'capy-shape-panel', 420, {
      marginLeft: '0',
      maxWidth: '100%',
      width: '100%',
    });
  }
}

export const shapeButtonTool: ExtensionType = {
  setup: (di) => {
    di.override(
      SeniorToolIdentifier('shape'),
      () =>
        ({
          block,
          toolbarContainer,
        }: {
          block: BlockComponent;
          toolbarContainer: HTMLElement;
        }) => ({
          content: html`<capy-shape-button
            .edgeless=${block}
            .toolbarContainer=${toolbarContainer}
          ></capy-shape-button>`,
          name: m.drawing_board_shapes(),
        })
    );
  },
};

// ---------------------------------------------------------------- maths tool

const ICONS: Record<string, string> = {
  bars: '<path d="M3 21h18M6 21v-8h4v8M14 21V7h4v14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  connect:
    '<path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M15.97 2.02a.75.75 0 0 1 1.06 0l4.88 4.879a.85.85 0 0 1 0 1.202l-4.88 4.88a.75.75 0 1 1-1.06-1.062l3.67-3.669H18c-3.151 0-4.552.758-5.25 1.662-.745.963-.873 2.28-1.002 3.898l-.008.101c-.119 1.486-.259 3.245-1.303 4.595C9.323 19.946 7.349 20.75 4 20.75a.75.75 0 0 1 0-1.5c3.151 0 4.552-.758 5.25-1.662.745-.963.873-2.28 1.002-3.898l.008-.101c.119-1.486.259-3.245 1.303-4.595C12.677 7.554 14.651 6.75 18 6.75h1.64l-3.67-3.67a.75.75 0 0 1 0-1.06"/>',
  curve:
    '<path d="M4 6c2 9 5 13 8 13s6-5 8-14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="4.5" cy="7" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/><circle cx="19.5" cy="7" r="2" fill="currentColor"/>',
  ellipse:
    '<ellipse cx="12" cy="12" rx="8.5" ry="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="20.5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="6" r="1.8" fill="currentColor"/><circle cx="3.5" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="18" r="1.8" fill="currentColor"/>',
  erase:
    '<path d="m9 20 11-11-5-5L4 15l5 5Zm0 0h11M8 11l5 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  fill: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 12V3a9 9 0 0 1 7.79 13.5Z" fill="currentColor"/>',
  formula:
    '<path d="M18 5H7l6 7-6 7h11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  label:
    '<path d="M5 6V4h14v2M12 4v16M9 20h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  line: '<path d="M6 18 18 6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="19" r="2.2" fill="currentColor"/><circle cx="19" cy="5" r="2.2" fill="currentColor"/>',
  pie: '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M12 12V3M12 12l7.5 5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  plane:
    '<path d="M6 21V3M6 18h15M3.5 5.5 6 3l2.5 2.5M18.5 15.5 21 18l-2.5 2.5M6 13h1.5M6 8h1.5M11 18v-1.5M16 18v-1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  point:
    '<path d="M12 3v5M12 16v5M3 12h5M16 12h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>',
  select:
    '<path d="M6 3.5 18.5 10.5l-5.8 1.6-2.7 5.9L6 3.5Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  vector:
    '<path d="M5 19 17.5 6.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M20 4l-1.4 6.6-5.2-5.2Z" fill="currentColor"/><circle cx="5" cy="19" r="2.2" fill="currentColor"/>',
};

/** A Hugeicons icon's data as an SVG, for the board's Lit templates. */
export function hugeIcon(icon: unknown) {
  const data = icon as readonly (readonly [string, Record<string, string>])[];
  const body = data
    .map(
      ([tag, attributes]) =>
        `<${tag} ${Object.entries(attributes)
          .filter(([name]) => name !== 'key')
          .map(
            ([name, value]) =>
              `${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}="${value}"`
          )
          .join(' ')}/>`
    )
    .join('');
  return unsafeSVG(
    `<svg fill="none" height="24" viewBox="0 0 24 24" width="24">${body}</svg>`
  );
}

/** One of the maths icons as an SVG string, 24 px. */
export const mathsIcon = (name: string) =>
  `<svg height="24" viewBox="0 0 24 24" width="24">${ICONS[name]}</svg>`;

/** Connect, with its name beside it (the action AFFiNE's own button runs). */
const connectAction = {
  content(ctx: ToolbarContext) {
    const models = ctx.getSurfaceModels();
    if (!models.length) return null;
    return html`<editor-icon-button
      aria-label=${m.drawing_board_connect()}
      data-testid="draw-connector"
      .tooltip=${m.drawing_board_connect()}
      @click=${(event: MouseEvent) => {
        event.stopPropagation();
        const point = ctx.gfx.viewport.toViewCoordFromClientCoord([
          event.x,
          event.y,
        ]);
        ctx.store.captureSync();
        ctx.gfx.tool.setTool(ConnectorTool, { mode: DEFAULT_CONNECTOR_MODE });
        ctx.gfx.tool.get(ConnectorTool).quickConnect(point, models[0]);
      }}
    >
      ${unsafeSVG(mathsIcon('connect'))}
      <span class="label">${m.drawing_board_connect()}</span>
    </editor-icon-button>`;
  },
  id: 'a.draw-connector',
};

const onlyOne = (ctx: ToolbarContext) => ctx.getSurfaceModels().length === 1;

/** AFFiNE's selection toolbar reads the editor's mode, which the board has to report.
 * It goes without what makes no sense on an answer, or needs other documents or a page
 * mode. The cards
 * add their pen, and a plane its size. */
export const boardToolbar = [
  DocModeExtension(
    new (class extends DocModeService {
      override getEditorMode() {
        return 'edgeless' as const;
      }
    })()
  ),
  ToolbarModuleExtension({
    config: {
      actions: [
        ...[
          'b.add-frame',
          'c.comment',
          'Z.a.selection',
          'd.conversions',
          // A note's place in page mode, and a group's copy into the page: the board
          // has no page mode (Epo 2026-11-09).
          'a.show-in',
          'b.display-in-page',
          'a.insert-into-page',
        ].map((id) => ({ id, when: false })),
        connectAction,
      ],
    },
    id: BlockFlavourIdentifier('custom:affine:surface:*'),
  }),
  // A frame is a block, outside the surface's scope, with the same Insert into Page.
  ToolbarModuleExtension({
    config: { actions: [{ id: 'a.insert-into-page', when: false }] },
    id: BlockFlavourIdentifier('custom:affine:frame'),
  }),
  ToolbarModuleExtension({
    config: {
      actions: [
        {
          generate: () => ({
            icon: html`${hugeIcon(Pen01Icon)}`,
            label: m.drawing_board_edit_plane(),
            run: (ctx: ToolbarContext) =>
              openPlane(
                ctx.gfx,
                ctx.getSurfaceModels()[0] as unknown as PlaneElementModel
              ),
            tooltip: m.drawing_board_edit_plane(),
          }),
          id: 'a.edit',
          when: onlyOne,
        },
        {
          generate: (ctx: ToolbarContext) => {
            const model = ctx.getSurfaceModels()[0] as unknown as
              | PlaneElementModel
              | undefined;
            const label = model?.fit
              ? m.drawing_board_fit_to_size()
              : m.drawing_board_custom_size();
            return {
              label,
              run: (context: ToolbarContext) => {
                if (!model) return;
                context.store.captureSync();
                model.fit = !model.fit;
                if (model.fit) fitCard(model);
              },
              showLabel: true,
              tooltip: label,
            };
          },
          id: 'b.size',
          when: onlyOne,
        },
      ],
    },
    id: BlockFlavourIdentifier('affine:surface:plane'),
  }),
  ToolbarModuleExtension({
    config: {
      actions: [
        {
          generate: () => ({
            icon: html`${hugeIcon(Pen01Icon)}`,
            label: m.drawing_board_edit_chart(),
            run: (ctx: ToolbarContext) =>
              openChart(
                ctx.gfx,
                ctx.getSurfaceModels()[0] as unknown as ChartElementModel
              ),
            tooltip: m.drawing_board_edit_chart(),
          }),
          id: 'a.edit',
          when: onlyOne,
        },
      ],
    },
    id: BlockFlavourIdentifier('affine:surface:chart'),
  }),
];

/** Where a formula starter was dropped, and the formula it starts with. */
export type FormulaStart = { at: Vec; latex: string };

/** The formula card's action, set by the formula module: the editor for a new
 * formula, or a starter's card where it was dropped. */
let openFormula: (gfx: GfxController, start?: FormulaStart) => void = () =>
  undefined;
export function setFormulaOpener(open: typeof openFormula) {
  openFormula = open;
}

const NEW_PLANE = { h: 320, ppu: 30, w: 480 };
const NEW_CHART = {
  bar: { h: 300, w: 420 },
  pie: { h: 300, w: 300 },
} as const;

type PieceKind =
  | 'bar'
  | 'cart'
  | 'deriv'
  | 'int'
  | 'mindmap'
  | 'pie'
  | 'polar'
  | 'sqrt'
  | 'sum';
/** A piece in a toolbar slot: its art, where it rests in a 96 × 64 slot (kept round
 * the middle when the slot is narrower), turned by
 * `r`°, and how far it lifts (turned by `hr`°) under the pointer. */
type Piece = {
  body: string;
  dy: number;
  h: number;
  hr?: number;
  kind: PieceKind;
  r: number;
  viewBox: string;
  w: number;
  x: number;
  y: number;
};

/** Each piece's tooltip, with its shortcut where it has one (Epo 2026-11-08). The keys
 * place the card in the view's middle. A formula piece starts its card filled in, so
 * it has no key: M (the slot's) opens an empty one. */
const PIECE_TIPS: Record<PieceKind, { key?: string; tip: () => string }> = {
  bar: { key: 'B', tip: m.drawing_board_bar_chart },
  cart: { key: 'G', tip: m.drawing_board_coordinate_plane },
  deriv: { tip: m.drawing_board_derivative },
  int: { tip: m.drawing_board_integral },
  mindmap: { tip: m.drawing_board_mind_map },
  pie: { key: '⇧ B', tip: m.drawing_board_pie_chart },
  polar: { key: '⇧ G', tip: m.drawing_board_polar_plane },
  sqrt: { tip: m.drawing_board_square_root },
  sum: { tip: m.drawing_board_sum },
};

/** What each Formulas piece starts its card with. */
const FORMULA_STARTS: Partial<Record<PieceKind, string>> = {
  deriv: String.raw`\frac{d}{dx}f(x)`,
  int: String.raw`\int f(x)\,dx`,
  sqrt: String.raw`\sqrt{x}`,
  sum: String.raw`\sum_{i=1}^{n} a_i`,
};

/** Drawn like AFFiNE's shape pieces (canvas NsamYcLR4imjm5Xi2fWFj2 "Picked", Epo
 * 2026-11-08): flat fills, cut off by the bar's bottom edge. */
const GRAPH_PIECES: Piece[] = [
  {
    body: `<circle cx="26" cy="26" r="26" fill="#173654"></circle><path d="M26 1L26 51M38.5 4.35L13.5 47.65M47.65 13.5L4.35 38.5M51 26L1 26M47.65 38.5L4.35 13.5M38.5 47.65L13.5 4.35" stroke="#fff" stroke-opacity=".22" stroke-width="1"></path><circle cx="26" cy="26" r="18" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="1.3"></circle><circle cx="26" cy="26" r="9" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="1.3"></circle><path d="M26 26h25" stroke="#fff" stroke-opacity=".75" stroke-width="1.6" stroke-linecap="round"></path><path d="M34 26A8 8 0 0 0 32.13 20.86" fill="none" stroke="#f6c343" stroke-width="1.8"></path><path d="M26 26L39.79 14.43" stroke="#f6c343" stroke-width="2.6" stroke-linecap="round"></path><circle cx="39.79" cy="14.43" r="3.4" fill="#f6c343"></circle>`,
    dy: -10,
    h: 52,
    kind: 'polar',
    r: 0,
    viewBox: '0 0 52 52',
    w: 52,
    x: 40,
    y: 7,
  },
  {
    body: `<rect x=".75" y=".75" width="46.5" height="46.5" rx="5" fill="#fff" stroke="#d9dde3" stroke-width="1.5"></rect><path d="M13 6v36M6 33h36" stroke="#173654" stroke-width="2.6" stroke-linecap="round"></path><path d="M8 9c4 17 9 21 16 21s12-4 16-21" fill="none" stroke="#1e96eb" stroke-width="3.2" stroke-linecap="round"></path>`,
    dy: -11,
    h: 48,
    hr: -10,
    kind: 'cart',
    r: -7,
    viewBox: '0 0 48 48',
    w: 48,
    x: 6,
    y: 17,
  },
];

const CHART_PIECES: Piece[] = [
  {
    body: `<path d="M18 20L34 20A16 16 0 0 1 8.82 33.11z" fill="#1e96eb"></path><path d="M18 20L8.82 33.11A16 16 0 0 1 22.14 4.55z" fill="#173654"></path><path d="M19.98 18.48L24.12 3.03A16 16 0 0 1 35.98 18.48z" fill="#f6c343"></path>`,
    dy: -11,
    h: 34,
    kind: 'pie',
    r: 0,
    viewBox: '0 0 38 38',
    w: 34,
    x: 40,
    y: 19,
  },
  {
    body: `<rect x="0" y="18" width="8" height="30" rx="2" fill="#1e96eb"></rect><rect x="10" y="3" width="8" height="45" rx="2" fill="#173654"></rect><rect x="20" y="27" width="8" height="21" rx="2" fill="#f6c343"></rect>`,
    dy: -9,
    h: 46,
    kind: 'bar',
    r: 0,
    viewBox: '0 0 28 46',
    w: 28,
    x: 22,
    y: 25,
  },
];

const FORMULA_PIECES: Piece[] = [
  {
    body: `<rect x="0" y="0" width="28" height="34" rx="4" fill="#1e96eb"></rect><text x="14" y="14" text-anchor="middle" font-family="Times New Roman, serif" font-style="italic" font-weight="700" font-size="12" fill="#fff">d</text><path d="M6 17.5h16" stroke="#fff" stroke-width="1.6" stroke-linecap="round"></path><text x="14" y="29" text-anchor="middle" font-family="Times New Roman, serif" font-style="italic" font-weight="700" font-size="12" fill="#fff">dx</text>`,
    dy: -9,
    h: 34,
    hr: 12,
    kind: 'deriv',
    r: 8,
    viewBox: '0 0 28 34',
    w: 28,
    x: 62,
    y: 6,
  },
  {
    body: `<path d="M20 6c-2-3-7-3-8.5 2.5L8.5 51c-1.2 5.5-6 6.2-8 3" fill="none" stroke="#1e96eb" stroke-width="4.6" stroke-linecap="round"></path>`,
    dy: -10,
    h: 60,
    kind: 'int',
    r: 0,
    viewBox: '0 0 24 60',
    w: 24,
    x: 3,
    y: 10,
  },
  {
    body: `<path d="M30 7V3.5H4.5L18 19 4.5 34.5H30V31" fill="none" stroke="#173654" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"></path>`,
    dy: -12,
    h: 38,
    kind: 'sum',
    r: 0,
    viewBox: '0 0 34 38',
    w: 34,
    x: 19,
    y: 27,
  },
  {
    body: `<path d="M3 27l6-3 7 18L27 4h38" fill="none" stroke="#173654" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"></path><path d="M36 17l14 18M50 17L36 35" stroke="#173654" stroke-width="4.8" stroke-linecap="round"></path>`,
    dy: -11,
    h: 31,
    kind: 'sqrt',
    r: 0,
    viewBox: '0 0 68 46',
    w: 46,
    x: 54,
    y: 38,
  },
];

const PIECE_SHADOW = 'drop-shadow(0 0 5px rgba(0, 0, 0, 0.2))';

/** Navy lightens on a dark board (--capy-navy); the fallback is for a drag preview
 * drawn outside it. */
/** The part of a dragged piece's overlay its shadow is set on (BlockSuite's own type
 * isn't exported). */
type OverlayLayer = { element: HTMLElement };

const pieceArt = (piece: Piece) =>
  unsafeSVG(
    `<svg width="${piece.w}" height="${piece.h}" viewBox="${piece.viewBox}" aria-hidden="true">${piece.body.replace(
      /(fill|stroke)="#173654"/g,
      'style="$1:var(--capy-navy, #173654)"'
    )}</svg>`
  );

/** AFFiNE's starting mind map, a topic and three ideas, centred on a point; its own
 * layout places the ideas. */
function addMindmap(gfx: GfxController, [cx, cy]: Vec) {
  const root = { h: 50, w: 145 };
  const idea = { h: 35, w: 80 };
  const left = cx - (root.w + 120 + idea.w) / 2;
  return gfx.std.get(EdgelessCRUDIdentifier).addElement('mindmap', {
    children: {
      children: [0, 1, 2].map((i) => ({
        children: [],
        text: m.drawing_board_mind_map_idea(),
        xywh: `[${left + root.w + 120},${cy - idea.h / 2 + (i - 1) * 50},${idea.w},${idea.h}]`,
      })),
      text: m.drawing_board_mind_map_topic(),
      xywh: `[${left},${cy - root.h / 2},${root.w},${root.h}]`,
    },
    style: MindmapStyle.ONE,
  }) as string;
}

const MINDMAP_PIECE: Piece = {
  body: `<path d="M17 20C22 20 22 8 28 8M17 20h11M17 20c5 0 5 12 11 12" fill="none" stroke="#173654" stroke-width="2"/><rect x="1" y="14" width="18" height="12" rx="3" fill="#1e96eb"/><rect x="27" y="3" width="13" height="9" rx="2.5" fill="#f6c343"/><rect x="27" y="15.5" width="13" height="9" rx="2.5" fill="#f6c343"/><rect x="27" y="28" width="13" height="9" rx="2.5" fill="#f6c343"/>`,
  dy: -8,
  h: 40,
  kind: 'mindmap',
  r: 0,
  viewBox: '0 0 41 40',
  w: 41,
  x: 28,
  y: 20,
};

/** Puts down the card a piece stands for, centred where it was dropped. */
export function placePiece(gfx: GfxController, kind: PieceKind, [cx, cy]: Vec) {
  const centred = (w: number, h: number) =>
    new Bound(cx - w / 2, cy - h / 2, w, h);
  if (kind === 'cart' || kind === 'polar') {
    const { h, ppu, w } = NEW_PLANE;
    finishPlacing(gfx, addPlane(gfx, centred(w, h), ppu, kind === 'polar'));
  } else if (kind === 'bar' || kind === 'pie') {
    const { h, w } = NEW_CHART[kind];
    finishPlacing(gfx, addChart(gfx, centred(w, h), kind));
  } else if (kind === 'mindmap') {
    finishPlacing(gfx, addMindmap(gfx, [cx, cy]));
  } else {
    const latex = FORMULA_STARTS[kind];
    if (latex) openFormula(gfx, { at: [cx, cy], latex });
  }
}

/** A slot of pieces beside the pen, eraser and shapes, as AFFiNE's shape slot works:
 * a piece lifts under the pointer; clicking or dragging picks it up, it follows the
 * pointer and lands where it's dropped, and once it leaves the toolbar a new one
 * rises into the slot. Back over the toolbar it returns (Epo 2026-11-08). */
abstract class CapyPieceSlot extends EdgelessToolbarToolMixin(
  SignalWatcher(LitElement)
) {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 64px;
    }
    /* Charts' two pieces (52 px across) need less room than a full slot, as the
       eraser does (Epo 2026-11-08). */
    :host([data-own-width]) {
      width: 60px;
    }
    edgeless-toolbar-button {
      display: block;
      width: 100%;
      height: 64px;
    }
    .box {
      display: flex;
      justify-content: center;
      align-items: flex-end;
      width: 100%;
      height: 64px;
    }
    .slot {
      /* AFFiNE's room for the pieces' shadows above and beside the slot */
      --safe: 10px;
      position: relative;
      flex-shrink: 0;
      box-sizing: border-box;
      width: calc(100% + 2 * var(--safe));
      height: calc(100% + var(--safe));
      overflow: hidden;
      pointer-events: none;
      /* Above the toolbar's buttons, whose hover backgrounds are positioned too: the
         pieces reach past the slot into its neighbours. */
      z-index: 1;
    }
    :host(:hover) .slot {
      z-index: 2;
    }
    .piece {
      position: absolute;
      line-height: 0;
      transform: rotate(var(--r));
      transition:
        transform 0.3s,
        z-index 0.1s;
      pointer-events: auto;
      cursor: grab;
    }
    .piece:hover,
    .piece.cancel {
      transform: translateY(var(--dy)) rotate(var(--hr));
      z-index: 1;
    }
    .piece.next {
      transform: translateY(64px) rotate(var(--r));
      transition: transform 0.5s cubic-bezier(0.39, 0.28, 0.09, 0.95);
      pointer-events: none;
    }
    .piece.next.coming {
      transform: rotate(var(--r));
    }
  `;

  // It's not a tool: no tool is ever active for it.
  override type = DefaultTool as never;

  // @ts-expect-error the mixin defines it as a getter, typed as a property.
  override get active() {
    return false;
  }

  protected abstract pieces: Piece[];
  /** The slot's own tooltip, between its pieces. */
  protected abstract slotTip: { key: string; tip: () => string };

  /** The piece under the pointer, which the tooltip names. */
  @state()
  private accessor hovered: PieceKind | null = null;

  /** A mouse: a click picks a piece up to carry. */
  private drag: EdgelessDraggableElementController<Piece> | undefined;
  /** A finger has nothing to carry it with: a tap puts the card in the middle of the
   * view, and a drag brings it out. */
  private touch: EdgelessDraggableElementController<Piece> | undefined;

  override updated() {
    if (this.drag || !this.edgeless || !this.toolbarContainer) return;
    const gfx = this.edgeless.std.get(GfxControllerIdentifier);
    const options = (clickToDrag: boolean) => ({
      clickToDrag,
      edgeless: this.edgeless,
      onDrop: (element: { data: Piece }, bound: Bound) =>
        placePiece(gfx, element.data.kind, [
          bound.x + bound.w / 2,
          bound.y + bound.h / 2,
        ]),
      onEnterOrLeaveScope: (overlay: OverlayLayer, isOutside?: boolean) => {
        overlay.element.style.filter = isOutside ? 'none' : PIECE_SHADOW;
      },
      onOverlayCreated: (overlay: OverlayLayer) => {
        overlay.element.style.filter = PIECE_SHADOW;
      },
      scopeElement: this.toolbarContainer ?? undefined,
    });
    this.drag = new EdgelessDraggableElementController(this, options(true));
    this.touch = new EdgelessDraggableElementController(this, {
      ...options(false),
      onElementClick: ({ data }) =>
        placePiece(gfx, data.kind, [
          gfx.viewport.centerX,
          gfx.viewport.centerY,
        ]),
    });
  }

  override render() {
    const states = this.touch?.states.draggingElement
      ? this.touch.states
      : this.drag?.states;
    const { cancelled, dragOut, draggingElement } = states ?? {};
    const held = draggingElement?.data.kind;
    const shown = this.hovered ? PIECE_TIPS[this.hovered] : this.slotTip;
    return html`<edgeless-toolbar-button
      .tooltip=${
        held
          ? ''
          : html`<affine-tooltip-content-with-shortcut
              data-tip=${shown.tip()}
              data-shortcut=${shown.key ?? ''}
            ></affine-tooltip-content-with-shortcut>`
      }
      .tooltipOffset=${5}
    >
      <div class="box"><div class="slot">
        ${this.pieces.map((piece) => {
          const isHeld = held === piece.kind;
          const vars = {
            '--dy': `${piece.dy}px`,
            '--hr': `${piece.hr ?? piece.r}deg`,
            '--r': `${piece.r}deg`,
            filter: PIECE_SHADOW,
            // From the slot's middle, as AFFiNE's pieces are: narrower on phones.
            left: `calc(50% + ${piece.x - 48}px)`,
            top: `${piece.y + 10}px`,
          };
          return html`${
            isHeld
              ? html`<div
                  class=${classMap({
                    coming: !!dragOut && !cancelled,
                    next: true,
                    piece: true,
                  })}
                  style=${styleMap(vars)}
                >
                  ${pieceArt(piece)}
                </div>`
              : nothing
          }<div
            class=${classMap({ cancel: isHeld && !dragOut, piece: true })}
            data-kind=${piece.kind}
            style=${styleMap({ ...vars, opacity: isHeld ? '0' : '1' })}
            @mouseenter=${() => {
              this.hovered = piece.kind;
            }}
            @mouseleave=${() => {
              this.hovered = null;
            }}
            @click=${(event: MouseEvent) => event.stopPropagation()}
            @mousedown=${(event: MouseEvent) =>
              this.drag?.onMouseDown(event, {
                data: piece,
                preview: html`${pieceArt(piece)}`,
              })}
            @touchstart=${(event: TouchEvent) => {
              // No mouse events after it, which would pick the piece up to carry.
              event.preventDefault();
              this.touch?.onTouchStart(event, {
                data: piece,
                preview: html`${pieceArt(piece)}`,
              });
            }}
          >
            ${pieceArt(piece)}
          </div>`;
        })}
      </div></div>
    </edgeless-toolbar-button>`;
  }
}

class CapyGraphSlot extends CapyPieceSlot {
  protected pieces = GRAPH_PIECES;
  protected slotTip = { key: 'G', tip: m.drawing_board_graphs };
}

class CapyChartSlot extends CapyPieceSlot {
  protected pieces = CHART_PIECES;
  protected slotTip = { key: 'B', tip: m.drawing_board_charts };
}

class CapyFormulaSlot extends CapyPieceSlot {
  protected pieces = FORMULA_PIECES;
  protected slotTip = { key: 'M', tip: m.drawing_board_formulas };
}

/** The workspace canvas's Misc panel (Epo 2026-11-09, A): tiles in groups, each a card
 * picked up and dropped like a slot's piece; a finger's tap puts it in the view's
 * middle. Groups join as their kinds land (board catalog). */
const MISC_GROUPS: { label: () => string; tiles: Piece[] }[] = [
  {
    label: m.drawing_board_diagrams,
    tiles: [...CHART_PIECES].reverse().concat(MINDMAP_PIECE),
  },
];

class CapyMiscPanel extends WithDisposable(SignalWatcher(LitElement)) {
  static override styles = [
    POPPER_STYLES,
    css`
      :host {
        background: var(--affine-background-overlay-panel-color);
        border: 1px solid var(--affine-border-color);
        border-bottom: 0;
        border-radius: 10px 10px 0 0;
        box-shadow: 0 -6px 20px rgb(0 0 0 / 6%);
        padding: 10px 10px 8px;
      }
      h3 {
        margin: 0 0 4px 4px;
        color: var(--affine-text-secondary-color);
        font-size: 12px;
        font-weight: 600;
      }
      .group + .group {
        margin-top: 8px;
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(4, 76px);
        gap: 4px;
      }
      .tile {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        height: 76px;
        border-radius: 8px;
        color: var(--affine-text-secondary-color);
        font-size: 11.5px;
        cursor: grab;
      }
      .tile:hover {
        background: var(--affine-hover-color);
        color: var(--affine-text-primary-color);
      }
      .art {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 40px;
        filter: ${unsafeCSS(PIECE_SHADOW)};
      }
    `,
  ];

  @property({ attribute: false })
  accessor edgeless!: BlockComponent;

  private drag: EdgelessDraggableElementController<Piece> | undefined;
  private touch: EdgelessDraggableElementController<Piece> | undefined;

  override firstUpdated() {
    const gfx = this.edgeless.std.get(GfxControllerIdentifier);
    // Once something is down, the panel goes, as AFFiNE's template panel does.
    const place = (kind: PieceKind, at: Vec) => {
      placePiece(gfx, kind, at);
      this.dispatchEvent(
        new Event('placed', { bubbles: true, composed: true })
      );
    };
    const options = (clickToDrag: boolean) => ({
      clickToDrag,
      edgeless: this.edgeless,
      onDrop: (element: { data: Piece }, bound: Bound) =>
        place(element.data.kind, [
          bound.x + bound.w / 2,
          bound.y + bound.h / 2,
        ]),
      onEnterOrLeaveScope: (overlay: OverlayLayer, isOutside?: boolean) => {
        overlay.element.style.filter = isOutside ? 'none' : PIECE_SHADOW;
      },
      onOverlayCreated: (overlay: OverlayLayer) => {
        overlay.element.style.filter = PIECE_SHADOW;
      },
      scopeElement: this,
    });
    this.drag = new EdgelessDraggableElementController(this, options(true));
    this.touch = new EdgelessDraggableElementController(this, {
      ...options(false),
      onElementClick: ({ data }) =>
        place(data.kind, [gfx.viewport.centerX, gfx.viewport.centerY]),
    });
  }

  override render() {
    return MISC_GROUPS.map(
      ({ label, tiles }) =>
        html`<div class="group">
          <h3>${label()}</h3>
          <div class="tiles">
            ${tiles.map(
              (piece) =>
                html`<div
                  class="tile"
                  data-kind=${piece.kind}
                  role="button"
                  @mousedown=${(event: MouseEvent) =>
                    this.drag?.onMouseDown(event, {
                      data: piece,
                      preview: html`${pieceArt(piece)}`,
                    })}
                  @touchstart=${(event: TouchEvent) => {
                    event.preventDefault();
                    this.touch?.onTouchStart(event, {
                      data: piece,
                      preview: html`${pieceArt(piece)}`,
                    });
                  }}
                >
                  <span class="art">${pieceArt(piece)}</span>
                  ${PIECE_TIPS[piece.kind].tip()}
                </div>`
            )}
          </div>
        </div>`
    );
  }
}

/** Misc's toolbar button: four small pieces, opening its panel above the toolbar. */
class CapyMiscButton extends EdgelessToolbarToolMixin(
  SignalWatcher(LitElement)
) {
  static override styles = css`
    :host {
      display: block;
      width: 56px;
      height: 64px;
    }
    edgeless-toolbar-button {
      display: block;
      width: 100%;
      height: 64px;
    }
    .box {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 64px;
    }
  `;

  // Not a tool: it opens a panel.
  override type = DefaultTool as never;

  // @ts-expect-error the mixin defines it as a getter, typed as a property.
  override get active() {
    return !!this.popper;
  }

  private toggle() {
    if (this.popper) {
      closePopper(this);
      this.requestUpdate();
      return;
    }
    const panel = openPopper(this, 'capy-misc-panel', 300, {
      marginLeft: 'auto',
      marginRight: '0',
      maxWidth: '100%',
      width: 'auto',
    });
    panel.addEventListener('placed', () => {
      closePopper(this);
      this.requestUpdate();
    });
    this.requestUpdate();
  }

  override render() {
    return html`<edgeless-toolbar-button
      .active=${this.active}
      .tooltip=${m.drawing_board_misc()}
      .tooltipOffset=${5}
      @click=${() => this.toggle()}
    >
      <div class="box">
        <svg width="34" height="34" viewBox="0 0 40 40" aria-hidden="true">
          <rect x="5" y="9" width="12" height="12" rx="2" fill="#1e96eb" />
          <circle cx="29" cy="15" r="6.5" fill="#f6c343" />
          <rect x="5" y="25" width="12" height="12" rx="2" fill="#e8798f" />
          <rect
            x="23"
            y="25"
            width="12"
            height="12"
            rx="2"
            style="fill:var(--capy-navy, #173654)"
          />
        </svg>
      </div>
    </edgeless-toolbar-button>`;
  }
}

const NEVER_MATCHES = /(?!)/;

/** Note cards keep AFFiNE's inline LaTeX spec, which paragraphs read as they render,
 * but typing $$ does nothing: KaTeX's HTML can't reach the marking image from a card.
 * Formulas have their own toolbar button. */
export const noLatexMarkdown: ExtensionType = {
  setup: (di) => {
    di.override(LatexExtension.identifier, () => ({
      action: () => ({ halt: false }),
      name: 'latex',
      pattern: NEVER_MATCHES,
    }));
  },
};

/** A toolbar slot: its element gets the board and the toolbar, which a piece leaves
 * to be placed. */
const seniorTool = (
  id: string,
  name: () => string,
  content: (block: BlockComponent, toolbar: HTMLElement) => TemplateResult
): ExtensionType => ({
  setup: (di) => {
    di.addImpl(
      SeniorToolIdentifier(id),
      () =>
        ({
          block,
          toolbarContainer,
        }: {
          block: BlockComponent;
          toolbarContainer: HTMLElement;
        }) => ({ content: content(block, toolbarContainer), name: name() })
    );
  },
});

const graphsTool = seniorTool(
  'capy-graphs',
  m.drawing_board_graphs,
  (block, toolbar) =>
    html`<capy-graph-slot
      .edgeless=${block}
      .toolbarContainer=${toolbar}
    ></capy-graph-slot>`
);
const chartsTool = seniorTool(
  'capy-charts',
  m.drawing_board_charts,
  (block, toolbar) =>
    html`<capy-chart-slot
      data-own-width
      .edgeless=${block}
      .toolbarContainer=${toolbar}
    ></capy-chart-slot>`
);
const formulasTool = seniorTool(
  'capy-formulas',
  m.drawing_board_formulas,
  (block, toolbar) =>
    html`<capy-formula-slot
      .edgeless=${block}
      .toolbarContainer=${toolbar}
    ></capy-formula-slot>`
);
const miscTool = seniorTool(
  'capy-misc',
  m.drawing_board_misc,
  (block, toolbar) =>
    html`<capy-misc-button
      .edgeless=${block}
      .toolbarContainer=${toolbar}
    ></capy-misc-button>`
);

/** The toolbar's slots after the shapes: the question board keeps Charts as its own
 * slot; the workspace canvas has them in Misc (Epo 2026-11-09). */
export const sheetTools = (board: BoardKind) =>
  board === 'question'
    ? [graphsTool, chartsTool, formulasTool]
    : [graphsTool, formulasTool, miscTool];

for (const [tag, element] of [
  ['capy-shape-panel', CapyShapePanel],
  ['capy-shape-button', CapyShapeButton],
  ['capy-graph-slot', CapyGraphSlot],
  ['capy-chart-slot', CapyChartSlot],
  ['capy-formula-slot', CapyFormulaSlot],
  ['capy-misc-panel', CapyMiscPanel],
  ['capy-misc-button', CapyMiscButton],
] as const)
  if (!customElements.get(tag)) customElements.define(tag, element);
