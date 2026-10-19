import { expect, it } from 'vitest';
import { clonedToast } from './CloneWorkspaceDialog';

it('warns that some files were not copied only when the clone left some out', () => {
  expect(clonedToast(2)).toEqual({
    title: 'Workspace cloned, but some files could not be copied',
    variant: 'warning',
  });
  expect(clonedToast(0)).toEqual({
    title: 'Workspace cloned successfully',
    variant: 'success',
  });
});
