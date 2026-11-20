import { expect, it } from 'vitest';
import * as Y from 'yjs';
import { hiddenEdits } from './boardHidden';

/* What a canvas's re-applied early edits cannot show (Q33): an element or
 * block another person deleted meanwhile is offered alone; anything else the
 * re-apply hides (an edit inside a part another person replaced) offers the
 * whole early board, so nothing goes unsaid (review b2 re-check N3). */

/** A board as BlockSuite keeps one: a page, its surface, and on it a shape
 * `from` and a shape `label` with a text. */
function board() {
  const doc = new Y.Doc();
  doc.transact(() => {
    const blocks = doc.getMap<Y.Map<unknown>>('blocks');
    const page = new Y.Map<unknown>();
    blocks.set('page', page);
    page.set('sys:flavour', 'affine:page');
    const children = new Y.Array<string>();
    page.set('sys:children', children);
    children.push(['surface']);
    const surface = new Y.Map<unknown>();
    blocks.set('surface', surface);
    surface.set('sys:flavour', 'affine:surface');
    surface.set('sys:children', new Y.Array<string>());
    const wrapper = new Y.Map<unknown>();
    surface.set('prop:elements', wrapper);
    const value = new Y.Map<Y.Map<unknown>>();
    wrapper.set('value', value);
    const from = new Y.Map<unknown>();
    value.set('from', from);
    from.set('xywh', '[0,0,100,100]');
    const label = new Y.Map<unknown>();
    value.set('label', label);
    label.set('xywh', '[400,0,100,100]');
    const text = new Y.Text();
    label.set('text', text);
    text.insert(0, 'hi');
  });
  return doc;
}

const fork = (doc: Y.Doc) => {
  const copy = new Y.Doc();
  Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
  return copy;
};

const elements = (doc: Y.Doc) =>
  (
    doc.getMap<Y.Map<unknown>>('blocks').get('surface')?.get('prop:elements') as
      | Y.Map<Y.Map<Y.Map<unknown>>>
      | undefined
  )?.get('value') ?? new Y.Map<Y.Map<unknown>>();

/** The early board moved `from` and typed into `label`'s text; the room's
 * document (`joined`) holds what others did meanwhile, and `held` its state
 * before the re-apply. */
function early(others: (joined: Y.Doc) => void) {
  const base = board();
  const tab = fork(base);
  elements(tab).get('from')?.set('xywh', '[50,50,100,100]');
  const text = elements(tab).get('label')?.get('text');
  if (!(text instanceof Y.Text)) throw new Error('No label text');
  text.insert(2, '!');
  const joined = fork(base);
  others(joined);
  const held = Y.decodeStateVector(Y.encodeStateVector(joined));
  return { held, joined, tab };
}

it('offers alone the element another person deleted, the rest showing', () => {
  const { held, joined, tab } = early((joined) =>
    elements(joined).delete('from')
  );
  const hidden = hiddenEdits(tab, joined, held);
  expect([...elements(hidden ?? new Y.Doc()).keys()]).toEqual(['from']);
  expect(
    elements(hidden ?? new Y.Doc())
      .get('from')
      ?.get('xywh')
  ).toBe('[50,50,100,100]');
});

it('offers the whole early board when a hidden element comes with typing into a text another person replaced', () => {
  const { held, joined, tab } = early((joined) => {
    elements(joined).delete('from');
    elements(joined).get('label')?.set('text', new Y.Text('bye'));
  });
  const hidden = elements(hiddenEdits(tab, joined, held) ?? new Y.Doc());
  expect([...hidden.keys()].sort()).toEqual(['from', 'label']);
  expect(String(hidden.get('label')?.get('text'))).toBe('hi!');
});

it('shows everything when nothing the early board edited was deleted', () => {
  const { held, joined, tab } = early((joined) =>
    elements(joined).get('label')?.set('xywh', '[0,300,100,100]')
  );
  expect(hiddenEdits(tab, joined, held)).toBeNull();
});
