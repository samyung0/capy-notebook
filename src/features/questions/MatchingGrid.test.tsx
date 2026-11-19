import { parseHTML } from 'linkedom';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { getLocale } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const { createRoot } = await import('react-dom/client');
const { MatchingGrid } = await import('./MatchingGrid');

const rows = ['Nucleus', 'Mitochondrion'];
const columns = ['Stores DNA', 'Makes ATP', 'Builds proteins'];
const host = document.createElement('div');
document.body.append(host);
let root: ReturnType<typeof createRoot>;
afterEach(() => act(() => root.unmount()));

async function show(props: Partial<Parameters<typeof MatchingGrid>[0]>) {
  root = createRoot(host);
  await act(async () =>
    root.render(
      <MatchingGrid columns={columns} label="Match" rows={rows} {...props} />
    )
  );
  // Each row's cells, as their radio inputs.
  return [...host.querySelectorAll('[role="radiogroup"]')].map((row) => [
    ...row.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
  ]);
}

it('sets each row in the editor by a click on a cell', async () => {
  const onPick = vi.fn();
  const grid = await show({ correct: [0, 1], onPick });
  expect(grid.map((row) => row.map((cell) => cell.checked))).toEqual([
    [true, false, false],
    [false, true, false],
  ]);
  const cell = grid[1][2];
  cell.checked = true;
  await act(async () => cell.click());
  expect(onPick).toHaveBeenCalledWith(1, 2);
});

it('names each row and cell for screen readers', async () => {
  const grid = await show({ value: [undefined, 1] });
  const groups = [...host.querySelectorAll('[role="radiogroup"]')];
  expect(groups.map((row) => row.getAttribute('aria-label'))).toEqual(rows);
  expect(grid[0].map((cell) => cell.getAttribute('aria-label'))).toEqual(
    columns.map((column) => `Nucleus: ${column}`)
  );
});

it('only reads without onPick, a checked answer showing its picks', async () => {
  const grid = await show({ correct: [0, 1], value: [0, 2] });
  expect(
    grid.flat().every((cell) => cell.getAttribute('aria-disabled') === 'true')
  ).toBe(true);
  expect(grid.map((row) => row.map((cell) => cell.checked))).toEqual([
    [true, false, false],
    [false, false, true],
  ]);
});

// A missed correct cell is not marked (Epo 2026-11-18): the correct answer
// lists apart under the grid.
it("names a checked answer's right and wrong picks", async () => {
  const grid = await show({ correct: [0, 1], value: [0, 2] });
  expect(
    grid.map((row) => row.map((cell) => cell.getAttribute('aria-label')))
  ).toEqual([
    [
      'Nucleus: Stores DNA, your answer, correct',
      'Nucleus: Makes ATP',
      'Nucleus: Builds proteins',
    ],
    [
      'Mitochondrion: Stores DNA',
      'Mitochondrion: Makes ATP',
      'Mitochondrion: Builds proteins, your answer, incorrect',
    ],
  ]);
});
