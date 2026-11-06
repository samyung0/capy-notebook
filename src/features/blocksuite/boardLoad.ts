import * as Y from 'yjs';
import {
  AXIS_MAX,
  BARS_MAX,
  LABEL_LENGTH_MAX,
  LABELS_MAX,
  LATEX_MAX,
  MARKS_MAX,
  SPOKES_MAX,
} from './boardData';

/** Why a saved board doesn't open: it's handed to the page, never half mounted. */
export class BoardLoadError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super(`drawing board: ${reason}`, options);
    this.name = 'BoardLoadError';
    this.reason = reason;
  }
}

/** What a board may hold: the blocks its tools make, each under the parents it may
 * have. The page is the root. The store checks none of this when a saved board loads:
 * it skips a block it doesn't know and takes any tree. */
const PARENTS: Record<string, string[]> = {
  'affine:image': ['affine:surface', 'affine:note'],
  'affine:list': ['affine:note', 'affine:paragraph', 'affine:list'],
  'affine:note': ['affine:page'],
  'affine:page': [],
  'affine:paragraph': ['affine:note', 'affine:paragraph', 'affine:list'],
  'affine:surface': ['affine:page'],
};
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

export type Fields = Record<string, unknown>;

const finite = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value);
const listUpTo = (value: unknown, max: number) =>
  Array.isArray(value) && value.length <= max;
/** `[x,y,w,h]`, as the board and its preview read a place. */
function isPlace(xywh: unknown) {
  if (typeof xywh !== 'string') return false;
  try {
    const place: unknown = JSON.parse(xywh);
    return (
      listUpTo(place, 4) &&
      (place as unknown[]).length === 4 &&
      (place as unknown[]).every(finite)
    );
  } catch {
    return false;
  }
}
/** A connector's end: on an element (by id) or at a point. */
const connection = (value: unknown) => {
  const { id, position } = (value ?? {}) as Fields;
  return (
    typeof id === 'string' ||
    (Array.isArray(position) && position.length === 2 && position.every(finite))
  );
};

/** The checks a card's own renderer relies on. */
function elementProblem(fields: Fields): string | null {
  const { type } = fields;
  if (typeof type !== 'string' || !ELEMENTS.has(type))
    return `element type ${String(type)}`;
  // A connector's place comes from its ends and a group's from its children, so
  // neither stores one; every other element does.
  if (type === 'connector')
    return connection(fields.source) && connection(fields.target)
      ? null
      : 'connector ends';
  if (type === 'group')
    return fields.children && typeof fields.children === 'object'
      ? null
      : 'group children';
  if (!isPlace(fields.xywh)) return `${type} without a place`;
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
 * and only what the board's tools make, each within its limits. Its blocks and canvas
 * elements as plain data, for the preview. */
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
    if (typeof flavour !== 'string' || !Object.hasOwn(PARENTS, flavour))
      throw new BoardLoadError(`block ${String(flavour)}`);
  const count = (flavour: string) =>
    flavours.filter((each) => each === flavour).length;
  if (count('affine:page') !== 1 || count('affine:surface') !== 1)
    throw new BoardLoadError('no single page and canvas');
  // One tree: every child exists and has one allowed parent, and every block but the
  // page is someone's child.
  const parentOf = new Map<string, string>();
  for (const [id, block] of Object.entries(blocks)) {
    const children = block['sys:children'];
    if (!Array.isArray(children)) throw new BoardLoadError('block children');
    for (const child of children) {
      const flavour = blocks[child]?.['sys:flavour'] as string | undefined;
      if (
        !flavour ||
        parentOf.has(child) ||
        !PARENTS[flavour].includes(block['sys:flavour'] as string)
      )
        throw new BoardLoadError('block tree');
      parentOf.set(child, id);
    }
  }
  for (const [id, block] of Object.entries(blocks)) {
    if ((block['sys:flavour'] === 'affine:page') === parentOf.has(id))
      throw new BoardLoadError('block tree');
    const onCanvas =
      block['sys:flavour'] === 'affine:note' ||
      (block['sys:flavour'] === 'affine:image' &&
        blocks[parentOf.get(id) as string]['sys:flavour'] === 'affine:surface');
    if (onCanvas && !isPlace(block['prop:xywh']))
      throw new BoardLoadError('block without a place');
  }
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
  return { blocks, elements: elements as Record<string, Fields> };
}
