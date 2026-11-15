import type { ShapeToolOption } from '@blocksuite/affine-gfx-shape';
import { ShapeType } from '@blocksuite/affine-model';
import { html, svg, type TemplateResult } from 'lit';

import {
  ScribbledDiamondIcon,
  ScribbledEllipseIcon,
  ScribbledRoundedRectangleIcon,
  ScribbledSquareIcon,
  ScribbledTriangleIcon,
} from './icons';

type Config = {
  name: ShapeToolOption['shapeName'];
  generalIcon: TemplateResult<1>;
  scribbledIcon: TemplateResult<1>;
  tooltip: string;
  disabled: boolean;
};

// Capy (local change 61): the switcher offers the board shapes panel's ten shapes,
// drawn as the panel draws them, so switching reaches every shape that can be placed.
const outline = (shape: TemplateResult<2>) =>
  html`<svg
    fill="none"
    height="1em"
    stroke="currentColor"
    stroke-linecap="round"
    stroke-linejoin="round"
    stroke-width="1.5"
    viewBox="0 0 24 24"
    width="1em"
  >
    ${shape}
  </svg>`;
const SquareIcon = () => outline(svg`<rect x="4" y="4" width="16" height="16"/>`);
const EllipseIcon = () => outline(svg`<circle cx="12" cy="12" r="8.5"/>`);
const DiamondIcon = () => outline(svg`<path d="M12 3l9 9-9 9-9-9z"/>`);
const TriangleIcon = () => outline(svg`<path d="M12 4l9 16H3z"/>`);
const RoundedRectangleIcon = () =>
  outline(svg`<rect x="3" y="6" width="18" height="12" rx="4"/>`);
const polygon = (
  name: ShapeType,
  tooltip: string,
  path: TemplateResult<2>
): Config => ({
  name,
  generalIcon: outline(path),
  scribbledIcon: outline(path),
  tooltip,
  disabled: false,
});

export const ShapeComponentConfig: Config[] = [
  {
    name: ShapeType.Rect,
    generalIcon: SquareIcon(),
    scribbledIcon: ScribbledSquareIcon,
    tooltip: 'Square',
    disabled: false,
  },
  {
    name: ShapeType.Ellipse,
    generalIcon: EllipseIcon(),
    scribbledIcon: ScribbledEllipseIcon,
    tooltip: 'Ellipse',
    disabled: false,
  },
  {
    name: ShapeType.Diamond,
    generalIcon: DiamondIcon(),
    scribbledIcon: ScribbledDiamondIcon,
    tooltip: 'Diamond',
    disabled: false,
  },
  {
    name: ShapeType.Triangle,
    generalIcon: TriangleIcon(),
    scribbledIcon: ScribbledTriangleIcon,
    tooltip: 'Triangle',
    disabled: false,
  },
  {
    name: 'roundedRect',
    generalIcon: RoundedRectangleIcon(),
    scribbledIcon: ScribbledRoundedRectangleIcon,
    tooltip: 'Rounded rectangle',
    disabled: false,
  },
  polygon(
    ShapeType.RightTriangle,
    'Right triangle',
    svg`<path d="M5 4v16h15z"/>`
  ),
  polygon(
    ShapeType.Parallelogram,
    'Parallelogram',
    svg`<path d="M8 6h13l-5 12H3z"/>`
  ),
  polygon(ShapeType.Trapezium, 'Trapezium', svg`<path d="M7 6h10l4 12H3z"/>`),
  polygon(
    ShapeType.Pentagon,
    'Pentagon',
    svg`<path d="M12 3l9 7-3.5 11h-11L3 10z"/>`
  ),
  polygon(ShapeType.Hexagon, 'Hexagon', svg`<path d="M7 4h10l5 8-5 8H7l-5-8z"/>`),
];

export const ShapeComponentConfigMap = ShapeComponentConfig.reduce(
  (acc, config) => {
    acc[config.name] = config;
    return acc;
  },
  {} as Record<Config['name'], Config>
);
