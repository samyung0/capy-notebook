import * as Y from 'yjs';
import { BOARD_CATALOG } from '@/api/board.generated';
import { mergedCap } from '@/api/mergedCap';
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
import { isStrokePoints } from './strokePoints';

/* The board's rules (Epo 2026-11-22, "sure A then"): what each stored canvas
 * element and block may hold, key by key, read from its Y map as stored (never
 * `toJSON()`), so a string where a text belongs is told apart. Every board is
 * read through them as it opens and as peers write to it (boardLoad.ts); the
 * canvas room checks no content (Epo 2026-11-22). boardRules.corpus.test.ts runs
 * them over what BlockSuite's own code writes. Relations two people's honest
 * edits can break together (a mind map's nodes against the canvas, a group's
 * children, a connector's ends, the block tree's links) are not here (Epo
 * 2026-11-22, "but A seems simpler, do A"); a child's kind under its parent is
 * (`childFits`). */

/** A question's answer board or the workspace canvas: each holds what the board
 * catalog lists for it (Epo 2026-11-09). */
export type BoardKind = (typeof BOARD_CATALOG.boards)[number];

const held = new Map<BoardKind, ReturnType<typeof holdsOf>>();
function holdsOf(board: BoardKind) {
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
/** What a board may hold: its blocks, each under the parents it may have (the page is
 * the root), and its canvas elements. The store checks none of this: it skips a
 * block it doesn't know and takes any tree. */
export function holds(board: BoardKind) {
  let found = held.get(board);
  if (!found) {
    found = holdsOf(board);
    held.set(board, found);
  }
  return found;
}

export type Fields = Record<string, unknown>;

/** BlockSuite's enums the rules read, as its own (`@blocksuite/affine/model`;
 * boardRules.corpus.test.ts holds them equal), kept here so the preview reads a
 * board without loading BlockSuite. */
export const ENUMS = {
  connectorMode: [0, 1, 2],
  fontStyle: ['italic', 'normal'],
  fontWeight: ['700', '300', '500', '400', '600'],
  labelAnchor: ['bottom', 'center', 'top'],
  layoutType: [2, 1, 0],
  listType: ['bulleted', 'numbered', 'todo', 'toggle'],
  mindmapStyle: [4, 1, 3, 2],
  noteDisplayMode: ['both', 'doc', 'edgeless'],
  noteShadow: [
    '--affine-note-shadow-box',
    '--affine-note-shadow-film',
    '--affine-note-shadow-float',
    '',
    '--affine-note-shadow-paper',
    '--affine-note-shadow-sticker',
  ],
  paragraphType: ['text', 'quote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
  pointStyle: ['Arrow', 'Circle', 'Diamond', 'None', 'Triangle'],
  shapeStyle: ['General', 'Scribbled'],
  shapeType: [
    'rect',
    'ellipse',
    'diamond',
    'triangle',
    'rightTriangle',
    'parallelogram',
    'trapezium',
    'pentagon',
    'hexagon',
  ],
  strokeStyle: ['dash', 'none', 'solid'],
  textAlign: ['center', 'left', 'right'],
  textResizing: [0, 1],
  textVerticalAlign: ['bottom', 'center', 'top'],
} as const satisfies Record<string, readonly (string | number)[]>;

/** An element's or block's id, and a key of the lists keyed by id. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const isId = (value: unknown) =>
  typeof value === 'string' && ID.test(value) && value !== '__proto__';

/** A Yjs plain value (Any), as stored: no `__proto__` key anywhere (Yjs's Any
 * decoder turns one into the object's prototype; a text format's value is JSON,
 * which keeps it as an own key), and no bytes (a Uint8Array) or bigint at any
 * depth, which Yjs can carry but the board never writes inside one (a stroke's
 * points are a binary value of their own, `strokePoints` below). */
function isPlain(value: unknown): boolean {
  switch (typeof value) {
    case 'undefined':
    case 'string':
    case 'number':
    case 'boolean':
      return true;
    case 'object':
      if (value === null) return true;
      if (Array.isArray(value))
        return (
          Object.getPrototypeOf(value) === Array.prototype &&
          value.every(isPlain)
        );
      return (
        Object.getPrototypeOf(value) === Object.prototype &&
        !Object.hasOwn(value, '__proto__') &&
        Object.values(value).every(isPlain)
      );
    default:
      return false;
  }
}

/** A key's value as the rules read it: plain, bytes, a text, a map, an array,
 * or anything else (another Yjs type, an embed), which never fits. */
type Stored =
  | { kind: 'plain'; value: unknown }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'text'; value: Y.Text }
  | { kind: 'map'; value: Y.Map<unknown> }
  | { kind: 'array'; value: Y.Array<unknown> }
  | { kind: 'other' };
const OTHER: Stored = { kind: 'other' };

function stored({ content }: Y.Item): Stored {
  // A run of values (a client's overwritten ones, which Yjs merges into one
  // struct while its history keeps them): the key holds the last; each is plain.
  if (content instanceof Y.ContentAny)
    return content.arr.every(isPlain)
      ? { kind: 'plain', value: content.arr.at(-1) }
      : OTHER;
  if (content instanceof Y.ContentBinary)
    return { kind: 'bytes', value: content.content };
  if (!(content instanceof Y.ContentType)) return OTHER;
  const { type } = content;
  if (type instanceof Y.XmlText) return OTHER;
  if (type instanceof Y.Text) return { kind: 'text', value: type };
  if (type instanceof Y.Map) return { kind: 'map', value: type };
  if (type instanceof Y.Array) return { kind: 'array', value: type };
  return OTHER;
}

/** A map's live entries as stored. */
function* entries(map: Y.Map<unknown>): Generator<[string, Stored]> {
  for (const [key, item] of map._map)
    if (!item.deleted) yield [key, stored(item)];
}

/** A key's plain value; undefined for anything else. */
function plainAt(map: Y.Map<unknown>, key: string): unknown {
  const item = map._map.get(key);
  if (!item || item.deleted) return;
  const value = stored(item);
  return value.kind === 'plain' ? value.value : undefined;
}

/** A rule for a key's stored value; `id` is its entity's key. */
type Rule = (value: Stored, id: string) => boolean;
/** A key's rule, whether it must be there, and whether it may hold `undefined`. */
type Field = { fits: Rule; required: boolean; unset: boolean };
const opt = (fits: Rule): Field => ({ fits, required: false, unset: true });
const req = (fits: Rule): Field => ({ fits, required: true, unset: false });
/** An entity's keys (any other one doesn't fit), and how many are required. */
type Table = {
  fields: Record<string, Field>;
  required: number;
  /** What the kind checks across its keys (a card's). */
  whole?: (map: Y.Map<unknown>) => boolean;
};
const table = (
  fields: Record<string, Field>,
  whole?: (map: Y.Map<unknown>) => boolean
): Table => ({
  fields,
  required: Object.values(fields).filter(({ required }) => required).length,
  whole,
});

/** Whether a stored map holds only its table's keys, each fitting, and every
 * required one: present and not undefined. */
function tableFits(map: Y.Map<unknown>, { fields, required }: Table, id = '') {
  let found = 0;
  for (const [key, value] of entries(map)) {
    if (!Object.hasOwn(fields, key)) return false;
    const field = fields[key];
    if (value.kind === 'plain' && value.value === undefined) {
      if (!field.unset) return false;
      continue;
    }
    if (!field.fits(value, id)) return false;
    if (field.required) found += 1;
  }
  return found === required;
}

// Plain values.
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string';
const isBoolean = (value: unknown) => typeof value === 'boolean';
const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const oneOf =
  (values: readonly unknown[]) =>
  (value: unknown): boolean =>
    values.includes(value);
const numbers = (length: number) => (value: unknown) =>
  Array.isArray(value) && value.length === length && value.every(finite);
const isPair = numbers(2);
const isBox = numbers(4);
const upTo =
  (max: number) =>
  (value: unknown): value is string =>
    isString(value) && value.length <= max;

/** `[x,y,w,h]`, as the board and its preview read a place. */
export function isPlace(xywh: unknown) {
  if (!isString(xywh)) return false;
  try {
    return isBox(JSON.parse(xywh));
  } catch {
    return false;
  }
}
/** A connector's end: on an element (by id) or at a point. */
const isConnection = (value: unknown) =>
  isObject(value) && (isString(value.id) || isPair(value.position));
const isShadow = (value: unknown) =>
  value === null ||
  (isObject(value) &&
    finite(value.blur) &&
    finite(value.offsetX) &&
    finite(value.offsetY) &&
    isColour(value.color));
const isLabelConstraints = (value: unknown) =>
  isObject(value) && isBoolean(value.hasMaxWidth) && finite(value.maxWidth);
const isLabelOffset = (value: unknown) =>
  isObject(value) &&
  finite(value.distance) &&
  (value.anchor === undefined || oneOf(ENUMS.labelAnchor)(value.anchor));
const isLabelStyle = (value: unknown) =>
  isObject(value) &&
  isColour(value.color) &&
  isString(value.fontFamily) &&
  finite(value.fontSize) &&
  oneOf(ENUMS.fontStyle)(value.fontStyle) &&
  oneOf(ENUMS.fontWeight)(value.fontWeight) &&
  oneOf(ENUMS.textAlign)(value.textAlign);
const isBooleans = (value: unknown) =>
  isObject(value) && Object.values(value).every(isBoolean);

// Stored values.
const plain =
  (fits: (value: unknown) => boolean): Rule =>
  (value) =>
    value.kind === 'plain' && fits(value.value);
const sameId: Rule = (value, id) =>
  value.kind === 'plain' && value.value === id;
/** A stroke's points: one binary value (`strokePoints.ts`). */
const strokePoints: Rule = (value) =>
  value.kind === 'bytes' && isStrokePoints(value.value);

/** Text content: string runs and formats whose values are plain (BlockSuite reads
 * each format through its schema and drops one that doesn't parse, so an object
 * such as a footnote's is fine), never an embed or a Yjs type. */
function textFits(text: Y.Text) {
  for (let item = text._start; item; item = item.right) {
    if (item.deleted) continue;
    const { content } = item;
    if (content instanceof Y.ContentString) continue;
    if (content instanceof Y.ContentFormat && isPlain(content.value)) continue;
    return false;
  }
  return true;
}
const text: Rule = (value) => value.kind === 'text' && textFits(value.value);

/** A map of id to entries, each as `fits` takes it. */
const mapOf =
  (fits: Rule): Rule =>
  (value) => {
    if (value.kind !== 'map') return false;
    for (const [key, entry] of entries(value.value))
      if (!(isId(key) && fits(entry, key))) return false;
    return true;
  };

/** A nested map holding only `fields`' keys (a note's). */
const nested = (fields: Record<string, Field>): Rule => {
  const rules = table(fields);
  return (value) => value.kind === 'map' && tableFits(value.value, rules);
};

/** A keyed list: a map of item id to the item and its order key (Epo 2026-11-16,
 * D10: a plane's elements; 2026-11-22: a chart's bars, labels and lines), up to
 * twice its `cap`, each item as `fits` takes it. */
const keyed = (cap: number, fits: (item: Fields) => boolean): Rule => {
  const entry = (value: Stored, id: string) =>
    value.kind === 'plain' &&
    isObject(value.value) &&
    isString(value.value.order) &&
    isObject(value.value.element) &&
    value.value.element.id === id &&
    fits(value.value.element);
  return (value) => {
    if (value.kind !== 'map') return false;
    let count = 0;
    for (const [key, item] of entries(value.value)) {
      count += 1;
      if (count > mergedCap(cap) || !isId(key) || !entry(item, key))
        return false;
    }
    return true;
  };
};

/** One of a plane's elements, of any kind a graph holds, checked as every graph's
 * (the graph model's one element check, Epo 2026-11-16). */
const planeElementFits = (element: Fields) =>
  graphElementSchema.safeParse(element).success;
const barFits = (bar: Fields) =>
  finite(bar.value) &&
  upTo(LABEL_LENGTH_MAX)(bar.label) &&
  (bar.fill === undefined || isColour(bar.fill));
const pieLabelFits = (label: Fields) =>
  upTo(LABEL_LENGTH_MAX)(label.text) &&
  finite(label.angle) &&
  finite(label.reach) &&
  isTextSize(label.size);
/** A pie line, with the fill of the slice it starts. */
const spokeFits = (spoke: Fields) =>
  finite(spoke.angle) && (spoke.fill === undefined || isColour(spoke.fill));

const colour = plain(isColour);
const number = plain(finite);
const boolean = plain(isBoolean);
const string = plain(isString);
const place = plain(isPlace);
const enumOf = (values: readonly unknown[]) => plain(oneOf(values));
const positive = plain((value) => finite(value) && value > 0);

/** Every element's keys: its type (which picks its table) and its id (its key). */
const ELEMENT = {
  comments: opt(plain(isBooleans)),
  hidden: opt(boolean),
  id: req(sameId),
  index: opt(string),
  lockedBySelf: opt(boolean),
  seed: opt(number),
  type: req(string),
};
const element = (fields: Record<string, Field>) =>
  table({ ...ELEMENT, ...fields });
const STROKE = element({
  color: opt(colour),
  lineWidth: opt(number),
  // A stroke always has its points: the model reads them on every frame.
  points: req(strokePoints),
  rotate: opt(number),
  xywh: req(place),
});

/** Each canvas element type's stored keys (BlockSuite's `@field`s, ours on the
 * cards). A connector's place comes from its ends, and a group's and a mind map's
 * from what they hold, so they store none. */
const ELEMENTS: Record<string, Table> = {
  brush: STROKE,
  chart: element({
    axisMax: req(
      plain((value) => finite(value) && value > 0 && value <= AXIS_MAX)
    ),
    axisStep: req(positive),
    bars: req(keyed(BARS_MAX, barFits)),
    kind: req(enumOf(['bar', 'pie'])),
    labels: req(keyed(LABELS_MAX, pieLabelFits)),
    rotate: opt(number),
    spokes: req(keyed(SPOKES_MAX, spokeFits)),
    xywh: req(place),
  }),
  connector: element({
    frontEndpointStyle: opt(enumOf(ENUMS.pointStyle)),
    labelConstraints: opt(plain(isLabelConstraints)),
    labelDisplay: opt(boolean),
    labelOffset: opt(plain(isLabelOffset)),
    labelStyle: opt(plain(isLabelStyle)),
    labelXYWH: opt(plain(isBox)),
    mode: req(enumOf(ENUMS.connectorMode)),
    rearEndpointStyle: opt(enumOf(ENUMS.pointStyle)),
    rough: opt(boolean),
    roughness: opt(number),
    source: req(plain(isConnection)),
    stroke: opt(colour),
    strokeStyle: opt(enumOf(ENUMS.strokeStyle)),
    strokeWidth: opt(number),
    target: req(plain(isConnection)),
    text: opt(text),
  }),
  formula: element({
    latex: req(plain(upTo(LATEX_MAX))),
    rotate: opt(number),
    xywh: req(place),
  }),
  group: element({
    children: req(mapOf(plain((value) => value === true))),
    title: req(text),
  }),
  highlighter: STROKE,
  mindmap: element({
    children: req(
      mapOf(
        plain(
          (node) =>
            isObject(node) &&
            isString(node.index) &&
            (node.parent === undefined || isString(node.parent)) &&
            (node.collapsed === undefined || isBoolean(node.collapsed))
        )
      )
    ),
    layoutType: req(enumOf(ENUMS.layoutType)),
    style: req(enumOf(ENUMS.mindmapStyle)),
  }),
  plane: element({
    elements: req(keyed(ELEMENTS_MAX, planeElementFits)),
    fit: opt(boolean),
    polar: opt(boolean),
    ppu: req(positive),
    rotate: opt(number),
    x0: req(number),
    xywh: req(place),
    y0: req(number),
  }),
  shape: element({
    color: opt(colour),
    fillColor: opt(colour),
    filled: opt(boolean),
    fontFamily: opt(string),
    fontSize: opt(number),
    fontStyle: opt(enumOf(ENUMS.fontStyle)),
    fontWeight: opt(enumOf(ENUMS.fontWeight)),
    maxWidth: opt(plain((value) => value === false || finite(value))),
    padding: opt(plain(isPair)),
    radius: opt(number),
    rotate: opt(number),
    roughness: opt(number),
    shadow: opt(plain(isShadow)),
    shapeStyle: opt(enumOf(ENUMS.shapeStyle)),
    // The renderer and the hit test pick by it; BlockSuite always stores it.
    shapeType: req(enumOf(ENUMS.shapeType)),
    strokeColor: opt(colour),
    strokeStyle: opt(enumOf(ENUMS.strokeStyle)),
    strokeWidth: opt(number),
    text: opt(text),
    textAlign: opt(enumOf(ENUMS.textAlign)),
    textHorizontalAlign: opt(enumOf(ENUMS.textAlign)),
    textResizing: opt(enumOf(ENUMS.textResizing)),
    textVerticalAlign: opt(enumOf(ENUMS.textVerticalAlign)),
    xywh: req(place),
  }),
  text: element({
    color: opt(colour),
    fontFamily: opt(string),
    fontSize: opt(number),
    fontStyle: opt(enumOf(ENUMS.fontStyle)),
    fontWeight: opt(enumOf(ENUMS.fontWeight)),
    hasMaxWidth: opt(boolean),
    rotate: opt(number),
    text: req(text),
    textAlign: opt(enumOf(ENUMS.textAlign)),
    xywh: req(place),
  }),
};

/** A stored canvas element under its key `id`, as the board's rules take it: a
 * type the board holds, and only that type's keys, each within its limits. */
export function elementFits(
  id: string,
  element: Y.Map<unknown>,
  board: BoardKind
) {
  const type = plainAt(element, 'type');
  return (
    isString(type) &&
    holds(board).elements.has(type) &&
    Object.hasOwn(ELEMENTS, type) &&
    isId(id) &&
    tableFits(element, ELEMENTS[type], id)
  );
}

/** A picture: an emoji by its code points, or a GIF by its KLIPY link. */
function pictureFits(props: Fields) {
  const { kind, label, ref } = props;
  return (
    upTo(BOARD_CATALOG.limits.PICTURE_REF_MAX)(ref) &&
    upTo(BOARD_CATALOG.limits.PICTURE_LABEL_MAX)(label) &&
    ((kind === 'emoji' && isListedEmoji(ref)) ||
      (kind === 'klipy' && isKlipyMedia(ref)))
  );
}

/** A link card: a web address, and a YouTube video's id when it is one. */
function linkFits(props: Fields) {
  const { url, videoId } = props;
  return (
    upTo(BOARD_CATALOG.limits.LINK_URL_MAX)(url) &&
    isWebAddress(url) &&
    isString(videoId) &&
    (videoId === '' || YOUTUBE_ID.test(videoId))
  );
}

/** A material card: a workspace quiz or set by id, with its title. */
function materialFits(props: Fields) {
  const { kind, materialId, title } = props;
  return (
    (kind === 'quiz' || kind === 'flashcards') &&
    isString(materialId) &&
    materialId.length > 0 &&
    materialId.length <= BOARD_CATALOG.limits.MATERIAL_ID_MAX &&
    upTo(BOARD_CATALOG.limits.CARD_TITLE_MAX)(title)
  );
}

/** Each capy card's own props, which its renderer reads together. */
const CARDS = {
  'affine:embed-capy-link': { fits: linkFits, keys: ['url', 'videoId'] },
  'affine:embed-capy-material': {
    fits: materialFits,
    keys: ['kind', 'materialId', 'title'],
  },
  'affine:embed-capy-picture': {
    fits: pictureFits,
    keys: ['kind', 'label', 'ref'],
  },
} as const;
type CardFlavour = keyof typeof CARDS;
const isCard = (flavour: string): flavour is CardFlavour =>
  Object.hasOwn(CARDS, flavour);

/** A capy card's own props (no `prop:` prefix) as its renderer expects them, with a
 * place and a turn: the paste of the workspace canvas's copied cards asks this of
 * a clipboard's plain props. */
export function embedFits(flavour: string, props: Fields) {
  return (
    isCard(flavour) &&
    CARDS[flavour].fits(props) &&
    finite(props.rotate) &&
    isPlace(props.xywh)
  );
}

/** Props whose BlockSuite default is `undefined`. Loading fills only an absent
 * prop, so any other prop holding `undefined` stays so, and is no value. */
const UNSET_PROPS = new Set([
  'comments',
  'meta:createdAt',
  'meta:createdBy',
  'meta:updatedAt',
  'meta:updatedBy',
  'textAlign',
]);
/** Every block's keys, and its props (`prop:` + the name). */
const block = (
  props: Record<string, Field>,
  whole?: (map: Y.Map<unknown>) => boolean
) =>
  table(
    {
      'sys:children': req(
        (value) => value.kind === 'array' && childIds(value.value)
      ),
      'sys:flavour': req(string),
      'sys:id': opt(sameId),
      'sys:version': opt(number),
      ...Object.fromEntries(
        Object.entries(props).map(([key, field]) => [
          `prop:${key}`,
          { ...field, unset: UNSET_PROPS.has(key) },
        ])
      ),
    },
    whole
  );
/** A block's children: ids, each a plain value. */
function childIds(array: Y.Array<unknown>) {
  for (let item = array._start; item; item = item.right) {
    if (item.deleted) continue;
    if (!(item.content instanceof Y.ContentAny)) return false;
    if (!item.content.arr.every(isId)) return false;
  }
  return true;
}
const comments = opt(mapOf(boolean));
/** Who wrote a paragraph, list or image and when, which their schemas declare. */
const META = {
  'meta:createdAt': opt(number),
  'meta:createdBy': opt(string),
  'meta:updatedAt': opt(number),
  'meta:updatedBy': opt(string),
};
/** A card's place and order. */
const CARD = {
  index: opt(string),
  lockedBySelf: opt(boolean),
  rotate: req(number),
  xywh: req(place),
};
const card = (flavour: CardFlavour) => {
  const { fits, keys } = CARDS[flavour];
  return block(
    {
      ...CARD,
      ...Object.fromEntries(keys.map((key) => [key, req(string)])),
    },
    (map) =>
      fits(
        Object.fromEntries(
          keys.map((key) => [key, plainAt(map, `prop:${key}`)])
        )
      )
  );
};
const NOTE_COLOURS = ['dark', 'light', 'normal'];
/** A note's background: a colour, or a map of its colours' strings that is one
 * by the same rule. */
const background: Rule = (value, id) => {
  if (colour(value, id)) return true;
  if (value.kind !== 'map') return false;
  const held: Record<string, string> = {};
  for (const [key, entry] of entries(value.value)) {
    if (!(NOTE_COLOURS.includes(key) && entry.kind === 'plain')) return false;
    if (!isString(entry.value)) return false;
    held[key] = entry.value;
  }
  return isColour(held);
};

/** Each flavour's stored keys. Loading writes a missing default prop, so props
 * may be absent unless a card's renderer needs them (`undefined` only as
 * `UNSET_PROPS` says). */
const BLOCKS: Record<string, Table> = {
  'affine:embed-capy-link': card('affine:embed-capy-link'),
  'affine:embed-capy-material': card('affine:embed-capy-material'),
  'affine:embed-capy-picture': card('affine:embed-capy-picture'),
  'affine:image': block({
    ...META,
    caption: opt(string),
    comments,
    height: opt(number),
    index: opt(string),
    lockedBySelf: opt(boolean),
    rotate: opt(number),
    size: opt(number),
    sourceId: opt(string),
    textAlign: opt(enumOf(ENUMS.textAlign)),
    width: opt(number),
    xywh: opt(place),
  }),
  'affine:list': block({
    ...META,
    checked: opt(boolean),
    collapsed: opt(boolean),
    comments,
    order: opt(plain((value) => value === null || finite(value))),
    text: opt(text),
    textAlign: opt(enumOf(ENUMS.textAlign)),
    type: opt(enumOf(ENUMS.listType)),
  }),
  'affine:note': block({
    background: opt(background),
    comments,
    displayMode: opt(enumOf(ENUMS.noteDisplayMode)),
    edgeless: opt(
      nested({
        collapse: opt(boolean),
        collapsedHeight: opt(number),
        scale: opt(number),
        style: req(
          nested({
            borderRadius: opt(number),
            borderSize: opt(number),
            borderStyle: opt(enumOf(ENUMS.strokeStyle)),
            shadowType: opt(enumOf(ENUMS.noteShadow)),
          })
        ),
      })
    ),
    hidden: opt(boolean),
    index: opt(string),
    lockedBySelf: opt(boolean),
    rotate: opt(number),
    xywh: req(place),
  }),
  'affine:page': block({ title: opt(text) }),
  'affine:paragraph': block({
    ...META,
    collapsed: opt(boolean),
    comments,
    text: opt(text),
    textAlign: opt(enumOf(ENUMS.textAlign)),
    type: opt(enumOf(ENUMS.paragraphType)),
  }),
  // The canvas's holder: BlockSuite's boxed map of element id to element.
  'affine:surface': block({
    elements: req((value) => {
      if (value.kind !== 'map') return false;
      const keys = [...entries(value.value)];
      return (
        keys.length === 2 &&
        keys.every(([key, entry]) =>
          key === 'type'
            ? entry.kind === 'plain' &&
              entry.value === '$blocksuite:internal:native$'
            : key === 'value' && entry.kind === 'map'
        )
      );
    }),
  }),
};

/** The props the board catalog gives only some boards' blocks (its `props`), each
 * value's rule. */
const BOARD_PROPS: Record<(typeof BOARD_CATALOG.props)[number]['name'], Field> =
  {
    // A question's answer area's top left, [x, y] (boardArea.ts).
    area: opt(plain(isPair)),
  };

const tables = new Map<BoardKind, Record<string, Table>>();
/** Each flavour's keys on `board`: its own, and the props the catalog gives it
 * there. */
function blockTables(board: BoardKind) {
  let found = tables.get(board);
  if (found) return found;
  found = { ...BLOCKS };
  for (const { boards, flavour, name } of BOARD_CATALOG.props) {
    if (!(boards as readonly string[]).includes(board)) continue;
    const { fields, whole } = found[flavour];
    found[flavour] = table(
      { ...fields, [`prop:${name}`]: BOARD_PROPS[name] },
      whole
    );
  }
  tables.set(board, found);
  return found;
}

/** Whether a flavour's blocks take BlockSuite's lock (`lockedBySelf`): the ones
 * that stand on the canvas. */
export const takesLock = (flavour: string) =>
  Object.hasOwn(BLOCKS, flavour) &&
  Object.hasOwn(BLOCKS[flavour].fields, 'prop:lockedBySelf');

/** A stored block under its key `id`, as the board's rules take it, one block at
 * a time (where it sits is `childFits`'): a flavour the board holds, and only that
 * flavour's keys on this board, each within its limits. */
export function blockFits(id: string, block: Y.Map<unknown>, board: BoardKind) {
  const flavour = plainAt(block, 'sys:flavour');
  const rules = blockTables(board);
  if (
    !(
      isString(flavour) &&
      holds(board).parents.has(flavour) &&
      Object.hasOwn(rules, flavour) &&
      isId(id)
    )
  )
    return false;
  const own = rules[flavour];
  return tableFits(block, own, id) && (own.whole?.(block) ?? true);
}

/** Whether `child` may sit under `parent`: its flavour lists the parent's. */
export function childFits(
  parent: Y.Map<unknown>,
  child: Y.Map<unknown>,
  board: BoardKind
) {
  const above = plainAt(parent, 'sys:flavour');
  const flavour = plainAt(child, 'sys:flavour');
  return (
    isString(above) &&
    isString(flavour) &&
    (holds(board).parents.get(flavour)?.includes(above) ?? false)
  );
}
