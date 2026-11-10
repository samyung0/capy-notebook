import * as Y from 'yjs';
import { BOARD_CATALOG } from '@/api/board.generated';
import { YOUTUBE_ID } from '@/features/materials/youtubeUrl';
import {
  AXIS_MAX,
  BARS_MAX,
  LABEL_LENGTH_MAX,
  LABELS_MAX,
  LATEX_MAX,
  MARKS_MAX,
  SPOKES_MAX,
} from './boardData';
import { isKlipyMedia, isListedEmoji, isWebAddress } from './boardPictureData';

/** Why a saved board doesn't open: it's handed to the page, never half mounted. */
export class BoardLoadError extends Error {
  readonly reason: string;

  constructor(reason: string, options?: ErrorOptions) {
    super(`drawing board: ${reason}`, options);
    this.name = 'BoardLoadError';
    this.reason = reason;
  }
}

/** A question's answer board or the workspace canvas: each holds what the board
 * catalog lists for it (Epo 2026-11-09). */
export type BoardKind = (typeof BOARD_CATALOG.boards)[number];

/** What a board may hold: its blocks, each under the parents it may have (the page is
 * the root), and its canvas elements. The store checks none of this when a saved board
 * loads: it skips a block it doesn't know and takes any tree. */
export function holds(board: BoardKind) {
  const on = ({ boards }: { boards: readonly string[] }) =>
    boards.includes(board);
  return {
    elements: new Set<string>(
      BOARD_CATALOG.elements.filter(on).map(({ type }) => type)
    ),
    parents: new Map<string, readonly string[]>(
      BOARD_CATALOG.blocks
        .filter(on)
        .map(({ flavour, parents }) => [flavour, parents])
    ),
  };
}

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
function elementProblem(
  fields: Fields,
  elements: ReadonlySet<string>
): string | null {
  const { type } = fields;
  if (typeof type !== 'string' || !elements.has(type))
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
  // A mind map's place comes from its nodes, shapes it lays out by style and layout
  // (its nodes are checked against the canvas in `mindmapFits`).
  if (type === 'mindmap')
    return fields.children &&
      typeof fields.children === 'object' &&
      [1, 2, 3, 4].includes(fields.style as number) &&
      [0, 1, 2].includes(fields.layoutType as number)
      ? null
      : 'mindmap fields';
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
      (fields.polar === undefined || typeof fields.polar === 'boolean') &&
      listUpTo(fields.marks, MARKS_MAX) &&
      (fields.marks as Fields[]).every(
        (mark) =>
          (mark?.kind !== 'label' ||
            (typeof mark.text === 'string' &&
              mark.text.length <= LABEL_LENGTH_MAX)) &&
          // A formula is text KaTeX lays out, within the formula card's limit.
          (mark?.kind !== 'formula' ||
            (typeof mark.latex === 'string' &&
              mark.latex.length <= LATEX_MAX)) &&
          // A vector runs from one point to one other.
          (mark?.kind !== 'vector' ||
            (listUpTo(mark.points, 2) &&
              (mark.points as unknown[]).length === 2)) &&
          // An ellipse is drawn from exactly its four handles.
          (mark?.kind !== 'ellipse' ||
            (listUpTo(mark.points, 4) &&
              (mark.points as unknown[]).length === 4 &&
              (mark.points as unknown[]).every(
                (point) =>
                  Array.isArray(point) &&
                  point.length === 2 &&
                  point.every(finite)
              )))
      )
      ? null
      : 'plane fields';
  if (type === 'chart') {
    const { axisMax, axisStep, bars, fills, kind, labels, spokes } = fields;
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
      (fills === undefined ||
        (listUpTo(fills, SPOKES_MAX) &&
          (fills as Fields[]).every((slice) => finite(slice?.from)))) &&
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

/** A mind map's nodes, which BlockSuite reads without checking: each a shape on the
 * canvas no other mind map or group holds, under a parent among them, one root and no
 * cycle. `owned` gathers the shapes held so far. */
function mindmapFits(
  children: Record<string, unknown>,
  elements: Record<string, Fields>,
  owned: Set<string>
) {
  const nodes = Object.entries(children);
  let roots = 0;
  for (const [id, node] of nodes) {
    const { collapsed, index, parent } = (node ?? {}) as Fields;
    if (
      elements[id]?.type !== 'shape' ||
      owned.has(id) ||
      typeof index !== 'string' ||
      (collapsed !== undefined && typeof collapsed !== 'boolean') ||
      (parent !== undefined &&
        (typeof parent !== 'string' || !Object.hasOwn(children, parent)))
    )
      return false;
    owned.add(id);
    if (parent === undefined) roots += 1;
  }
  if (roots !== 1) return false;
  // From any node, its parents reach the root within as many steps as there are nodes.
  return nodes.every(([id]) => {
    let at: string | undefined = id;
    for (let step = 0; at !== undefined; step += 1) {
      if (step > nodes.length) return false;
      at = (children[at] as Fields).parent as string | undefined;
    }
    return true;
  });
}

/** A mind map's nodes against the canvas: shapes no group or other mind map holds. */
function mindmapOwnsItsNodes(id: string, all: Record<string, Fields>) {
  const owned = new Set<string>();
  for (const [other, element] of Object.entries(all))
    if (
      other !== id &&
      (element.type === 'group' || element.type === 'mindmap') &&
      element.children &&
      typeof element.children === 'object'
    )
      for (const node of Object.keys(element.children)) owned.add(node);
  return mindmapFits(all[id].children as Record<string, unknown>, all, owned);
}

/** An element added to a mounted board (a paste, a duplicate, a peer), as the load
 * check would take it: `all` is the canvas's elements serialized, needed only for a
 * mind map's nodes. */
export function addedElementFits(
  id: string,
  all: Record<string, Fields>,
  kinds: ReadonlySet<string>
) {
  if (hidesKeys(all[id]) || elementProblem(all[id], kinds)) return false;
  return all[id].type !== 'mindmap' || mindmapOwnsItsNodes(id, all);
}

/** A picture: an emoji by its code points, or a GIF by its KLIPY link. */
function pictureFits(props: Fields) {
  const kind = props['kind'];
  const ref = props['ref'];
  const label = props['label'];
  return (
    typeof ref === 'string' &&
    ref.length <= BOARD_CATALOG.limits.PICTURE_REF_MAX &&
    typeof label === 'string' &&
    label.length <= BOARD_CATALOG.limits.PICTURE_LABEL_MAX &&
    finite(props['rotate']) &&
    ((kind === 'emoji' && isListedEmoji(ref)) ||
      (kind === 'klipy' && isKlipyMedia(ref)))
  );
}

/** A link card: a web address, and a YouTube video's id when it is one. */
function linkFits(props: Fields) {
  const url = props['url'];
  const videoId = props['videoId'];
  return (
    typeof url === 'string' &&
    url.length <= BOARD_CATALOG.limits.LINK_URL_MAX &&
    isWebAddress(url) &&
    typeof videoId === 'string' &&
    (videoId === '' || YOUTUBE_ID.test(videoId)) &&
    finite(props['rotate'])
  );
}

/** A material card: a workspace quiz or set by id, with its title. */
function materialFits(props: Fields) {
  const kind = props['kind'];
  const id = props['materialId'];
  const title = props['title'];
  return (
    (kind === 'quiz' || kind === 'flashcards') &&
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= BOARD_CATALOG.limits.MATERIAL_ID_MAX &&
    typeof title === 'string' &&
    title.length <= BOARD_CATALOG.limits.CARD_TITLE_MAX &&
    finite(props['rotate'])
  );
}

/** A capy embed's own props (no `prop:` prefix) as its renderer expects them, with a
 * place: the load check and the workspace canvas's paste both ask this. */
export function embedFits(flavour: string, props: Fields) {
  const fits = {
    'affine:embed-capy-link': linkFits,
    'affine:embed-capy-material': materialFits,
    'affine:embed-capy-picture': pictureFits,
  }[flavour];
  return !!fits && fits(props) && isPlace(props.xywh);
}

/** A saved board's update, checked before anything mounts: one page with one canvas,
 * and only what the board's tools make, each within its limits. Its blocks and canvas
 * elements as plain data, for the preview. */
/** Yjs's `toJSON` writes `obj[key] = value`, so a `__proto__` key becomes the object's
 * prototype: its entry hides from every check while BlockSuite, reading the Y maps,
 * still loads it. Such a board is refused. */
function hidesKeys(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== Array.prototype) return true;
  return Object.values(value).some(hidesKeys);
}

/** A saved block's props without their `prop:` prefix. */
const ownProps = (block: Fields): Fields =>
  Object.fromEntries(
    Object.entries(block)
      .filter(([key]) => key.startsWith('prop:'))
      .map(([key, value]) => [key.slice(5), value])
  );

export function checkSavedBoard(update: Uint8Array, board: BoardKind) {
  const { elements: kinds, parents } = holds(board);
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
  } catch (cause) {
    throw new BoardLoadError('unreadable', { cause });
  }
  const blocks = doc.getMap('blocks').toJSON() as Record<string, Fields>;
  if (hidesKeys(blocks)) throw new BoardLoadError('hidden key');
  const flavours = Object.values(blocks).map((block) => block['sys:flavour']);
  for (const flavour of flavours)
    if (typeof flavour !== 'string' || !parents.has(flavour))
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
        !parents.get(flavour)?.includes(block['sys:flavour'] as string)
      )
        throw new BoardLoadError('block tree');
      parentOf.set(child, id);
    }
  }
  for (const [id, block] of Object.entries(blocks)) {
    if ((block['sys:flavour'] === 'affine:page') === parentOf.has(id))
      throw new BoardLoadError('block tree');
    const flavour = block['sys:flavour'] as string;
    if (
      flavour.startsWith('affine:embed-capy-') &&
      !embedFits(flavour, ownProps(block))
    )
      throw new BoardLoadError(
        `${flavour.slice('affine:embed-capy-'.length)} fields`
      );
    const onCanvas =
      flavour === 'affine:note' ||
      flavour.startsWith('affine:embed-capy-') ||
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
  const all = elements as Record<string, Fields>;
  for (const element of Object.values(all)) {
    const problem = elementProblem(element, kinds);
    if (problem) throw new BoardLoadError(problem);
  }
  for (const [id, element] of Object.entries(all))
    if (element.type === 'mindmap' && !mindmapOwnsItsNodes(id, all))
      throw new BoardLoadError('mindmap nodes');
  doc.destroy();
  return { blocks, elements: elements as Record<string, Fields> };
}
