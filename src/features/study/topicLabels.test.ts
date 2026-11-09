import { expect, it } from 'vitest';
import { topicSquares } from './topicLabels';

const count = (list: string[], name: string) =>
  list.filter((s) => s === name).length;

it('draws one square per question up to ten, unattempted last', () => {
  expect(
    topicSquares({ partial: 1, right: 2, unattempted: 2, wrong: 1 })
  ).toEqual([
    'right',
    'right',
    'partial',
    'wrong',
    'unattempted',
    'unattempted',
  ]);
});

it('scales a large topic to ten', () => {
  const squares = topicSquares({
    partial: 0,
    right: 40,
    unattempted: 40,
    wrong: 20,
  });
  expect(squares).toHaveLength(10);
  expect(count(squares, 'right')).toBe(4);
  expect(count(squares, 'wrong')).toBe(2);
  expect(count(squares, 'unattempted')).toBe(4);
});

it('keeps one grey square for any unattempted question', () => {
  const squares = topicSquares({
    partial: 0,
    right: 199,
    unattempted: 1,
    wrong: 0,
  });
  expect(squares).toHaveLength(10);
  expect(count(squares, 'unattempted')).toBe(1);
});

it('shows a topic nobody answered as all grey', () => {
  expect(
    topicSquares({ partial: 0, right: 0, unattempted: 30, wrong: 0 })
  ).toEqual(new Array(10).fill('unattempted'));
});
