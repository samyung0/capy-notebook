import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Extraction } from '@/api/types';
import { m } from '@/i18n';
import { announceExtractionEnd } from './extractionEnd';

const { toast } = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('@/components/ui/userToast', () => ({ userToast: toast }));

const run = (over: Partial<Extraction>): Extraction => ({
  createdAt: '2026-11-04T10:00:00Z',
  id: 'ex_1',
  recorded: 12,
  status: 'done',
  title: 'Past paper',
  workspaceId: 'ws_1',
  ...over,
});

describe('announceExtractionEnd', () => {
  beforeEach(() => toast.mockClear());

  it('offers the finished quiz when its run page is not open', () => {
    const open = vi.fn();
    announceExtractionEnd(run({ quizId: 'qz_1' }), undefined, open);
    const options = toast.mock.calls[0][0];
    expect(options.title).toBe(
      m.make_quiz_ready_toast({ title: 'Past paper' })
    );
    options.button.onClick();
    expect(open).toHaveBeenCalledWith('ws_1', 'qz_1');
  });

  it('says why a run failed', () => {
    announceExtractionEnd(
      run({ error: 'The pages could not be read.', status: 'failed' }),
      undefined,
      vi.fn()
    );
    expect(toast.mock.calls[0][0]).toMatchObject({
      description: 'The pages could not be read.',
      variant: 'error',
    });
  });

  it('leaves a run to its own page', () => {
    announceExtractionEnd(run({ quizId: 'qz_1' }), 'ex_1', vi.fn());
    expect(toast).not.toHaveBeenCalled();
  });
});
