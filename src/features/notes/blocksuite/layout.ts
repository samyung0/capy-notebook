import * as Y from 'yjs';
import type {
  MaterialElement,
  MaterialNode,
  MaterialText,
  MaterialValue,
} from '@/features/materials/document';

/**
 * The blocks layout of a note room (todo-blocksuite-layout.md): Plate material
 * JSON to BlockSuite's flat `blocks` map and back. Plain `yjs`, no BlockSuite
 * import, and the same layout the Rust `blocks` crate writes.
 *
 * Both directions go through a JSON form of the map, `BlocksJson` (the shared
 * goldens' `blocks`): block id → `{flavour, version, children, props}`, with a
 * `Y.Text` as its delta array and dotted flat-data keys as they are stored.
 */

export const BLOCKS_ROOT = 'blocks';
export const ROOT_ID = 'root';
export const NOTE_ID = 'note';

export type Delta = Array<{
  attributes?: Record<string, unknown>;
  insert: string;
}>;

export interface BlockJson {
  children: string[];
  flavour: string;
  props: Record<string, unknown>;
  version: number;
}

export type BlocksJson = Record<string, BlockJson>;

/** Every flavour the layout writes, with its schema `version`. */
const VERSIONS: Record<string, number> = {
  'affine:callout': 1,
  'affine:code': 1,
  'affine:divider': 1,
  'affine:image': 1,
  'affine:latex': 1,
  'affine:list': 1,
  'affine:note': 1,
  'affine:page': 2,
  'affine:paragraph': 1,
  'affine:table': 1,
  'capy:audio': 1,
  'capy:chart': 1,
  'capy:column': 1,
  'capy:columns': 1,
  'capy:graph': 1,
  'capy:html-embed': 1,
  'capy:material-ref': 1,
  'capy:mermaid': 1,
  'capy:plot': 1,
  'capy:toc': 1,
  'capy:video': 1,
};
export const FLAVOURS: ReadonlySet<string> = /* @__PURE__ */ new Set(
  Object.keys(VERSIONS)
);

/** `NoteDisplayMode.DocOnly`: the note shows in the page, never on a canvas. */
const DOC_ONLY = 'doc';

/** Each flavour's non-undefined schema defaults (the `props:` of its
 * `affine/model` schema), written at seed because BlockSuite writes any
 * missing one on load (`sync-controller.ts:309-317`). Texts are empty
 * deltas. The table is flat data, whose empty defaults hold no leaf. */
function schemaDefaults(flavour: string): Record<string, unknown> {
  switch (flavour) {
    case 'affine:page':
      return { title: [] };
    case 'affine:note':
      return {
        background: { dark: '#252525', light: '#ffffff' },
        displayMode: DOC_ONLY,
        edgeless: {
          style: {
            borderRadius: 8,
            borderSize: 4,
            borderStyle: 'none',
            shadowType: '--affine-note-shadow-box',
          },
        },
        hidden: false,
        index: 'a0',
        lockedBySelf: false,
        xywh: '[0,0,498,92]',
      };
    case 'affine:paragraph':
      return { collapsed: false, text: [], type: 'text' };
    case 'affine:list':
      return {
        checked: false,
        collapsed: false,
        order: null,
        text: [],
        type: 'bulleted',
      };
    case 'affine:code':
      return { caption: '', language: null, text: [], wrap: false };
    case 'affine:image':
      return {
        caption: '',
        height: 0,
        index: 'a0',
        lockedBySelf: false,
        rotate: 0,
        size: -1,
        sourceId: '',
        width: 0,
        xywh: '[0,0,0,0]',
      };
    case 'affine:latex':
      return {
        index: 'a0',
        latex: '',
        lockedBySelf: false,
        rotate: 0,
        scale: 1,
        xywh: '[0,0,16,16]',
      };
    case 'affine:callout':
      return {
        backgroundColorName: 'grey',
        icon: { type: 'emoji', unicode: '💡' },
        text: [],
      };
    default:
      return {};
  }
}

const TEXT_PROPS: Record<string, readonly string[]> = {
  'affine:callout': ['text'],
  'affine:code': ['text'],
  'affine:list': ['text'],
  'affine:page': ['title'],
  'affine:paragraph': ['text'],
  'capy:mermaid': ['source', 'caption'],
};

function isTextProp(flavour: string, key: string) {
  if (flavour === 'affine:table')
    return key.startsWith('cells.') && key.endsWith('.text');
  return TEXT_PROPS[flavour]?.includes(key) ?? false;
}

/** Blocks a following deeper block nests under (Tab in BlockSuite). */
const HOLDERS = /* @__PURE__ */ new Set(['affine:paragraph', 'affine:list']);

// Plate mark ↔ Y.Text attribute; `ai` and `comment*` marks are never written
// and any other mark is refused.
const MARK_ATTRIBUTE: Record<string, string> = {
  backgroundColor: 'background',
  bold: 'bold',
  code: 'code',
  color: 'color',
  fontFamily: 'fontFamily',
  fontSize: 'fontSize',
  highlight: 'highlight',
  italic: 'italic',
  kbd: 'kbd',
  strikethrough: 'strike',
  subscript: 'subscript',
  superscript: 'superscript',
  underline: 'underline',
};
const ATTRIBUTE_MARK = /* @__PURE__ */ Object.fromEntries(
  Object.entries(MARK_ATTRIBUTE).map(([mark, attribute]) => [attribute, mark])
);

const LIST_STYLE: Record<string, string> = {
  bulleted: 'disc',
  numbered: 'decimal',
  todo: 'todo',
};

const NUMBERED_STYLE = /(-alpha|-roman)$|^decimal-/;
const HEADING = /^h[1-6]$/;

function listType(style: string) {
  if (style === 'disc') return 'bulleted';
  if (style === 'decimal') return 'numbered';
  if (style === 'todo') return 'todo';
  return NUMBERED_STYLE.test(style) ? 'numbered' : 'bulleted';
}

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

/** Flavours whose schema parent is only `affine:note`: always at the top
 * level, whatever their indent. */
const NOTE_ONLY = /* @__PURE__ */ new Set([
  'affine:table',
  'capy:chart',
  'capy:columns',
  'capy:graph',
  'capy:html-embed',
  'capy:material-ref',
  'capy:plot',
]);

/** Keys every block may carry: list keys a non-list block drops (N2), the
 * indent (nesting) and `textIndent` (N5). Any other key is refused. */
const BLOCK_KEYS = [
  'id',
  'type',
  'children',
  'indent',
  'listStyleType',
  'checked',
  'listStart',
  'listRestart',
  'listRestartPolite',
  'textIndent',
];
const OWN_KEYS = ['id', 'type', 'children'];

type Json = Record<string, unknown>;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!(a && b && typeof a === 'object' && typeof b === 'object')) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => deepEqual((a as Json)[key], (b as Json)[key]));
}

/** `fractional-indexing`'s keys from `generateNKeysBetween(null, null, n)`:
 * `a0`…`az`, `b00`…`bzz`, `c000`… */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export function orderKey(index: number) {
  let rest = index;
  let length = 1;
  let span = DIGITS.length;
  while (rest >= span) {
    rest -= span;
    length += 1;
    span *= DIGITS.length;
  }
  let digits = '';
  for (let i = 0; i < length; i++) {
    digits = DIGITS[rest % DIGITS.length] + digits;
    rest = Math.floor(rest / DIGITS.length);
  }
  return String.fromCharCode('a'.charCodeAt(0) + length - 1) + digits;
}

// ---------------------------------------------------------------------------
// Plate value → BlocksJson

function refuse(type: string, reason: string): never {
  throw new Error(`Cannot convert ${type}: ${reason}`);
}

function isObject(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function object(node: unknown, type: string): Json {
  if (!isObject(node)) refuse(type, 'not an object');
  return node;
}

function isLeaf(node: Json) {
  return 'text' in node && !('type' in node);
}

function typeOf(node: Json): string {
  return str(node.type) ?? refuse('node', 'no type');
}

function childrenOf(node: Json): unknown[] {
  return Array.isArray(node.children) ? node.children : [];
}

function keys(node: Json, type: string, base: string[], extra: string[] = []) {
  for (const key of Object.keys(node))
    if (!(base.includes(key) || extra.includes(key)))
      refuse(type, `unsupported key ${key}`);
}

/** Elements never written to the blocks layout. */
const isTransient = (type: string) =>
  type === 'mention_input' || type === 'slash_input' || type === 'placeholder';

/** Adjacent inserts with equal attributes merged and empty ones dropped, as
 * `Y.Text.toDelta()` reads them. */
export function normalizeDelta(delta: Delta): Delta {
  const out: Delta = [];
  for (const op of delta) {
    if (!op.insert) continue;
    const attributes =
      op.attributes && Object.keys(op.attributes).length
        ? op.attributes
        : undefined;
    const last = out.at(-1);
    if (last && deepEqual(last.attributes, attributes)) {
      last.insert += op.insert;
      continue;
    }
    out.push(
      attributes ? { attributes, insert: op.insert } : { insert: op.insert }
    );
  }
  return out;
}

function leaf(node: Json, attributes: Json = {}) {
  for (const [key, value] of Object.entries(node)) {
    if (key === 'text' || key === 'ai' || key.startsWith('comment')) continue;
    const attribute = MARK_ATTRIBUTE[key] ?? refuse('text', `mark ${key}`);
    attributes[attribute] = value;
  }
  return { attributes, insert: str(node.text) ?? '' };
}

/** A text block's children (leaves and inline elements) as Y.Text runs. */
function inline(nodes: unknown[]): Delta {
  const runs: Delta = [];
  for (const child of nodes) {
    const node = object(child, 'inline');
    if (isLeaf(node)) {
      runs.push(leaf(node));
      continue;
    }
    const type = typeOf(node);
    if (type === 'a') {
      keys(node, type, [...OWN_KEYS, 'url', 'target']);
      for (const text of childrenOf(node)) {
        const linked = object(text, type);
        if (!isLeaf(linked)) refuse(type, 'holds an element');
        runs.push(leaf(linked, { link: node.url ?? null }));
      }
    } else if (type === 'inline_equation') {
      keys(node, type, [...OWN_KEYS, 'texExpression']);
      runs.push({
        attributes: { latex: node.texExpression ?? '' },
        insert: ' ',
      });
    } else if (type === 'mention') {
      keys(node, type, [...OWN_KEYS, 'key', 'value']);
      const mention: Json = {};
      if ('key' in node) mention.member = node.key;
      if ('value' in node) mention.name = node.value;
      runs.push({ attributes: { mention }, insert: ' ' });
    } else if (!isTransient(type)) {
      refuse(type, 'not an inline element');
    }
  }
  return normalizeDelta(runs);
}

/** Texts joined with "\n" (N3, N6, code lines). */
function join(parts: Delta[]): Delta {
  return normalizeDelta(
    parts.flatMap((part, index) => (index ? [{ insert: '\n' }, ...part] : part))
  );
}

const TEXT_BLOCK = /^(p|h[1-6])$/;

/** A blockquote's paragraphs, nested quotes included, in order (N3). */
function quoteParts(nodes: unknown[], parts: Delta[]) {
  for (const child of nodes) {
    const node = object(child, 'blockquote');
    if (isLeaf(node)) {
      parts.push(inline([node]));
      continue;
    }
    const type = typeOf(node);
    if (type === 'blockquote') {
      keys(node, type, BLOCK_KEYS, ['align']);
      quoteParts(childrenOf(node), parts);
    } else if (TEXT_BLOCK.test(type)) {
      keys(node, type, BLOCK_KEYS, ['align']);
      parts.push(inline(childrenOf(node)));
    } else if (
      type === 'a' ||
      type === 'mention' ||
      type === 'inline_equation'
    ) {
      parts.push(inline([node]));
    } else {
      refuse('blockquote', `holds a ${type}`);
    }
  }
}

/** The plain text of a media caption (`[{text}]`, a paragraph list or a
 * string): leaves concatenated, paragraphs joined with "\n". */
function captionText(caption: unknown): string | undefined {
  const text = (node: unknown): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(text).join('');
    if (isObject(node))
      return typeof node.text === 'string' && !('type' in node)
        ? node.text
        : text(node.children);
    return '';
  };
  if (caption === undefined || caption === null) return;
  if (typeof caption === 'string') return caption;
  if (!Array.isArray(caption)) refuse('caption', 'not text');
  return caption.every((node) => !(isObject(node) && 'type' in node))
    ? text(caption)
    : caption.map(text).join('\n');
}

function textAlign(node: Json, type: string): string | undefined {
  if (node.align === undefined) return;
  switch (node.align) {
    case 'left':
    case 'start':
      return 'left';
    case 'center':
      return 'center';
    case 'right':
    case 'end':
      return 'right';
    case 'justify':
      return 'justify';
    default:
      return refuse(type, 'unsupported align');
  }
}

type Kind = 'note' | 'callout' | 'column';

class Writer {
  readonly blocks: BlocksJson = {};
  /** Block ids taken so far (`root` and `note` included). */
  private readonly used = new Set([ROOT_ID, NOTE_ID]);

  /** A Plate id when it is a non-empty string not used before; otherwise
   * `<parent id>-b<index>`. */
  blockId(id: unknown, parent: string, index: number) {
    if (typeof id === 'string' && id && !this.used.has(id)) {
      this.used.add(id);
      return id;
    }
    return unique(this.used, `${parent}-b${index}`);
  }

  add(id: string, flavour: string) {
    const block: BlockJson = {
      children: [],
      flavour,
      props: schemaDefaults(flavour),
      version: VERSIONS[flavour],
    };
    this.blocks[id] = block;
    return block;
  }

  /** A container's Plate children as nested blocks: a list's target depth is
   * `indent - 1`, any other block's `indent`, clamped to one below the
   * deepest open paragraph or list (N1). Returns the container's children. */
  place(nodes: unknown[], parent: string, kind: Kind): string[] {
    const out: string[] = [];
    // stack[d] is the open paragraph or list at depth d.
    const stack: string[] = [];
    const attach = (id: string) =>
      (stack.length ? this.blocks[stack.at(-1) as string].children : out).push(
        id
      );
    nodes.forEach((child, index) => {
      const node = object(child, 'node');
      if (isLeaf(node)) {
        // The placeholder leaf of an empty value or element.
        if (node.text === '') return;
        refuse('text', 'a text leaf among blocks');
      }
      const type = typeOf(node);
      if (isTransient(type)) return;
      const { id, target } = this.block(node, type, parent, index);
      const { flavour } = this.blocks[id];
      const noteOnly = NOTE_ONLY.has(flavour);
      if (kind !== 'note' && noteOnly) refuse(type, 'only at the top level');
      if (kind === 'callout' && !HOLDERS.has(flavour))
        refuse(type, 'not a text block in a callout');
      const depth = noteOnly ? 0 : Math.min(target, stack.length);
      while (stack.length > depth) attach(stack.pop() as string);
      if (HOLDERS.has(flavour)) stack.push(id);
      else attach(id);
    });
    while (stack.length) attach(stack.pop() as string);
    return out;
  }

  /** Writes one Plate block and its contents; returns its id and target
   * depth. */
  block(node: Json, type: string, parent: string, index: number) {
    const id = this.blockId(node.id, parent, index);
    const indent = node.indent;
    const depth =
      typeof indent === 'number' && Number.isInteger(indent) && indent > 0
        ? indent
        : 0;
    const write = (flavour: string) => this.add(id, flavour).props;
    /** Copies `key` into prop `to` when present. */
    const copy = (props: Json, key: string, to = key) => {
      if (node[key] !== undefined) props[to] = node[key];
    };
    const caption = (props: Json) => {
      const text = captionText(node.caption);
      if (text !== undefined) props.caption = text;
    };
    const align = (props: Json) => {
      const value = textAlign(node, type);
      if (value) props.textAlign = value;
    };
    if (TEXT_BLOCK.test(type)) {
      keys(node, type, BLOCK_KEYS, ['align']);
      const text = inline(childrenOf(node));
      const style = str(node.listStyleType);
      // N2: only a paragraph is a list item.
      if (style !== undefined && type === 'p') {
        const list = listType(style);
        const props = write('affine:list');
        props.type = list;
        props.text = text;
        if (list === 'todo')
          props.checked =
            typeof node.checked === 'boolean' ? node.checked : false;
        const order = [
          node.listRestart,
          node.listRestartPolite,
          node.listStart,
        ].find((value) => typeof value === 'number');
        if (order !== undefined) props.order = order;
        props.listStyleType = style;
        align(props);
        return { id, target: Math.max(0, depth - 1) };
      }
      const props = write('affine:paragraph');
      props.type = type === 'p' ? 'text' : type;
      props.text = text;
      align(props);
      return { id, target: depth };
    }
    switch (type) {
      case 'blockquote': {
        keys(node, type, BLOCK_KEYS, ['align']);
        const parts: Delta[] = [];
        quoteParts(childrenOf(node), parts);
        const props = write('affine:paragraph');
        props.type = 'quote';
        props.text = join(parts);
        align(props);
        break;
      }
      case 'code_block': {
        keys(node, type, BLOCK_KEYS, ['lang']);
        const lines = childrenOf(node).map((child) => {
          const line = object(child, 'code_line');
          if (typeOf(line) !== 'code_line')
            refuse(type, 'a child that is not a code_line');
          keys(line, 'code_line', OWN_KEYS);
          return inline(childrenOf(line));
        });
        const props = write('affine:code');
        props.text = join(lines);
        copy(props, 'lang', 'language');
        break;
      }
      case 'hr':
        keys(node, type, BLOCK_KEYS);
        write('affine:divider');
        break;
      case 'toc':
        keys(node, type, BLOCK_KEYS);
        write('capy:toc');
        break;
      case 'callout': {
        keys(node, type, BLOCK_KEYS, ['variant']);
        const block = this.add(id, 'affine:callout');
        copy(block.props, 'variant');
        block.children = this.place(childrenOf(node), id, 'callout');
        break;
      }
      case 'equation':
        keys(node, type, BLOCK_KEYS, ['texExpression']);
        copy(write('affine:latex'), 'texExpression', 'latex');
        break;
      case 'img': {
        keys(node, type, BLOCK_KEYS, [
          'assetId',
          'sizeBytes',
          'caption',
          'align',
          'width',
          'name',
          'contentType',
        ]);
        const props = write('affine:image');
        copy(props, 'assetId', 'sourceId');
        copy(props, 'sizeBytes', 'size');
        caption(props);
        align(props);
        copy(props, 'width', 'widthPercent');
        copy(props, 'name');
        copy(props, 'contentType');
        break;
      }
      case 'audio': {
        keys(node, type, BLOCK_KEYS, [
          'assetId',
          'name',
          'contentType',
          'sizeBytes',
          'caption',
        ]);
        const props = write('capy:audio');
        for (const key of ['assetId', 'name', 'contentType', 'sizeBytes'])
          copy(props, key);
        caption(props);
        break;
      }
      case 'video': {
        keys(node, type, BLOCK_KEYS, [
          'provider',
          'videoId',
          'width',
          'caption',
        ]);
        const props = write('capy:video');
        for (const key of ['provider', 'videoId', 'width']) copy(props, key);
        caption(props);
        break;
      }
      case 'chart':
      case 'plot':
      case 'graph': {
        keys(node, type, BLOCK_KEYS, ['block', 'width']);
        if (!isObject(node.block)) refuse(type, 'block must be an object');
        const props = write(`capy:${type}`);
        copy(props, 'block');
        copy(props, 'width');
        break;
      }
      case 'html_embed': {
        keys(node, type, BLOCK_KEYS, ['html', 'caption']);
        const props = write('capy:html-embed');
        copy(props, 'html');
        copy(props, 'caption');
        break;
      }
      case 'mermaid': {
        keys(node, type, BLOCK_KEYS, ['source', 'theme', 'width']);
        const props = write('capy:mermaid');
        props.source = normalizeDelta([{ insert: str(node.source) ?? '' }]);
        let caption: Delta = [];
        for (const child of childrenOf(node)) {
          const element = object(child, 'mermaid_caption');
          if (isLeaf(element) && element.text === '') continue;
          if (typeOf(element) !== 'mermaid_caption')
            refuse(type, 'a child that is not a mermaid_caption');
          keys(element, 'mermaid_caption', OWN_KEYS);
          caption = inline(childrenOf(element));
        }
        props.caption = caption;
        copy(props, 'width');
        copy(props, 'theme');
        break;
      }
      case 'material_ref': {
        keys(node, type, BLOCK_KEYS, ['materialId', 'refKind', 'pending']);
        // An imported fence body no stored document holds; null is absent.
        if (node.pending !== undefined && node.pending !== null)
          refuse(type, 'holds a pending import');
        const props = write('capy:material-ref');
        copy(props, 'materialId');
        copy(props, 'refKind');
        break;
      }
      case 'column_group': {
        keys(node, type, BLOCK_KEYS);
        const group = this.add(id, 'capy:columns');
        childrenOf(node).forEach((child, columnIndex) => {
          const column = object(child, 'column');
          if (typeOf(column) !== 'column')
            refuse(type, 'a child that is not a column');
          keys(column, 'column', [...OWN_KEYS, 'width']);
          const columnId = this.blockId(column.id, id, columnIndex);
          const block = this.add(columnId, 'capy:column');
          if (column.width !== undefined) block.props.width = column.width;
          block.children = this.place(childrenOf(column), columnId, 'column');
          group.children.push(columnId);
        });
        break;
      }
      case 'table':
        keys(node, type, BLOCK_KEYS, ['colSizes', 'marginLeft']);
        Object.assign(write('affine:table'), tableProps(id, node));
        break;
      default:
        refuse(type, 'unsupported element type');
    }
    return { id, target: depth };
  }
}

function unique(used: Set<string>, base: string) {
  let candidate = base;
  for (let n = 2; used.has(candidate); n++) candidate = `${base}-${n}`;
  used.add(candidate);
  return candidate;
}

const SPAN_KEYS = [
  ...OWN_KEYS,
  'colSpan',
  'rowSpan',
  'attributes',
  'background',
  'borders',
  'size',
];

/** A table as flat data: rows and columns with fractional orders, one text
 * per cell (N4, N6). Row and column ids hold no "." (BlockSuite splits flat
 * keys on it). */
function tableProps(tableId: string, table: Json) {
  type Cell = { header: boolean; text: Delta } | null;
  const prefix = tableId.replaceAll('.', '_');
  const rows = childrenOf(table);
  const rowIds: string[] = [];
  const usedRows = new Set<string>();
  // grid[r][c]: the cell placed there; a merged cell's other positions null.
  const grid: Cell[][] = rows.map(() => []);
  rows.forEach((child, r) => {
    const row = object(child, 'tr');
    if (typeOf(row) !== 'tr') refuse('table', 'a child that is not a tr');
    keys(row, 'tr', [...OWN_KEYS, 'size']);
    const id = row.id;
    const kept =
      typeof id === 'string' && id && !id.includes('.') && !usedRows.has(id);
    if (kept) usedRows.add(id);
    rowIds.push(kept ? id : unique(usedRows, `${prefix}-r${r}`));
    let c = 0;
    for (const value of childrenOf(row)) {
      const cell = object(value, 'td');
      const type = typeOf(cell);
      if (type !== 'td' && type !== 'th')
        refuse('tr', 'a child that is not a cell');
      keys(cell, type, SPAN_KEYS);
      while (grid[r][c] !== undefined) c++;
      const span = (key: string) => {
        const n = cell[key];
        return typeof n === 'number' && Number.isInteger(n) && n >= 0
          ? Math.max(1, n)
          : 1;
      };
      const colSpan = span('colSpan');
      const rowSpan = span('rowSpan');
      const parts = childrenOf(cell).map((value) => {
        const paragraph = object(value, type);
        const paragraphType = typeOf(paragraph);
        if (!TEXT_BLOCK.test(paragraphType))
          refuse(type, `holds a ${paragraphType}`);
        keys(paragraph, paragraphType, OWN_KEYS);
        return inline(childrenOf(paragraph));
      });
      // N4: a merged cell is split; its other positions are empty.
      for (let dr = 0; dr < rowSpan && r + dr < rows.length; dr++)
        for (let dc = 0; dc < colSpan; dc++) grid[r + dr][c + dc] = null;
      grid[r][c] = { header: type === 'th', text: join(parts) };
      c += colSpan;
    }
  });
  const columnCount = Math.max(0, ...grid.map((row) => row.length));
  const columnIds = Array.from(
    { length: columnCount },
    (_, i) => `${prefix}-c${i}`
  );
  const sizes = Array.isArray(table.colSizes) ? table.colSizes : [];
  const props: Json = {};
  rowIds.forEach((rowId, r) => {
    const placed = grid[r].filter((cell): cell is NonNullable<Cell> => !!cell);
    props[`rows.${rowId}.rowId`] = rowId;
    props[`rows.${rowId}.order`] = orderKey(r);
    if (placed.length && placed.every((cell) => cell.header))
      props[`rows.${rowId}.header`] = true;
  });
  columnIds.forEach((columnId, c) => {
    props[`columns.${columnId}.columnId`] = columnId;
    props[`columns.${columnId}.order`] = orderKey(c);
    if (typeof sizes[c] === 'number')
      props[`columns.${columnId}.width`] = sizes[c];
  });
  rowIds.forEach((rowId, r) => {
    columnIds.forEach((columnId, c) => {
      props[`cells.${rowId}:${columnId}.text`] = grid[r][c]?.text ?? [];
    });
  });
  return props;
}

/** The blocks map a Plate value seeds: `root`, `note` and the content, or one
 * empty paragraph for an empty value. */
export function valueToBlocks(value: MaterialValue): BlocksJson {
  const writer = new Writer();
  writer.add(ROOT_ID, 'affine:page').children.push(NOTE_ID);
  const note = writer.add(NOTE_ID, 'affine:note');
  note.children = writer.place(value, NOTE_ID, 'note');
  if (!note.children.length) {
    const id = writer.blockId(undefined, NOTE_ID, 0);
    writer.add(id, 'affine:paragraph');
    note.children.push(id);
  }
  return writer.blocks;
}

// ---------------------------------------------------------------------------
// BlocksJson → Plate value

const emptyLeaf = () => [{ text: '' }];

function markLeaf({ attributes = {}, insert }: Delta[number]): MaterialText {
  const node: MaterialText = { text: insert };
  for (const [attribute, value] of Object.entries(attributes)) {
    if (attribute === 'link') continue;
    const mark =
      ATTRIBUTE_MARK[attribute] ?? refuse('text', `attribute ${attribute}`);
    node[mark] = value;
  }
  return node;
}

/** Y.Text runs back to Plate leaves and inline elements, numbering the
 * inline elements `<owner>.i<n>`. */
function inlineReader(owner: string) {
  let count = 0;
  const nextId = () => `${owner}.i${count++}`;
  return (runs: Delta): MaterialNode[] => {
    const nodes: MaterialNode[] = [];
    let i = 0;
    while (i < runs.length) {
      const run = runs[i];
      const attributes = run.attributes ?? {};
      if ('latex' in attributes) {
        // One per UTF-16 unit: Yjs merges equal neighbours.
        for (let left = run.insert.length; left > 0; left--)
          nodes.push({
            children: emptyLeaf(),
            id: nextId(),
            texExpression: attributes.latex,
            type: 'inline_equation',
          });
        i++;
      } else if ('mention' in attributes) {
        const mention = (attributes.mention ?? {}) as Json;
        // One per UTF-16 unit: Yjs merges equal neighbours.
        for (let left = run.insert.length; left > 0; left--) {
          const node: MaterialElement = {
            children: emptyLeaf(),
            id: nextId(),
            type: 'mention',
          };
          if ('member' in mention) node.key = mention.member;
          if ('name' in mention) node.value = mention.name;
          nodes.push(node);
        }
        i++;
      } else if ('link' in attributes) {
        const url = attributes.link;
        const leaves: MaterialText[] = [];
        for (
          let next = runs[i];
          next &&
          deepEqual(next.attributes?.link, url) &&
          !(next.attributes && 'latex' in next.attributes) &&
          !(next.attributes && 'mention' in next.attributes);
          next = runs[++i]
        )
          leaves.push(markLeaf(next));
        nodes.push({ children: leaves, id: nextId(), type: 'a', url });
      } else {
        nodes.push(markLeaf(run));
        i++;
      }
    }
    // Slate's normalization: a text leaf around and between inlines.
    const out: MaterialNode[] = [];
    const isElement = (node: MaterialNode | undefined) =>
      !node || 'type' in node;
    for (const node of nodes) {
      if ('type' in node && isElement(out.at(-1))) out.push({ text: '' });
      out.push(node);
    }
    if (isElement(out.at(-1))) out.push({ text: '' });
    return out;
  };
}

/** A text split at its "\n"s (code lines). */
function splitLines(delta: Delta): Delta[] {
  let line: Delta = [];
  const lines = [line];
  for (const op of delta) {
    op.insert.split('\n').forEach((part, index) => {
      if (index) {
        line = [];
        lines.push(line);
      }
      if (part) line.push({ ...op, insert: part });
    });
  }
  return lines;
}

class Reader {
  private readonly blocks: BlocksJson;

  constructor(blocks: BlocksJson) {
    this.blocks = blocks;
  }

  /** A container's children as Plate blocks: each paragraph's and list's
   * subtree after it at one more depth. Ids no block has (a concurrent
   * delete) are skipped; an empty container is one empty leaf. */
  value(ids: string[]): MaterialValue {
    const out: MaterialNode[] = [];
    const flatten = (list: string[], depth: number) => {
      for (const id of list) {
        const block = this.blocks[id];
        if (!block) continue;
        out.push(this.element(id, block, depth));
        if (HOLDERS.has(block.flavour)) flatten(block.children, depth + 1);
        else if (
          block.children.length &&
          block.flavour !== 'affine:callout' &&
          block.flavour !== 'capy:columns'
        )
          refuse(block.flavour, `block ${id} holds children`);
      }
    };
    flatten(ids, 0);
    // An empty note, as the Plate projection gives it.
    if (!out.length) out.push({ text: '' });
    return out as MaterialValue;
  }

  element(id: string, block: BlockJson, depth: number): MaterialElement {
    const props = block.props;
    const node: MaterialElement = { children: [], id, type: '' };
    const copy = (key: string, to = key) => {
      if (props[key] !== undefined) node[to] = props[key];
    };
    const indent = (value: number) => {
      if (value > 0) node.indent = value;
    };
    const align = () => {
      if (typeof props.textAlign === 'string') node.align = props.textAlign;
    };
    const caption = () => {
      if (typeof props.caption === 'string' && props.caption)
        node.caption = [{ text: props.caption }];
    };
    const text = (key: string) =>
      (props[key] ?? refuse(block.flavour, `no ${key}`)) as Delta;
    const voidBlock = (type: string) => {
      node.type = type;
      node.children = emptyLeaf();
    };
    switch (block.flavour) {
      case 'affine:paragraph': {
        const type = str(props.type);
        const runs = inlineReader(id)(text('text'));
        if (type === 'quote') {
          node.type = 'blockquote';
          node.children = [{ children: runs, id: `${id}.p`, type: 'p' }];
        } else if (type === 'text' || (type && HEADING.test(type))) {
          node.type = type === 'text' ? 'p' : type;
          node.children = runs;
        } else {
          refuse(block.flavour, `type ${type}`);
        }
        align();
        indent(depth);
        break;
      }
      case 'affine:list': {
        const type = str(props.type);
        const style =
          str(props.listStyleType) ??
          LIST_STYLE[type ?? ''] ??
          refuse(block.flavour, `type ${type}`);
        node.type = 'p';
        node.listStyleType = style;
        indent(depth + 1);
        if (type === 'todo')
          node.checked = typeof props.checked === 'boolean' && props.checked;
        if (typeof props.order === 'number') node.listStart = props.order;
        align();
        node.children = inlineReader(id)(text('text'));
        break;
      }
      case 'affine:code': {
        node.type = 'code_block';
        if (typeof props.language === 'string') node.lang = props.language;
        indent(depth);
        const read = inlineReader(id);
        node.children = splitLines(text('text')).map((line, n) => ({
          children: read(line),
          id: `${id}.l${n}`,
          type: 'code_line',
        }));
        break;
      }
      case 'affine:divider':
        voidBlock('hr');
        indent(depth);
        break;
      case 'capy:toc':
        voidBlock('toc');
        indent(depth);
        break;
      case 'affine:callout':
        node.type = 'callout';
        copy('variant');
        indent(depth);
        node.children = this.value(block.children);
        break;
      case 'affine:latex':
        voidBlock('equation');
        copy('latex', 'texExpression');
        indent(depth);
        break;
      case 'affine:image':
        voidBlock('img');
        copy('sourceId', 'assetId');
        copy('name');
        copy('contentType');
        if (typeof props.size === 'number' && props.size >= 0)
          node.sizeBytes = props.size;
        copy('widthPercent', 'width');
        align();
        caption();
        indent(depth);
        break;
      case 'capy:audio':
        voidBlock('audio');
        for (const key of ['assetId', 'name', 'contentType', 'sizeBytes'])
          copy(key);
        caption();
        indent(depth);
        break;
      case 'capy:video':
        voidBlock('video');
        for (const key of ['provider', 'videoId', 'width']) copy(key);
        caption();
        indent(depth);
        break;
      case 'capy:chart':
      case 'capy:plot':
      case 'capy:graph':
        voidBlock(block.flavour.slice('capy:'.length));
        copy('block');
        copy('width');
        break;
      case 'capy:html-embed':
        voidBlock('html_embed');
        copy('html');
        copy('caption');
        break;
      case 'capy:mermaid':
        node.type = 'mermaid';
        node.source = text('source')
          .map((op) => op.insert)
          .join('');
        copy('theme');
        copy('width');
        indent(depth);
        node.children = [
          {
            children: inlineReader(id)(text('caption')),
            id: `${id}.p`,
            type: 'mermaid_caption',
          },
        ];
        break;
      case 'capy:material-ref':
        voidBlock('material_ref');
        copy('materialId');
        copy('refKind');
        break;
      case 'capy:columns': {
        node.type = 'column_group';
        const columns = block.children.flatMap((columnId) => {
          const column = this.blocks[columnId];
          if (!column) return [];
          if (column.flavour !== 'capy:column')
            refuse(block.flavour, `child ${columnId} is not a column`);
          const element: MaterialElement = {
            children: this.value(column.children),
            id: columnId,
            type: 'column',
          };
          if (column.props.width !== undefined)
            element.width = column.props.width;
          return [element];
        });
        node.children = columns.length ? columns : emptyLeaf();
        break;
      }
      case 'affine:table':
        node.type = 'table';
        tableValue(node, block);
        break;
      default:
        refuse(block.flavour, 'unsupported flavour');
    }
    return node;
  }
}

const byOrder = (a: [string, string], b: [string, string]) =>
  a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1;

/** A table's rows by order: `tr` ids are the row ids, cells `td` (`th` in a
 * header row) with derived ids, one paragraph each. */
function tableValue(node: MaterialElement, block: BlockJson) {
  const props = block.props;
  const order = (key: string) =>
    str(props[key]) ?? refuse(block.flavour, `no ${key}`);
  const rows: [string, string][] = [];
  const columns: [string, string][] = [];
  for (const key of Object.keys(props)) {
    const [group, id, field, ...rest] = key.split('.');
    if (rest.length) continue;
    if (group === 'rows' && field === 'rowId')
      rows.push([order(`rows.${id}.order`), id]);
    if (group === 'columns' && field === 'columnId')
      columns.push([order(`columns.${id}.order`), id]);
  }
  rows.sort(byOrder);
  columns.sort(byOrder);
  const widths = columns.map(([, id]) => props[`columns.${id}.width`]);
  if (widths.some((width) => width !== undefined))
    node.colSizes = widths.map((width) => width ?? null);
  const trs = rows.map(([, rowId]) => {
    const header = props[`rows.${rowId}.header`] === true;
    const cells = columns.map(([, columnId]) => {
      const cellId = `${rowId}:${columnId}`;
      return {
        children: [
          {
            children: inlineReader(cellId)(
              (props[`cells.${cellId}.text`] ?? []) as Delta
            ),
            id: `${cellId}.p`,
            type: 'p',
          },
        ],
        id: cellId,
        type: header ? 'th' : 'td',
      };
    });
    return {
      children: cells.length ? cells : emptyLeaf(),
      id: rowId,
      type: 'tr',
    };
  });
  node.children = trs.length ? trs : emptyLeaf();
}

/** The Plate value a blocks map projects (`value()`): the note's subtree,
 * without the `root` and `note` hubs. */
export function blocksToValue(blocks: BlocksJson): MaterialValue {
  const note = blocks[NOTE_ID];
  if (note?.flavour !== 'affine:note')
    throw new Error('The blocks layout has no note block');
  return new Reader(blocks).value(note.children);
}

/** A Plate value as the blocks layout gives it back: the spec's
 * normalizations applied and derived ids rewritten. */
export function canonical(value: MaterialValue): MaterialValue {
  return blocksToValue(valueToBlocks(value));
}

// ---------------------------------------------------------------------------
// Yjs

/** `native2Y`: arrays and plain objects become deep `Y.Array`s and `Y.Map`s. */
function native2Y(value: unknown): unknown {
  if (Array.isArray(value)) return Y.Array.from(value.map(native2Y) as never[]);
  if (value && typeof value === 'object') {
    const map = new Y.Map<unknown>();
    for (const [key, item] of Object.entries(value))
      if (item !== undefined) map.set(key, native2Y(item));
    return map;
  }
  return value;
}

function y2Json(value: unknown): unknown {
  if (value instanceof Y.Text) return normalizeDelta(value.toDelta() as Delta);
  if (value instanceof Y.Array) return value.toArray().map(y2Json);
  if (value instanceof Y.Map)
    return Object.fromEntries(
      [...value.entries()].map(([key, item]) => [key, y2Json(item)])
    );
  return value;
}

/** Writes a blocks map into an empty doc's `blocks` root, in one
 * transaction. */
export function writeBlocks(doc: Y.Doc, blocks: BlocksJson) {
  const root = doc.getMap<Y.Map<unknown>>(BLOCKS_ROOT);
  if (root.size) throw new Error('The blocks root is not empty');
  doc.transact(() => {
    for (const [id, block] of Object.entries(blocks)) {
      const yBlock = new Y.Map<unknown>();
      root.set(id, yBlock);
      yBlock.set('sys:id', id);
      yBlock.set('sys:flavour', block.flavour);
      yBlock.set('sys:version', block.version);
      yBlock.set('sys:children', Y.Array.from(block.children));
      for (const [key, value] of Object.entries(block.props)) {
        if (isTextProp(block.flavour, key)) {
          const text = new Y.Text();
          yBlock.set(`prop:${key}`, text);
          text.applyDelta(value as Delta);
        } else {
          yBlock.set(`prop:${key}`, native2Y(value));
        }
      }
    }
  });
}

/** A doc's `blocks` root as JSON (the goldens' `blocks`). */
export function readBlocks(doc: Y.Doc): BlocksJson {
  const blocks: BlocksJson = {};
  for (const [id, yBlock] of doc.getMap<Y.Map<unknown>>(BLOCKS_ROOT)) {
    const props: Record<string, unknown> = {};
    for (const [key, value] of yBlock)
      if (key.startsWith('prop:')) props[key.slice(5)] = y2Json(value);
    blocks[id] = {
      children: (yBlock.get('sys:children') as Y.Array<string>).toArray(),
      flavour: yBlock.get('sys:flavour') as string,
      props,
      version: yBlock.get('sys:version') as number,
    };
  }
  return blocks;
}

/** Seeds a doc with a Plate value's blocks layout (`state_from_value`). */
export function applyValue(doc: Y.Doc, value: MaterialValue): Y.Doc {
  writeBlocks(doc, valueToBlocks(value));
  return doc;
}

/** `state_from_value`: a Plate value's blocks layout as one Yjs update. */
export function stateFromValue(
  value: MaterialValue,
  doc = new Y.Doc()
): Uint8Array {
  return Y.encodeStateAsUpdate(applyValue(doc, value));
}

/** `value()`: the Plate value a blocks room projects. */
export function blocksValue(doc: Y.Doc): MaterialValue {
  return blocksToValue(readBlocks(doc));
}
