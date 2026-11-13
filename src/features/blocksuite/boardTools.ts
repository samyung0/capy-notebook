import { addImages } from '@blocksuite/affine/blocks/image';
import { setNotesInline } from '@blocksuite/affine/blocks/note';
import {
  DefaultTool,
  EdgelessCRUDIdentifier,
} from '@blocksuite/affine/blocks/surface';
import { ConnectorTool } from '@blocksuite/affine/gfx/connector';
import {
  EdgelessNoteSeniorButton,
  NoteTool,
  type NoteToolOption,
} from '@blocksuite/affine/gfx/note';
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
  isInlineNote,
  isTransparent,
  MAX_IMAGE_WIDTH,
  MindmapStyle,
  NoteBlockModel,
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
  type BlockStdScope,
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
import {
  ArrowLeft04Icon,
  Cancel01Icon,
  Link04Icon,
  Pen01Icon,
  PlusSignIcon,
  TextIcon,
} from '@hugeicons/core-free-icons';
import {
  css,
  html,
  LitElement,
  nothing,
  type PropertyValues,
  svg,
  type TemplateResult,
  unsafeCSS,
} from 'lit';
import { property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import { repeat } from 'lit/directives/repeat.js';
import { styleMap } from 'lit/directives/style-map.js';
import { unsafeSVG } from 'lit/directives/unsafe-svg.js';
import * as Y from 'yjs';
import { BOARD_CATALOG } from '@/api/board.generated';
import type { MaterialPreview } from '@/api/types';
import { userToast } from '@/components/ui/userToast';
import {
  cardEditable,
  cardEditing,
  setCardEditing,
} from '@/features/canvas/materialCardHosts';
import {
  cardCountLabel,
  questionCountLabel,
} from '@/features/materials/countLabels';
import {
  youtubeVideoId,
  youtubeWatchUrl,
} from '@/features/materials/youtubeUrl';
import { m } from '@/i18n';
import { errorCopy } from '@/lib/errors';
import { IMAGE_ACCEPT } from '@/lib/fitImage';
import { iconUrl } from '@/lib/icon-catalog';
import {
  addCard,
  type CardMaterialKind,
  LINK_FLAVOUR,
  type LinkBlockModel,
  MATERIAL_CARD_SIZE,
  MATERIAL_FLAVOUR,
  workspaceOf,
} from './boardCards';
import { addChart, type ChartElementModel, openChart } from './boardChart';
import {
  type KlipyGif,
  type KlipyKind,
  klipyEnabled,
  klipyMedia,
  klipyShared,
} from './boardKlipy';
import type { BoardKind } from './boardLoad';
import { addPicture } from './boardPicture';
import {
  EMOJI,
  emojiStillUrl,
  emojiText,
  isWebAddress,
  type PictureKind,
} from './boardPictureData';
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
  ShapeType.RightTriangle,
  ShapeType.Parallelogram,
  ShapeType.Trapezium,
  ShapeType.Pentagon,
  ShapeType.Hexagon,
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

/** Solids and diagrams no shape type draws: straight connectors and ellipses
 * grouped together, in a 100 by 100 box. A pen stroke would smear at the corners.
 * The flat polygons are shape types (vendored local change 46), so they fill, hold
 * text and connect as a square does (Epo 2026-11-12). */
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

/** A clicked line's length; it is centred on the click. */
const LINE_LENGTH = 120;

/** An arrowhead's two strokes at `to`, pointing away from `from`. */
function arrowHead(from: Vec, to: Vec) {
  const angle = Math.atan2(to[1] - from[1], to[0] - from[0]);
  const wing = (turn: number): Vec => [
    to[0] - 12 * Math.cos(angle + turn),
    to[1] - 12 * Math.sin(angle + turn),
  ];
  const [a, b] = [wing(Math.PI / 6), wing(-Math.PI / 6)];
  return `M${a[0]} ${a[1]}L${to[0]} ${to[1]}L${b[0]} ${b[1]}`;
}

/** The SVG of a preset or line as it will be placed, for the pointer to carry. */
function stampMarkup(preset: string, at: Vec, colour: string) {
  const stroke = `fill="none" stroke="${colour}" stroke-width="2" stroke-linejoin="round"`;
  const ends = LINE_ENDS[preset];
  if (ends) {
    const from: Vec = [at[0] - LINE_LENGTH / 2, at[1]];
    const to: Vec = [at[0] + LINE_LENGTH / 2, at[1]];
    const d = [
      `M${from[0]} ${from[1]}L${to[0]} ${to[1]}`,
      ends.rear ? arrowHead(from, to) : '',
      ends.front ? arrowHead(to, from) : '',
    ].join('');
    return `<path d="${d}" ${stroke}/>`;
  }
  const { h, w, parts } = PRESETS[preset];
  const box = new Bound(at[0] - w / 2, at[1] - h / 2, w, h);
  const scaled = ([x, y]: Vec): Vec => [
    box.x + (x / 100) * box.w,
    box.y + (y / 100) * box.h,
  ];
  return parts
    .map((part) => {
      if ('ellipse' in part) {
        const [x, y, pw, ph] = part.ellipse;
        const [left, top] = scaled([x, y]);
        const [rx, ry] = [(pw / 200) * box.w, (ph / 200) * box.h];
        return `<ellipse cx="${left + rx}" cy="${top + ry}" rx="${rx}" ry="${ry}" ${stroke}/>`;
      }
      if ('text' in part) {
        const [left, top] = scaled(part.at);
        return `<text x="${left}" y="${top + 18}" fill="${colour}" font-size="18">${part.text}</text>`;
      }
      const from = scaled(part.from);
      const to = scaled(part.to);
      return `<path d="M${from[0]} ${from[1]}L${to[0]} ${to[1]}${
        part.arrow === 'rear' || part.arrow === 'both'
          ? arrowHead(from, to)
          : ''
      }${part.arrow === 'both' ? arrowHead(to, from) : ''}" ${stroke}/>`;
    })
    .join('');
}

/** A preset or line from the shapes panel: it follows the pointer, centred on it,
 * until a click places it there, or a drag sizes it (Epo 2026-11-12). */
export class StampTool extends BaseTool<{ preset: string }> {
  static override toolName = 'capy-stamp';

  private start: Vec | null = null;
  private end: Vec | null = null;

  private model(e: PointerEventState): Vec {
    return this.gfx.viewport.toModelCoord(e.x, e.y) as Vec;
  }

  private show(markup: string) {
    const layer = previews.get(this.gfx);
    if (layer) layer.innerHTML = markup;
  }

  private place(from: Vec, to: Vec | null) {
    const { gfx } = this;
    const { preset } = this.activatedOption;
    const ends = LINE_ENDS[preset];
    if (ends) {
      const [start, end]: [Vec, Vec] = to
        ? [from, to]
        : [
            [from[0] - LINE_LENGTH / 2, from[1]],
            [from[0] + LINE_LENGTH / 2, from[1]],
          ];
      finishPlacing(gfx, addSegment(gfx, start, end, ends));
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
    this.show('');
    this.place(this.model(e), null);
  }

  override pointerMove(e: PointerEventState) {
    if (this.start) return;
    const colour = this.std
      .get(ThemeProvider)
      .getColorValue(DefaultTheme.black, undefined, true);
    this.show(stampMarkup(this.activatedOption.preset, this.model(e), colour));
  }

  override pointerOut() {
    if (!this.start) this.show('');
  }

  override deactivate() {
    this.show('');
  }

  override dragStart(e: PointerEventState) {
    this.start = this.model(e);
  }

  override dragMove(e: PointerEventState) {
    if (!this.start) return;
    this.end = this.model(e);
    const [x1, y1] = this.start;
    const [x2, y2] = this.end;
    this.show(
      LINE_ENDS[this.activatedOption.preset]
        ? `<path d="M${x1} ${y1}L${x2} ${y2}" stroke="${PREVIEW}" stroke-width="2"/>`
        : `<rect x="${Math.min(x1, x2)}" y="${Math.min(y1, y2)}" width="${Math.abs(x2 - x1)}" height="${Math.abs(y2 - y1)}" fill="none" stroke="${PREVIEW}" stroke-dasharray="4 4"/>`
    );
  }

  override dragEnd() {
    const { end, start } = this;
    this.start = null;
    this.end = null;
    this.show('');
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
        icon: '<path d="M5 4v16h15z"/>',
        label: m.drawing_board_right_triangle,
        shapeName: ShapeType.RightTriangle,
      },
      {
        icon: '<path d="M8 6h13l-5 12H3z"/>',
        label: m.drawing_board_parallelogram,
        shapeName: ShapeType.Parallelogram,
      },
      {
        icon: '<path d="M7 6h10l4 12H3z"/>',
        label: m.drawing_board_trapezium,
        shapeName: ShapeType.Trapezium,
      },
      {
        icon: '<path d="M12 3l9 7-3.5 11h-11L3 10z"/>',
        label: m.drawing_board_pentagon,
        shapeName: ShapeType.Pentagon,
      },
      {
        icon: '<path d="M7 4h10l5 8-5 8H7l-5-8z"/>',
        label: m.drawing_board_hexagon,
        shapeName: ShapeType.Hexagon,
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

  /** A shape picked here follows the pointer until it is placed: the shape
   * tool draws it on activating, but not when only its shape changes, so it
   * is drawn again, as AFFiNE's own menu does (Epo 2026-11-12). */
  private pick(item: PanelItem) {
    if ('shapeName' in item) {
      this.gfx.tool.setTool(ShapeTool, { shapeName: item.shapeName });
      const tool = this.gfx.tool.currentTool$.peek();
      if (tool instanceof ShapeTool) tool.createOverlay();
    } else this.gfx.tool.setTool(StampTool, { preset: item.preset });
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
  style: Partial<CSSStyleDeclaration>,
  onDispose?: () => void
) {
  // While a panel is open the toolbar sits over a selected element's own
  // toolbar (z-index 1000), which otherwise covered the panel (Epo 2026-11-12).
  const toolbar = toolbarWidgetOf(button);
  if (toolbar) toolbar.style.zIndex = '1001';
  let unlisten = () => {};
  const popper = button.createPopper(tag as 'div', button, {
    onDispose: () => {
      if (toolbar) toolbar.style.zIndex = '';
      unlisten();
      onDispose?.();
    },
    setProps: (element: HTMLElement & { edgeless?: unknown }) => {
      element.edgeless = button.edgeless;
    },
  });
  const { element } = popper;
  const clip = element.parentElement;
  if (clip) clip.style.height = `${height}px`;
  Object.assign(element.style, style);
  keepEventsIn(element);
  unlisten = closeOnPressOutside(button, element);
  return element;
}

/** A press anywhere but the panel and its button closes the panel, as a popover
 * does (Epo 2026-11-12). A shape picked in it is still placed by that press.
 * Returns the listener's removal, for the panel's dispose. */
function closeOnPressOutside(button: PopperButton, panel: HTMLElement) {
  const onPress = (event: PointerEvent) => {
    const path = event.composedPath();
    if (path.includes(panel) || path.includes(button)) return;
    closePopper(button);
    button.requestUpdate();
  };
  document.addEventListener('pointerdown', onPress, true);
  return () => document.removeEventListener('pointerdown', onPress, true);
}

/** Every toolbar button with a panel (Epo 2026-11-12): a click only opens or closes
 * the panel, so nothing follows the pointer until something is picked in it. */
function togglePanel(button: PopperButton, open: () => void) {
  if (button.popper) closePopper(button);
  else open();
  button.requestUpdate();
}

/** Each panel button's tool at its last update, and whether that was its own. */
const followed = new WeakMap<object, { held: boolean; tool: unknown }>();

/** From a panel button's `updated`: its panel closes once what was picked in it is
 * placed (its tool given up), or when another tool is taken while it is open. The
 * tool it opened over stays: the pen stays the pen while the panel is open (Epo
 * 2026-11-12). */
function followTool(
  button: PopperButton & { edgelessTool?: { toolType?: unknown } },
  holds: boolean
) {
  const tool = button.edgelessTool?.toolType;
  const last = followed.get(button);
  followed.set(button, { held: holds, tool });
  if (!last) return;
  if ((last.held && !holds) || (!holds && tool !== last.tool))
    closePopper(button);
}

/** The bottom toolbar's widget, whose shadow tree holds the button. */
function toolbarWidgetOf(button: HTMLElement): HTMLElement | null {
  let node: Node = button;
  while (true) {
    const root = node.getRootNode();
    if (!(root instanceof ShadowRoot)) return null;
    const host = root.host as HTMLElement;
    if (host.tagName === 'EDGELESS-TOOLBAR-WIDGET') return host;
    node = host;
  }
}

const kept = new WeakSet<HTMLElement>();
/** The toolbar stops a press's start at its container, but its end and click,
 * keys, clipboard and wheel still reached the board under the panel: a click
 * there cleared the board's selection, which took focus out of the panel's
 * field, and a key could act on the board (Epo 2026-11-12). Escape still goes
 * on, to close the panel. */
function keepEventsIn(element: HTMLElement) {
  if (kept.has(element)) return;
  kept.add(element);
  for (const type of [
    'click',
    'copy',
    'cut',
    'keydown',
    'keyup',
    'mouseup',
    'paste',
    'pointerup',
    'wheel',
  ])
    element.addEventListener(type, (event) => {
      if (event instanceof KeyboardEvent && event.key === 'Escape') return;
      event.stopPropagation();
    });
}

/** Leaving the tool closes its menu. Forgetting it at once lets a quick click open
 * it again while it's still sliding away. */
function closePopper(button: PopperButton) {
  const { popper } = button;
  if (!popper) return;
  button.popper = null;
  popper.dispose();
}

/** AFFiNE's draggable pieces, opening the grouped panel for its one-row menu.
 * A click on the button or a piece only opens or closes the panel (Epo
 * 2026-11-12): AFFiNE also took up a rectangle, which then followed the
 * pointer. A piece is taken up by dragging it, or picked in the panel. */
// @ts-expect-error `_toggleMenu` and the click handlers are private in the base,
// which reads them through `this`.
class CapyShapeButton extends EdgelessShapeToolButton {
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: the base's template reads it.
  private readonly _handleWrapperClick = () =>
    togglePanel(this, () => this._toggleMenu());

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: the base's template reads it.
  private readonly _handleShapeClick = () =>
    togglePanel(this, () => this._toggleMenu());

  private get shapeTool() {
    const tool = this.edgelessTool?.toolType;
    return tool === ShapeTool || tool === StampTool;
  }

  // @ts-expect-error the mixin defines it as a getter, typed as a property.
  override get active() {
    return this.shapeTool || !!this.popper;
  }

  override updated(changed: Map<PropertyKey, unknown>) {
    super.updated(changed);
    followTool(this, this.shapeTool);
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

/** AFFiNE's note button, as the shape button (Epo 2026-11-12): a click only
 * opens or closes the menu of note kinds, where AFFiNE also took up a note at
 * once; a kind picked in it follows the pointer until placed. */
// @ts-expect-error `_toggleNoteMenu` is private in the base, which reads it
// through `this`.
class CapyNoteButton extends EdgelessNoteSeniorButton {
  // @ts-expect-error the mixin defines it as a getter, typed as a property.
  override get active() {
    return this.edgelessTool?.toolType === NoteTool || !!this.popper;
  }

  override updated(changed: Map<PropertyKey, unknown>) {
    super.updated(changed);
    followTool(this, this.edgelessTool?.toolType === NoteTool);
  }

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: the base's template reads it.
  private _toggleNoteMenu() {
    togglePanel(this, () => {
      let unlisten = () => {};
      const menu = this.createPopper('edgeless-note-menu', this, {
        onDispose: () => unlisten(),
      });
      keepEventsIn(menu.element);
      unlisten = closeOnPressOutside(this, menu.element);
      // Link first, where the board takes link cards (Epo 2026-11-13, P1).
      if (boardKinds.get(this.edgeless.std)?.board === 'workspace')
        this.showLink(menu.element, false);
      Object.assign(menu.element, {
        childFlavour: this.childFlavour,
        // Marked only while a note of that kind is in hand: the last one picked
        // isn't (Epo 2026-11-13).
        childType:
          this.edgelessTool?.toolType === NoteTool ? this.childType : null,
        edgeless: this.edgeless,
        onChange: (props: Partial<NoteToolOption>) => {
          Object.assign(this, props);
          this.setEdgelessTool(NoteTool, {
            childFlavour: this.childFlavour,
            childType: this.childType,
            tip: this.tip,
          });
        },
        tip: this.tip,
      });
    });
  }

  /** The menu's Link button, lit while its field is open above the row. */
  private showLink(
    menu: HTMLElement & { above?: unknown; lead?: unknown },
    open: boolean
  ) {
    const label = m.drawing_board_link();
    menu.lead = html`<edgeless-tool-icon-button
      .active=${open}
      .activeMode=${'background'}
      .tooltip=${label}
      aria-label=${label}
      @click=${() => this.showLink(menu, !open)}
      >${hugeIcon(Link04Icon)}</edgeless-tool-icon-button
    >`;
    menu.above = open
      ? html`<capy-link-add
          .gfx=${this.edgeless.std.get(GfxControllerIdentifier)}
          @placed=${() => {
            closePopper(this);
            this.requestUpdate();
          }}
        ></capy-link-add>`
      : nothing;
    // The popper's clip is 100 px, the row's height: room for the field.
    if (menu.parentElement)
      menu.parentElement.style.height = open ? '180px' : '100px';
  }
}

export const noteButtonTool: ExtensionType = {
  setup: (di) => {
    di.override(
      SeniorToolIdentifier('note'),
      () =>
        ({ block }: { block: BlockComponent }) => ({
          content: html`<capy-note-button .edgeless=${block}></capy-note-button>`,
          name: 'Note',
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

/** What a typed link places: a YouTube address as its video, any other web address
 * as itself; null when it is neither. */
function readLink(value: string) {
  const typed = value.trim();
  let url: URL | null = null;
  for (const candidate of [typed, `https://${typed}`])
    try {
      url = new URL(candidate);
      break;
    } catch {
      // The next spelling.
    }
  // Only an address is a video: a bare 11-letter word is a typo, not an id.
  const videoId = url && youtubeVideoId(url.href);
  if (videoId) return { url: youtubeWatchUrl(videoId), videoId };
  if (
    !(url && isWebAddress(url.href) && url.hostname.includes('.')) ||
    url.href.length > BOARD_CATALOG.limits.LINK_URL_MAX
  )
    return null;
  return { url: url.href, videoId: '' };
}

/** A typed link's card in the view's middle, selected: a YouTube video 16:9, any
 * other web address a web card. False when it isn't a web address. */
function placeLink(gfx: GfxController, value: string) {
  const link = readLink(value);
  if (!link) return false;
  addCard(gfx, LINK_FLAVOUR, link, link.videoId ? [320, 180] : [280, 76]);
  return true;
}

/** The note menu's Link field (Epo 2026-11-13, P1): the address Misc's YouTube
 * tile takes, above the menu's row; Add places its card. */
class CapyLinkAdd extends LitElement {
  static override styles = css`
    .panel {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: 320px;
      max-width: calc(100vw - 32px);
      padding: 6px;
      box-sizing: border-box;
      border: 1px solid var(--affine-border-color);
      border-radius: 10px;
      background: var(--affine-background-overlay-panel-color);
      box-shadow: var(--affine-overlay-shadow);
    }
    form {
      display: flex;
      gap: 6px;
    }
    input {
      flex: 1;
      min-width: 0;
      height: 32px;
      padding: 0 10px;
      box-sizing: border-box;
      border: 1px solid var(--affine-border-color);
      border-radius: 6px;
      background: transparent;
      color: var(--affine-text-primary-color);
      font: inherit;
      font-size: 13px;
      outline: none;
    }
    input:focus {
      border-color: var(--affine-primary-color);
    }
    button {
      height: 32px;
      padding: 0 12px;
      border: 1px solid var(--affine-border-color);
      border-radius: 6px;
      background: transparent;
      color: var(--affine-text-primary-color);
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .error {
      margin: 0 2px;
      color: var(--affine-error-color);
      font-size: 12px;
    }
  `;

  gfx!: GfxController;
  private invalid = false;

  override firstUpdated() {
    this.renderRoot.querySelector('input')?.focus();
  }

  override render() {
    return html`<div class="panel">
      <form
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const input = this.renderRoot.querySelector('input');
          if (input && placeLink(this.gfx, input.value)) {
            this.dispatchEvent(new Event('placed'));
            return;
          }
          this.invalid = true;
          this.requestUpdate();
        }}
      >
        <input
          aria-label=${m.drawing_board_link_address()}
          maxlength=${BOARD_CATALOG.limits.LINK_URL_MAX}
          placeholder=${m.drawing_board_link_address()}
          type="text"
          @input=${() => {
            if (!this.invalid) return;
            this.invalid = false;
            this.requestUpdate();
          }}
        />
        <button type="submit">${m.drawing_board_link_add()}</button>
      </form>
      ${this.invalid ? html`<p class="error">${m.drawing_board_link_invalid()}</p>` : nothing}
    </div>`;
  }
}

/** A placed link's Edit link (Epo 2026-11-13, E1): a field under the toolbar with
 * the address in it. Save points the card at the new one where it stands, as wide
 * as it was; a video is 16:9 and a web link takes its card's height. */
class CapyLinkEdit extends LitElement {
  static override styles = css`
    form {
      display: flex;
      flex-direction: column;
      gap: 6px;
      width: 280px;
    }
    .row {
      display: flex;
      gap: 6px;
    }
    input {
      flex: 1;
      min-width: 0;
      height: 32px;
      padding: 0 10px;
      box-sizing: border-box;
      border: 1px solid var(--affine-border-color);
      border-radius: 6px;
      background: transparent;
      color: var(--affine-text-primary-color);
      font: inherit;
      font-size: 13px;
      outline: none;
    }
    input:focus {
      border-color: var(--affine-primary-color);
    }
    button {
      height: 32px;
      padding: 0 12px;
      border: 0;
      border-radius: 6px;
      background: var(--affine-primary-color);
      color: #fff;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    .error {
      margin: 0 2px;
      color: var(--affine-error-color);
      font-size: 12px;
    }
  `;

  model!: LinkBlockModel;
  store!: ToolbarContext['store'];
  private invalid = false;

  /** The address as it stands, selected to be typed over. */
  open() {
    this.invalid = false;
    this.requestUpdate();
    const input = this.renderRoot.querySelector('input');
    if (!input) return;
    input.value = this.model.props.url;
    requestAnimationFrame(() => input.select());
  }

  private save(value: string) {
    const link = readLink(value);
    if (!link) {
      this.invalid = true;
      this.requestUpdate();
      return;
    }
    const bound = Bound.deserialize(this.model.xywh);
    const wasVideo = !!this.model.props.videoId;
    if (link.videoId) bound.h = (bound.w * 9) / 16;
    else if (wasVideo) bound.h = (bound.w * 76) / 280;
    this.store.captureSync();
    this.store.updateBlock(this.model, { ...link, xywh: bound.serialize() });
    this.dispatchEvent(new Event('done'));
  }

  override render() {
    // Keys, presses and the clipboard stay in the field, not the board's shortcuts.
    const keep = (event: Event) => event.stopPropagation();
    // BlockSuite's menu closes on any click outside its button, its own content
    // too: a click in the field, or Enter's on Save, keeps it open.
    return html`<form
      @click=${keep}
      @submit=${(event: SubmitEvent) => {
        event.preventDefault();
        const input = this.renderRoot.querySelector('input');
        if (input) this.save(input.value);
      }}
    >
      <div class="row">
        <input
          aria-label=${m.drawing_board_link_address()}
          maxlength=${BOARD_CATALOG.limits.LINK_URL_MAX}
          type="text"
          @input=${() => {
            if (!this.invalid) return;
            this.invalid = false;
            this.requestUpdate();
          }}
          @keydown=${keep}
          @pointerdown=${keep}
          @copy=${keep}
          @cut=${keep}
          @paste=${keep}
        />
        <button type="submit">${m.drawing_board_link_save()}</button>
      </div>
      ${this.invalid ? html`<p class="error">${m.drawing_board_link_invalid()}</p>` : nothing}
    </form>`;
  }
}

const editLinkAction = {
  content: (ctx: ToolbarContext) => {
    const model = ctx.getSurfaceModels()[0] as unknown as
      | LinkBlockModel
      | undefined;
    if (!model) return null;
    const label = m.drawing_board_edit_link();
    return html`<editor-menu-button
      .contentPadding=${'10px'}
      .button=${html`<editor-icon-button aria-label=${label} .tooltip=${label}>
        ${hugeIcon(Pen01Icon)}<span class="label">${label}</span>
      </editor-icon-button>`}
      @toggle=${(event: CustomEvent<boolean>) => {
        if (!event.detail) return;
        (event.currentTarget as HTMLElement)
          .querySelector<CapyLinkEdit>('capy-link-edit')
          ?.open();
      }}
    >
      <capy-link-edit
        .model=${model}
        .store=${ctx.store}
        @done=${(event: Event) =>
          (
            (event.currentTarget as HTMLElement).closest(
              'editor-menu-button'
            ) as (HTMLElement & { hide(): void }) | null
          )?.hide()}
      ></capy-link-edit>
    </editor-menu-button>`;
  },
  id: 'a.edit-link',
  when: onlyOne,
};

/** Whether a note is inline, read through its props' signals, so an undo
 * redraws the toolbar. */
const isInline = ({ props }: NoteBlockModel) =>
  isInlineNote({
    background: props.background$.value,
    edgeless: props.edgeless$.value,
  });
const anyCard = (ctx: ToolbarContext) =>
  ctx.getSurfaceModelsByType(NoteBlockModel).some((note) => !isInline(note));

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
  ToolbarModuleExtension({
    config: { actions: [editLinkAction] },
    id: BlockFlavourIdentifier('affine:surface:embed-capy-link'),
  }),
  // A quiz or set card's Edit, and Done while it is edited, for whoever may edit
  // its material (Epo 2026-11-13): the card itself has no button.
  ToolbarModuleExtension({
    config: {
      actions: [
        {
          generate: (ctx: ToolbarContext) => {
            const [model] = ctx.getSurfaceModels();
            if (!(onlyOne(ctx) && model && cardEditable(model.id))) return null;
            const card = model as unknown as {
              id: string;
              props: { materialId: string };
            };
            const editing = cardEditing()?.id === card.id;
            const label = editing ? m.drawing_board_done() : m.action_edit();
            return {
              active: editing,
              icon: html`${hugeIcon(Pen01Icon)}`,
              label,
              run: () =>
                setCardEditing(
                  editing
                    ? null
                    : { id: card.id, materialId: card.props.materialId }
                ),
              showLabel: true,
              tooltip: label,
            };
          },
          id: 'a.edit-card',
        },
      ],
    },
    id: BlockFlavourIdentifier('affine:surface:embed-capy-material'),
  }),
  // I2 (Epo 2026-11-13): Inline lights while the notes are inline; a press turns
  // them into cards, or cards inline.
  ToolbarModuleExtension({
    config: {
      actions: [
        {
          generate: (ctx: ToolbarContext) => {
            const notes = ctx.getSurfaceModelsByType(NoteBlockModel);
            if (!notes.length || notes.length !== ctx.getSurfaceModels().length)
              return null;
            const inline = notes.every(isInline);
            return {
              active: inline,
              icon: html`${hugeIcon(TextIcon)}`,
              label: m.drawing_board_note_inline(),
              run: () => setNotesInline(ctx.std, notes, !inline),
              showLabel: true,
              tooltip: m.drawing_board_note_inline_tip(),
            };
          },
          id: 'd.t-inline',
        },
        // Style is a card's (Epo 2026-11-13): an inline note has no fill,
        // shadow, border or corner. Size switched to a custom height, which
        // notes no longer have (local change 55): a note is its text's height.
        { id: 'd.style', when: anyCard },
        { id: 'f.auto-height', when: false },
      ],
    },
    id: BlockFlavourIdentifier('custom:affine:surface:note'),
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

class CapyFormulaSlot extends CapyPieceSlot {
  protected pieces = FORMULA_PIECES;
  protected slotTip = { key: 'M', tip: m.drawing_board_formulas };
}

/** The Misc panel (Epo 2026-11-09, A; on the answer board too since 2026-11-10):
 * tiles in groups, each a card picked up and dropped like a slot's piece; a finger's
 * tap puts it in the view's middle. Each board shows what it may hold (`tileFits`). */
type MiscView = 'klipy' | 'link' | 'quiz' | 'flashcards';
/** A tile: a card picked up like a slot's piece, or a picker it opens. KLIPY's
 * picker is the GIF & Sticker slot's, not a tile. */
type MiscTile =
  | { piece: Piece }
  /** Picks image files from the device, for a phone's lack of paste and drop. */
  | { art: TemplateResult; label: () => string; pick: 'image' }
  | {
      art: TemplateResult;
      label: () => string;
      view: Exclude<MiscView, 'klipy'>;
    };
const MISC_GROUPS: {
  label: () => string;
  /** Its name on the account's Canvas page, if another. */
  accountLabel?: () => string;
  tiles: MiscTile[];
}[] = [
  {
    label: m.drawing_board_diagrams,
    tiles: [...CHART_PIECES]
      .reverse()
      .concat(MINDMAP_PIECE)
      .map((piece) => ({ piece })),
  },
  /** The workspace canvas's Formulas, whose slot there holds GIFs and stickers
   * (Epo 2026-11-12, M1). */
  {
    label: m.drawing_board_formulas,
    tiles: FORMULA_PIECES.map((piece) => ({ piece })),
  },
  {
    label: m.drawing_board_media,
    tiles: [
      {
        art: svg`<svg width="36" height="32" viewBox="0 0 36 32" aria-hidden="true"><rect x="2" y="3" width="32" height="26" rx="4" fill="#dcebfb"/><circle cx="12" cy="12" r="3.5" fill="#f2c94c"/><path d="M4 26.5 13.5 17l5.5 5.5 5-5L32 25.5V25a4 4 0 0 1-4 4H8a4 4 0 0 1-4-2.5Z" fill="#1e96eb"/></svg>`,
        label: m.drawing_board_image,
        pick: 'image',
      },
      {
        // YouTube's play mark; a web address still lands as a link card (Epo
        // 2026-11-13, Y2).
        art: svg`<svg width="38" height="27" viewBox="0 0 38 27" aria-hidden="true"><rect width="38" height="27" rx="7" fill="#ff0033"/><path d="M15 7.5v12l10.5-6z" fill="#fff"/></svg>`,
        label: m.drawing_board_youtube,
        view: 'link',
      },
    ],
  },
  {
    // Every quiz and set the person can open (Epo 2026-11-13, N1).
    accountLabel: m.drawing_board_quizzes_flashcards,
    label: m.drawing_board_from_workspace,
    tiles: [
      {
        art: svg`<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#1e96eb" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M13 3 5 13.5h6L10 21l8-10.5h-6L13 3Z"/></svg>`,
        label: m.drawing_board_quiz,
        view: 'quiz',
      },
      {
        art: svg`<svg width="38" height="34" viewBox="0 0 32 30" aria-hidden="true"><rect x="9" y="3" width="20" height="14" rx="2" fill="#fff" stroke="#c9ccd2" transform="rotate(8 19 10)"/><rect x="4" y="9" width="20" height="14" rx="2" fill="#e8798f"/></svg>`,
        label: m.drawing_board_flashcards,
        view: 'flashcards',
      },
    ],
  },
];

/** The GIF & Sticker picker's tabs: KLIPY's two kinds and the shipped emoji. */
type PickerTab = KlipyKind | 'emoji';

/** A picture being carried from the picker: what it places, its size on screen as
 * placed, and for KLIPY's the result its share event names. */
type Carried = {
  h: number;
  picture: { kind: PictureKind; label: string; ref: string };
  shared?: { gif: KlipyGif; kind: KlipyKind };
  w: number;
};
/** A carried picture as the drag controller takes it. */
type CarryInfo = {
  data: Carried;
  preview: TemplateResult;
  standardWidth: number;
};

/** The GIF columns' loading shapes: KLIPY's usual 4:3, square and wide. */
const SKELETON_LEFT = [4 / 3, 1, 16 / 9];
const SKELETON_RIGHT = [1, 16 / 9, 4 / 3];

/** The tab picked last, which the picker opens on next. */
let lastTab: PickerTab = 'gifs';

/** Blocks in the GIF columns' height, for one without KLIPY's size. */
const ratioOf = ({ preview: { height, width } }: KlipyGif) =>
  width && height && Number.isFinite(width / height)
    ? width / height
    : undefined;

/** The panel's one frame (Epo 2026-11-09, Misc round 2): the same size in every
 * view, so switching views moves nothing. */
const PANEL_WIDTH = 360;
const PANEL_HEIGHT = 440;
/** The grid shows a filter field from this many quizzes or sets. */
const FILTER_FROM = 6;

/** The Misc panel: the chart and mind map pieces, picked up like a slot's piece,
 * and the pickers (Epo 2026-11-09): Emoji, GIF and Sticker (KLIPY, one search with
 * two tabs), Link, and the workspace's quizzes and sets as thumbnail grids with a
 * New tile first. One 360 × 440 frame: Back, the title, a close; the body scrolls.
 * While KLIPY loads, a shimmer grid of the final shape stands in. */
class CapyMiscPanel extends WithDisposable(SignalWatcher(LitElement)) {
  static override styles = [
    POPPER_STYLES,
    css`
      :host {
        display: flex;
        flex-direction: column;
        width: ${PANEL_WIDTH}px;
        height: ${PANEL_HEIGHT}px;
        max-width: 100vw;
        box-sizing: border-box;
        /* One edge for the title, the group names and the tiles (Epo 2026-11-12). */
        padding: 16px 16px 8px;
        background: var(--affine-background-overlay-panel-color);
        border: 1px solid var(--affine-border-color);
        border-bottom: 0;
        border-radius: 10px 10px 0 0;
        box-shadow: 0 -6px 20px rgb(0 0 0 / 6%);
        color: var(--affine-text-primary-color);
      }
      h3 {
        margin: 0 0 4px;
        color: var(--affine-text-secondary-color);
        font-size: 12px;
        font-weight: 600;
      }
      .body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
      }
      /* Short tiles and groups close together: every group shows without
         scrolling (Epo 2026-11-13, C1). */
      .group + .group {
        margin-top: 8px;
      }
      .tiles {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 4px;
      }
      /* A picture tile is a button, which the popper styles make 36px square:
         every tile fills its column, its art centred over its name. */
      .tile {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 3px;
        box-sizing: border-box;
        width: 100%;
        height: 60px;
        padding: 4px;
        border-radius: 8px;
        color: var(--affine-text-secondary-color);
        font-size: 11.5px;
        cursor: grab;
      }
      button.tile {
        cursor: pointer;
      }
      .tile:hover {
        background: var(--affine-hover-color);
        color: var(--affine-text-primary-color);
      }
      .art {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 40px;
        height: 30px;
      }
      .tile[data-kind] .art {
        filter: ${unsafeCSS(PIECE_SHADOW)};
      }
      /* Every tile's art fits the box (the integral stands 60 px tall in its slot). */
      .art svg {
        width: auto;
        height: auto;
        max-width: 40px;
        max-height: 30px;
      }
      .head {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 32px;
        margin-bottom: 8px;
      }
      .head button {
        width: 32px;
        height: 32px;
        flex: none;
      }
      /* The close button's icon, not its box, meets the panel's right edge. */
      .head button:last-child {
        margin-right: -7px;
      }
      .head .title {
        flex: 1;
        min-width: 0;
        margin: 0;
        overflow: hidden;
        color: var(--affine-text-primary-color);
        font-size: 14px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .head input,
      .filter {
        flex: 1;
        min-width: 0;
        height: 32px;
        padding: 0 10px;
        border: 1px solid var(--affine-border-color);
        border-radius: 6px;
        background: transparent;
        color: var(--affine-text-primary-color);
        font: inherit;
        font-size: 13px;
        outline: none;
      }
      .head input:focus,
      .filter:focus {
        border-color: var(--affine-primary-color);
      }
      .filter {
        width: 100%;
        box-sizing: border-box;
        margin-bottom: 8px;
      }
      .tabs {
        display: flex;
        gap: 2px;
        margin: 0 0 8px;
        border-bottom: 1px solid var(--affine-border-color);
      }
      .tabs button {
        width: auto;
        height: auto;
        margin-bottom: -1px;
        padding: 6px 10px 7px;
        border-bottom: 2px solid transparent;
        border-radius: 0;
        color: var(--affine-text-secondary-color);
        font-size: 12.5px;
        font-weight: 600;
      }
      .tabs button[aria-selected='true'] {
        border-bottom-color: var(--affine-primary-color);
        color: var(--affine-text-primary-color);
      }
      .emoji {
        display: grid;
        grid-template-columns: repeat(8, 1fr);
        gap: 2px;
      }
      .emoji button {
        width: 100%;
        height: auto;
        aspect-ratio: 1;
      }
      .emoji img {
        width: 30px;
        height: 30px;
      }
      .cells {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 8px;
        align-content: start;
      }
      /* Height auto: the popper styles make a button 36px tall, which beat the
         aspect ratio and squeezed the rows. */
      .cells > * {
        width: 100%;
        height: auto;
        aspect-ratio: 1;
        padding: 0;
        border-radius: 6px;
        overflow: hidden;
      }
      /* GIFs: two columns, each cell at its GIF's shape (Epo 2026-11-13, G1), its
         blurred preview showing until the GIF has loaded (L2). */
      .columns {
        display: flex;
        gap: 8px;
        align-items: flex-start;
      }
      .column {
        display: flex;
        flex: 1;
        flex-direction: column;
        gap: 8px;
        min-width: 0;
      }
      /* Hovered too: the panel's button hover would paint over the preview
         (Epo 2026-11-13). */
      .column > *,
      .column > :hover {
        width: 100%;
        height: auto;
        padding: 0;
        border-radius: 6px;
        overflow: hidden;
        background: var(--blur, none) center / cover no-repeat;
      }
      .column > [data-loaded] {
        background: none;
      }
      .column img {
        display: block;
        width: 100%;
        height: 100%;
      }
      /* Stickers: squares, each whole (S1). */
      .cells img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }
      .skeleton {
        background: linear-gradient(
          100deg,
          var(--affine-hover-color) 30%,
          var(--affine-background-overlay-panel-color) 50%,
          var(--affine-hover-color) 70%
        );
        background-size: 200% 100%;
        animation: shine 1.4s infinite;
      }
      @keyframes shine {
        to {
          background-position: -200% 0;
        }
      }
      .note {
        padding: 28px 10px;
        color: var(--affine-text-secondary-color);
        font-size: 12.5px;
        text-align: center;
      }
      .cards {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 8px;
        align-content: start;
      }
      .cards > * {
        min-width: 0;
      }
      .card {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 4px;
        width: 100%;
        /* Not the toolbar's 36px button: its content sets the height. */
        height: auto;
        min-height: 96px;
        padding: 8px 10px 9px;
        /* No edge and no type pill (Epo 2026-11-13): the hover marks the tile. */
        border-radius: 8px;
        background: var(--affine-background-primary-color);
        color: var(--affine-text-primary-color);
        text-align: left;
      }
      .card:hover {
        background: var(--affine-hover-color);
      }
      .card .t {
        overflow: hidden;
        font-size: 12.5px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .card .q {
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
        font-size: 11.5px;
        line-height: 1.4;
      }
      .card .n {
        margin-top: auto;
        color: var(--affine-text-secondary-color);
        font-size: 11px;
      }
      .card .ws {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        margin-top: -2px;
        color: var(--affine-text-secondary-color);
        font-size: 11px;
      }
      .card .ws img {
        flex: none;
        width: 12px;
        height: 12px;
        border-radius: 3px;
      }
      .card .ws span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .card.new {
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: 1px dashed var(--affine-border-color);
        color: var(--affine-text-secondary-color);
        font-size: 12px;
      }
      .card.new .plus {
        display: grid;
        place-items: center;
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: var(--affine-hover-color);
        color: var(--affine-primary-color);
      }
      .fc {
        position: relative;
        height: 48px;
      }
      .fc span {
        position: absolute;
        inset: 0;
        padding: 6px 8px;
        border: 1px solid var(--affine-border-color);
        border-radius: 6px;
        background: var(--affine-background-overlay-panel-color);
        font-size: 11.5px;
        line-height: 1.35;
        overflow: hidden;
      }
      .fc span.back {
        z-index: 0;
        border-color: #e8798f;
        background: #e8798f;
        opacity: 0.55;
        transform: translate(5px, -5px) rotate(3deg);
      }
      .fc span.front {
        z-index: 1;
      }
      form.link {
        display: flex;
        gap: 6px;
      }
      form.link input {
        flex: 1;
        min-width: 0;
        height: 32px;
        padding: 0 10px;
        border: 1px solid var(--affine-border-color);
        border-radius: 6px;
        background: transparent;
        color: var(--affine-text-primary-color);
        font: inherit;
        font-size: 13px;
        outline: none;
      }
      form.link input:focus {
        border-color: var(--affine-primary-color);
      }
      form.link button {
        width: auto;
        height: 32px;
        padding: 0 12px;
        border: 1px solid var(--affine-border-color);
        color: var(--affine-text-primary-color);
        font-size: 13px;
      }
      .error {
        margin: 6px 2px 0;
        color: var(--affine-error-color);
        font-size: 12px;
      }
      .credit {
        margin-top: 6px;
        text-align: right;
        color: var(--affine-text-secondary-color);
        font-size: 11px;
      }
    `,
  ];

  @property({ attribute: false })
  accessor edgeless!: BlockComponent;
  /** Opened by the GIF & Sticker slot: KLIPY's view alone, with no Back. */
  @property({ attribute: false })
  accessor only: 'klipy' | undefined;

  @state()
  private accessor view: MiscView | null = null;
  @state()
  private accessor tab: PickerTab = 'gifs';
  @state()
  private accessor found: KlipyGif[] | 'loading' | 'failed' = 'loading';
  /** KLIPY has a page after the last one loaded. */
  @state()
  private accessor more = false;
  @state()
  private accessor linkError = false;
  @state()
  private accessor filter = '';
  @state()
  private accessor creating = false;

  private drag: EdgelessDraggableElementController<Piece> | undefined;
  private touch: EdgelessDraggableElementController<Piece> | undefined;
  private pictureDrag: EdgelessDraggableElementController<Carried> | undefined;
  private search: AbortController | undefined;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private query = '';
  /** The last page loaded, and the next one's request while it runs. */
  private page = 1;
  private nextPage: AbortController | undefined;

  private get gfx() {
    return this.edgeless.std.get(GfxControllerIdentifier);
  }

  /** Once something is down, the panel goes, as AFFiNE's template panel does. */
  private placed() {
    this.dispatchEvent(new Event('placed', { bubbles: true, composed: true }));
  }

  override firstUpdated() {
    const { gfx } = this;
    const place = (kind: PieceKind, at: Vec) => {
      placePiece(gfx, kind, at);
      this.placed();
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
    // A GIF, sticker or emoji lands at the size it was carried at.
    this.pictureDrag = new EdgelessDraggableElementController(this, {
      clickToDrag: true,
      edgeless: this.edgeless,
      onDrop: (element: { data: Carried }, bound: Bound) =>
        this.placeAt(element.data, [
          bound.x + bound.w / 2,
          bound.y + bound.h / 2,
        ]),
      scopeElement: this,
    });
  }

  override disconnectedCallback() {
    super.disconnectedCallback();
    this.search?.abort();
    clearTimeout(this.searchTimer);
  }

  /** Image files picked from the device land as pasted ones do, through the
   * board's blob source: stored at once on the workspace canvas. */
  private pickImages() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = IMAGE_ACCEPT;
    input.multiple = true;
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      if (!files.length) return;
      // Select takes over from the pen, say, before the images land selected.
      this.gfx.tool.setTool(DefaultTool);
      // A file the board can't read is said by BlockSuite's own notice.
      addImages(this.edgeless.std, files, { maxWidth: MAX_IMAGE_WIDTH }).catch(
        () => undefined
      );
      this.placed();
    });
    input.click();
  }

  /** What last pressed a cell: a finger's tap ends in mouse events too. */
  private pointer = '';

  /** A mouse picks a GIF, sticker or emoji up to carry (Epo 2026-11-12). */
  private carry(event: MouseEvent, made: CarryInfo | undefined) {
    if (this.pointer === 'mouse' && made)
      this.pictureDrag?.onMouseDown(event, made);
  }

  /** A finger's tap or a key puts it in the view's middle, so a finger still
   * scrolls the grid. */
  private tap(event: MouseEvent, made: CarryInfo | undefined) {
    if (event.detail && this.pointer === 'mouse') return;
    const { centerX, centerY } = this.gfx.viewport;
    if (made) this.placeAt(made.data, [centerX, centerY]);
  }

  /** What a GIF or sticker cell carries: KLIPY's size for it, or its cell's
   * picture's when KLIPY gives none; a cell not drawn yet has neither and gives
   * nothing. A link past what a board stores can't be placed; the picker still
   * shows it (KLIPY's terms: no result removed). */
  private gifCarry(cell: HTMLElement, gif: KlipyGif, kind: KlipyKind) {
    if (gif.media.url.length > BOARD_CATALOG.limits.PICTURE_REF_MAX) {
      userToast({
        title: m.drawing_board_gif_unplaceable(),
        variant: 'warning',
      });
      return;
    }
    const { height = 0, width = 0 } = gif.media;
    const drawn = cell.querySelector('img');
    const [w, h] =
      Number.isFinite(width) &&
      width > 0 &&
      Number.isFinite(height) &&
      height > 0
        ? [width, height]
        : [drawn?.naturalWidth ?? 0, drawn?.naturalHeight ?? 0];
    if (!(w > 0 && h > 0)) return;
    // Screen pixels on the longer side, as placed.
    const scale = (kind === 'stickers' ? 160 : 240) / Math.max(w, h);
    return this.carryInfo(cell, gif.preview.url, {
      h: h * scale,
      picture: {
        kind: 'klipy',
        label: gif.title.slice(0, BOARD_CATALOG.limits.PICTURE_LABEL_MAX),
        ref: gif.media.url,
      },
      shared: { gif, kind },
      w: w * scale,
    });
  }

  /** An emoji carries at 96 screen pixels. */
  private emojiCarry(cell: HTMLElement, code: string) {
    return this.carryInfo(cell, emojiStillUrl(code), {
      h: 96,
      picture: { kind: 'emoji', label: emojiText(code), ref: code },
      w: 96,
    });
  }

  /** The carried picture keeps its cell's box, letterboxed in it: the box grows
   * until the picture inside is its placed size. */
  private carryInfo(cell: HTMLElement, src: string, data: Carried): CarryInfo {
    const { height, width } = cell.getBoundingClientRect();
    return {
      data,
      preview: html`<img
        alt=""
        referrerpolicy="no-referrer"
        src=${src}
        style=${styleMap({ 'object-fit': 'contain' })}
      />`,
      standardWidth:
        Math.max(data.w, (data.h * width) / height) / this.gfx.viewport.zoom,
    };
  }

  /** A carried picture centred on a board point, at its size on screen. */
  private placeAt(data: Carried, [x, y]: Vec) {
    const { zoom } = this.gfx.viewport;
    const [w, h] = [data.w / zoom, data.h / zoom];
    addPicture(this.gfx, new Bound(x - w / 2, y - h / 2, w, h), data.picture);
    // KLIPY's link stays on the board, as its terms ask; its share event is told.
    if (data.shared) klipyShared(data.shared.kind, data.shared.gif, this.query);
    this.placed();
  }

  override willUpdate(changed: PropertyValues<this>) {
    if (changed.has('only') && this.only) this.open(this.only);
  }

  private open(view: MiscView) {
    this.view = view;
    this.linkError = false;
    this.filter = '';
    if (view === 'klipy') {
      this.tab = lastTab;
      this.query = '';
      this.find('');
    }
  }

  private pick(tab: PickerTab) {
    if (this.tab === tab) return;
    this.tab = tab;
    lastTab = tab;
    this.find(this.query, true);
  }

  /** KLIPY's search on its tabs; the emoji tab has none. */
  private find(query: string, now = false) {
    this.query = query;
    clearTimeout(this.searchTimer);
    const kind = this.tab;
    if (kind === 'emoji') return;
    this.searchTimer = setTimeout(
      () => {
        this.search?.abort();
        this.nextPage?.abort();
        const search = new AbortController();
        this.search = search;
        this.found = 'loading';
        this.more = false;
        this.page = 1;
        klipyMedia(kind, query, 1, search.signal).then(
          ({ items, more }) => {
            if (search.signal.aborted) return;
            this.found = items;
            this.more = more;
          },
          () => {
            if (!search.signal.aborted) this.found = 'failed';
          }
        );
      },
      query && !now ? 300 : 0
    );
  }

  /** Near the end of the results, KLIPY's next page joins them (it pages by 24).
   * A failed page stops there: scrolling back up and down asks again. */
  private loadMore(body: HTMLElement) {
    const found = this.found;
    const kind = this.tab;
    if (
      kind === 'emoji' ||
      !(this.more && Array.isArray(found)) ||
      this.nextPage
    )
      return;
    if (body.scrollTop + body.clientHeight < body.scrollHeight - 240) return;
    const request = new AbortController();
    this.nextPage = request;
    const search = this.search;
    klipyMedia(kind, this.query, this.page + 1, request.signal)
      .then(
        ({ items, more }) => {
          if (request.signal.aborted || search !== this.search) return;
          this.page += 1;
          this.found = [...found, ...items];
          this.more = more;
        },
        () => {}
      )
      .finally(() => {
        if (this.nextPage === request) this.nextPage = undefined;
      });
  }

  private renderTile(tile: MiscTile) {
    if ('piece' in tile) {
      const { piece } = tile;
      return html`<div
        class=${classMap({ formula: piece.kind in FORMULA_STARTS, tile: true })}
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
      </div>`;
    }
    if ('pick' in tile)
      return html`<button
        class="tile"
        data-pick=${tile.pick}
        type="button"
        @click=${() => this.pickImages()}
      >
        <span class="art">${tile.art}</span>
        ${tile.label()}
      </button>`;
    return html`<button
      class="tile"
      data-view=${tile.view}
      type="button"
      @click=${() => this.open(tile.view)}
    >
      <span class="art">${tile.art}</span>
      ${tile.label()}
    </button>`;
  }

  /** Every view's header: Back, the title or KLIPY's search, and a close. */
  private head(title: () => string, search?: boolean) {
    return html`<div class="head">
      ${
        this.only
          ? nothing
          : html`<button
              aria-label=${m.drawing_board_back()}
              title=${m.drawing_board_back()}
              type="button"
              @click=${() => {
                this.view = null;
              }}
            >
              ${hugeIcon(ArrowLeft04Icon)}
            </button>`
      }
      ${
        search && this.tab !== 'emoji'
          ? html`<input
              aria-label=${m.drawing_board_gif_search()}
              placeholder=${m.drawing_board_gif_search()}
              type="search"
              .value=${this.query}
              @input=${(event: Event) =>
                this.find((event.target as HTMLInputElement).value)}
            />`
          : html`<h3 class="title">${title()}</h3>`
      }
      ${this.closeButton()}
    </div>`;
  }

  private closeButton() {
    return html`<button
      aria-label=${m.drawing_board_close()}
      title=${m.drawing_board_close()}
      type="button"
      @click=${() =>
        this.dispatchEvent(
          new Event('closed', { bubbles: true, composed: true })
        )}
    >
      ${hugeIcon(Cancel01Icon)}
    </button>`;
  }

  /** A GIF or sticker cell: a mouse carries it, a finger or a key places it. */
  private gifCell(gif: KlipyGif, kind: KlipyKind, ratio?: number) {
    const made = (event: Event) =>
      this.gifCarry(event.currentTarget as HTMLElement, gif, kind);
    return html`<button
      aria-label=${gif.title}
      title=${gif.title}
      type="button"
      style=${styleMap({
        '--blur': kind === 'gifs' && gif.blur ? `url("${gif.blur}")` : null,
        'aspect-ratio': ratio ? String(ratio) : null,
      })}
      @pointerdown=${(event: PointerEvent) => {
        this.pointer = event.pointerType;
      }}
      @mousedown=${(event: MouseEvent) => this.carry(event, made(event))}
      @click=${(event: MouseEvent) => this.tap(event, made(event))}
    >
      <img
        alt=""
        loading="lazy"
        referrerpolicy="no-referrer"
        src=${gif.preview.url}
        @load=${(event: Event) =>
          (event.currentTarget as HTMLElement).parentElement?.setAttribute(
            'data-loaded',
            ''
          )}
      />
    </button>`;
  }

  /** GIFs in two columns, each whole at its own shape and into the shorter
   * column (Epo 2026-11-13, G1): Discord's picker. KLIPY's order holds within
   * that, and a page loaded later leaves the earlier cells where they are. */
  private renderGifs(gifs: KlipyGif[]) {
    const columns: KlipyGif[][] = [[], []];
    const tall = [0, 0];
    for (const gif of gifs) {
      const column = tall[0] <= tall[1] ? 0 : 1;
      columns[column].push(gif);
      tall[column] += 1 / (ratioOf(gif) ?? 1);
    }
    return html`<div class="columns">
      ${columns.map(
        (column) =>
          html`<div class="column">
            ${repeat(
              column,
              (gif) => gif.id,
              (gif) => this.gifCell(gif, 'gifs', ratioOf(gif))
            )}
          </div>`
      )}
    </div>`;
  }

  /** The 48 shipped emoji (Noto, credited), stills in the grid. */
  private renderEmoji() {
    return html`<div class="body">
      <div class="emoji">
        ${EMOJI.map((code) => {
          const made = (event: Event) =>
            this.emojiCarry(event.currentTarget as HTMLElement, code);
          return html`<button
            aria-label=${emojiText(code)}
            type="button"
            @pointerdown=${(event: PointerEvent) => {
              this.pointer = event.pointerType;
            }}
            @mousedown=${(event: MouseEvent) => this.carry(event, made(event))}
            @click=${(event: MouseEvent) => this.tap(event, made(event))}
          >
            <img alt="" loading="lazy" src=${emojiStillUrl(code)} />
          </button>`;
        })}
      </div>
    </div>`;
  }

  /** The GIF & Sticker picker: KLIPY's GIFs and stickers, and the shipped emoji
   * (Epo 2026-11-13), one tab each. */
  private renderKlipy() {
    const kind = this.tab;
    const tabs = html`<div class="tabs" role="tablist">
      ${(['gifs', 'stickers', 'emoji'] as const).map(
        (tab) =>
          html`<button
            aria-selected=${kind === tab}
            role="tab"
            type="button"
            @click=${() => this.pick(tab)}
          >
            ${
              tab === 'gifs'
                ? m.drawing_board_gifs_tab()
                : tab === 'stickers'
                  ? m.drawing_board_stickers_tab()
                  : m.drawing_board_emoji()
            }
          </button>`
      )}
    </div>`;
    if (kind === 'emoji') return html`${tabs}${this.renderEmoji()}`;
    if (!klipyEnabled())
      return html`${tabs}
        <div class="body"><p class="note">${m.drawing_board_gif_off()}</p></div>`;
    const found = this.found;
    const stickers = kind === 'stickers';
    return html`${tabs}
      <div
        class="body"
        @scroll=${(event: Event) => this.loadMore(event.currentTarget as HTMLElement)}
      >
        ${
          found === 'loading'
            ? stickers
              ? html`<div class="cells" aria-busy="true">
                  ${Array.from({ length: 9 }, () => html`<div class="skeleton"></div>`)}
                </div>`
              : html`<div class="columns" aria-busy="true">
                  ${[SKELETON_LEFT, SKELETON_RIGHT].map(
                    (ratios) =>
                      html`<div class="column">
                        ${ratios.map(
                          (ratio) =>
                            html`<div
                              class="skeleton"
                              style=${styleMap({ 'aspect-ratio': String(ratio) })}
                            ></div>`
                        )}
                      </div>`
                  )}
                </div>`
            : found === 'failed'
              ? html`<p class="note">${m.drawing_board_gif_failed()}</p>`
              : found.length
                ? stickers
                  ? html`<div class="cells">
                      ${repeat(
                        found,
                        (gif) => gif.id,
                        (gif) => this.gifCell(gif, 'stickers')
                      )}
                    </div>`
                  : this.renderGifs(found)
                : html`<p class="note">
                    ${stickers ? m.drawing_board_sticker_none() : m.drawing_board_gif_none()}
                  </p>`
        }
      </div>
      <div class="credit">${m.drawing_board_gif_credit()}</div>`;
  }

  /** A link card: a YouTube video shows its poster; any other address its host. */
  private addLink(value: string) {
    if (!placeLink(this.gfx, value)) {
      this.linkError = true;
      return;
    }
    this.placed();
  }

  private renderLink() {
    return html`<div class="body">
      <form
        class="link"
        @submit=${(event: SubmitEvent) => {
          event.preventDefault();
          const input = (event.target as HTMLFormElement).querySelector(
            'input'
          );
          if (input) this.addLink(input.value);
        }}
      >
        <input
          aria-label=${m.drawing_board_link_address()}
          maxlength=${BOARD_CATALOG.limits.LINK_URL_MAX}
          placeholder=${m.drawing_board_link_address()}
          type="text"
          @input=${() => {
            this.linkError = false;
          }}
        />
        <button type="submit">${m.drawing_board_link_add()}</button>
      </form>
      ${
        this.linkError
          ? html`<p class="error">${m.drawing_board_link_invalid()}</p>`
          : nothing
      }
    </div>`;
  }

  /** A quiz or set card at the view's middle, then the panel goes. */
  private placeMaterial(kind: CardMaterialKind, id: string, title: string) {
    addCard(
      this.gfx,
      MATERIAL_FLAVOUR,
      {
        kind,
        materialId: id,
        title: title.slice(0, BOARD_CATALOG.limits.CARD_TITLE_MAX),
      },
      MATERIAL_CARD_SIZE[kind]
    );
    this.placed();
  }

  /** The New tile: the workspace makes one, the card lands, its editor opens (also
   * when the panel closed while the create was in flight: nothing made is left
   * unplaced and unsaid). */
  private async createMaterial(kind: CardMaterialKind) {
    const workspace = workspaceOf(this.edgeless.std);
    if (!workspace || this.creating) return;
    this.creating = true;
    try {
      const made = await workspace.create(kind);
      this.placeMaterial(kind, made.id, made.title);
      workspace.open(made.id);
    } catch (error) {
      const failed =
        kind === 'quiz'
          ? m.drawing_board_create_failed()
          : m.drawing_board_create_set_failed();
      userToast({
        description: errorCopy(error, failed),
        title: failed,
        variant: 'error',
      });
    } finally {
      this.creating = false;
    }
  }

  private renderMaterials(kind: CardMaterialKind) {
    // Unknown while the list loads: the New tile alone, no "none yet".
    const links = workspaceOf(this.edgeless.std);
    const loaded = links?.materials();
    const all = loaded?.filter((material) => material.kind === kind) ?? [];
    const needle = this.filter.trim().toLowerCase();
    // On the account's page the filter also matches the workspace's name.
    const listed = needle
      ? all.filter(({ title, workspace }) =>
          [title, workspace?.name ?? ''].some((text) =>
            text.toLowerCase().includes(needle)
          )
        )
      : all;
    const newTile = html`<button
      class="card new"
      ?disabled=${this.creating}
      type="button"
      @click=${() => this.createMaterial(kind)}
    >
      <span class="plus">${hugeIcon(PlusSignIcon)}</span>
      ${kind === 'quiz' ? m.drawing_board_new_quiz() : m.drawing_board_new_set()}
    </button>`;
    const none = links?.account
      ? kind === 'quiz'
        ? m.drawing_board_no_own_quizzes()
        : m.drawing_board_no_own_flashcards()
      : kind === 'quiz'
        ? m.drawing_board_no_quizzes()
        : m.drawing_board_no_flashcards();
    return html`<div class="body">
      ${
        all.length >= FILTER_FROM
          ? html`<input
              aria-label=${m.drawing_board_filter()}
              class="filter"
              placeholder=${m.drawing_board_filter()}
              type="search"
              .value=${this.filter}
              @input=${(event: Event) => {
                this.filter = (event.target as HTMLInputElement).value;
              }}
            />`
          : nothing
      }
      <div class="cards">
        ${newTile}
        ${listed.map(
          ({ id, preview, title, workspace }) =>
            html`<button
              class="card"
              title=${title}
              type="button"
              @click=${() => this.placeMaterial(kind, id, title)}
            >
              ${this.thumbnail(kind, title, preview)}
              <span class="n">${this.count(kind, preview)}</span>
              ${
                // Its workspace on the account's page; nothing when in none
                // (Epo 2026-11-13, A).
                workspace
                  ? html`<span class="ws"
                      >${
                        workspace.iconId
                          ? html`<img alt="" src=${iconUrl(workspace.iconId)} />`
                          : nothing
                      }<span>${workspace.name}</span></span
                    >`
                  : nothing
              }
            </button>`
        )}
      </div>
      ${loaded && all.length === 0 ? html`<p class="note">${none}</p>` : nothing}
    </div>`;
  }

  /** A quiz tile's top: the title, then the stored preview's first question's
   * stem; a set's: the stacked pair with the first card's front, then the
   * title. */
  private thumbnail(
    kind: CardMaterialKind,
    title: string,
    preview?: MaterialPreview
  ) {
    const name = html`<span class="t">${title}</span>`;
    if (kind === 'quiz') {
      const first = preview?.kind === 'quiz' ? preview.first : undefined;
      return first ? html`${name}<span class="q">${first.stem}</span>` : name;
    }
    const front =
      preview?.kind === 'flashcards' && preview.first
        ? preview.first.front
        : m.drawing_board_card_front();
    return html`<span class="fc">
        <span class="back"></span>
        <span class="front">${front}</span>
      </span>
      ${name}`;
  }

  private count(kind: CardMaterialKind, preview?: MaterialPreview) {
    if (kind === 'quiz')
      return questionCountLabel(
        preview?.kind === 'quiz' ? preview.questionCount : 0
      );
    return cardCountLabel(
      preview?.kind === 'flashcards' ? preview.cardCount : 0
    );
  }

  override render() {
    if (this.view === 'klipy')
      return html`${this.head(m.drawing_board_gif_sticker, true)}${this.renderKlipy()}`;
    if (this.view === 'link')
      return html`${this.head(m.drawing_board_youtube)}${this.renderLink()}`;
    if (this.view === 'quiz' || this.view === 'flashcards')
      return html`${this.head(
        this.view === 'quiz' ? m.drawing_board_quiz : m.drawing_board_flashcards
      )}${this.renderMaterials(this.view)}`;
    const workspace = workspaceOf(this.edgeless.std);
    return html`<div class="head">
        <h3 class="title">${m.drawing_board_misc()}</h3>
        ${this.closeButton()}
      </div>
      <div class="body">
        ${MISC_GROUPS.map(({ accountLabel, label, tiles }) => ({
          label: (workspace?.account && accountLabel) || label,
          tiles: tiles.filter(
            (tile) =>
              tileFits(tile, boardKinds.get(this.edgeless.std)) &&
              // The quizzes and sets need a list lent.
              (workspace ||
                !('view' in tile) ||
                (tile.view !== 'quiz' && tile.view !== 'flashcards'))
          ),
        }))
          .filter(({ tiles }) => tiles.length)
          .map(
            ({ label, tiles }) =>
              html`<div class="group">
              <h3>${label()}</h3>
              <div class="tiles">
                ${tiles.map((tile) => this.renderTile(tile))}
              </div>
            </div>`
          )}
      </div>`;
  }
}

/** Misc's toolbar button: four small pieces as large as the slots' pieces beside
 * it (Epo 2026-11-12), opening its panel above the toolbar. */
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
    togglePanel(this, () => this.open());
  }

  private open() {
    // However it goes (the toolbar closes it for another panel), the button redraws.
    const panel = openPopper(
      this,
      'capy-misc-panel',
      PANEL_HEIGHT,
      {
        marginLeft: 'auto',
        marginRight: '0',
        maxWidth: '100%',
        width: `${PANEL_WIDTH}px`,
      },
      () => this.requestUpdate()
    );
    for (const done of ['placed', 'closed'])
      panel.addEventListener(done, () => {
        closePopper(this);
        this.requestUpdate();
      });
  }

  override render() {
    return html`<edgeless-toolbar-button
      .active=${this.active}
      .tooltip=${m.drawing_board_misc()}
      .tooltipOffset=${5}
      @click=${() => this.toggle()}
    >
      <div class="box">
        <svg width="48" height="48" viewBox="0 0 40 40" aria-hidden="true">
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

/** The workspace canvas's GIF & Sticker slot (Epo 2026-11-12, A): a GIF card
 * behind a sticker, centred in the bar and lifting together on hover. A click
 * opens KLIPY's view on the tab used last. */
class CapyGifStickerButton extends EdgelessToolbarToolMixin(
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
    }
    /* Centred in the bar, not cut by its bottom edge (Epo 2026-11-13). */
    .box {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 64px;
    }
    svg {
      display: block;
      filter: ${unsafeCSS(PIECE_SHADOW)};
      transition: transform 0.3s;
    }
    :host(:hover) svg,
    :host([data-open]) svg {
      transform: translateY(-4px);
    }
  `;

  // Not a tool: it opens a panel.
  override type = DefaultTool as never;

  // @ts-expect-error the mixin defines it as a getter, typed as a property.
  override get active() {
    return !!this.popper;
  }

  override updated() {
    this.toggleAttribute('data-open', this.active);
  }

  private open() {
    const panel = openPopper(
      this,
      'capy-misc-panel',
      PANEL_HEIGHT,
      {
        marginLeft: 'auto',
        marginRight: '0',
        maxWidth: '100%',
        width: `${PANEL_WIDTH}px`,
      },
      () => this.requestUpdate()
    );
    Object.assign(panel, { only: 'klipy' } satisfies Partial<CapyMiscPanel>);
    for (const done of ['placed', 'closed'])
      panel.addEventListener(done, () => {
        closePopper(this);
        this.requestUpdate();
      });
  }

  override render() {
    return html`<edgeless-toolbar-button
      .active=${this.active}
      .tooltip=${m.drawing_board_gif_sticker()}
      .tooltipOffset=${5}
      @click=${() => togglePanel(this, () => this.open())}
    >
      <div class="box">
        <svg width="76" height="54" viewBox="0 0 76 54" aria-hidden="true">
          <g transform="rotate(-9 26 30)">
            <rect x="6" y="12" width="40" height="30" rx="5" fill="#7f5fd6" />
            <text
              x="14"
              y="32"
              fill="#fff"
              font-family="JetBrains Mono, ui-monospace, monospace"
              font-size="12"
              font-weight="700"
            >
              GIF
            </text>
          </g>
          <path
            d="M44 18a4 4 0 0 1 4-4h18a4 4 0 0 1 4 4v12L58 42H48a4 4 0 0 1-4-4Z"
            fill="#f2c94c"
          />
          <path d="M70 30L58 42v-8a4 4 0 0 1 4-4Z" fill="#e0b335" />
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
    // Its own 56 px, not a full slot's 96 (local change 29), as the eraser.
    html`<capy-misc-button
      data-own-width
      .edgeless=${block}
      .toolbarContainer=${toolbar}
    ></capy-misc-button>`
);

const gifStickerTool = seniorTool(
  'capy-gif-sticker',
  m.drawing_board_gif_sticker,
  (block, toolbar) =>
    html`<capy-gif-sticker-button
      .edgeless=${block}
      .toolbarContainer=${toolbar}
    ></capy-gif-sticker-button>`
);

/** The toolbar's slots after the shapes (Epo 2026-11-10): Misc holds the charts,
 * and on each board only what it may hold. The workspace canvas has GIFs and
 * stickers where an answer board has Formulas, which join its Misc (Epo
 * 2026-11-12). */
export const sheetTools = (board: BoardKind) => [
  graphsTool,
  board === 'workspace' ? gifStickerTool : formulasTool,
  miscTool,
];

const boardKinds = new WeakMap<
  BlockStdScope,
  { board: BoardKind; images: boolean }
>();
/** Says which board a mounted editor is and whether it takes images, for what
 * its Misc panel offers. */
export const markBoard = (
  std: BlockStdScope,
  board: BoardKind,
  images: boolean
) => boardKinds.set(std, { board, images });

/** Whether a Misc tile is for this board (board catalog): an answer board holds
 * the charts and images (its formulas have their slot); the mind map, the
 * formulas, the other pictures, links and the workspace's quizzes and sets are the
 * workspace canvas's. */
const tileFits = (
  tile: MiscTile,
  { board, images }: { board?: BoardKind; images?: boolean } = {}
) => {
  if ('pick' in tile) return !!images;
  return (
    board === 'workspace' ||
    ('piece' in tile && CHART_PIECES.includes(tile.piece))
  );
};

for (const [tag, element] of [
  ['capy-shape-panel', CapyShapePanel],
  ['capy-shape-button', CapyShapeButton],
  ['capy-note-button', CapyNoteButton],
  ['capy-graph-slot', CapyGraphSlot],
  ['capy-formula-slot', CapyFormulaSlot],
  ['capy-misc-panel', CapyMiscPanel],
  ['capy-misc-button', CapyMiscButton],
  ['capy-gif-sticker-button', CapyGifStickerButton],
  ['capy-link-edit', CapyLinkEdit],
  ['capy-link-add', CapyLinkAdd],
] as const)
  if (!customElements.get(tag)) customElements.define(tag, element);
