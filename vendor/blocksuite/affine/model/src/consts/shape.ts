export const DEFAULT_ROUGHNESS = 1.4;

// TODO: need to check the default central area ratio
export const DEFAULT_CENTRAL_AREA_RATIO = 0.3;

export enum ShapeTextFontSize {
  LARGE = 28,
  MEDIUM = 20,
  SMALL = 12,
  XLARGE = 36,
}

export enum ShapeType {
  Rect = 'rect',
  Ellipse = 'ellipse',
  Diamond = 'diamond',
  Triangle = 'triangle',
  // Capy (local change 46): polygons the board's shapes panel offers.
  RightTriangle = 'rightTriangle',
  Parallelogram = 'parallelogram',
  Trapezium = 'trapezium',
  Pentagon = 'pentagon',
  Hexagon = 'hexagon',
}

/** Capy (local change 46): each polygon type's corners as fractions of its box,
 * clockwise from the top. Hit tests, connectors, the canvas and the cursor preview
 * all draw from these. */
export const POLYGON_SHAPES: Partial<Record<string, [number, number][]>> = {
  [ShapeType.RightTriangle]: [
    [0, 0],
    [1, 1],
    [0, 1],
  ],
  [ShapeType.Parallelogram]: [
    [0.25, 0],
    [1, 0],
    [0.75, 1],
    [0, 1],
  ],
  [ShapeType.Trapezium]: [
    [0.25, 0],
    [0.75, 0],
    [1, 1],
    [0, 1],
  ],
  [ShapeType.Pentagon]: [
    [0.5, 0],
    [1, 0.38],
    [0.81, 1],
    [0.19, 1],
    [0, 0.38],
  ],
  [ShapeType.Hexagon]: [
    [0.25, 0],
    [0.75, 0],
    [1, 0.5],
    [0.75, 1],
    [0.25, 1],
    [0, 0.5],
  ],
};

/** Capy (local change 46): a shape's size when placed with a click. */
export function getShapeSize(name: ShapeName): [number, number] {
  switch (name) {
    case 'roundedRect':
      return [140, 100];
    case ShapeType.Parallelogram:
    case ShapeType.Trapezium:
      return [150, 90];
    case ShapeType.Pentagon:
      return [104, 100];
    case ShapeType.Hexagon:
      return [116, 100];
    default:
      return [100, 100];
  }
}

export type ShapeName = ShapeType | 'roundedRect';

export function getShapeName(type: ShapeType, radius: number): ShapeName {
  if (type === ShapeType.Rect && radius > 0) {
    return 'roundedRect';
  }
  return type;
}

export function getShapeType(name: ShapeName): ShapeType {
  if (name === 'roundedRect') {
    return ShapeType.Rect;
  }
  return name;
}

export function getShapeRadius(name: ShapeName): number {
  if (name === 'roundedRect') {
    return 0.1;
  }
  return 0;
}

export enum ShapeStyle {
  General = 'General',
  Scribbled = 'Scribbled',
}
