import { expect, it } from 'vitest';
import {
  bindFigure,
  changeBlocks,
  duplicateQuestion,
  newQuestionBlock,
  saveFigure,
  sectionBlocks,
  withAnswer,
} from './questionEdits';
import { blankQuestion, type Question, type QuestionBlock } from './types';

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

it('keeps the text, blanks as plain lines, turned away from Fill in the blanks', () => {
  const [first] = blankQuestion().parts;
  const part = withAnswer(
    {
      ...first,
      answer: { accepted: [['100']], type: 'gaps' },
      blocks: [{ text: 'Water boils at (1) ______ °C.', type: 'text' }],
    },
    { accepted: [], type: 'short' }
  );
  expect(part.blocks).toEqual([
    { text: 'Water boils at ______ °C.', type: 'text' },
  ]);
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
