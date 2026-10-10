import * as Y from 'yjs';
import {
  type MaterialElement,
  type MaterialValue,
  normalizeMaterialBlock,
} from '@/features/materials/document';

/* A note's value read from its room for a live View (live-items DESIGN.md 3),
 * block by block: each top-level block keeps its object until the room
 * changes something inside it, so the static renderer, which re-renders a
 * top-level block only when its object changes (PlateStatic's memo), redraws
 * one block per remote keystroke. */

/** Deep equality of JSON values, key order aside (the room and the
 * projection write a block's keys in different orders). */
function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => same(item, b[index]))
    );
  const keys = Object.keys(a);
  return (
    keys.length === Object.keys(b).length &&
    keys.every((key) =>
      same(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key]
      )
    )
  );
}

type Attributes = Record<string, unknown>;

/** Slate's `deepEquals`, as slate-yjs merges text runs with it: plain objects
 * deeply, arrays item by item with `===`. */
function slateEquals(a: Attributes, b: Attributes): boolean {
  const equal = (x: unknown, y: unknown) => {
    if (Array.isArray(x) && Array.isArray(y))
      return x.length === y.length && x.every((item, i) => item === y[i]);
    if (x && y && typeof x === 'object' && typeof y === 'object')
      return slateEquals(x as Attributes, y as Attributes);
    return x === y;
  };
  return (
    Object.keys(a).every((key) => equal(a[key], b[key])) &&
    Object.keys(b).every((key) => key in a)
  );
}

/**
 * `yTextToSlateElement` of @slate-yjs/core 1.0.2 with Capy's shape-A patch
 * (a Mermaid source text reads as its string), without loading slate: the
 * element's attributes, then its delta as children, empty strings dropped and
 * neighbouring strings of equal attributes merged; no children reads as the
 * placeholder leaf.
 */
export function yTextElement(yText: Y.XmlText): Attributes {
  const node: Attributes = {};
  for (const [key, value] of Object.entries(yText.getAttributes()))
    node[key] = value instanceof Y.AbstractType ? value.toString() : value;
  const children: Attributes[] = [];
  let run: { attributes?: Attributes; leaf: Attributes } | null = null;
  for (const op of yText.toDelta() as {
    attributes?: Attributes;
    insert: unknown;
  }[]) {
    if (typeof op.insert !== 'string') {
      children.push(yTextElement(op.insert as Y.XmlText));
      run = null;
      continue;
    }
    if (!op.insert) continue;
    if (
      run &&
      (run.attributes === op.attributes ||
        (!run.attributes === !op.attributes &&
          slateEquals(run.attributes ?? {}, op.attributes ?? {})))
    ) {
      run.leaf.text = `${run.leaf.text as string}${op.insert}`;
      continue;
    }
    const leaf = { ...op.attributes, text: op.insert };
    children.push(leaf);
    run = { attributes: op.attributes, leaf };
  }
  node.children = children.length ? children : [{ text: '' }];
  return node;
}

/** A top-level entry of the room's root as a normalized Plate block. */
function blockOf(insert: unknown): MaterialElement {
  const node =
    insert instanceof Y.XmlText
      ? yTextElement(insert)
      : { text: typeof insert === 'string' ? insert : '' };
  return normalizeMaterialBlock(node as unknown as MaterialElement);
}

/** The top-level block a changed type sits in (the root itself for a change
 * of the block list). */
function topLevel(root: Y.XmlText, type: Y.AbstractType<unknown>) {
  let current: Y.AbstractType<unknown> = type;
  while (current._item && current._item.parent !== root)
    current = current._item.parent as Y.AbstractType<unknown>;
  return current;
}

export class NoteBlocks {
  private readonly root: Y.XmlText;
  private readonly blocks = new Map<unknown, MaterialElement>();
  value: MaterialValue = [];

  constructor(root: Y.XmlText) {
    this.root = root;
  }

  /** The room's value once it synced, handed over from the painted
   * projection: a block equal to the painted one at its id (or its place)
   * keeps the painted object, so the switch redraws only what differs. */
  handOver(painted: MaterialValue): MaterialValue {
    const byId = new Map(painted.map((block) => [block.id, block]));
    this.blocks.clear();
    this.value = (this.root.toDelta() as { insert: unknown }[]).map(
      ({ insert }, index) => {
        const live = blockOf(insert);
        const shown =
          (typeof live.id === 'string' && byId.get(live.id)) || painted[index];
        const kept = shown && same(shown, live) ? shown : live;
        this.blocks.set(insert, kept);
        return kept;
      }
    );
    return this.value;
  }

  /** After the room's events: the blocks they touched are read again, the
   * others keep their objects. Returns whether the value changed. */
  apply(events: Y.YEvent<Y.AbstractType<unknown>>[]): boolean {
    let list = false;
    for (const event of events) {
      const block = topLevel(this.root, event.target);
      if (block === this.root) list = true;
      else this.blocks.delete(block);
    }
    const entries = this.root.toDelta() as { insert: unknown }[];
    if (list) {
      const live = new Set(entries.map(({ insert }) => insert));
      for (const key of [...this.blocks.keys()])
        if (!live.has(key)) this.blocks.delete(key);
    }
    let changed = entries.length !== this.value.length;
    const next = entries.map(({ insert }, index) => {
      let block = this.blocks.get(insert);
      if (!block) {
        block = blockOf(insert);
        this.blocks.set(insert, block);
      }
      if (block !== this.value[index]) changed = true;
      return block;
    });
    if (changed) this.value = next;
    return changed;
  }
}
