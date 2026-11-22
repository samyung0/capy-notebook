import * as Y from 'yjs';
import { BOARD_CATALOG } from '@/api/board.generated';
import { YOUTUBE_ID } from '@/features/materials/youtubeUrl';
import { graphElementSchema } from '@/features/questions/validation';
import {
  AXIS_MAX,
  BARS_MAX,
  ELEMENTS_MAX,
  isColour,
  isTextSize,
  LABEL_LENGTH_MAX,
  LABELS_MAX,
  LATEX_MAX,
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
export function isPlace(xywh: unknown) {
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

/** One of a plane's elements, of any kind a graph holds, checked as every graph's
 * (the graph model's one element check, Epo 2026-11-16). */
const planeElementFits = (element: Fields) =>
  graphElementSchema.safeParse(element).success;

/** How many items the load check takes of a list whose add tools stop at `cap`:
 * twice it, as two people's adds at the same moment merge past the cap (Epo
 * 2026-11-22, "sure A"; a quiz or note figure's maps hold twice theirs too). */
const mergedCap = (cap: number) => 2 * cap;

/** A keyed list: a map of item id to the item and its order key (Epo 2026-11-16,
 * D10: a plane's elements; 2026-11-22: a chart's bars, labels and lines), up to
 * twice its `cap`, each item as `fits` takes it. */
function keyedFit(
  value: unknown,
  cap: number,
  fits: (item: Fields) => boolean
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value as Record<string, Fields>);
  return (
    entries.length <= mergedCap(cap) &&
    entries.every(
      ([id, entry]) =>
        typeof entry?.order === 'string' &&
        typeof entry.element === 'object' &&
        entry.element !== null &&
        (entry.element as Fields).id === id &&
        fits(entry.element as Fields)
    )
  );
}

const barFits = (bar: Fields) =>
  finite(bar.value) &&
  typeof bar.label === 'string' &&
  bar.label.length <= LABEL_LENGTH_MAX;
const pieLabelFits = (label: Fields) =>
  typeof label.text === 'string' &&
  label.text.length <= LABEL_LENGTH_MAX &&
  finite(label.angle) &&
  finite(label.reach) &&
  isTextSize(label.size);
/** A pie line, with the fill of the slice it starts. */
const spokeFits = (spoke: Fields) =>
  finite(spoke.angle) && (spoke.fill === undefined || isColour(spoke.fill));

/** The checks a card's own renderer relies on. */
function elementProblem(
  fields: Fields,
  elements: ReadonlySet<string>
): string | null {
  const type = fields?.type;
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
      (fields.rotate === undefined || finite(fields.rotate)) &&
      keyedFit(fields.elements, ELEMENTS_MAX, planeElementFits)
      ? null
      : 'plane fields';
  if (type === 'chart') {
    const { axisMax, axisStep, bars, kind, labels, spokes } = fields;
    const fine =
      (kind === 'bar' || kind === 'pie') &&
      (fields.rotate === undefined || finite(fields.rotate)) &&
      finite(axisMax) &&
      (axisMax as number) > 0 &&
      (axisMax as number) <= AXIS_MAX &&
      finite(axisStep) &&
      (axisStep as number) > 0 &&
      keyedFit(bars, BARS_MAX, barFits) &&
      keyedFit(labels, LABELS_MAX, pieLabelFits) &&
      keyedFit(spokes, SPOKES_MAX, spokeFits);
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
      (element?.type === 'group' || element?.type === 'mindmap') &&
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

/** Yjs's `toJSON` writes `obj[key] = value`, so a `__proto__` key becomes the object's
 * prototype: its entry hides from every check while BlockSuite, reading the Y maps,
 * still loads it. Such an entry never fits. */
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

/** A saved board's update, checked before anything mounts: one page with one canvas,
 * and only what the board's tools make, each within its limits. Its blocks and canvas
 * elements as plain data, for the preview.
 *
 * A question's board is its owner's alone, and is refused for the first thing that
 * doesn't fit. A workspace canvas is written by others too (a peer, a newer version),
 * so it opens whenever it has its page and canvas: `misfits` says what doesn't fit,
 * `blocks` and `elements` leave those out, and the board draws them as placeholders
 * (Epo 2026-11-18: reject nothing, delete nothing a person hasn't acknowledged). */
export function checkSavedBoard(update: Uint8Array, board: BoardKind) {
  const { elements: kinds, parents } = holds(board);
  const misfits: string[] = [];
  const misfit = (reason: string) => {
    if (board !== 'workspace') throw new BoardLoadError(reason);
    misfits.push(reason);
  };
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, update);
  } catch (cause) {
    throw new BoardLoadError('unreadable', { cause });
  }
  const saved = doc.getMap('blocks').toJSON() as Record<string, Fields>;
  doc.destroy();
  if (hidesKeys(saved)) misfit('hidden key');
  const blocks = Object.fromEntries(
    Object.entries(saved).filter(([, block]) => {
      const flavour = block?.['sys:flavour'];
      const held = typeof flavour === 'string' && parents.has(flavour);
      if (!held) misfit(`block ${String(flavour)}`);
      return held;
    })
  );
  const flavourOf = (id: string) =>
    Object.hasOwn(blocks, id)
      ? (blocks[id]['sys:flavour'] as string)
      : undefined;
  const count = (flavour: string) =>
    Object.keys(blocks).filter((id) => flavourOf(id) === flavour).length;
  // Without these there is nothing to open, on either board.
  if (count('affine:page') !== 1 || count('affine:surface') !== 1)
    throw new BoardLoadError('no single page and canvas');
  /** Blocks that don't fit, left out of what is returned. */
  const out = new Set<string>();
  // One tree: every child exists and has one allowed parent, and every block but the
  // page is someone's child.
  const parentOf = new Map<string, string>();
  for (const [id, block] of Object.entries(blocks)) {
    const children = block['sys:children'];
    if (!Array.isArray(children)) {
      misfit('block children');
      out.add(id);
      continue;
    }
    for (const child of children) {
      const flavour = flavourOf(child);
      // A child left out above for its flavour has been said already.
      if (!flavour && Object.hasOwn(saved, child)) continue;
      if (
        !flavour ||
        parentOf.has(child) ||
        !parents.get(flavour)?.includes(block['sys:flavour'] as string)
      ) {
        misfit('block tree');
        if (flavour) out.add(child);
      } else parentOf.set(child, id);
    }
  }
  for (const [id, block] of Object.entries(blocks)) {
    if (out.has(id)) continue;
    const flavour = block['sys:flavour'] as string;
    const embed = flavour.startsWith('affine:embed-capy-');
    const onCanvas =
      flavour === 'affine:note' ||
      embed ||
      (flavour === 'affine:image' &&
        flavourOf(parentOf.get(id) as string) === 'affine:surface');
    const problem =
      (flavour === 'affine:page') === parentOf.has(id)
        ? 'block tree'
        : embed && !embedFits(flavour, ownProps(block))
          ? `${flavour.slice('affine:embed-capy-'.length)} fields`
          : onCanvas && !isPlace(block['prop:xywh'])
            ? 'block without a place'
            : null;
    if (!problem) continue;
    misfit(problem);
    out.add(id);
  }
  const surface = Object.values(blocks).find(
    (block) => block['sys:flavour'] === 'affine:surface'
  ) as Fields;
  const all = (surface['prop:elements'] as Fields | undefined)?.value as
    | Record<string, Fields>
    | undefined;
  if (!all || typeof all !== 'object')
    throw new BoardLoadError('canvas without elements');
  const elements = { ...all };
  for (const [id, element] of Object.entries(all)) {
    const problem = elementProblem(element, kinds);
    if (!problem) continue;
    misfit(problem);
    delete elements[id];
  }
  for (const [id, element] of Object.entries(elements))
    if (element.type === 'mindmap' && !mindmapOwnsItsNodes(id, all)) {
      misfit('mindmap nodes');
      delete elements[id];
    }
  for (const id of out) delete blocks[id];
  return { blocks, elements, misfits };
}

/** A Yjs value as plain data. */
const plain = (value: unknown): unknown =>
  value instanceof Y.AbstractType ? value.toJSON() : value;

/** A stored canvas element read from its own map (`id` is its key), as the load check
 * would take it: the board draws it for real, and anything else as a placeholder. */
export function storedElementFits(
  id: string,
  element: Y.Map<unknown>,
  kinds: ReadonlySet<string>
) {
  // Never a key of a plain object, which is what the board's code keeps elements in.
  if (id === '__proto__') return false;
  const fields = element.toJSON() as Fields;
  if (fields.type !== 'mindmap')
    return addedElementFits(id, { [id]: fields }, kinds);
  // A mind map's nodes are checked against the whole canvas.
  const canvas = element.parent as Y.Map<unknown>;
  return addedElementFits(
    id,
    Object.fromEntries(
      [...canvas.entries()].map(([key, each]) => [key, plain(each) as Fields])
    ),
    kinds
  );
}

/** A stored block read from its own map, as the load check would take it one block at
 * a time (its place in the tree isn't read): a flavour the board holds, a capy
 * embed's fields, and a place where it has one. The page and the canvas always are:
 * the load check answers for those, and the canvas's elements are read one by one. */
export function storedBlockFits(
  block: Y.Map<unknown>,
  parents: ReadonlyMap<string, readonly string[]>
) {
  const flavour = block.get('sys:flavour');
  if (typeof flavour !== 'string' || !parents.has(flavour)) return false;
  if (flavour === 'affine:page' || flavour === 'affine:surface') return true;
  const props = ownProps(
    Object.fromEntries(
      [...block.entries()].map(([key, value]) => [key, plain(value)])
    )
  );
  if (hidesKeys(props)) return false;
  if (flavour.startsWith('affine:embed-capy-'))
    return embedFits(flavour, props);
  return props.xywh === undefined || isPlace(props.xywh);
}
