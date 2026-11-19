import { POLYGON_SHAPES, type ShapeType } from '../../../consts/shape.js';
import { diamond } from './diamond.js';
import { ellipse } from './ellipse.js';
import { polygon } from './polygon.js';
import { rect } from './rect.js';
import { triangle } from './triangle.js';

export const shapeMethods: Record<ShapeType, typeof rect> = {
  rect,
  triangle,
  ellipse,
  diamond,
  // Capy (local change 46)
  rightTriangle: polygon(POLYGON_SHAPES.rightTriangle!),
  parallelogram: polygon(POLYGON_SHAPES.parallelogram!),
  trapezium: polygon(POLYGON_SHAPES.trapezium!),
  pentagon: polygon(POLYGON_SHAPES.pentagon!),
  hexagon: polygon(POLYGON_SHAPES.hexagon!),
};
