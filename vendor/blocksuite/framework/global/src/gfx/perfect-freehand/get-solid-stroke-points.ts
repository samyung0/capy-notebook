import type { IVec, IVec3 } from '../model/index.js';
import { getStroke } from './get-stroke.js';

export function getSolidStrokePoints(
  points: (IVec | IVec3)[],
  lineWidth: number
) {
  return getStroke(points, {
    // Capy (local change 50): a stroke at pressure 0.5 is its width wide, as the
    // previews draw it. The easing gives 0.5 a radius of size / √2, so AFFiNE's
    // size drew every width 1.41 times over (a 4 as 5.7, the highlighter's 22 as 31).
    size: lineWidth / Math.SQRT2,
    thinning: 0.6,
    streamline: 0.5,
    smoothing: 0.5,
    easing: t => Math.sin((t * Math.PI) / 2),
    // Capy (local change 50): a stroke without pressure (a mouse's) draws at one
    // width, a pressure stroke's at 0.5. AFFiNE made it up from the speed, so a
    // quick stroke came out thin.
    simulatePressure: false,
  });
}
