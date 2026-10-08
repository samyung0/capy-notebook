import { slateNodesToInsertDelta, yTextToSlateElement } from '@slate-yjs/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  applyMaterialCommands,
  applyTextCommands,
  type DocumentCommand,
  EditError,
  inspectMaterial,
  officeError,
  officeGuards,
  verifyMaterialGuards,
  verifyOfficeGuards,
  verifyTextGuards,
} from './editCommands.js';

function material(value: unknown[]) {
  const document = new Y.Doc();
  document
    .get('content', Y.XmlText)
    .applyDelta(slateNodesToInsertDelta(value as never));
  return document;
}

function blocks(document: Y.Doc) {
  return (
    yTextToSlateElement(document.get('content', Y.XmlText)) as unknown as {
      children: Array<{ id: string }>;
    }
  ).children;
}

const paragraph = (id: string, text: string) => ({
  children: [{ text }],
  id,
  type: 'p',
});

describe('material edit commands', () => {
  it('inspects and replaces a void question without losing its guarded Undo', () => {
    const question = {
      id: 'q1',
      labels: 'letters',
      layout: 'paper',
      parts: [
        {
          answer: { correct: true, type: 'boolean' },
          blocks: [{ text: 'True?', type: 'text' }],
          id: 'p1',
          marks: 1,
          solution: [],
        },
      ],
      stem: [{ text: 'Shared context', type: 'text' }],
    };
    const node = {
      children: [{ text: '' }],
      id: 'q1',
      question,
      type: 'quiz_question',
    };
    const document = material([
      { children: [node], id: 'quiz1', type: 'quiz' },
    ]);
    expect(
      JSON.parse(inspectMaterial(document)[0].children?.[0].text ?? '{}')
    ).toEqual(question);
    const replacement = {
      ...node,
      question: {
        ...question,
        stem: [{ text: 'Changed context', type: 'text' }],
      },
    };
    const result = applyMaterialCommands(document, [
      {
        node: replacement,
        nodeId: 'q1',
        parentType: 'quiz',
        type: 'replace_child',
      },
    ]);
    verifyMaterialGuards(document, result.guards);
    applyMaterialCommands(document, result.inverse);
    expect(
      JSON.parse(inspectMaterial(document)[0].children?.[0].text ?? '{}')
    ).toEqual(question);
    const chart = {
      kind: 'line',
      labels: ['A'],
      series: [{ name: 'S', values: [1] }],
      title: 'Trend',
      type: 'chart',
    };
    const notes = material([
      { block: chart, children: [{ text: '' }], id: 'chart1', type: 'chart' },
    ]);
    expect(
      JSON.parse(inspectMaterial(notes)[0].properties?.block ?? '{}')
    ).toEqual(chart);
  });
  it('replaces text, records the inverse and undoes through it', () => {
    const document = material([
      paragraph('b1', 'alpha beta'),
      paragraph('b2', 'gamma'),
    ]);
    const outcome = applyMaterialCommands(document, [
      {
        blockId: 'b1',
        expectedText: 'beta',
        text: 'delta',
        type: 'replace_text',
      },
    ]);
    expect(inspectMaterial(document)[0].text).toBe('alpha delta');
    expect(outcome.guards.map((guard) => guard.kind)).toEqual(['block']);
    verifyMaterialGuards(document, outcome.guards);
    applyMaterialCommands(document, outcome.inverse);
    expect(inspectMaterial(document)[0].text).toBe('alpha beta');
  });

  it('keeps links and inline equations in other blocks and beside the replaced span', () => {
    const rich = (id: string, where: string, grows: string) => ({
      children: [
        { text: 'See ' },
        { children: [{ text: 'the source' }], type: 'a', url: 'https://x.org' },
        { text: where },
        {
          children: [{ text: '' }],
          texExpression: 'x^2',
          type: 'inline_equation',
        },
        { text: grows },
      ],
      id,
      type: 'p',
    });
    const document = material([
      rich('b1', ' where ', ' grows fast.'),
      rich('b2', ' where ', ' grows fast.'),
    ]);
    // Each span starts right after one inline element and the first ends
    // right before the other.
    applyMaterialCommands(document, [
      {
        blockId: 'b1',
        expectedText: ' where ',
        text: ' when ',
        type: 'replace_text',
      },
      {
        blockId: 'b1',
        expectedText: ' grows fast.',
        text: ' grows quickly.',
        type: 'replace_text',
      },
    ]);
    expect(blocks(document)).toEqual([
      rich('b1', ' when ', ' grows quickly.'),
      rich('b2', ' where ', ' grows fast.'),
    ]);
  });

  it('names a missed target as it reads now', () => {
    const document = material([
      paragraph('b1', 'alpha beta'),
      paragraph('b2', 'gamma'),
    ]);
    const refusal = (command: DocumentCommand) => {
      try {
        applyMaterialCommands(document, [command]);
      } catch (error) {
        return error;
      }
      throw new Error('the edit applied');
    };
    expect(
      refusal({
        blockId: 'b1',
        expectedText: 'delta',
        text: 'x',
        type: 'replace_text',
      })
    ).toMatchObject({
      code: 'stale_target',
      details: { block: { id: 'b1', text: 'alpha beta', type: 'p' } },
    });
    expect(
      refusal({ blockId: 'b2', expectedText: 'gam', type: 'remove_block' })
    ).toMatchObject({
      code: 'stale_target',
      details: { block: { id: 'b2', text: 'gamma', type: 'p' } },
    });
    expect(
      refusal({
        blockId: 'gone',
        expectedText: 'x',
        text: 'y',
        type: 'replace_text',
      })
    ).toMatchObject({
      code: 'unavailable_target',
      details: {
        blocks: [
          { id: 'b1', text: 'alpha beta', type: 'p' },
          { id: 'b2', text: 'gamma', type: 'p' },
        ],
        total: 2,
      },
    });
  });

  it('lands an insert whose anchor block is gone and undoes it', () => {
    const document = material([
      paragraph('b1', 'alpha'),
      paragraph('b2', 'beta'),
      paragraph('b3', 'gamma'),
    ]);
    const ids = () => blocks(document).map((block) => block.id);
    // Deleted before this call: its place is unknown, so the end.
    const late = applyMaterialCommands(document, [
      {
        afterBlockId: 'deleted',
        blocks: [paragraph('n1', 'one')],
        type: 'insert_block',
      },
    ]);
    expect(late.relocated).toEqual([
      { after: 'b3', anchor: 'deleted', end: true },
    ]);
    expect(ids()).toEqual(['b1', 'b2', 'b3', 'n1']);
    verifyMaterialGuards(document, late.guards);
    applyMaterialCommands(document, late.inverse);
    expect(ids()).toEqual(['b1', 'b2', 'b3']);
    // Removed earlier in the same call: the blocks take its place.
    const swap = applyMaterialCommands(document, [
      { blockId: 'b2', expectedText: 'beta', type: 'remove_block' },
      {
        afterBlockId: 'b2',
        blocks: [paragraph('n2', 'two')],
        type: 'insert_block',
      },
    ]);
    expect(swap.relocated).toEqual([{ after: 'b1', anchor: 'b2', end: false }]);
    expect(ids()).toEqual(['b1', 'n2', 'b3']);
    verifyMaterialGuards(document, swap.guards);
    applyMaterialCommands(document, swap.inverse);
    expect(ids()).toEqual(['b1', 'b2', 'b3']);
  });

  it('shows math as written and replaces a whole block, which Undo restores in place', () => {
    const line = {
      children: [
        { text: 'The slope ' },
        {
          children: [{ text: '' }],
          texExpression: 'm',
          type: 'inline_equation',
        },
        { text: ' is steep.' },
      ],
      id: 'b1',
      type: 'p',
    };
    const formula = {
      children: [{ text: '' }],
      id: 'f1',
      texExpression: 'P(X=k)',
      type: 'equation',
    };
    const document = material([line, formula, paragraph('b3', 'end')]);
    expect(inspectMaterial(document).map((block) => block.text)).toEqual([
      'The slope $m$ is steep.',
      '$$P(X=k)$$',
      'end',
    ]);
    // Text is matched as shown; only the plain text around math changes.
    expect(() =>
      applyMaterialCommands(document, [
        {
          blockId: 'b1',
          expectedText: 'slope $m$',
          text: 'gradient',
          type: 'replace_text',
        },
      ])
    ).toThrow('replace_block');
    const edited = applyMaterialCommands(document, [
      {
        blockId: 'b1',
        expectedText: ' is steep.',
        text: ' is gentle.',
        type: 'replace_text',
      },
    ]);
    expect(inspectMaterial(document)[0].text).toBe('The slope $m$ is gentle.');
    applyMaterialCommands(document, edited.inverse);
    expect(blocks(document)[0]).toEqual(line);

    const replaced = applyMaterialCommands(document, [
      {
        blockId: 'f1',
        blocks: [
          { children: [{ text: 'Binomial' }], id: 'n1', type: 'h2' },
          paragraph('n2', 'The chance of k successes.'),
        ],
        expectedText: '$$P(X=k)$$',
        type: 'replace_block',
      },
    ]);
    expect(blocks(document).map((block) => block.id)).toEqual([
      'b1',
      'n1',
      'n2',
      'b3',
    ]);
    verifyMaterialGuards(document, replaced.guards);
    applyMaterialCommands(document, replaced.inverse);
    expect(blocks(document)).toEqual([line, formula, paragraph('b3', 'end')]);
    expect(() =>
      applyMaterialCommands(document, [
        {
          blockId: 'f1',
          blocks: [paragraph('n3', 'x')],
          expectedText: '$$P(X=1)$$',
          type: 'replace_block',
        },
      ])
    ).toThrow(
      expect.objectContaining({
        details: { block: { id: 'f1', text: '$$P(X=k)$$', type: 'equation' } },
      })
    );
  });

  it('exposes an embedded material reference by id and kind', () => {
    const document = material([
      paragraph('b1', 'intro'),
      {
        children: [{ text: '' }],
        id: 'r1',
        materialId: 'mat_q',
        refKind: 'quiz',
        type: 'material_ref',
      },
    ]);
    expect(inspectMaterial(document)[1]).toEqual({
      id: 'r1',
      properties: { materialId: 'mat_q', refKind: 'quiz' },
      text: '',
      type: 'material_ref',
    });
  });

  it('undoes its own deletion immediately and refuses once the gap was written and reverted', () => {
    const document = material([
      paragraph('b1', 'alpha'),
      paragraph('b2', 'beta'),
      paragraph('b3', 'gamma'),
    ]);
    const removal = applyMaterialCommands(document, [
      { blockId: 'b2', expectedText: 'beta', type: 'remove_block' },
    ]);
    expect(removal.guards.map((guard) => guard.kind)).toEqual(['gap']);
    verifyMaterialGuards(document, removal.guards);
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(document));
    verifyMaterialGuards(restored, removal.guards);
    applyMaterialCommands(restored, removal.inverse);
    expect(blocks(restored).map((block) => block.id)).toEqual([
      'b1',
      'b2',
      'b3',
    ]);
    // Insert-then-delete inside the gap leaves a tombstone the guard sees.
    applyMaterialCommands(document, [
      {
        afterBlockId: 'b1',
        blocks: [paragraph('bx', 'x')],
        type: 'insert_block',
      },
    ]);
    applyMaterialCommands(document, [
      { blockId: 'bx', expectedText: 'x', type: 'remove_block' },
    ]);
    expect(blocks(document).map((block) => block.id)).toEqual(['b1', 'b3']);
    expect(() => verifyMaterialGuards(document, removal.guards)).toThrow(
      'changed since this edit'
    );
  });

  it('keeps an Undo valid when a neighbouring block or another card changes', () => {
    const card = (id: string, front: string) => ({
      children: [
        { children: [{ text: front }], type: 'flashcard_front' },
        { children: [{ text: `${front} back` }], type: 'flashcard_back' },
      ],
      id,
      type: 'flashcard',
    });
    const document = material([
      paragraph('b1', 'alpha'),
      paragraph('b2', 'beta'),
      {
        children: [card('c1', 'one'), card('c2', 'two')],
        id: 'deck',
        type: 'flashcards',
      },
    ]);
    const outcome = applyMaterialCommands(document, [
      {
        blockId: 'b2',
        expectedText: 'beta',
        text: 'BETA',
        type: 'replace_text',
      },
      {
        node: card('c1', 'uno'),
        nodeId: 'c1',
        parentType: 'flashcards',
        type: 'replace_child',
      },
    ]);
    expect(outcome.guards.map((guard) => guard.kind)).toEqual([
      'block',
      'child',
    ]);
    applyMaterialCommands(document, [
      {
        blockId: 'b1',
        expectedText: 'alpha',
        text: 'ALPHA',
        type: 'replace_text',
      },
      {
        node: card('c2', 'dos'),
        nodeId: 'c2',
        parentType: 'flashcards',
        type: 'replace_child',
      },
    ]);
    verifyMaterialGuards(document, outcome.guards);
    applyMaterialCommands(document, [
      {
        node: card('c1', 'ein'),
        nodeId: 'c1',
        parentType: 'flashcards',
        type: 'replace_child',
      },
    ]);
    expect(() => verifyMaterialGuards(document, outcome.guards)).toThrow(
      EditError
    );
  });

  it('guards a gap after the nearest surviving block when one call removes adjacent blocks', () => {
    const document = material([
      paragraph('b1', 'alpha'),
      paragraph('b2', 'beta'),
      paragraph('b3', 'gamma'),
      paragraph('b4', 'delta'),
    ]);
    const outcome = applyMaterialCommands(document, [
      { blockId: 'b3', expectedText: 'gamma', type: 'remove_block' },
      { blockId: 'b2', expectedText: 'beta', type: 'remove_block' },
    ]);
    expect(blocks(document).map((block) => block.id)).toEqual(['b1', 'b4']);
    expect(outcome.guards).toMatchObject([{ afterBlockId: 'b1', kind: 'gap' }]);
    verifyMaterialGuards(document, outcome.guards);
    applyMaterialCommands(document, outcome.inverse);
    expect(blocks(document).map((block) => block.id)).toEqual([
      'b1',
      'b2',
      'b3',
      'b4',
    ]);
  });

  it('drops the guard of a node the same call removed again', () => {
    const document = material([
      paragraph('b1', 'alpha'),
      paragraph('b2', 'beta'),
    ]);
    const outcome = applyMaterialCommands(document, [
      {
        afterBlockId: 'b1',
        blocks: [paragraph('b9', 'nine')],
        type: 'insert_block',
      },
      { blockId: 'b9', expectedText: 'nine', type: 'remove_block' },
    ]);
    expect(blocks(document).map((block) => block.id)).toEqual(['b1', 'b2']);
    expect(outcome.guards.map((guard) => guard.kind)).toEqual(['gap']);
    verifyMaterialGuards(document, outcome.guards);
  });

  it('keeps a gap Undo valid when a block two away is deleted', () => {
    const document = material([
      paragraph('b1', 'alpha'),
      paragraph('b2', 'beta'),
      paragraph('b3', 'gamma'),
      paragraph('b4', 'delta'),
    ]);
    const removal = applyMaterialCommands(document, [
      { blockId: 'b2', expectedText: 'beta', type: 'remove_block' },
    ]);
    applyMaterialCommands(document, [
      { blockId: 'b4', expectedText: 'delta', type: 'remove_block' },
    ]);
    verifyMaterialGuards(document, removal.guards);
  });

  it('keeps a gap Undo valid when a neighbour block is edited', () => {
    const document = material([
      paragraph('b1', 'alpha'),
      paragraph('b2', 'beta'),
    ]);
    const removal = applyMaterialCommands(document, [
      { blockId: 'b2', expectedText: 'beta', type: 'remove_block' },
    ]);
    applyMaterialCommands(document, [
      {
        blockId: 'b1',
        expectedText: 'alpha',
        text: 'alpha!',
        type: 'replace_text',
      },
    ]);
    verifyMaterialGuards(document, removal.guards);
  });

  it('refuses a stale expectation before changing anything', () => {
    const document = material([paragraph('b1', 'alpha')]);
    expect(() =>
      applyMaterialCommands(document, [
        {
          blockId: 'b1',
          expectedText: 'nope',
          text: 'x',
          type: 'replace_text',
        },
        {
          afterBlockId: 'b1',
          blocks: [paragraph('b9', 'new')],
          type: 'insert_block',
        },
      ])
    ).toThrow(EditError);
    expect(blocks(document)).toHaveLength(1);
  });

  it('guards fail once the edited block changed after the edit', () => {
    const document = material([
      paragraph('b1', 'alpha'),
      paragraph('b2', 'beta'),
    ]);
    const outcome = applyMaterialCommands(document, [
      {
        afterBlockId: 'b1',
        blocks: [paragraph('b3', 'inserted')],
        type: 'insert_block',
      },
    ]);
    expect(blocks(document).map((block) => block.id)).toEqual([
      'b1',
      'b3',
      'b2',
    ]);
    verifyMaterialGuards(document, outcome.guards);
    applyMaterialCommands(document, [
      {
        blockId: 'b3',
        expectedText: 'inserted',
        text: 'changed',
        type: 'replace_text',
      },
    ]);
    expect(() => verifyMaterialGuards(document, outcome.guards)).toThrow(
      'changed since this edit'
    );
    expect(() =>
      applyMaterialCommands(document, [
        { blockId: 'b3', expectedText: 'changed', type: 'remove_block' },
      ])
    ).not.toThrow();
    expect(() => verifyMaterialGuards(document, outcome.guards)).toThrow(
      EditError
    );
  });
});

describe('text source commands', () => {
  it('replaces a unique span and its guard covers the new text', () => {
    const document = new Y.Doc();
    document.getText('source').insert(0, 'one two three');
    const outcome = applyTextCommands(document, [
      { expectedText: 'two', text: '2', type: 'replace_text' },
    ]);
    expect(document.getText('source').toString()).toBe('one 2 three');
    const batch = new Y.Doc();
    batch.getText('source').insert(0, 'AAA BBB');
    const both = applyTextCommands(batch, [
      { expectedText: 'BBB', text: 'CCCCCC', type: 'replace_text' },
      { expectedText: 'AAA', text: '', type: 'replace_text' },
    ]);
    expect(batch.getText('source').toString()).toBe(' CCCCCC');
    expect(both.guards).toMatchObject([
      { length: 6, offset: 1 },
      { length: 0, offset: 0 },
    ]);
    verifyTextGuards(batch, both.guards);
    // A moved span is re-found by its text; a changed one is refused.
    const moved = new Y.Doc();
    moved.getText('source').insert(0, 'one two three');
    const single = applyTextCommands(moved, [
      { expectedText: 'two', text: '2', type: 'replace_text' },
    ]);
    moved.getText('source').insert(0, 'prefix ');
    verifyTextGuards(moved, single.guards);
    // Typing right beside the replaced span leaves it intact.
    moved.getText('source').insert(11, '!');
    verifyTextGuards(moved, single.guards);
    moved
      .getText('source')
      .delete(moved.getText('source').toString().indexOf('2'), 1);
    expect(() => verifyTextGuards(moved, single.guards)).toThrow(EditError);
    const overlapping = new Y.Doc();
    overlapping.getText('source').insert(0, 'abcdef');
    expect(() =>
      applyTextCommands(overlapping, [
        { expectedText: 'bcd', text: 'X', type: 'replace_text' },
        { expectedText: 'aX', text: 'y', type: 'replace_text' },
      ])
    ).toThrow('overlap');
    expect(outcome.guards[0]).toMatchObject({
      kind: 'text',
      length: 1,
      offset: 4,
    });
    verifyTextGuards(document, outcome.guards);
    document.getText('source').insert(5, '!');
    verifyTextGuards(document, outcome.guards);
    document.getText('source').delete(4, 1);
    expect(() => verifyTextGuards(document, outcome.guards)).toThrow(EditError);
  });

  it('refuses ambiguous expectations', () => {
    const document = new Y.Doc();
    document.getText('source').insert(0, 'aa aa');
    expect(() =>
      applyTextCommands(document, [
        { expectedText: 'aa', text: 'b', type: 'replace_text' },
      ])
    ).toThrow(EditError);
  });
});

describe('office guards', () => {
  function storyState(text: string) {
    const document = new Y.Doc();
    const stories = document.getMap('stories');
    const story = new Y.Text();
    stories.set('body', story);
    story.insert(0, text);
    return document;
  }

  it('derive item runs from engine locators and detect later changes', () => {
    const document = storyState('hello world');
    const guards = officeGuards(Y.encodeStateAsUpdate(document), [
      { id: 'body:paragraph:p1', path: ['stories', 'body'], range: [0, 5] },
    ]);
    expect(guards[0]).toMatchObject({
      id: 'body:paragraph:p1',
      kind: 'office',
    });
    const located = [
      {
        id: 'body:paragraph:p1',
        path: ['stories', 'body'],
        range: [0, 5] as [number, number],
      },
    ];
    verifyOfficeGuards(Y.encodeStateAsUpdate(document), guards, located);
    expect(() =>
      verifyOfficeGuards(Y.encodeStateAsUpdate(document), guards, [])
    ).toThrow('is gone');
    (document.getMap('stories').get('body') as Y.Text).insert(2, 'X');
    expect(() =>
      verifyOfficeGuards(Y.encodeStateAsUpdate(document), guards, located)
    ).toThrow('changed since this edit');
  });

  it('cover XLSX cell map entries, including a later rewrite to the same value', () => {
    const document = new Y.Doc();
    const contents = new Y.Map();
    const sheet = new Y.Map();
    document.getMap('xlsx:sheets').set('s1', sheet);
    sheet.set('contents', contents);
    contents.set('[1,1]', 'v');
    const target = {
      id: 's1:[1,1]',
      path: ['xlsx:sheets', 's1', 'contents', '[1,1]'],
    };
    const guards = officeGuards(Y.encodeStateAsUpdate(document), [target]);
    verifyOfficeGuards(Y.encodeStateAsUpdate(document), guards, [target]);
    contents.set('[1,1]', 'v');
    expect(() =>
      verifyOfficeGuards(Y.encodeStateAsUpdate(document), guards, [target])
    ).toThrow(EditError);
    expect(
      officeGuards(Y.encodeStateAsUpdate(document), [target])[0].runs
    ).not.toEqual(guards[0].runs);
  });

  it('map engine refusals onto edit errors', () => {
    const mapped = officeError(new Error('stale_target: the cell moved'));
    expect(mapped).toBeInstanceOf(EditError);
    expect((mapped as EditError).code).toBe('stale_target');
    expect((mapped as EditError).message).toBe('the cell moved');
    const other = new Error('worker died');
    expect(officeError(other)).toBe(other);
  });
});
