import { expect, it } from 'vitest';
import { sourcePercentages } from './WorkspaceSettingsDialog';

it('rounds disjoint source categories to exactly 100 percent and leaves an empty workspace empty', () => {
  expect(sourcePercentages([1, 1, 1])).toEqual([34, 33, 33]);
  expect(sourcePercentages([1, 2, 4])).toEqual([14, 29, 57]);
  expect(sourcePercentages([0, 0, 8])).toEqual([0, 0, 100]);
  expect(sourcePercentages([0, 0, 0])).toEqual([0, 0, 0]);
});
