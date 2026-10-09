/** Where the photo sits under the crop circle: offset of its centre from the
 * circle's centre (stage px), zoom over the cover fit, quarter-turn rotation. */
export interface PhotoView {
  rotation: number;
  x: number;
  y: number;
  zoom: number;
}

interface Size {
  height: number;
  width: number;
}

/** The share of the circle the photo must still cover when zoomed out. */
export const MIN_COVERAGE = 0.75;

/** Stage px per image px: zoom 1 makes the short side span the circle. */
const scaleOf = (size: Size, zoom: number, diameter: number) =>
  (diameter / Math.min(size.width, size.height)) * zoom;

/** Share of a radius-r circle covered by a centred rectangle of half-sizes
 * a and b: four times the quadrant area under min(b, sqrt(r² - x²)). */
export function circleCoverage(a: number, b: number, r: number) {
  const arc = (x: number) =>
    (x * Math.sqrt(r * r - x * x) + r * r * Math.asin(x / r)) / 2;
  const end = Math.min(a, r);
  // Below x0 the rectangle's edge is lower than the circle's.
  const x0 = b >= r ? 0 : Math.sqrt(r * r - b * b);
  const quadrant = b * Math.min(end, x0) + (end > x0 ? arc(end) - arc(x0) : 0);
  return (4 * quadrant) / (Math.PI * r * r);
}

/** The smallest zoom whose centred photo still covers MIN_COVERAGE of the
 * circle; it depends on the aspect ratio alone. */
export function minZoomFor(size: Size) {
  const short = Math.min(size.width, size.height);
  const long = Math.max(size.width, size.height);
  // Diameter 2: at zoom z the half-sizes are z and z * long / short.
  let low = 0;
  let high = 1;
  for (let i = 0; i < 30; i++) {
    const zoom = (low + high) / 2;
    if (circleCoverage((zoom * long) / short, zoom, 1) >= MIN_COVERAGE)
      high = zoom;
    else low = zoom;
  }
  return high;
}

/** Clamps zoom and offset: on an axis where the photo is wider than the
 * circle it keeps covering it, on one where it is narrower it stays centred,
 * which is where minZoomFor measured its coverage. */
export function fitView(
  view: PhotoView,
  size: Size,
  diameter: number,
  zoomRange: { max: number; min: number }
): PhotoView {
  const zoom = Math.min(zoomRange.max, Math.max(zoomRange.min, view.zoom));
  const scale = scaleOf(size, zoom, diameter);
  const turned = view.rotation % 180 !== 0;
  const width = (turned ? size.height : size.width) * scale;
  const height = (turned ? size.width : size.height) * scale;
  const maxX = Math.max(0, (width - diameter) / 2);
  const maxY = Math.max(0, (height - diameter) / 2);
  return {
    rotation: view.rotation,
    x: Math.min(maxX, Math.max(-maxX, view.x)),
    y: Math.min(maxY, Math.max(-maxY, view.y)),
    zoom,
  };
}

/** Draws the photo for a context already translated to the circle's centre,
 * in stage px; the 512 px export scales the context first. */
export function cropPhoto(
  context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  view: PhotoView,
  diameter: number
) {
  const scale = scaleOf(bitmap, view.zoom, diameter);
  context.imageSmoothingQuality = 'high';
  context.translate(view.x, view.y);
  context.rotate((view.rotation * Math.PI) / 180);
  context.scale(scale, scale);
  context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);
}
