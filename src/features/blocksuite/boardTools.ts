import { DefaultTool } from '@blocksuite/affine/blocks/surface';
import {
  EdgelessShapeToolButton,
  ShapeTool,
} from '@blocksuite/affine/gfx/shape';
import { Bound } from '@blocksuite/affine/global/gfx';
import { SignalWatcher } from '@blocksuite/affine/global/lit';
import {
  ConnectorMode,
  DefaultTheme,
  isTransparent,
  PointStyle,
  type ShapeName,
} from '@blocksuite/affine/model';
import {
  EditPropsStore,
  ThemeProvider,
} from '@blocksuite/affine/shared/services';
import type { PointerEventState } from '@blocksuite/affine/std';
import {
  BaseTool,
  type GfxController,
  GfxControllerIdentifier,
} from '@blocksuite/affine/std/gfx';
import {
  EdgelessToolbarToolMixin,
  SeniorToolIdentifier,
} from '@blocksuite/affine/widgets/edgeless-toolbar';
import { css, html, LitElement, svg } from 'lit';
import { property } from 'lit/decorators.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import * as Y from 'yjs';
import { m } from '@/i18n';
import {
  coordinates,
  SHEET,
  smoothThrough,
  snapToGrid,
  type Vec,
} from './boardGeometry';

const SHAPE_NAMES: ShapeName[] = [
  'rect',
  'ellipse',
  'diamond',
  'triangle',
  'roundedRect',
];

/** New shapes have no fill and a black outline, so the grid and the strokes under
 * them stay readable for marking. */
export function outlineNewShapes(gfx: GfxController) {
  setShapeFill(gfx, 'transparent');
}

function setShapeFill(gfx: GfxController, fillColor: unknown) {
  const props = gfx.std.get(EditPropsStore);
  for (const name of SHAPE_NAMES)
    props.recordLastProps(`shape:${name}`, {
      fillColor,
      filled: !isTransparent(fillColor),
      strokeColor: DefaultTheme.black,
    });
}

// ---------------------------------------------------------------- plotting

type Plot = 'point' | 'line' | 'curve';

const previews = new WeakMap<GfxController, SVGSVGElement>();

/** The layer under the strokes that shows a plot being placed. It lives on the
 * sheet, so it moves and scales with the board and never reaches the answer. */
export function setBoardPreview(gfx: GfxController, layer: SVGSVGElement) {
  previews.set(gfx, layer);
}

const snap = (gfx: GfxController, e: PointerEventState) =>
  snapToGrid(gfx.viewport.toModelCoord(e.x, e.y) as Vec);

const INK = '#000000';
const DOT = 10;
/** A brush this wide draws as thick as a 2 px shape outline or connector. */
const CURVE_WIDTH = 1.5;
const PREVIEW = '#1e96eb';

function addDot(gfx: GfxController, [x, y]: Vec) {
  return gfx.surface?.addElement({
    fillColor: DefaultTheme.black,
    filled: true,
    shapeType: 'ellipse',
    strokeColor: DefaultTheme.black,
    strokeWidth: 1,
    type: 'shape',
    xywh: new Bound(x - DOT / 2, y - DOT / 2, DOT, DOT).serialize(),
  });
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

/** Point, Line and Curve: each click snaps to a grid crossing and the coordinates
 * show while you place it. Everything lands as ordinary dots and strokes. */
export class PlotTool extends BaseTool<{ plot: Plot }> {
  static override toolName = 'capy-plot';

  private placed: Vec[] = [];

  private get plot() {
    return this.activatedOption.plot;
  }

  override activate() {
    this.placed = [];
  }

  override deactivate() {
    if (this.plot === 'curve') this.commitCurve();
    this.placed = [];
    this.draw(null);
  }

  override pointerMove(e: PointerEventState) {
    this.draw(snap(this.gfx, e));
  }

  override pointerOut() {
    this.draw(null);
  }

  override click(e: PointerEventState) {
    const at = snap(this.gfx, e);
    if (!at) return;
    const last = this.placed.at(-1);
    const repeat = last && last[0] === at[0] && last[1] === at[1];
    if (this.plot === 'point') {
      addDot(this.gfx, at);
      this.gfx.doc.captureSync();
    } else if (this.plot === 'line') {
      if (last && !repeat) {
        addGroup(this.gfx, [
          addSegment(this.gfx, last, at),
          addDot(this.gfx, last),
          addDot(this.gfx, at),
        ]);
        this.gfx.doc.captureSync();
        this.placed = [];
      } else if (!last) this.placed = [at];
    } else if (repeat) this.commitCurve();
    else this.placed.push(at);
    this.draw(at);
  }

  private commitCurve() {
    const { placed } = this;
    this.placed = [];
    if (placed.length < 2) return;
    const brush = this.gfx.surface?.addElement({
      color: DefaultTheme.black,
      lineWidth: CURVE_WIDTH,
      points: smoothThrough(placed).map(([x, y]) => [x, y, 0.5]),
      type: 'brush',
    });
    addGroup(this.gfx, [brush, ...placed.map((p) => addDot(this.gfx, p))]);
    this.gfx.doc.captureSync();
  }

  private draw(at: Vec | null) {
    const layer = previews.get(this.gfx);
    if (!layer) return;
    const parts: string[] = [];
    if (at)
      parts.push(
        `<path d="M${at[0]} 0V${at[1]}M${SHEET.origin.x} ${at[1]}H${at[0]}" stroke="${PREVIEW}" stroke-dasharray="4 4" fill="none"/>`,
        `<circle cx="${at[0]}" cy="${at[1]}" r="${DOT / 2}" fill="${PREVIEW}"/>`,
        `<g transform="translate(${at[0] + 12} ${at[1] - 32})"><rect width="${coordinates(at).length * 8 + 14}" height="24" rx="4" fill="#111"/><text x="7" y="17" fill="#fff" font-size="14" font-family="Arial, sans-serif">${coordinates(at)}</text></g>`
      );
    const points = this.placed;
    for (const [x, y] of points)
      parts.push(`<circle cx="${x}" cy="${y}" r="${DOT / 2}" fill="${INK}"/>`);
    const line = at ? [...points, at] : points;
    if (line.length > 1) {
      const path = smoothThrough(line)
        .map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`)
        .join('');
      parts.push(
        `<path d="${path}" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`
      );
    }
    layer.innerHTML = parts.join('');
  }
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
        shapeName: 'rect',
      },
      {
        icon: '<circle cx="12" cy="12" r="8.5"/>',
        label: m.drawing_board_ellipse,
        shapeName: 'ellipse',
      },
      {
        icon: '<path d="M12 3l9 9-9 9-9-9z"/>',
        label: m.drawing_board_diamond,
        shapeName: 'diamond',
      },
      {
        icon: '<path d="M12 4l9 16H3z"/>',
        label: m.drawing_board_triangle,
        shapeName: 'triangle',
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

const FILLS = DefaultTheme.FillColorShortPalettes.filter(
  ({ value }: { value: unknown }) => !isTransparent(value)
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
`;

class CapyShapePanel extends SignalWatcher(LitElement) {
  static override styles = [
    POPPER_STYLES,
    css`
      :host {
        background: #fff;
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
        display: flex;
        align-items: center;
        gap: 2px;
        margin: 10px -14px 0;
        padding: 8px 14px 0 8px;
        border-top: 1px solid var(--affine-border-color);
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
    const props = this.edgeless.std.get(EditPropsStore).lastProps$.value;
    const theme = this.edgeless.std.get(ThemeProvider);
    const current = props['shape:rect'].fillColor;
    const swatch = (color: unknown, label: string, cls = '') =>
      html`<button
        aria-label=${label}
        aria-pressed=${JSON.stringify(current) === JSON.stringify(color)}
        title=${label}
        type="button"
        @click=${() => setShapeFill(this.gfx, color)}
      >
        <i
          class=${cls}
          style=${cls ? '' : `background:${theme.generateColorProperty(color)}`}
        ></i>
      </button>`;
    return html`<div class="groups">
        ${PANEL.map((group, i) => this.renderGroup(group, i === 0))}
      </div>
      <div class="fills" role="group" aria-label=${m.drawing_board_fill()}>
        ${swatch('transparent', m.drawing_board_no_fill(), 'none')}
        ${FILLS.map(({ key, value }: { key: string; value: unknown }) =>
          swatch(value, key)
        )}
      </div>`;
  }

  @property({ attribute: false })
  accessor edgeless!: EdgelessShapeToolButton['edgeless'];
}

/** A popper taller than AFFiNE's 100 px clip, spanning the toolbar. */
function openPopper(
  button: EdgelessShapeToolButton | CapyMathsButton,
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
}

/** Leaving the tool closes its menu. Forgetting it at once lets a quick click open
 * it again while it's still sliding away. */
function closePopper(button: EdgelessShapeToolButton | CapyMathsButton) {
  const { popper } = button;
  if (!popper) return;
  button.popper = null;
  popper.dispose();
}

/** AFFiNE's draggable pieces, opening the grouped panel for its one-row menu. */
class CapyShapeButton extends EdgelessShapeToolButton {
  override get active() {
    const active = this.edgelessTool?.toolType;
    return active === ShapeTool || active === StampTool;
  }

  override updated(changed: Map<PropertyKey, unknown>) {
    super.updated(changed);
    if (!this.active) closePopper(this);
  }

  protected _toggleMenu() {
    openPopper(this, 'capy-shape-panel', 420, {
      marginLeft: '0',
      maxWidth: '100%',
      width: '100%',
    });
  }
}

export const shapeButtonTool = {
  setup: (di: { override: (...args: unknown[]) => void }) => {
    di.override(
      SeniorToolIdentifier('shape'),
      () =>
        ({
          block,
          toolbarContainer,
        }: {
          block: unknown;
          toolbarContainer: unknown;
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

const MATHS_ICONS: Record<Plot | 'axes', string> = {
  axes: '<path d="M6 21V3M6 18h15M3.5 5.5 6 3l2.5 2.5M18.5 15.5 21 18l-2.5 2.5M6 13h1.5M6 8h1.5M11 18v-1.5M16 18v-1.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  curve:
    '<path d="M4 6c2 9 5 13 8 13s6-5 8-14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="4.5" cy="7" r="2" fill="currentColor"/><circle cx="12" cy="19" r="2" fill="currentColor"/><circle cx="19.5" cy="7" r="2" fill="currentColor"/>',
  line: '<path d="M6 18 18 6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5" cy="19" r="2.2" fill="currentColor"/><circle cx="19" cy="5" r="2.2" fill="currentColor"/>',
  point:
    '<path d="M12 3v5M12 16v5M3 12h5M16 12h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/>',
};

const icon24 = (body: string) =>
  html`<svg height="24" viewBox="0 0 24 24" width="24">${shape(body)}</svg>`;

/** The formula button's action, set by the formula module. */
let openFormula: (gfx: GfxController) => void = () => undefined;
export function setFormulaOpener(open: typeof openFormula) {
  openFormula = open;
}
const FORMULA_ICON =
  '<path d="M18 5H7l6 7-6 7h11" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';

class CapyMathsMenu extends SignalWatcher(LitElement) {
  static override styles = [
    POPPER_STYLES,
    css`
      :host {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 6px 8px;
        background: var(--affine-background-overlay-panel-color);
        border: 1px solid var(--affine-border-color);
        border-bottom: 0;
        border-radius: 8px 8px 0 0;
      }
      i {
        width: 1px;
        height: 20px;
        margin: 0 4px;
        background: var(--affine-border-color);
      }
    `,
  ];

  private get gfx() {
    return this.edgeless.std.get(GfxControllerIdentifier);
  }

  override render() {
    const option = this.gfx.tool.currentToolOption$.value;
    const plot = (kind: Plot, label: string) =>
      html`<button
        aria-label=${label}
        aria-pressed=${
          option?.toolType === PlotTool && option.options?.plot === kind
        }
        title=${label}
        type="button"
        @click=${() => this.gfx.tool.setTool(PlotTool, { plot: kind })}
      >
        ${icon24(MATHS_ICONS[kind])}
      </button>`;
    const addAxes = () => {
      const { h, w } = PRESETS.axes;
      const { centerX, centerY } = this.gfx.viewport;
      finishPlacing(
        this.gfx,
        placePreset(
          this.gfx,
          'axes',
          new Bound(centerX - w / 2, centerY - h / 2, w, h)
        )
      );
    };
    return html`${plot('point', m.drawing_board_point())}
      ${plot('line', m.drawing_board_line_through_points())}
      ${plot('curve', m.drawing_board_curve())}
      <button
        aria-label=${m.drawing_board_add_axes()}
        title=${m.drawing_board_add_axes()}
        type="button"
        @click=${addAxes}
      >
        ${icon24(MATHS_ICONS.axes)}
      </button>
      <i></i>
      <button
        aria-label=${m.drawing_board_formula()}
        title=${m.drawing_board_formula()}
        type="button"
        @click=${() => openFormula(this.gfx)}
      >
        ${icon24(FORMULA_ICON)}
      </button>`;
  }

  @property({ attribute: false })
  accessor edgeless!: EdgelessShapeToolButton['edgeless'];
}

/** A sheet of graph paper with a curve, beside the pen, eraser and shapes. */
class CapyMathsButton extends EdgelessToolbarToolMixin(
  SignalWatcher(LitElement)
) {
  static override styles = css`
    :host {
      display: block;
      width: 100%;
      height: 64px;
    }
    edgeless-toolbar-button {
      display: block;
      width: 100%;
      height: 64px;
      overflow: hidden;
    }
    .art {
      position: absolute;
      left: 17px;
      top: 16px;
      line-height: 0;
      filter: drop-shadow(0 2px 6px rgb(0 0 0 / 14%));
      transition: transform 0.3s;
    }
    .wrap {
      position: relative;
      width: 100%;
      height: 64px;
      overflow: hidden;
      cursor: pointer;
    }
    .wrap:hover .art,
    .art[data-active='true'] {
      transform: translateY(-8px);
    }
  `;

  override type = PlotTool as never;

  override updated() {
    if (!this.active) closePopper(this);
  }

  private toggle() {
    if (this.tryDisposePopper()) return;
    if (this.gfx.tool.currentToolOption$.peek()?.toolType !== PlotTool)
      this.gfx.tool.setTool(PlotTool, { plot: 'point' });
    openPopper(this, 'capy-maths-menu', 100, {
      marginLeft: 'auto',
      marginRight: '10px',
      maxWidth: '100%',
      width: 'fit-content',
    });
  }

  override render() {
    return html`<edgeless-toolbar-button
      .active=${this.active}
      .tooltip=${this.popper ? '' : m.drawing_board_maths()}
      .tooltipOffset=${5}
      @click=${() => this.toggle()}
    >
      <div class="wrap">
        <span class="art" data-active=${this.active}>
          <svg height="62" viewBox="0 0 62 62" width="62">
            <g transform="rotate(-5 31 31)">
              <rect
                fill="#fff"
                height="60"
                rx="3"
                stroke="#dfe1e6"
                width="54"
                x="4"
                y="4"
              ></rect>
              <path
                d="M13 4v60M22 4v60M31 4v60M40 4v60M49 4v60M4 13h54M4 22h54M4 31h54M4 40h54M4 49h54"
                stroke="#e8ecf1"
              ></path>
              <path
                d="M13 4v60M4 40h54"
                stroke="#85858a"
                stroke-width="1.3"
              ></path>
              <path
                d="M8 14c5 21 10 31 17 31s12-12 21-35"
                fill="none"
                stroke="#2b9be8"
                stroke-linecap="round"
                stroke-width="2.4"
              ></path>
            </g>
          </svg>
        </span>
      </div>
    </edgeless-toolbar-button>`;
  }
}

export const mathsTool = {
  setup: (di: { addImpl: (...args: unknown[]) => void }) => {
    di.addImpl(
      SeniorToolIdentifier('capy-maths'),
      () =>
        ({ block }: { block: unknown }) => ({
          content: html`<capy-maths-button .edgeless=${block}></capy-maths-button>`,
          name: m.drawing_board_maths(),
        })
    );
  },
};

for (const [tag, element] of [
  ['capy-shape-panel', CapyShapePanel],
  ['capy-shape-button', CapyShapeButton],
  ['capy-maths-menu', CapyMathsMenu],
  ['capy-maths-button', CapyMathsButton],
] as const)
  if (!customElements.get(tag)) customElements.define(tag, element);
