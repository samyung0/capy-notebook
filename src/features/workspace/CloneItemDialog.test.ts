import { expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { cloneErrorMessage } from './CloneItemDialog';

it('says an unreadable source cannot be copied, not that the input was refused', () => {
  const unreadable = new ApiError(422, 'Unprocessable Entity', undefined, {
    code: 'material_content_unreadable',
  });
  expect(cloneErrorMessage(unreadable)).toBe(
    "This item can't be copied because its stored content could not be read."
  );
});
