import { NoteStoreExtension } from '@blocksuite/affine/blocks/note/store';
import { ParagraphStoreExtension } from '@blocksuite/affine/blocks/paragraph/store';
import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import type { SurfaceBlockModel } from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { UnknownElementModel } from '@blocksuite/affine/std/gfx';
import { Text } from '@blocksuite/affine/store';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { keepToCatalog, savedCopy } from './boardKeep';
import { type BoardKind, BoardLoadError, checkSavedBoard } from './boardLoad';
import {
  UNKNOWN_BLOCK,
  UNKNOWN_CARD,
  UnknownCardModel,
  unknownStore,
} from './boardUnknown';

/* A board shared with others holds what they wrote (Epo 2026-11-18): content this
 * build can't read opens as placeholders and stays in the document as it is. These
 * run BlockSuite's store and canvas model as `mountDrawingBoard` sets them up,
 * without the editor's view. */

const stores = new StoreExtensionManager([
  RootStoreExtension,
  SurfaceStoreExtension,
  NoteStoreExtension,
  ParagraphStoreExtension,
]);

function emptyStore(board: BoardKind) {
  const workspace = new TestWorkspace();
  workspace.storeExtensions = [...stores.get('store'), ...unknownStore(board)];
  workspace.meta.initialize();
  return workspace.createDoc('board').getStore();
}

/** A board as `mountDrawingBoard` opens a saved one, with its catalog guard. */
function open(saved: Uint8Array, board: BoardKind) {
  const store = emptyStore(board);
  Y.applyUpdate(store.spaceDoc, saved);
  store.load();
  const [surface] = store.getModelsByFlavour(
    'affine:surface'
  ) as SurfaceBlockModel[];
  keepToCatalog(store, surface, board);
  return { store, surface };
}

/** A canvas as the board makes one: a page, its canvas, and a note with a line. */
function canvas() {
  const store = emptyStore('workspace');
  let note = '';
  store.load(() => {
    const page = store.addBlock('affine:page', { title: new Text() });
    store.addBlock('affine:surface', {}, page);
    note = store.addBlock('affine:note', { xywh: '[40,36,250,95]' }, page);
    store.addBlock('affine:paragraph', { text: new Text('Light') }, note);
  });
  return { note, update: Y.encodeStateAsUpdate(store.spaceDoc) };
}

const mapOf = (fields: Record<string, unknown>) => {
  const map = new Y.Map<unknown>();
  for (const [key, value] of Object.entries(fields)) map.set(key, value);
  return map;
};

const blocksOf = (doc: Y.Doc) => doc.getMap<Y.Map<unknown>>('blocks');
const surfaceOf = (doc: Y.Doc) =>
  [...blocksOf(doc).entries()].find(
    ([, block]) => block.get('sys:flavour') === 'affine:surface'
  ) as [string, Y.Map<unknown>];
const elementsOf = (doc: Y.Doc) =>
  (surfaceOf(doc)[1].get('prop:elements') as Y.Map<unknown>).get(
    'value'
  ) as Y.Map<unknown>;

/** What another build writes: an element of a type this one has no model for, one
 * with no place to draw at, an entry that is no element, a block of a flavour it has
 * no schema for on the canvas and in a note, and entries keyed `__proto__`. `tag`
 * keeps two rounds apart. */
function writeUnknown(doc: Y.Doc, note: string, tag: string) {
  doc.transact(() => {
    const elements = elementsOf(doc);
    elements.set(
      `hologram${tag}`,
      mapOf({
        depth: 3,
        id: `hologram${tag}`,
        index: 'a5',
        type: 'hologram',
        xywh: '[360.123,50.456,320,150]',
      })
    );
    elements.set(`aura${tag}`, mapOf({ type: 'aura' }));
    elements.set(`stray${tag}`, 7);
    elements.set(
      '__proto__',
      mapOf({ index: 'a6', tag, type: 'shape', xywh: '[0,0,10,10]' })
    );
    const block = (flavour: string, props: Record<string, unknown>) =>
      mapOf({
        'sys:children': new Y.Array(),
        'sys:flavour': flavour,
        ...Object.fromEntries(
          Object.entries(props).map(([key, value]) => [`prop:${key}`, value])
        ),
      });
    const blocks = blocksOf(doc);
    blocks.set(
      `card${tag}`,
      block('affine:embed-hologram', {
        index: 'a7',
        source: 'h1',
        xywh: '[410.5,280,240,130]',
      })
    );
    blocks.set(`line${tag}`, block('affine:hologram-caption', { text: 'x' }));
    blocks.set('__proto__', block('affine:paragraph', { tag }));
    const [, surface] = surfaceOf(doc);
    (surface.get('sys:children') as Y.Array<string>).push([`card${tag}`]);
    const noteBlock = blocks.get(note) as Y.Map<unknown>;
    (noteBlock.get('sys:children') as Y.Array<string>).push([
      `line${tag}`,
      '__proto__',
    ]);
  });
}

function withUnknown() {
  const { note, update } = canvas();
  const doc = new Y.Doc();
  Y.applyUpdate(doc, update);
  writeUnknown(doc, note, '');
  return { note, saved: Y.encodeStateAsUpdate(doc) };
}

const settled = () => new Promise((resolve) => setTimeout(resolve));

it('opens a canvas holding what it cannot read, as placeholders, unchanged', async () => {
  const { note, saved } = withUnknown();
  expect(checkSavedBoard(saved, 'workspace').misfits).toEqual([
    'hidden key',
    'block affine:embed-hologram',
    'block affine:hologram-caption',
    // The note's child that no check can see.
    'block tree',
    'element type hologram',
    'element type aura',
    'element type undefined',
  ]);
  const { store, surface } = open(saved, 'workspace');
  await settled();

  const hologram = surface.getElementById('hologram');
  expect(hologram).toBeInstanceOf(UnknownElementModel);
  expect(hologram?.xywh).toBe('[360.123,50.456,320,150]');
  expect(surface.getElementById('__proto__')).toBeInstanceOf(
    UnknownElementModel
  );
  // With no place to draw at, nothing is drawn.
  expect(surface.hasElementById('aura')).toBe(false);
  const card = store.getModelById('card');
  expect(card).toBeInstanceOf(UnknownCardModel);
  expect(card?.flavour).toBe(UNKNOWN_CARD);
  expect((card as UnknownCardModel).xywh).toBe('[410.5,280,240,130]');
  expect(
    store.getModelById(note)?.children.map(({ flavour }) => flavour)
  ).toEqual(['affine:paragraph', UNKNOWN_BLOCK]);

  // Opening wrote nothing, and neither does the copy a save stores.
  expect(Y.encodeStateAsUpdate(store.spaceDoc)).toEqual(saved);
  expect(savedCopy(store.spaceDoc, 'workspace')).toEqual(saved);
  expect(Y.encodeStateAsUpdate(store.spaceDoc)).toEqual(saved);

  // Moved by its own person, a placeholder keeps everything else it holds.
  surface.updateElement('hologram', { xywh: '[1,2,320,150]' });
  expect(
    (elementsOf(store.spaceDoc).get('hologram') as Y.Map<unknown>).toJSON()
  ).toEqual({
    depth: 3,
    id: 'hologram',
    index: 'a5',
    type: 'hologram',
    xywh: '[1,2,320,150]',
  });
});

it('draws what a peer adds as placeholders and leaves it in the document', async () => {
  const { note, update } = canvas();
  const { store, surface } = open(update, 'workspace');
  const peer = new Y.Doc();
  Y.applyUpdate(peer, update);
  writeUnknown(peer, note, '2');
  const added = Y.encodeStateAsUpdate(
    peer,
    Y.encodeStateVector(store.spaceDoc)
  );

  // As the room will apply it: under an origin of its own.
  Y.applyUpdate(store.spaceDoc, added, 'room');
  await settled();

  expect(surface.getElementById('hologram2')).toBeInstanceOf(
    UnknownElementModel
  );
  expect(store.getModelById('card2')).toBeInstanceOf(UnknownCardModel);
  expect(store.getModelById('line2')?.flavour).toBe(UNKNOWN_BLOCK);
  expect(Y.encodeStateAsUpdate(store.spaceDoc)).toEqual(
    Y.encodeStateAsUpdate(peer)
  );
});

it("still takes out what the canvas's own person adds that it does not hold", async () => {
  const { note, update } = canvas();
  const { store, surface } = open(update, 'workspace');

  // A connector joined to nothing, and a copied placeholder pasted back.
  const connector = surface.addElement({
    source: {},
    target: {},
    type: 'connector',
  });
  const pasted = store.addBlock(UNKNOWN_BLOCK, {}, note);
  expect(surface.hasElementById(connector)).toBe(true);
  expect(store.hasBlock(pasted)).toBe(true);
  await settled();

  expect(elementsOf(store.spaceDoc).has(connector)).toBe(false);
  expect(blocksOf(store.spaceDoc).has(pasted)).toBe(false);
});

it("keeps what the canvas holds through its own person's undo and redo", async () => {
  const { store, surface } = open(canvas().update, 'workspace');
  const types = () => surface.elementModels.map(({ type }) => type);

  surface.addElement({
    children: {
      children: [{ children: [], text: 'Idea', xywh: '[200,0,80,35]' }],
      text: 'Topic',
      xywh: '[0,0,145,50]',
    },
    style: 1,
    type: 'mindmap',
  });
  await settled();
  expect(types()).toEqual(['shape', 'shape', 'mindmap']);

  // Redo brings it back through the same reading a peer's goes through.
  store.undo();
  store.redo();
  await settled();
  expect(types()).toEqual(['shape', 'shape', 'mindmap']);
});

it('keeps a question board to its catalog whatever adds to it', async () => {
  expect(() => checkSavedBoard(withUnknown().saved, 'question')).toThrow(
    BoardLoadError
  );

  const { note, update } = canvas();
  const { store } = open(update, 'question');
  const peer = new Y.Doc();
  Y.applyUpdate(peer, update);
  writeUnknown(peer, note, '');
  Y.applyUpdate(
    store.spaceDoc,
    Y.encodeStateAsUpdate(peer, Y.encodeStateVector(store.spaceDoc)),
    'room'
  );
  await settled();

  expect([...elementsOf(store.spaceDoc).keys()]).toEqual([]);
  expect(blocksOf(store.spaceDoc).has('card')).toBe(false);
});
