import * as Y from 'yjs';
import {
  AXIS_MAX,
  BARS_MAX,
  LABEL_LENGTH_MAX,
  LABELS_MAX,
  SPOKES_MAX,
} from './boardChart';
import { LATEX_MAX } from './boardFormula';
import { MARKS_MAX } from './boardPlane';

/** Why a saved board doesn't open: it's handed to the page, never half mounted. */
export class BoardLoadError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super(`drawing board: ${reason}`, options);
    this.name = 'BoardLoadError';
    this.reason = reason;
  }
}

/** What a board may hold: the blocks and canvas elements its tools make. */
const FLAVOURS = new Set([
  'affine:image',
  'affine:list',
  'affine:note',
  'affine:page',
  'affine:paragraph',
  'affine:surface',
]);
const ELEMENTS = new Set([
  'brush',
  'chart',
  'connector',
  'formula',
  'group',
  'plane',
  'shape',
  'text',
]);

type Fields = Record<string, unknown>;

const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value);
const listUpTo = (value: unknown, max: number) =>
  Array.isArray(value) && value.length <= max;

/** The checks a card's own renderer relies on. */
function elementProblem(fields: Fields): string | null {
  const { type } = fields;
  if (typeof type !== 'string' || !ELEMENTS.has(type))
    return `element type ${String(type)}`;
  if (typeof fields.xywh !== 'string') return `${type} without a place`;
  if (type === 'formula')
    return typeof fields.latex === 'string' && fields.latex.length <= LATEX_MAX
      ? null
      : 'formula latex';
  if (type === 'plane')
    return finite(fields.ppu) &&
      (fields.ppu as number) > 0 &&
      finite(fields.x0) &&
      finite(fields.y0) &&
      listUpTo(fields.marks, MARKS_MAX)
      ? null
      : 'plane fields';
  if (type === 'chart') {
    const { axisMax, axisStep, bars, kind, labels, spokes } = fields;
    const fine =
      (kind === 'bar' || kind === 'pie') &&
      finite(axisMax) &&
      (axisMax as number) > 0 &&
      (axisMax as number) <= AXIS_MAX &&
      finite(axisStep) &&
      (axisStep as number) > 0 &&
      listUpTo(bars, BARS_MAX) &&
      listUpTo(spokes, SPOKES_MAX) &&
      (spokes as unknown[]).every(finite) &&
      listUpTo(labels, LABELS_MAX) &&
      (labels as Fields[]).every(
        (label) =>
          typeof label?.text === 'string' &&
          label.text.length <= LABEL_LENGTH_MAX &&
          finite(label.angle)
      ) &&
      (bars as Fields[]).every(
        (bar) =>
          finite(bar?.value) &&
          typeof bar.label === 'string' &&
          bar.label.length <= LABEL_LENGTH_MAX
      );
    return fine ? null : 'chart fields';
  }
  return null;
}

/** A saved board's update, checked before anything mounts: one page with one canvas,
 * and only what the board's tools make, each within its limits. */
export function checkSavedBoard(update: Uint8Array) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
  } catch (cause) {
    throw new BoardLoadError('unreadable', { cause });
  }
  const blocks = doc.getMap('blocks').toJSON() as Record<string, Fields>;
  const flavours = Object.values(blocks).map((block) => block['sys:flavour']);
  for (const flavour of flavours)
    if (typeof flavour !== 'string' || !FLAVOURS.has(flavour))
      throw new BoardLoadError(`block ${String(flavour)}`);
  const count = (flavour: string) =>
    flavours.filter((each) => each === flavour).length;
  if (count('affine:page') !== 1 || count('affine:surface') !== 1)
    throw new BoardLoadError('no single page and canvas');
  const surface = Object.values(blocks).find(
    (block) => block['sys:flavour'] === 'affine:surface'
  ) as Fields;
  const elements = (surface['prop:elements'] as Fields | undefined)?.value;
  if (!elements || typeof elements !== 'object')
    throw new BoardLoadError('canvas without elements');
  for (const element of Object.values(elements as Record<string, Fields>)) {
    const problem = elementProblem(element);
    if (problem) throw new BoardLoadError(problem);
  }
  doc.destroy();
}
