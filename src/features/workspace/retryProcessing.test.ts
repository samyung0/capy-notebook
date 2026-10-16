import { afterEach, describe, expect, it, vi } from 'vitest';
import { retryFailedFile } from './retryProcessing';

const userToast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/userToast', () => ({ userToast }));

afterEach(() => userToast.mockReset());

describe('retryFailedFile', () => {
  it('retries a still-indexed file in one click, without the dialog', async () => {
    const retry = vi.fn(() => Promise.resolve());
    const openDialog = vi.fn();
    retryFailedFile({ id: 'f_1', indexed: true }, retry, openDialog);
    await vi.waitFor(() => expect(userToast).toHaveBeenCalledOnce());
    expect(retry).toHaveBeenCalledWith({ id: 'f_1', parseMode: 'fast' });
    expect(openDialog).not.toHaveBeenCalled();
  });

  it('opens the dialog for a file that is not indexed', () => {
    const retry = vi.fn(() => Promise.resolve());
    const openDialog = vi.fn();
    retryFailedFile({ id: 'f_1', indexed: false }, retry, openDialog);
    expect(openDialog).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
  });
});
