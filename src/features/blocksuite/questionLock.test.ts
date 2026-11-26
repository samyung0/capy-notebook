import { NoteStoreExtension } from '@blocksuite/affine/blocks/note/store';
import { ParagraphStoreExtension } from '@blocksuite/affine/blocks/paragraph/store';
import { RootStoreExtension } from '@blocksuite/affine/blocks/root/store';
import {
  DefaultTool,
  type SurfaceBlockModel,
} from '@blocksuite/affine/blocks/surface';
import { SurfaceStoreExtension } from '@blocksuite/affine/blocks/surface/store';
import { StoreExtensionManager } from '@blocksuite/affine/ext-loader';
import { BrushStoreExtension } from '@blocksuite/affine/gfx/brush/store';
import { ShapeStoreExtension } from '@blocksuite/affine/gfx/shape/store';
import { Bound } from '@blocksuite/affine/global/gfx';
import type { NoteBlockModel } from '@blocksuite/affine/model';
import type { BlockStdScope } from '@blocksuite/affine/std';
import type { GfxController } from '@blocksuite/affine/std/gfx';
import { TestWorkspace } from '@blocksuite/affine/store/test';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { anyOutside, moveArea, storedArea } from './boardArea';
import { boardFirstState } from './boardFirstState';
import { AREA_PROP, areaBox } from './boardGeometry';
import { savedCopy } from './boardKeep';
import { checkSavedBoard } from './boardLoad';
import { guardQuestion, holdsQuestion, questionCopy } from './questionLock';

/* A Canvas part (Epo 2026-11-23): the answer area's place kept in the board, and
 * the student's copy of the teacher's board with every part of the question
 * locked, run on BlockSuite's store and canvas model as `mountDrawingBoard`
 * opens an in-memory board, without the editor's view. */

const stores = new StoreExtensionManager([
  RootStoreExtension,
  SurfaceStoreExtension,
  NoteStoreExtension,
  ParagraphStoreExtension,
  BrushStoreExtension,
  ShapeStoreExtension,
]);

/** A board opened from `saved`, as an answer or a sample opens. */
function open(saved: Uint8Array) {
  const workspace = new TestWorkspace();
  workspace.storeExtensions = stores.get('store');
  workspace.meta.initialize();
  const store = workspace.createDoc('board').getStore();
  Y.applyUpdate(store.spaceDoc, saved);
  store.load();
  store.resetHistory();
  const [surface] = store.getModelsByFlavour(
    'affine:surface'
  ) as SurfaceBlockModel[];
  return { store, surface };
}

/** The teacher's question: a shape and a note, the area moved. */
function teachersBoard() {
  const { store, surface } = open(boardFirstState());
  surface.addElement({
    shapeType: 'rect',
    type: 'shape',
    xywh: '[400,200,100,100]',
  });
  const note = store.addBlock(
    'affine:note',
    { xywh: '[600,200,300,100]' },
    store.root?.id
  );
  store.addBlock('affine:paragraph', {}, note);
  moveArea(store, 300, 100);
  return savedCopy(store.spaceDoc, 'question');
}

it("keeps the area's place in the board: one step to undo, and saved with it", () => {
  const { store } = open(boardFirstState());
  expect(storedArea(store).serialize()).toBe('[0,0,1920,1200]');
  moveArea(store, 640.4, -200.6);
  expect(storedArea(store).serialize()).toBe('[640,-201,1920,1200]');
  const { blocks } = checkSavedBoard(
    savedCopy(store.spaceDoc, 'question'),
    'question'
  );
  const page = Object.values(blocks).find(
    (block) => block['sys:flavour'] === 'affine:page'
  );
  expect(areaBox(page?.[AREA_PROP])).toEqual({
    h: 1200,
    w: 1920,
    x: 640,
    y: -201,
  });
  store.undo();
  expect(storedArea(store).serialize()).toBe('[0,0,1920,1200]');
});

it('says when anything lies wholly or partly outside the area', () => {
  const area = new Bound(0, 0, 1920, 1200);
  const at = (x: number) => ({ elementBound: new Bound(x, 10, 100, 100) });
  expect(anyOutside(area, [at(10), at(1820)])).toBe(false);
  expect(anyOutside(area, [at(10), at(1900)])).toBe(true);
  expect(anyOutside(area, [at(4000)])).toBe(true);
});

it('copies a question board with every element and canvas block locked, its area where the teacher put it', () => {
  const copy = questionCopy(teachersBoard());
  const { blocks, elements } = checkSavedBoard(copy, 'question');
  expect(
    Object.values(elements).map(({ lockedBySelf }) => lockedBySelf)
  ).toEqual([true]);
  const note = Object.values(blocks).find(
    (block) => block['sys:flavour'] === 'affine:note'
  );
  expect(note?.['prop:lockedBySelf']).toBe(true);
  const page = Object.values(blocks).find(
    (block) => block['sys:flavour'] === 'affine:page'
  );
  expect(page?.[AREA_PROP]).toEqual([300, 100]);
  const doc = new Y.Doc();
  Y.applyUpdate(doc, copy);
  expect(holdsQuestion(doc)).toBe(true);
});

it("keeps the question's parts locked through a save and a reopen, and the student's own stroke unlocked", () => {
  const { store, surface } = open(questionCopy(teachersBoard()));
  // The copy is no step to undo.
  expect(store.canUndo).toBe(false);
  const stroke = surface.addElement({
    points: [
      [0, 0],
      [40, 20],
    ],
    type: 'brush',
    xywh: '[450,250,40,20]',
  });
  const reopened = open(savedCopy(store.spaceDoc, 'question'));
  const locked = (id: string) =>
    reopened.surface.getElementById(id)?.isLocked();
  const [shape] = reopened.surface.elementModels.filter(
    ({ type }) => type === 'shape'
  );
  expect(locked(shape.id)).toBe(true);
  expect(locked(stroke)).toBe(false);
  const [note] = reopened.store.getModelsByFlavour(
    'affine:note'
  ) as NoteBlockModel[];
  expect(note.isLocked()).toBe(true);
});

/** A BlockSuite slot or Subject, as far as the guard listens to it. */
function slot() {
  const listeners: (() => void)[] = [];
  return {
    next: () => {
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.push(listener);
      return { unsubscribe: () => undefined };
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('keeps the tip through a view update that moves nothing, and hides it once the board pans', () => {
  const { document, Event } = parseHTML('<div></div>');
  vi.stubGlobal('document', document);
  const frames: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (frame: FrameRequestCallback) =>
    frames.push(frame)
  );
  const viewport = {
    centerX: 960,
    centerY: 600,
    height: 600,
    toModelCoordFromClientCoord: ([x, y]: number[]) => [x, y],
    viewportUpdated: slot(),
    width: 800,
    zoom: 0.5,
  };
  // Everything under the pointer is part of the question.
  const gfx = {
    getElementByPoint: () => ({ isLocked: () => true }),
    selection: { selectedElements: [], slots: { updated: slot() } },
    tool: { currentToolName$: { peek: () => DefaultTool.toolName } },
    viewport,
  } as unknown as GfxController;
  const std = {
    get: () => ({ handleElementSelection: () => true }),
  } as unknown as BlockStdScope;
  const board = document.createElement('div');
  board.getBoundingClientRect = () => ({ left: 0, top: 0 }) as DOMRect;
  guardQuestion(std, gfx, board, 'Part of the question');
  const tip = board.querySelector('.capy-question-tip') as HTMLElement;

  board.dispatchEvent(
    Object.assign(new Event('pointermove'), {
      buttons: 0,
      clientX: 450,
      clientY: 400,
      pointerType: 'mouse',
    })
  );
  for (const frame of frames.splice(0)) frame(0);
  expect(tip.hidden).toBe(false);
  // BlockSuite's refresh once a view change settles: the same view.
  viewport.viewportUpdated.next();
  expect(tip.hidden).toBe(false);
  viewport.centerX += 120;
  viewport.viewportUpdated.next();
  expect(tip.hidden).toBe(true);
});
