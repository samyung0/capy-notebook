import * as Y from 'yjs';
import { MATERIAL_DOCUMENT_DEPTH_CEILING } from './materialDocument.js';

// IMPORTANT: KEEP IN SYNC WITH src/lib/const.ts and
// server/internal/materialdoc/document.go
export const MATERIAL_DOCUMENT_LIMITS = {
  maxContentBytes: 2 * 1024 * 1024,
  maxDepth: 16,
  maxNodes: 10_000,
} as const;

export interface MaterialDocumentMetrics {
  contentBytes: number;
  maxDepth: number;
  nodeCount: number;
}

export type MaterialLimitCode =
  | 'document_depth_exceeded'
  | 'document_nodes_exceeded'
  | 'document_size_exceeded'
  | 'undo_payload_exceeded';

export class MaterialDocumentLimitError extends Error {
  readonly code: MaterialLimitCode;
  readonly metrics: MaterialDocumentMetrics;

  constructor(code: MaterialLimitCode, metrics: MaterialDocumentMetrics) {
    super(`invalid material document: ${code}`);
    this.name = 'MaterialDocumentLimitError';
    this.code = code;
    this.metrics = metrics;
  }
}

function stripRuntimeCommentMarks(value: unknown[]): unknown[] {
  return value.map((node) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const normalized: Record<string, unknown> = {};
    const record = node as Record<string, unknown>;
    const isTextLeaf = record.text !== null && record.text !== undefined;
    for (const [key, child] of Object.entries(record)) {
      if (isTextLeaf && (key === 'comment' || key.startsWith('comment_'))) {
        continue;
      }
      normalized[key] =
        key === 'children' && Array.isArray(child)
          ? stripRuntimeCommentMarks(child)
          : child;
    }
    return normalized;
  });
}

export function measureMaterialValue(
  value: unknown[]
): MaterialDocumentMetrics {
  const normalized = stripRuntimeCommentMarks(value);
  const metrics: MaterialDocumentMetrics = {
    contentBytes: Buffer.byteLength(
      JSON.stringify({ schemaVersion: 1, value: normalized }),
      'utf8'
    ),
    maxDepth: 0,
    nodeCount: 0,
  };
  const visit = (node: unknown, depth: number) => {
    metrics.nodeCount += 1;
    if (depth > metrics.maxDepth) metrics.maxDepth = depth;
    // Structural validation rejects children beyond this point. Walking every
    // structurally valid level keeps shrink-only comparisons exact even when a
    // legacy document already exceeds the product depth cap.
    if (depth >= MATERIAL_DOCUMENT_DEPTH_CEILING) return;
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    const children = (node as { children?: unknown }).children;
    if (!Array.isArray(children)) return;
    for (const child of children) visit(child, depth + 1);
  };
  for (const node of normalized) visit(node, 0);
  return metrics;
}

export function materialLimitCode(
  metrics: MaterialDocumentMetrics
): MaterialLimitCode | null {
  if (metrics.contentBytes > MATERIAL_DOCUMENT_LIMITS.maxContentBytes) {
    return 'document_size_exceeded';
  }
  if (metrics.nodeCount > MATERIAL_DOCUMENT_LIMITS.maxNodes) {
    return 'document_nodes_exceeded';
  }
  if (metrics.maxDepth > MATERIAL_DOCUMENT_LIMITS.maxDepth) {
    return 'document_depth_exceeded';
  }
  return null;
}

/**
 * An over-limit document must stay editable in the shrinking direction.
 * Rejecting every write once a document is too large would also reject the
 * deletions needed to recover, leaving the material permanently unsavable.
 */
export function recoversMaterialLimits(
  next: MaterialDocumentMetrics,
  previous: MaterialDocumentMetrics | null
): boolean {
  if (!previous) return false;
  return (
    next.contentBytes <= previous.contentBytes &&
    next.nodeCount <= previous.nodeCount &&
    next.maxDepth <= previous.maxDepth
  );
}

// JSON bytes an update can add on top of its own strings and attributes: a
// text leaf `{"text":""}` and a block `{"children":[]}`, each with its comma;
// and the split of a surrogate pair at an inserted item's two sides, which
// turns each half into U+FFFD (4 bytes become 6 per side).
const LEAF_BYTES = 12;
const ELEMENT_BYTES = 16;
const SPLIT_BYTES = 4;

const jsonBytes = (value: unknown) =>
  Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
// A string's JSON escaping, without its quotes.
const textBytes = (text: string) => jsonBytes(text) - 2;
// `"key":value,` in a Plate node.
const attributeBytes = (key: string, value: unknown) =>
  jsonBytes(key) + jsonBytes(value) + 2;

type Kind = 'element' | 'format' | 'string';
// A held shared type, as far as the bound walks it.
type Shared = { _item: Y.Item | null };
interface Children {
  attributes: number;
  items: { item: Y.Item; kind: Kind }[];
}
interface Subtree {
  bytes: number;
  depth: number;
  nodes: number;
}

function kindOf(item: Y.Item): Kind | 'deleted' | null {
  const content = item.content;
  if (content instanceof Y.ContentString) return 'string';
  if (content instanceof Y.ContentFormat) return 'format';
  if (content instanceof Y.ContentDeleted) return 'deleted';
  if (content instanceof Y.ContentType && content.type instanceof Y.XmlText)
    return 'element';
  return null;
}

/**
 * An upper bound on what one update adds to the room's measured Plate value
 * (measureMaterialValue): `contentBytes` and `nodeCount` at most, and
 * `maxDepth`, the depth of the deepest node it can create (0 when none). Read
 * from the update's own structs against the room, never a copy of it. Returns
 * null when the update holds something the bound does not model (content
 * slate-yjs never writes, a reference it cannot resolve); the caller measures
 * exactly then. Call it only for an update the room can place (inspectUpdate).
 *
 * What it relies on: a Plate leaf is a run of strings in one Y.XmlText with no
 * format item or embed between them (slate-yjs merges equal neighbours), so
 * deleting strings, embeds or attributes never grows the value; a string
 * typed next to a visible string joins that leaf and adds only its escaped
 * bytes; anything else that touches a text's formatting is bounded by
 * re-pricing that text's leaves at their largest possible attributes; a new
 * block is priced from its own structs.
 */
export function materialUpdateGrowth(
  content: Y.XmlText,
  update: Uint8Array
): MaterialDocumentMetrics | null {
  try {
    return updateGrowth(content, update);
  } catch {
    // A value JSON cannot encode (a bigint attribute): measure it exactly.
    return null;
  }
}

function updateGrowth(
  content: Y.XmlText,
  update: Uint8Array
): MaterialDocumentMetrics | null {
  const document = content.doc;
  if (!document) return null;
  const store = document.store;
  const held = (id: Y.ID) => id.clock < Y.getState(store, id.client);
  const { ds, structs } = Y.decodeUpdate(update);
  const incoming = new Map<number, Y.Item[]>();
  for (const struct of structs) {
    if (!(struct instanceof Y.Item)) continue;
    const items = incoming.get(struct.id.client) ?? [];
    items.push(struct);
    incoming.set(struct.id.client, items);
  }
  // Decoded structs arrive in clock order per client.
  const incomingAt = (id: Y.ID) => {
    const items = incoming.get(id.client) ?? [];
    let low = 0;
    let high = items.length - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const item = items[middle];
      if (id.clock < item.id.clock) high = middle - 1;
      else if (id.clock >= item.id.clock + item.length) low = middle + 1;
      else return item;
    }
  };
  // Whether the update deletes every unit of [from, to) of a client.
  const deletes = (client: number, from: number, to: number) => {
    const ranges = (ds.clients.get(client) ?? [])
      .filter(({ clock, len }) => clock < to && clock + len > from)
      .sort((a, b) => a.clock - b.clock);
    let reached = from;
    for (const { clock, len } of ranges) {
      if (clock > reached) return false;
      reached = Math.max(reached, clock + len);
    }
    return reached >= to;
  };
  const hidden = (item: Y.Item) =>
    item.deleted ||
    deletes(item.id.client, item.id.clock, item.id.clock + item.length);
  const heldItem = (id: Y.ID) => {
    const struct = Y.getItem(store, id);
    return struct instanceof Y.Item ? struct : null;
  };

  // Where each new item lands: a held type or a new block, and its map key.
  // An item without a parent takes its origin's, else its right origin's.
  type Place = { key: string | null; parent: Shared | Y.Item };
  const places = new Map<Y.Item, Place | 'gone' | 'unknown'>();
  const placeOf = (start: Y.Item) => {
    const chain: Y.Item[] = [];
    let item = start;
    let found: Place | 'gone' | 'unknown';
    while (true) {
      const known = places.get(item);
      if (known) {
        found = known;
        break;
      }
      places.set(item, 'unknown'); // a reference cycle stays unknown
      chain.push(item);
      // Yjs drops an item next to a garbage-collected struct.
      const sides = [item.origin, item.rightOrigin].filter(
        (id): id is Y.ID => id !== null && held(id)
      );
      if (sides.some((id) => !heldItem(id))) {
        found = 'gone';
        break;
      }
      const parent = item.parent as string | Y.ID | null;
      if (typeof parent === 'string') {
        const root = document.share.get(parent);
        found = root ? { key: item.parentSub, parent: root } : 'unknown';
        break;
      }
      if (parent) {
        if (held(parent)) {
          const holder = heldItem(parent);
          found = holder
            ? holder.content instanceof Y.ContentType
              ? { key: item.parentSub, parent: holder.content.type }
              : 'unknown'
            : 'gone';
        } else {
          const holder = incomingAt(parent);
          found = holder ? { key: item.parentSub, parent: holder } : 'unknown';
        }
        break;
      }
      const sibling = item.origin ?? item.rightOrigin;
      if (!sibling) {
        found = 'unknown';
        break;
      }
      if (held(sibling)) {
        const struct = heldItem(sibling) as Y.Item;
        found = { key: struct.parentSub, parent: struct.parent as Shared };
        break;
      }
      const next = incomingAt(sibling);
      if (!next) {
        found = 'unknown';
        break;
      }
      item = next;
    }
    for (const item of chain) places.set(item, found);
    return found;
  };

  let bytes = 0;
  let nodes = 0;
  let depth = 0;
  // New children of each held text and of each new block.
  const texts = new Map<Y.XmlText, Children>();
  const blocks = new Map<Y.Item, Children>();
  const childrenOf = <K>(map: Map<K, Children>, key: K) => {
    let children = map.get(key);
    if (!children) {
      children = { attributes: 0, items: [] };
      map.set(key, children);
    }
    return children;
  };
  // Where a held type sits: under content or not, and its depth (the
  // content root is -1, a top-level block 0, as measureMaterialValue counts).
  const ancestry = (type: Shared) => {
    let level = -1;
    let top = type;
    while (top._item) {
      level += 1;
      top = top._item.parent as Shared;
    }
    return { level, underContent: top === content };
  };

  for (const items of incoming.values()) {
    for (const item of items) {
      if (item.id.clock + item.length <= Y.getState(store, item.id.client))
        continue;
      const place = placeOf(item);
      if (place === 'gone') continue;
      if (place === 'unknown') return null;
      const kind = kindOf(item);
      if (place.key !== null) {
        // An attribute: `"key":value,` at most (it may replace a longer one).
        if (item.content instanceof Y.ContentDeleted) continue;
        if (!(item.content instanceof Y.ContentAny)) return null;
        const values = item.content.getContent();
        const added = attributeBytes(place.key, values.at(-1));
        if (place.parent instanceof Y.Item) {
          childrenOf(blocks, place.parent).attributes += added;
          continue;
        }
        const { underContent } = ancestry(place.parent);
        if (!underContent) continue;
        // The content root takes no attributes; the exact check refuses it.
        if (place.parent === content) return null;
        bytes += added;
        continue;
      }
      if (kind === null) return null;
      if (kind === 'deleted') continue;
      if (place.parent instanceof Y.Item) {
        if (kindOf(place.parent) !== 'element') return null;
        childrenOf(blocks, place.parent).items.push({ item, kind });
        continue;
      }
      if (!ancestry(place.parent).underContent) continue;
      if (!(place.parent instanceof Y.XmlText)) return null;
      childrenOf(texts, place.parent).items.push({ item, kind });
    }
  }

  // Deleting a visible format item can widen another one's reach: such a
  // text is re-priced below.
  const reformatted = new Set<Y.XmlText>();
  for (const [client, ranges] of ds.clients) {
    const clientStructs = store.clients.get(client);
    if (!clientStructs) continue;
    const end = Y.getState(store, client);
    for (const { clock, len } of ranges) {
      const until = Math.min(clock + len, end);
      if (clock >= until) continue;
      for (
        let index = Y.findIndexSS(clientStructs, clock);
        index < clientStructs.length && clientStructs[index].id.clock < until;
        index += 1
      ) {
        const struct = clientStructs[index];
        if (
          struct instanceof Y.Item &&
          !struct.deleted &&
          struct.content instanceof Y.ContentFormat &&
          struct.parent instanceof Y.XmlText &&
          ancestry(struct.parent).underContent
        )
          reformatted.add(struct.parent);
      }
    }
  }

  for (const text of reformatted) childrenOf(texts, text);

  // The held items on either side of a new item: its origins, followed
  // through other new items.
  const heldSide = (start: Y.ID | null, side: 'origin' | 'rightOrigin') => {
    let id = start;
    while (id && !held(id)) {
      const next = incomingAt(id);
      if (!next) return;
      id = next[side];
    }
    return id;
  };
  const isVisibleString = (id: Y.ID) => {
    const struct = heldItem(id);
    return (
      struct !== null &&
      struct.content instanceof Y.ContentString &&
      !struct.deleted &&
      !deletes(id.client, id.clock, id.clock + 1)
    );
  };
  // Whether every held unit strictly between two held positions of a text
  // ends up invisible, so new items land next to the two positions.
  const adjacent = (text: Y.XmlText, left: Y.ID | null, right: Y.ID | null) => {
    let item: Y.Item | null;
    if (left) {
      const struct = heldItem(left);
      if (!struct || struct.parent !== text) return false;
      const end = struct.id.clock + struct.length;
      if (left.clock + 1 < end) {
        if (
          right &&
          right.client === left.client &&
          right.clock === left.clock + 1
        )
          return true;
        if (!struct.deleted && !deletes(left.client, left.clock + 1, end))
          return false;
      }
      item = struct.right;
    } else item = text._start;
    while (item) {
      const { client, clock } = item.id;
      if (
        right &&
        right.client === client &&
        right.clock >= clock &&
        right.clock < clock + item.length
      )
        return (
          right.clock === clock ||
          item.deleted ||
          deletes(client, clock, right.clock)
        );
      if (!hidden(item)) return false;
      item = item.right;
    }
    return right === null;
  };
  // The nearest visible held item that is not a format, from a position on.
  const neighbour = (id: Y.ID | null, step: 'left' | 'right') => {
    let item = id ? heldItem(id) : null;
    while (item && (hidden(item) || item.content instanceof Y.ContentFormat))
      item = item[step];
    return item;
  };

  for (const [text, { items }] of texts) {
    let retext =
      reformatted.has(text) ||
      items.some(({ kind }) => kind === 'format') ||
      (items.some(({ kind }) => kind === 'string') &&
        items.some(({ kind }) => kind === 'element'));
    for (const { item, kind } of items) {
      if (retext) break;
      const left = heldSide(item.origin, 'origin');
      const right = heldSide(item.rightOrigin, 'rightOrigin');
      if (left === undefined || right === undefined) return null;
      if (!adjacent(text, left, right)) retext = true;
      else if (kind === 'string')
        // Typed next to a visible string, it joins that leaf; into an empty
        // text, it replaces the empty leaf.
        retext = !(
          (left && isVisibleString(left)) ||
          (right && isVisibleString(right)) ||
          adjacent(text, null, null)
        );
      // A block between two strings of one leaf splits it.
      else
        retext =
          neighbour(left, 'left')?.content instanceof Y.ContentString &&
          neighbour(right, 'right')?.content instanceof Y.ContentString;
    }
    // Re-price the text's leaves: each run of visible held strings between
    // two boundaries, plus one per new item, at the largest attributes its
    // formats can give.
    let leaves = 1;
    const widest = new Map<string, number>();
    const format = (item: Y.Item) => {
      const { key, value } = item.content as Y.ContentFormat;
      if (value !== null)
        widest.set(
          key,
          Math.max(widest.get(key) ?? 0, attributeBytes(key, value))
        );
    };
    if (retext) {
      let run = false;
      for (let item = text._start; item; item = item.right) {
        if (hidden(item)) continue;
        if (item.content instanceof Y.ContentString) {
          if (!run) leaves += 1;
          run = true;
          continue;
        }
        run = false;
        if (item.content instanceof Y.ContentFormat) format(item);
      }
    }
    for (const { item, kind } of items) {
      bytes += SPLIT_BYTES;
      if (kind === 'string')
        bytes += textBytes((item.content as Y.ContentString).str);
      else if (kind === 'format') format(item);
      else {
        const block = subtree(item, ancestry(text).level + 1);
        if (!block) return null;
        bytes += block.bytes;
        nodes += block.nodes;
        depth = Math.max(depth, block.depth);
      }
      if (retext) leaves += 1;
    }
    if (retext) {
      let attributes = 0;
      for (const size of widest.values()) attributes += size;
      bytes += leaves * (LEAF_BYTES + attributes);
      nodes += leaves;
    }
  }
  return { contentBytes: bytes, maxDepth: depth, nodeCount: nodes };

  // A new block and everything in it, all new: its attributes, its strings,
  // and one leaf per boundary at the largest attributes its formats give.
  function subtree(block: Y.Item, level: number): Subtree | null {
    // Deeper than any structurally valid document: measure exactly.
    if (level > MATERIAL_DOCUMENT_DEPTH_CEILING) return null;
    const { attributes, items } = blocks.get(block) ?? {
      attributes: 0,
      items: [],
    };
    const widest = new Map<string, number>();
    let size = ELEMENT_BYTES + attributes;
    let count = 1;
    let deepest = level + 1;
    let boundaries = 0;
    for (const { item, kind } of items) {
      size += SPLIT_BYTES;
      if (kind === 'string') {
        size += textBytes((item.content as Y.ContentString).str);
        continue;
      }
      boundaries += 1;
      if (kind === 'format') {
        const { key, value } = item.content as Y.ContentFormat;
        if (value !== null)
          widest.set(
            key,
            Math.max(widest.get(key) ?? 0, attributeBytes(key, value))
          );
        continue;
      }
      const child = subtree(item, level + 1);
      if (!child) return null;
      size += child.bytes;
      count += child.nodes;
      deepest = Math.max(deepest, child.depth);
    }
    let leafAttributes = 0;
    for (const width of widest.values()) leafAttributes += width;
    const leaves = boundaries + 1;
    return {
      bytes: size + leaves * (LEAF_BYTES + leafAttributes),
      depth: deepest,
      nodes: count + leaves,
    };
  }
}
