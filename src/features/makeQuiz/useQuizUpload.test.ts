import { expect, it } from 'vitest';
import type { SourceUploadPolicy } from '@/api/types';
import { wouldStayUnread } from './useQuizUpload';

const policy = {
  kinds: [
    { kind: 'md', text: true },
    { kind: 'pdf', text: false },
  ],
} as SourceUploadPolicy;

it('keeps out a file that would be stored with no text', () => {
  expect(wouldStayUnread('pdf', 'none', policy)).toBe(true);
  expect(wouldStayUnread('pdf', 'fast', policy)).toBe(false);
  expect(wouldStayUnread('md', 'none', policy)).toBe(false);
});
