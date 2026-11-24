import { expect, it } from 'vitest';
import { removePart, splitPart, withKeptPart } from './groups';
import {
  answerAbove,
  answerOwn,
  bindFigure,
  changeBlocks,
  duplicateQuestion,
  isBlankPart,
  newPart,
  newQuestionBlock,
  sampleWithinCap,
  saveFigure,
  sectionBlocks,
  withAnswer,
} from './questionEdits';
import {
  blankQuestion,
  type Question,
  type QuestionBlock,
  type QuestionPart,
} from './types';

it('duplicates a question with new ids, its parts still in their group', () => {
  const [first] = blankQuestion().parts;
  const question: Question = {
    ...blankQuestion(),
    groups: [{ blocks: [{ text: 'Shared', type: 'text' }], id: 'g1' }],
    parts: [
      { ...first, group: 'g1', id: 'p1' },
      { ...first, group: 'g1', id: 'p2' },
    ],
  };
  const copy = duplicateQuestion(question);
  expect(copy.id).not.toBe(question.id);
  const group = copy.groups?.[0].id;
  expect(group).not.toBe('g1');
  expect(copy.parts.map((part) => part.group)).toEqual([group, group]);
  expect(copy.parts.map((part) => part.id)).not.toContain('p1');
  expect(copy.groups?.[0].blocks).toEqual(question.groups?.[0].blocks);
});

// Its blanks stay numbered, so lists kept for the tab match them on the way
// back (Epo 2026-11-23).
it('keeps the text and its numbered blanks, turned away from Fill in the blanks', () => {
  const [first] = blankQuestion().parts;
  const blocks: QuestionBlock[] = [
    { text: 'Water boils at (1) ______ °C.', type: 'text' },
  ];
  const part = withAnswer(
    { ...first, answer: { accepted: [['100']], type: 'gaps' }, blocks },
    { accepted: [], type: 'short' }
  );
  expect(part.blocks).toEqual(blocks);
});

// A part turned into a canvas part keeps its canvas, else gets an empty one
// (Epo 2026-11-23).
it('gives a part turned into a canvas part one canvas', () => {
  const [first] = blankQuestion().parts;
  const turned = withAnswer(first, { type: 'canvas' });
  expect(turned.blocks).toEqual([...first.blocks, { type: 'canvas' }]);
  const drawn = { board: 'b', image: 'i', type: 'canvas' } as const;
  const shown = { ...first, blocks: [...first.blocks, drawn] };
  expect(withAnswer(shown, { type: 'canvas' }).blocks).toEqual(shown.blocks);
});

// Same canvas takes the part's own canvas out for the tab; New canvas puts
// it back where it sat, else adds an empty one (Epo 2026-11-23).
it("moves a canvas part's own canvas out on Same canvas and back on New", () => {
  const [first] = blankQuestion().parts;
  const drawn = { board: 'b', image: 'i', type: 'canvas' } as const;
  const own = {
    ...first,
    answer: { type: 'canvas' as const },
    blocks: [drawn, ...first.blocks],
  };
  const { kept, part: same } = answerAbove(own);
  expect(same.answer).toEqual({ shared: true, type: 'canvas' });
  expect(same.blocks).toEqual(first.blocks);
  expect(kept).toEqual({ block: drawn, index: 0 });
  expect(answerOwn(same, kept)).toEqual(own);
  expect(answerOwn(same).blocks).toEqual([...first.blocks, { type: 'canvas' }]);
  // Turned into a canvas part answering above, it gets no canvas of its own.
  expect(withAnswer(first, { shared: true, type: 'canvas' }).blocks).toEqual(
    first.blocks
  );
});

// A shared part holding a view-only canvas answers on it on New canvas, the
// one Same took left aside: one canvas a list (Epo 2026-11-23).
it('makes a canvas a shared part holds its own on New canvas', () => {
  const [first] = blankQuestion().parts;
  const shown = { board: 'b', image: 'i', type: 'canvas' } as const;
  const shared = {
    ...first,
    answer: { shared: true as const, type: 'canvas' as const },
    blocks: [...first.blocks, shown],
  };
  const kept = { block: { type: 'canvas' as const }, index: 0 };
  expect(answerOwn(shared, kept)).toEqual({
    ...shared,
    answer: { type: 'canvas' },
  });
});

// Two editors' marking items merged an open part to 26 marks (Epo
// 2026-11-22); turned closed, it carries the 20 a closed part may.
it('holds marks merged past the cap to it when an open part turns closed', () => {
  const [first] = blankQuestion().parts;
  const open = {
    ...first,
    answer: { accepted: [], type: 'open' as const },
    marks: 26,
    markscheme: [
      { marks: 13, text: 'One' },
      { marks: 13, text: 'Two' },
    ],
  };
  expect(withAnswer(open, { accepted: ['a'], type: 'short' }).marks).toBe(20);
  expect(withAnswer(open, { accepted: [['a']], type: 'gaps' }).marks).toBe(20);
});

// Epo 2026-11-24: what Add part kept goes back only into a part still blank,
// in a group or not, as the room reads it back.
it('tells a part still as Add part made it', () => {
  const blank = newPart();
  expect(isBlankPart({ ...blank, group: 'g', markscheme: undefined })).toBe(
    true
  );
  expect(isBlankPart({ ...blank, marks: 2 })).toBe(false);
});

// Epo 2026-11-24: a kept drawn sample that would take the question past 4
// canvases stays in the tab's memory; the rest of the kept answer comes back.
// Here (b) was split into sub-parts, its sample kept, and (a) drew a sample
// meanwhile.
it('holds a restored drawn sample off past the canvas cap', () => {
  const canvas = { type: 'canvas' as const };
  const sample = { board: 's', image: 't' };
  const scheme = [{ marks: 1, text: 'Right.' }];
  const own = (id: string): QuestionPart => ({
    ...newPart(),
    answer: { type: 'canvas' },
    blocks: [{ text: 'Draw it.', type: 'text' }, canvas],
    id,
    markscheme: scheme,
  });
  const question: Question = {
    ...blankQuestion(),
    parts: [own('a'), { ...own('b'), answer: { sample, type: 'canvas' } }],
    stem: [{ text: 'A cross.', type: 'text' }, canvas],
  };
  const { kept, question: split } = splitPart(question, 'b', 'g', newPart(), {
    ...newPart(),
    id: 'y',
  });
  if (!kept) throw new Error('nothing kept');
  const [x] = kept.parts;
  const drawn = {
    ...split,
    parts: split.parts.map((part) =>
      part.id === 'a'
        ? { ...part, answer: { sample, type: 'canvas' as const } }
        : part
    ),
  };
  const back = withKeptPart(removePart(drawn, 'y'), x, kept);
  const { held, question: capped } = sampleWithinCap(back, x);
  expect(held).toEqual(sample);
  const restored = capped.parts.find((part) => part.id === x);
  expect(restored?.answer).toEqual({ type: 'canvas' });
  expect(restored?.markscheme).toEqual(scheme);
});

// A co-editor added text B above while the chart's dialog was open: Save
// replaces the chart, not text A now at its old place.
it('saves a figure where it is now, never over another block', () => {
  const text = (value: string): QuestionBlock => ({
    text: value,
    type: 'text',
  });
  const chart = text('old chart');
  const saved = text('new chart');
  const now = [text('B'), text('A'), chart];
  expect(saveFigure(now, { block: chart, index: 1 }, saved)).toEqual([
    text('B'),
    text('A'),
    saved,
  ]);
  // A new figure goes after the block it was added after.
  expect(
    saveFigure(
      now,
      { before: text('A'), block: saved, index: 1, isNew: true },
      saved
    )
  ).toEqual([text('B'), text('A'), saved, chart]);
});

// A draft has no room: a chart just added goes into the question at once,
// each dialog change is written to the question, and Remove takes it out.
it('edits a draft’s new chart in the question as it is made', () => {
  const [part] = blankQuestion().parts;
  const text: QuestionBlock = { text: 'A', type: 'text' };
  let question: Question = {
    ...blankQuestion(),
    parts: [{ ...part, blocks: [text] }],
  };
  const section = { partId: part.id };
  const block = newQuestionBlock('chart');
  const opened = bindFigure(
    { before: text, block, index: 1, isNew: true, section },
    {
      question: question.id,
      writeBlocks: (at, change) => {
        question = changeBlocks(
          question,
          at,
          change(sectionBlocks(question, at))
        );
        return question;
      },
    }
  );
  if (!opened) throw new Error('not added');
  expect(opened.index).toBe(1);
  expect(question.parts[0].blocks).toEqual([text, block]);
  opened.binding.setFields({ title: 'Rain' });
  const { labels, series } = opened.binding.read() ?? {
    labels: [],
    series: [],
  };
  opened.binding.setChartCell(series[0], labels[0], 4);
  expect(question.parts[0].blocks).toEqual([
    text,
    { ...block, series: [{ name: '', values: [4] }], title: 'Rain' },
  ]);
  opened.binding.remove();
  expect(question.parts[0].blocks).toEqual([text]);
});
