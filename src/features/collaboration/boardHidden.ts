import * as Y from 'yjs';

/**
 * What a canvas's re-applied early edits (Q31) cannot show, by element and
 * block (Epo 2026-11-19, Q33): the late merge names hidden edits by top-level
 * block, and every stroke, shape and connector sits in the one surface block,
 * so that would hide them all. Here an edit is hidden when the element or
 * block it sits in shows on the early board and no longer does on the merged
 * one: another person deleted it meanwhile. A field both sides changed is not
 * hidden: Yjs's pick stands.
 */

/** The canvas's elements map in a BlockSuite board document. */
function surfaceElements(doc: Y.Doc) {
  for (const block of doc.getMap<unknown>('blocks').values()) {
    if (!(block instanceof Y.Map)) continue;
    if (block.get('sys:flavour') !== 'affine:surface') continue;
    const elements: unknown = block.get('prop:elements');
    const value = elements instanceof Y.Map ? elements.get('value') : null;
    if (value instanceof Y.Map) return value;
  }
  return null;
}

/** The element and block ids the early board's own edits sit in (its
 * structs past what `held` names, the joined document's state before the
 * re-apply), each one that board still shows. */
function editedIds(early: Y.Doc, held: ReadonlyMap<number, number>) {
  const elements = new Set<string>();
  const blocks = new Set<string>();
  const elementMap = surfaceElements(early);
  const blockMap = early.getMap('blocks');
  for (const [client, structs] of early.store.clients) {
    const from = held.get(client) ?? 0;
    for (const struct of structs) {
      if (
        !(struct instanceof Y.Item) ||
        struct.id.clock + struct.length <= from
      )
        continue;
      let child = struct;
      let parent = struct.parent;
      while (parent instanceof Y.AbstractType) {
        if (child.parentSub && parent === elementMap) {
          if (elementMap.has(child.parentSub)) elements.add(child.parentSub);
          break;
        }
        if (child.parentSub && parent === blockMap) {
          if (blockMap.has(child.parentSub)) blocks.add(child.parentSub);
          break;
        }
        const around: Y.Item | null = parent._item;
        if (!around) break;
        child = around;
        parent = around.parent;
      }
    }
  }
  return { blocks, elements };
}

/** The blocks `kept` needs on a board: themselves, what they sit in, what
 * sits in them, and the page and its surface. */
function blocksFor(doc: Y.Doc, kept: ReadonlySet<string>) {
  const blocks = doc.getMap<Y.Map<unknown>>('blocks');
  const parents = new Map<string, string>();
  for (const [id, block] of blocks) {
    const children = block.get('sys:children');
    if (children instanceof Y.Array)
      for (const child of children.toArray() as string[])
        parents.set(child, id);
  }
  const keep = new Set<string>();
  const down = (id: string) => {
    if (keep.has(id)) return;
    keep.add(id);
    const children = blocks.get(id)?.get('sys:children');
    if (children instanceof Y.Array)
      for (const child of children.toArray() as string[]) down(child);
  };
  for (const id of kept) {
    down(id);
    for (let up = parents.get(id); up; up = parents.get(up)) keep.add(up);
  }
  for (const [id, block] of blocks) {
    const flavour = block.get('sys:flavour');
    if (flavour === 'affine:page' || flavour === 'affine:surface') keep.add(id);
  }
  return keep;
}

/**
 * A document of the early board's edits the merged one does not show, for
 * copying (the copy-only recovery beside the live board), or null when every
 * edit shows: the elements and blocks the early board edited and still
 * shows that the merged board no longer does (another person deleted them).
 * `early`: the board's document before the re-apply; `merged`: the joined
 * document after it; `held`: the joined document's state vector before it.
 */
export function hiddenEdits(
  early: Y.Doc,
  merged: Y.Doc,
  held: ReadonlyMap<number, number>
) {
  const edited = editedIds(early, held);
  const shown = surfaceElements(merged);
  const shownBlocks = merged.getMap('blocks');
  const elements = new Set(
    [...edited.elements].filter((id) => !shown?.has(id))
  );
  const blocks = new Set(
    [...edited.blocks].filter((id) => !shownBlocks.has(id))
  );
  if (!(blocks.size || elements.size)) return null;
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(early));
  const keep = blocksFor(copy, blocks);
  copy.transact(() => {
    const elementMap = surfaceElements(copy);
    for (const id of [...(elementMap?.keys() ?? [])])
      if (!elements.has(id)) elementMap?.delete(id);
    const blockMap = copy.getMap<Y.Map<unknown>>('blocks');
    for (const id of [...blockMap.keys()])
      if (!keep.has(id)) blockMap.delete(id);
    for (const block of blockMap.values()) {
      const children = block.get('sys:children');
      if (!(children instanceof Y.Array)) continue;
      const ids = children.toArray() as string[];
      for (let index = ids.length - 1; index >= 0; index--)
        if (!keep.has(ids[index])) children.delete(index, 1);
    }
  });
  return copy;
}
