import { expect, it, vi } from 'vitest';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('./client', () => ({ api: { get, post } }));

import { takeUploadTurn } from './uploadTurn';

it('waits in line, polling from each place it hears, until its turn', async () => {
  post.mockResolvedValueOnce({ position: 2, ticketId: 'utk_1' });
  get
    .mockResolvedValueOnce({ position: 1, ticketId: 'utk_1' })
    .mockResolvedValueOnce({ position: 0, ticketId: 'utk_1' });
  const places: number[] = [];
  const path = await takeUploadTurn(
    '/workspaces/ws_1/sources/uploads',
    { name: 'notes.pdf' },
    undefined,
    (position) => places.push(position)
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
  expect(path).toBe('/workspaces/ws_1/sources/uploads?ticket=utk_1');
});
