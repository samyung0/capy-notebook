import { beforeEach, expect, it, vi } from 'vitest';

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
    { name: 'notes.pdf' }
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

// A ticket request is never aborted: a removal while it is out gives the
// ticket back once it answers, so a removed file is counted once, by its
// give-back (upload-limits review r2 L1).
it('gives back a ticket that answers after the upload was removed', async () => {
  const controller = new AbortController();
  let answer = (_: unknown) => undefined as void;
  post.mockImplementationOnce(
    (_path: string, _body: unknown, options?: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        options?.signal?.addEventListener('abort', () =>
          reject(options.signal?.reason)
        );
        answer = resolve;
      })
  );
  const send = vi.fn();
  const queued = vi.fn();
  const upload = uploadWithTicket(
    '/workspaces/ws_1/sources/uploads',
    {},
    send,
    {
      onQueued: queued,
      signal: controller.signal,
    }
  );
  controller.abort(uploadRemoved);
  answer({ position: 2, ticketId: 'utk_5' });
  await expect(upload).rejects.toBe(uploadRemoved);
  // The caller hears the ticket, so it knows its give-back counts the file.
  expect(queued).toHaveBeenCalledWith(2);
  expect(del).toHaveBeenCalledWith('/uploads/tickets/utk_5?reason=removed');
  expect(send).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

// A file the user removed counts as removed in its batch (Epo 2026-10-22).
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
