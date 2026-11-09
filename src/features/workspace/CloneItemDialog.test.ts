import { expect, it } from 'vitest';
import { ApiError } from '@/api/client';
import { cloneErrorMessage } from './CloneItemDialog';

it('says a text file over the text cap is refused for being text (Q629, Q630)', () => {
  const refused = (text: boolean) =>
    new ApiError(400, 'Bad Request', undefined, {
      code: 'file_too_large',
      maxBytes: 2 << 20,
      text,
    });
  expect(cloneErrorMessage(refused(true))).toBe(
    'Text files must be 2 MB or smaller'
  );
  expect(cloneErrorMessage(refused(false))).toBe(
    'Files must be 2 MB or smaller'
  );
});

it('says an unreadable source cannot be copied, not that the input was refused', () => {
  const unreadable = new ApiError(422, 'Unprocessable Entity', undefined, {
    code: 'material_content_unreadable',
  });
  expect(cloneErrorMessage(unreadable)).toBe(
    "This item can't be copied because its stored content could not be read."
  );
});
