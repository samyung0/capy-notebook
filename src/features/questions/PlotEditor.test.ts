import { type ChangeEvent, isValidElement, type ReactNode } from 'react';
import { expect, it } from 'vitest';
import { m } from '@/i18n';
import { PlotEditor } from './BlockEditor';
import { blockIssues } from './issues';
import { blockWithoutBlanks, type PlotBlock } from './types';
import { questionBlockSchema } from './validation';

type Cell = {
  'aria-label'?: string;
  children?: ReactNode;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  onValue?: (value: number) => void;
};

/** The input under `node` with this accessible label. PlotEditor holds no
 * hooks, so calling it returns its element tree. */
function input(node: ReactNode, label: string): Cell | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = input(child, label);
      if (found) return found;
    }
    return;
  }
  if (!isValidElement<Cell>(node)) return;
  if (node.props['aria-label'] === label) return node.props;
  return input(node.props.children, label);
}

/** Types into the input labelled `label` and returns the block it makes. */
function edit(
  block: PlotBlock,
  label: string,
  typed: (cell: Cell) => void
): PlotBlock {
  let next: PlotBlock | undefined;
  const cell = input(
    PlotEditor({
      block,
      descriptionMax: 500,
      onChange: (value) => {
        next = value;
      },
    }),
    label
  );
  if (!cell) throw new Error(`No input labelled ${label}`);
  typed(cell);
  if (!next) throw new Error(`${label} changed nothing`);
  return next;
}

it('edits a point and a series name into a plot the note dialog saves', () => {
  const plot: PlotBlock = {
    lines: [{ axis: 'y', label: 'Threshold', value: -55 }],
    marks: [{ label: 'Peak', x: 1, y: 30 }],
    series: [
      {
        name: 'Vm',
        points: [
          [0, -70],
          [1, 30],
          [2, -80],
        ],
      },
    ],
    title: 'Action potential',
    type: 'plot',
    xTitle: 'Time (ms)',
    yTitle: 'Membrane potential (mV)',
  };
  const point = m.question_ui_plot_point_y({ number: 2, series: 1 });
  const renamed = edit(plot, m.question_ui_series_name({ number: 1 }), (cell) =>
    cell.onChange?.({
      target: { value: 'Membrane' },
    } as ChangeEvent<HTMLInputElement>)
  );
  const moved = edit(renamed, point, (cell) => cell.onValue?.(40));
  expect(moved).toEqual({
    ...plot,
    series: [
      {
        name: 'Membrane',
        points: [
          [0, -70],
          [1, 40],
          [2, -80],
        ],
      },
    ],
  });
  // What the dialog's Save runs: no issue holds it, and the block parses.
  expect(blockIssues(moved)).toEqual([]);
  expect(questionBlockSchema.parse(blockWithoutBlanks(moved))).toEqual(moved);
  // An emptied cell keeps Save off with the plot's own issue.
  expect(
    blockIssues(edit(moved, point, (cell) => cell.onValue?.(Number.NaN)))
  ).toEqual([
    m.question_issue_plot({ message: m.question_validation_plot_number() }),
  ]);
});
