import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError } from './client';

const { del, get, post } = vi.hoisted(() => ({
  del: vi.fn(),
  get: vi.fn(),
  post: vi.fn(),
}));
vi.mock('./client', async (load) => ({
  ...(await load<typeof import('./client')>()),
  api: { del, get, post },
}));

import { uploadRemoved, uploadWithTicket } from './uploadTurn';

beforeEach(() => {
  vi.resetAllMocks();
  del.mockResolvedValue(undefined);
});

it('waits in line, polling from each place it hears, then uploads with its ticket', async () => {
  post.mockResolvedValueOnce({ position: 2, ticketId: 'utk_1' });
  get
    .mockResolvedValueOnce({ position: 1, ticketId: 'utk_1' })
    .mockResolvedValueOnce({ position: 0, ticketId: 'utk_1' });
  const places: number[] = [];
  const send = vi.fn(async (path: string) => path);
  const sent = await uploadWithTicket(
    '/workspaces/ws_1/sources/uploads',
    { name: 'notes.pdf' },
    send,
    { onQueued: (position) => places.push(position) }
  );
  expect(post).toHaveBeenCalledWith(
    '/workspaces/ws_1/sources/uploads/tickets',
    { name: 'notes.pdf' },
    { signal: undefined }
  );
  expect(get.mock.calls.map(([url]) => url)).toEqual([
    '/uploads/tickets/utk_1?position=2',
    '/uploads/tickets/utk_1?position=1',
  ]);
  expect(places).toEqual([2, 1, 0]);
  expect(sent).toBe('/workspaces/ws_1/sources/uploads?ticket=utk_1');
  expect(del).not.toHaveBeenCalled();
});

it('gives its ticket back when the upload is cancelled while it waits', async () => {
  const controller = new AbortController();
  post.mockResolvedValueOnce({ position: 3, ticketId: 'utk_2' });
  get.mockImplementationOnce(() => {
    controller.abort();
    return Promise.reject(new DOMException('aborted', 'AbortError'));
  });
  await expect(
    uploadWithTicket(
      '/materials/m_1/editor-assets/uploads',
      { name: 'figure.png' },
      vi.fn(),
      { signal: controller.signal }
    )
  ).rejects.toThrow('aborted');
  expect(del).toHaveBeenCalledWith('/uploads/tickets/utk_2');
});

// Epo 2026-10-22: a file the user removed counts as removed in its batch.
it('gives the ticket of a removed upload back as removed', async () => {
  const controller = new AbortController();
  post.mockResolvedValueOnce({ position: 3, ticketId: 'utk_4' });
  get.mockImplementationOnce(() => {
    controller.abort(uploadRemoved);
    return Promise.reject(uploadRemoved);
  });
  await expect(
    uploadWithTicket('/workspaces/ws_1/sources/uploads', {}, vi.fn(), {
      signal: controller.signal,
    })
  ).rejects.toBe(uploadRemoved);
  expect(del).toHaveBeenCalledWith('/uploads/tickets/utk_4?reason=removed');
});

it('gives its ticket back before a refused upload is retried', async () => {
  post.mockResolvedValue({ position: 0, ticketId: 'utk_3' });
  const limited = new ApiError(429, 'Too Many Requests');
  const send = vi.fn().mockRejectedValue(limited);
  await expect(
    uploadWithTicket('/workspaces/ws_1/sources/uploads', {}, send, {
      willRetry: true,
    })
  ).rejects.toBe(limited);
  // Given back before the caller sees the refusal, so its retry's new
  // ticket never races the old one; the retry counts the file in its batch.
  expect(del).toHaveBeenLastCalledWith('/uploads/tickets/utk_3?reason=retry');
  // The last attempt's 429 is not retried: the file counts as failed.
  await expect(
    uploadWithTicket('/workspaces/ws_1/sources/uploads', {}, send)
  ).rejects.toBe(limited);
  expect(del).toHaveBeenLastCalledWith('/uploads/tickets/utk_3');
});
