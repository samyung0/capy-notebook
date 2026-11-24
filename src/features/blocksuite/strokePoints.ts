/* A pen or highlighter stroke's points as the board stores them (Epo 2026-11-24,
 * vendor/blocksuite/README.md local change 79): one Uint8Array, a Yjs binary value,
 * where nested number arrays cost a value each. A 4-byte header (byte 0 the values
 * per point: 2 for x and y, 3 with pressure; bytes 1 to 3 zero), then every point's
 * values in turn as little-endian Float32s. Points are relative to the stroke's box
 * (its `xywh`), so Float32's 24-bit fraction keeps a stroke 10,000 units long to
 * about a thousandth of a unit wherever it sits on the board. The board's model, its
 * rules, the preview and the saved copy all read and write them here; nothing else
 * decodes them.
 *
 * Keep this file free of imports: the vendored brush and highlighter models import
 * it, and an import would pull app code into BlockSuite's bundle. */

const HEADER = 4;

// A Float32Array reads in the platform's byte order; every supported one is
// little-endian.
if (new Uint8Array(new Uint16Array([1]).buffer)[0] !== 1)
  throw new Error('stroke points need a little-endian platform');

/** A point as the board draws it: x and y, and pressure where the pen gave one. */
export type StrokePoint = [number, number] | [number, number, number];

/** Stored points read in place: `stride` values per point. */
export type StrokeView = { stride: 2 | 3; values: Float32Array };

/** The bytes of `points`, each `[x, y]` or each `[x, y, pressure]`, less `origin`
 * from x and y. A stroke with no points stores x and y. */
export function encodeStrokePoints(
  points: readonly (readonly number[])[],
  [ox, oy]: readonly number[] = [0, 0]
): Uint8Array {
  const stride = points.length ? points[0].length : 2;
  if (stride !== 2 && stride !== 3)
    throw new Error(`a stroke point holds 2 or 3 values, not ${stride}`);
  const bytes = new Uint8Array(HEADER + points.length * stride * 4);
  bytes[0] = stride;
  const values = new Float32Array(bytes.buffer, HEADER);
  for (const [i, point] of points.entries()) {
    if (point.length !== stride)
      throw new Error('a stroke mixes points with and without pressure');
    values[i * stride] = point[0] - ox;
    values[i * stride + 1] = point[1] - oy;
    if (stride === 3) values[i * stride + 2] = point[2];
  }
  return bytes;
}

/** The header's values per point, or 0 when the value is no bytes holding whole
 * points. */
function strideOf(bytes: unknown) {
  if (!(bytes instanceof Uint8Array)) return 0;
  if (bytes.length < HEADER || bytes[1] || bytes[2] || bytes[3]) return 0;
  const stride = bytes[0];
  if (stride !== 2 && stride !== 3) return 0;
  return (bytes.length - HEADER) % (stride * 4) ? 0 : stride;
}

/** Stored points' values: a view of the bytes, or a copy when they don't start
 * on a 4-byte boundary. Throws for any value that isn't stored points (the type
 * can't promise what a peer wrote); the board's rules (`isStrokePoints`) keep
 * those out of the editor. */
export function strokeView(bytes: Uint8Array): StrokeView {
  const stride = strideOf(bytes);
  if (!stride) throw new Error('malformed stroke points');
  const start = bytes.byteOffset + HEADER;
  const length = (bytes.length - HEADER) / 4;
  const values =
    start % 4
      ? new Float32Array(bytes.slice(HEADER).buffer)
      : new Float32Array(bytes.buffer, start, length);
  return { stride, values };
}

/** Whether a value is stored points: bytes with the header, whole points and
 * finite values. */
export function isStrokePoints(bytes: unknown): bytes is Uint8Array {
  return (
    bytes instanceof Uint8Array &&
    strideOf(bytes) > 0 &&
    strokeView(bytes).values.every(Number.isFinite)
  );
}

export function decodeStrokePoints(bytes: Uint8Array): StrokePoint[] {
  const { stride, values } = strokeView(bytes);
  const points: StrokePoint[] = [];
  for (let i = 0; i < values.length; i += stride)
    points.push(
      stride === 3
        ? [values[i], values[i + 1], values[i + 2]]
        : [values[i], values[i + 1]]
    );
  return points;
}

/** Whether (x, y), in the stroke's own units (from its box's corner), lies within
 * `threshold` of its line: of a segment, or of its one point. Reads the bytes in
 * place, as the hit test runs on every pointer move over the stroke's box. */
export function strokeNearPoint(
  bytes: Uint8Array,
  x: number,
  y: number,
  threshold: number
) {
  const { stride, values } = strokeView(bytes);
  if (!values.length) return false;
  let ax = values[0];
  let ay = values[1];
  if (values.length === stride) return Math.hypot(x - ax, y - ay) < threshold;
  for (let i = stride; i < values.length; i += stride) {
    const bx = values[i];
    const by = values[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length
      ? Math.min(Math.max(((x - ax) * dx + (y - ay) * dy) / length, 0), 1)
      : 0;
    if (Math.hypot(x - ax - t * dx, y - ay - t * dy) < threshold) return true;
    ax = bx;
    ay = by;
  }
  return false;
}
